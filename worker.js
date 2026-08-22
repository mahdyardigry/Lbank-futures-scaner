const BYBIT_BASE = "https://api.bybit.com";

const TIMEFRAMES = [
  { key: "1", label: "1m", weight: 20 },
  { key: "3", label: "3m", weight: 30 },
  { key: "5", label: "5m", weight: 50 }
];

const MIN_TARGET_PERCENT = 30;
const MAX_FULL_ANALYSIS = 40;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

export default {
  async fetch(request) {

    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: cors
      });
    }

    try {

      // =========================
      // FUTURES LIST
      // =========================

      if (url.pathname === "/api/futures") {

        const data = await bybit(
          "/v5/market/instruments-info?category=linear&limit=1000"
        );

        const list = data.result?.list || [];

        const futures = list
          .filter(x =>
            x.status === "Trading" &&
            x.quoteCoin === "USDT" &&
            !x.symbol.includes("-")
          )
          .map(x => x.symbol)
          .sort();

        return json({
          ok: true,
          source: "Bybit Futures",
          count: futures.length,
          futures
        });
      }


      // =========================
      // KLINE
      // =========================

      if (url.pathname === "/api/kline") {

        const symbol =
          normalizeSymbol(
            url.searchParams.get("symbol")
          );

        const interval =
          url.searchParams.get("interval") || "15";

        let limit =
          Number(
            url.searchParams.get("limit") || 100
          );

        limit =
          Math.max(
            20,
            Math.min(limit, 200)
          );

        if (!symbol) {

          return json({
            ok: false,
            error: "symbol required"
          }, 400);

        }

        const data =
          await getKline(
            symbol,
            interval,
            limit
          );

        return json({
          ok: true,
          source: "Bybit Futures",
          symbol,
          interval,
          rows: data
        });
      }


      // =========================
      // MANUAL ANALYZE
      // =========================

      if (url.pathname === "/api/analyze") {

        const symbol =
          normalizeSymbol(
            url.searchParams.get("symbol")
          );

        if (!symbol) {

          return json({
            ok: false,
            error: "symbol required"
          }, 400);

        }

        const result =
          await analyzeSymbol(symbol);

        return json({
          ok: true,
          ...result
        });
      }


      // =========================
      // FAST MARKET SCAN
      // =========================

      if (url.pathname === "/api/scan") {

        const data =
          await bybit(
            "/v5/market/instruments-info?category=linear&limit=1000"
          );

        const instruments =
          data.result?.list || [];

        const symbols =
          instruments
            .filter(x =>
              x.status === "Trading" &&
              x.quoteCoin === "USDT" &&
              !x.symbol.includes("-")
            )
            .map(x => x.symbol);

        /*
         * مرحله اول:
         * فقط 5m برای غربالگری
         */

        const candidates = [];

        const batchSize = 20;

        for (
          let i = 0;
          i < symbols.length;
          i += batchSize
        ) {

          const batch =
            symbols.slice(
              i,
              i + batchSize
            );

          const batchResults =
            await Promise.all(
              batch.map(
                async symbol => {

                  try {

                    const rows =
                      await getKline(
                        symbol,
                        "5",
                        60
                      );

                    const quick =
                      quickFilter(rows);

                    if (quick) {

                      return {
                        symbol,
                        ...quick
                      };

                    }

                  } catch (e) {

                    return null;

                  }

                  return null;

                }
              )
            );

          for (
            const item of batchResults
          ) {

            if (item) {
              candidates.push(item);
            }

          }
        }


        /*
         * بهترین کاندیدها اول
         */

        candidates.sort(
          (a, b) =>
            b.quickScore -
            a.quickScore
        );


        /*
         * فقط 40 ارز وارد تحلیل کامل
         */

        const selected =
          candidates.slice(
            0,
            MAX_FULL_ANALYSIS
          );


        const results = [];

        for (
          let i = 0;
          i < selected.length;
          i += 5
        ) {

          const batch =
            selected.slice(
              i,
              i + 5
            );

          const analyzed =
            await Promise.all(
              batch.map(
                async candidate => {

                  try {

                    return await analyzeSymbol(
                      candidate.symbol
                    );

                  } catch (e) {

                    return null;

                  }

                }
              )
            );

          for (
            const result of analyzed
          ) {

            if (!result) continue;

            /*
             * فقط سیگنال‌هایی که
             * فضای حداقل 30 درصدی دارند
             */

            if (
              result.signal !== "WAIT" &&
              result.potentialPercent >=
                MIN_TARGET_PERCENT
            ) {

              results.push(result);

            }

          }

        }


        /*
         * قوی‌ترین سیگنال‌ها
         */

        results.sort(
          (a, b) => {

            if (
              b.score.final !==
              a.score.final
            ) {

              return (
                b.score.final -
                a.score.final
              );

            }

            return (
              b.potentialPercent -
              a.potentialPercent
            );

          }
        );


        const top10 =
          results.slice(0, 10);


        return json({

          ok: true,

          source:
            "Bybit Futures",

          totalSymbols:
            symbols.length,

          candidates:
            candidates.length,

          fullAnalysis:
            selected.length,

          found:
            results.length,

          returned:
            top10.length,

          minimumPotential:
            MIN_TARGET_PERCENT,

          results:
            top10

        });

      }


      return json({
        ok: false,
        error: "API endpoint not found"
      }, 404);

    } catch (error) {

      return json({

        ok: false,

        error:
          "Worker error",

        detail:
          error?.message ||
          String(error)

      }, 500);

    }

  }
};


// =====================================================
// ANALYZE SYMBOL
// =====================================================

async function analyzeSymbol(symbol) {

  const timeframes = {};

  for (
    const tf of TIMEFRAMES
  ) {

    try {

      const rows =
        await getKline(
          symbol,
          tf.key,
          100
        );

      timeframes[tf.key] =
        analyzeTimeframe(rows);

    } catch (e) {

      timeframes[tf.key] = {
        error: e.message
      };

    }

  }


  let longScore = 0;
  let shortScore = 0;

  let bullish = 0;
  let bearish = 0;


  for (
    const tf of TIMEFRAMES
  ) {

    const x =
      timeframes[tf.key];

    if (
      !x ||
      x.error
    ) continue;


    if (
      x.trend === "BULLISH"
    ) {

      bullish++;

    }


    if (
      x.trend === "BEARISH"
    ) {

      bearish++;

    }


    if (
      x.direction === "LONG"
    ) {

      longScore +=
        tf.weight;

    }


    if (
      x.direction === "SHORT"
    ) {

      shortScore +=
        tf.weight;

    }

  }


  /*
   * تأیید چندتایم‌فریمی
   */

  if (
    bullish >= 2
  ) {

    longScore += 15;

  }


  if (
    bearish >= 2
  ) {

    shortScore += 15;

  }


  /*
   * تعیین سیگنال
   */

  let signal = "WAIT";

  if (
    longScore >= 60 &&
    longScore > shortScore
  ) {

    signal = "LONG";

  }


  if (
    shortScore >= 60 &&
    shortScore > longScore
  ) {

    signal = "SHORT";

  }


  /*
   * تایم‌فریم اصلی 5 دقیقه
   */

  const main =
    timeframes["5"];


  if (!main) {

    throw new Error(
      "5m data unavailable"
    );

  }


  const entry =
    main.close;


  let sl = null;
  let tp1 = null;
  let tp2 = null;
  let tp3 = null;


  /*
   * LONG
   */

  if (
    signal === "LONG"
  ) {

    sl =
      calculateLongSL(
        main
      );

    const risk =
      entry - sl;

    tp1 =
      entry +
      risk * 2;

    tp2 =
      entry +
      risk * 4;

    tp3 =
      entry +
      risk * 6;

  }


  /*
   * SHORT
   */

  if (
    signal === "SHORT"
  ) {

    sl =
      calculateShortSL(
        main
      );

    const risk =
      sl - entry;

    tp1 =
      entry -
      risk * 2;

    tp2 =
      entry -
      risk * 4;

    tp3 =
      entry -
      risk * 6;

  }


  let potentialPercent = 0;


  if (
    signal === "LONG" &&
    tp3
  ) {

    potentialPercent =
      (
        (tp3 - entry) /
        entry
      ) * 100;

  }


  if (
    signal === "SHORT" &&
    tp3
  ) {

    potentialPercent =
      (
        (entry - tp3) /
        entry
      ) * 100;

  }


  /*
   * امتیاز نهایی
   */

  const finalScore =
    Math.min(
      100,
      Math.max(
        longScore,
        shortScore
      )
    );


  return {

    source:
      "Bybit Futures",

    symbol,

    signal,

    mainTimeframe:
      "5m",

    price:
      entry,

    entry,

    sl,

    tp1,

    tp2,

    tp3,

    potentialPercent:
      Number(
        potentialPercent.toFixed(2)
      ),

    score: {

      long:
        longScore,

      short:
        shortScore,

      final:
        finalScore

    },

    bullishTimeframes:
      bullish,

    bearishTimeframes:
      bearish,

    timeframes

  };

}


// =====================================================
// TIMEFRAME ANALYSIS
// =====================================================

function analyzeTimeframe(rows) {

  if (
    !rows ||
    rows.length < 30
  ) {

    throw new Error(
      "Not enough candles"
    );

  }


  const closes =
    rows.map(
      x => x.close
    );


  const volumes =
    rows.map(
      x => x.volume
    );


  const current =
    rows[
      rows.length - 1
    ];


  const previous =
    rows[
      rows.length - 2
    ];


  const price =
    current.close;


  const ma7 =
    sma(
      closes,
      7
    );


  const ma20 =
    sma(
      closes,
      20
    );


  const previousMA20 =
    sma(
      closes.slice(0, -1),
      20
    );


  /*
   * شیب MA20
   */

  const slopePercent =
    (
      (ma20 - previousMA20) /
      previousMA20
    ) * 100;


  let slope =
    "FLAT";


  if (
    slopePercent > 0.03
  ) {

    slope = "UP";

  }
  else if (
    slopePercent < -0.03
  ) {

    slope = "DOWN";

  }


  /*
   * روند
   */

  let trend =
    "RANGE";


  if (
    ma7 > ma20
  ) {

    trend =
      "BULLISH";

  }
  else if (
    ma7 < ma20
  ) {

    trend =
      "BEARISH";

  }


  /*
   * لمس MA20
   */

  const touchMA20 =
    current.low <= ma20 &&
    current.high >= ma20;


  /*
   * فاصله قیمت از MA20
   */

  const distancePercent =
    Math.abs(
      price - ma20
    ) /
    ma20 *
    100;


  /*
   * واکنش کندل
   */

  const bullishReaction =
    current.close >
    current.open &&
    current.close >
    ma20;


  const bearishReaction =
    current.close <
    current.open &&
    current.close <
    ma20;


  /*
   * ساختار
   */

  const structure =
    detectStructure(
      closes
    );


  /*
   * FVG
   */

  const fvg =
    detectFVG(
      rows
    );


  /*
   * حجم
   */

  const volumeMA20 =
    sma(
      volumes,
      20
    );


  const currentVolume =
    current.volume;


  const volumeSpike =
    currentVolume >
    volumeMA20 * 1.5;


  /*
   * جهت
   */

  let direction =
    "NONE";


  if (
    trend === "BULLISH" &&
    slope === "UP" &&
    touchMA20 &&
    bullishReaction
  ) {

    direction =
      "LONG";

  }


  if (
    trend === "BEARISH" &&
    slope === "DOWN" &&
    touchMA20 &&
    bearishReaction
  ) {

    direction =
      "SHORT";

  }


  /*
   * اگر FVG هم‌جهت باشد
   * قدرت تأیید بیشتر است.
   */

  if (
    direction === "LONG" &&
    fvg.type === "BULLISH"
  ) {

    direction =
      "LONG";

  }


  if (
    direction === "SHORT" &&
    fvg.type === "BEARISH"
  ) {

    direction =
      "SHORT";

  }


  return {

    price,

    close:
      price,

    open:
      current.open,

    high:
      current.high,

    low:
      current.low,

    ma7,

    ma20,

    slope,

    slopePercent,

    distancePercent,

    trend,

    touchMA20,

    bullishReaction,

    bearishReaction,

    structure,

    fvg,

    volume: {

      current:
        currentVolume,

      ma20:
        volumeMA20,

      spike:
        volumeSpike

    },

    direction,

    swingLow:
      findSwingLow(rows),

    swingHigh:
      findSwingHigh(rows)

  };

}


// =====================================================
// QUICK FILTER
// =====================================================

function quickFilter(rows) {

  if (
    !rows ||
    rows.length < 30
  ) {

    return null;

  }


  const closes =
    rows.map(
      x => x.close
    );


  const volumes =
    rows.map(
      x => x.volume
    );


  const price =
    closes[
      closes.length - 1
    ];


  const ma20 =
    sma(
      closes,
      20
    );


  const volumeMA20 =
    sma(
      volumes,
      20
    );


  const distance =
    Math.abs(
      price - ma20
    ) /
    ma20;


  /*
   * فقط ارزهایی که
   * نسبتاً نزدیک MA20 هستند
   */

  if (
    distance > 0.08
  ) {

    return null;

  }


  let score = 0;


  if (
    distance < 0.02
  ) {

    score += 40;

  }
  else if (
    distance < 0.05
  ) {

    score += 25;

  }
  else {

    score += 10;

  }


  if (
    volumes[
      volumes.length - 1
    ] >
    volumeMA20 * 1.3
  ) {

    score += 30;

  }


  const ma7 =
    sma(
      closes,
      7
    );


  if (
    ma7 > ma20 ||
    ma7 < ma20
  ) {

    score += 20;

  }


  return {

    quickScore:
      score,

    price,

    ma20,

    distancePercent:
      distance * 100

  };

}


// =====================================================
// SL
// =====================================================

function calculateLongSL(x) {

  let sl =
    x.swingLow;


  if (
    !sl ||
    sl >= x.price
  ) {

    sl =
      x.price * 0.97;

  }


  return sl;

}


function calculateShortSL(x) {

  let sl =
    x.swingHigh;


  if (
    !sl ||
    sl <= x.price
  ) {

    sl =
      x.price * 1.03;

  }


  return sl;

}


// =====================================================
// SWING
// =====================================================

function findSwingLow(rows) {

  const start =
    Math.max(
      0,
      rows.length - 10
    );


  let low =
    rows[start].low;


  for (
    let i = start;
    i < rows.length;
    i++
  ) {

    if (
      rows[i].low < low
    ) {

      low =
        rows[i].low;

    }

  }


  return low;

}


function findSwingHigh(rows) {

  const start =
    Math.max(
      0,
      rows.length - 10
    );


  let high =
    rows[start].high;


  for (
    let i = start;
    i < rows.length;
    i++
  ) {

    if (
      rows[i].high > high
    ) {

      high =
        rows[i].high;

    }

  }


  return high;

}


// =====================================================
// STRUCTURE
// =====================================================

function detectStructure(closes) {

  if (
    closes.length < 10
  ) {

    return "NONE";

  }


  const n =
    closes.length;


  const a =
    closes[n - 7];


  const b =
    closes[n - 4];


  const c =
    closes[n - 1];


  if (
    c > b &&
    b > a
  ) {

    return "BULLISH BOS";

  }


  if (
    c < b &&
    b < a
  ) {

    return "BEARISH BOS";

  }


  return "NONE";

}


// =====================================================
// FVG
// =====================================================

function detectFVG(rows) {

  if (
    rows.length < 3
  ) {

    return {
      type: "NONE",
      bottom: null,
      top: null
    };

  }


  const a =
    rows[
      rows.length - 3
    ];


  const c =
    rows[
      rows.length - 1
    ];


  if (
    c.low > a.high
  ) {

    return {

      type:
        "BULLISH",

      bottom:
        a.high,

      top:
        c.low

    };

  }


  if (
    c.high < a.low
  ) {

    return {

      type:
        "BEARISH",

      bottom:
        c.high,

      top:
        a.low

    };

  }


  return {

    type:
      "NONE",

    bottom:
      null,

    top:
      null

  };

}


// =====================================================
// KLINE
// =====================================================

async function getKline(
  symbol,
  interval,
  limit = 100
) {

  const endpoint =
    "/v5/market/kline" +
    "?category=linear" +
    "&symbol=" +
    encodeURIComponent(symbol) +
    "&interval=" +
    encodeURIComponent(interval) +
    "&limit=" +
    limit;


  const data =
    await bybit(
      endpoint
    );


  const list =
    data.result?.list || [];


  return list
    .reverse()
    .map(x => ({

      time:
        Number(x[0]),

      open:
        Number(x[1]),

      high:
        Number(x[2]),

      low:
        Number(x[3]),

      close:
        Number(x[4]),

      volume:
        Number(x[5])

    }));

}


// =====================================================
// BYBIT
// =====================================================

async function bybit(path) {

  const response =
    await fetch(
      BYBIT_BASE + path
    );


  if (!response.ok) {

    throw new Error(
      "Bybit HTTP " +
      response.status
    );

  }


  const data =
    await response.json();


  if (
    data.retCode !== 0
  ) {

    throw new Error(
      data.retMsg ||
      "Bybit API error"
    );

  }


  return data;

}


// =====================================================
// HELPERS
// =====================================================

function normalizeSymbol(symbol) {

  if (!symbol) {
    return "";
  }

  return symbol
    .toUpperCase()
    .replace(
      /[^A-Z0-9]/g,
      ""
    );

}


function sma(
  data,
  period
) {

  if (
    !data ||
    data.length < period
  ) {

    return null;

  }


  const part =
    data.slice(
      data.length - period
    );


  return (
    part.reduce(
      (a, b) => a + b,
      0
    ) /
    period
  );

}


function json(
  data,
  status = 200
) {

  return new Response(
    JSON.stringify(
      data
    ),
    {

      status,

      headers: {

        "Content-Type":
          "application/json; charset=utf-8",

        ...cors

      }

    }
  );

}
