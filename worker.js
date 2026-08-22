const BYBIT_BASE = "https://api.bybit.com";

const TIMEFRAMES = [
  { key: "1", label: "1m", weight: 1 },
  { key: "3", label: "3m", weight: 1 },
  { key: "5", label: "5m", weight: 2 },
  { key: "15", label: "15m", weight: 3 },
  { key: "60", label: "1H", weight: 4 }
];

const SCAN_LIMIT = 60;
const QUICK_LIMIT = 40;

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
      // CHECK
      // =========================

      if (url.pathname === "/api/check") {

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

        const list =
          await getFuturesList();

        const exists =
          list.includes(symbol);

        return json({
          ok: true,
          exists,
          symbol,
          market: "Bybit Futures"
        });
      }


      // =========================
      // FUTURES
      // =========================

      if (url.pathname === "/api/futures") {

        const futures =
          await getFuturesList();

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

        const rows =
          await getKlines(
            symbol,
            interval,
            limit
          );

        return json({
          ok: true,
          source: "Bybit Futures",
          symbol,
          interval,
          rows
        });
      }


      // =========================
      // MANUAL ANALYSIS
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

        const futures =
          await getFuturesList();

        /*
         * مرحله اول:
         * فقط 1H و 15m برای غربالگری سریع
         */

        const candidates = [];

        const batchSize = 10;

        for (
          let i = 0;
          i < futures.length;
          i += batchSize
        ) {

          const batch =
            futures.slice(
              i,
              i + batchSize
            );

          const quick =
            await Promise.all(
              batch.map(
                async symbol => {

                  try {

                    return await quickScan(
                      symbol
                    );

                  } catch {
                    return null;
                  }

                }
              )
            );

          quick.forEach(x => {

            if (x) {
              candidates.push(x);
            }

          });

        }


        /*
         * بهترین‌ها را انتخاب می‌کنیم
         */

        candidates.sort(
          (a, b) =>
            b.quickScore -
            a.quickScore
        );


        const selected =
          candidates.slice(
            0,
            SCAN_LIMIT
          );


        /*
         * مرحله دوم:
         * تحلیل کامل فقط برای
         * ارزهای انتخاب‌شده
         */

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

                    const result =
                      await analyzeSymbol(
                        candidate.symbol
                      );

                    return result;

                  } catch {

                    return null;

                  }

                }
              )
            );

          analyzed.forEach(result => {

            if (
              result &&
              result.signal !== "WAIT" &&
              result.score.final >= 55
            ) {

              results.push(result);

            }

          });

        }


        /*
         * مرتب‌سازی نهایی
         */

        results.sort(
          (a, b) =>
            b.score.final -
            a.score.final
        );


        const top10 =
          results.slice(0, 10);


        return json({

          ok: true,

          source:
            "Bybit Futures",

          totalFutures:
            futures.length,

          quickCandidates:
            candidates.length,

          fullyAnalyzed:
            selected.length,

          found:
            top10.length,

          results:
            top10

        });

      }


      return json({
        ok: false,
        error: "API endpoint not found"
      }, 404);

    }

    catch (error) {

      return json({
        ok: false,
        error: "Worker error",
        detail:
          error?.message ||
          String(error)
      }, 500);

    }

  }
};


// =================================================
// FUTURES LIST
// =================================================

async function getFuturesList() {

  const data =
    await bybit(
      "/v5/market/instruments-info" +
      "?category=linear" +
      "&limit=1000"
    );

  const list =
    data.result?.list || [];

  return list
    .filter(x =>
      x.status === "Trading" &&
      x.quoteCoin === "USDT" &&
      !x.symbol.includes("-")
    )
    .map(x => x.symbol)
    .sort();
}


// =================================================
// QUICK SCAN
// =================================================

async function quickScan(symbol) {

  const [rows15, rows60] =
    await Promise.all([

      getKlines(
        symbol,
        "15",
        QUICK_LIMIT
      ),

      getKlines(
        symbol,
        "60",
        QUICK_LIMIT
      )

    ]);

  const a15 =
    analyzeTimeframe(rows15);

  const a60 =
    analyzeTimeframe(rows60);

  let score = 0;

  /*
   * 15m
   */

  if (
    a15.trend === "BULLISH" ||
    a15.trend === "BEARISH"
  ) {
    score += 10;
  }

  if (
    a15.touchMA20
  ) {
    score += 15;
  }

  if (
    a15.maSlopeStrength > 0.03
  ) {
    score += 10;
  }

  if (
    a15.volumeSpike
  ) {
    score += 5;
  }


  /*
   * 1H
   */

  if (
    a60.trend === "BULLISH" ||
    a60.trend === "BEARISH"
  ) {
    score += 10;
  }

  if (
    a60.maSlopeStrength > 0.03
  ) {
    score += 10;
  }


  /*
   * هماهنگی جهت
   */

  if (
    a15.trend !== "RANGE" &&
    a15.trend === a60.trend
  ) {
    score += 20;
  }


  return {
    symbol,
    quickScore: score
  };
}


// =================================================
// FULL ANALYSIS
// =================================================

async function analyzeSymbol(symbol) {

  const timeframes = {};

  /*
   * دریافت 5 تایم‌فریم
   * به صورت موازی
   */

  const data =
    await Promise.all(
      TIMEFRAMES.map(
        async tf => {

          try {

            const rows =
              await getKlines(
                symbol,
                tf.key,
                100
              );

            return {
              key: tf.key,
              analysis:
                analyzeTimeframe(rows)
            };

          } catch (e) {

            return {
              key: tf.key,
              analysis: {
                error: e.message
              }
            };

          }

        }
      )
    );


  data.forEach(x => {

    timeframes[x.key] =
      x.analysis;

  });


  const main =
    timeframes["15"];


  if (
    !main ||
    main.error
  ) {

    throw new Error(
      "15m data unavailable"
    );

  }


  let bullish = 0;
  let bearish = 0;

  TIMEFRAMES.forEach(tf => {

    const x =
      timeframes[tf.key];

    if (!x || x.error) return;

    if (
      x.trend === "BULLISH"
    ) bullish++;

    if (
      x.trend === "BEARISH"
    ) bearish++;

  });


  /*
   * LONG / SHORT امتیاز
   */

  let longScore = 0;
  let shortScore = 0;


  TIMEFRAMES.forEach(tf => {

    const x =
      timeframes[tf.key];

    if (!x || x.error) return;


    if (
      x.confirmation === "LONG"
    ) {

      longScore +=
        tf.weight * 10;

    }


    if (
      x.confirmation === "SHORT"
    ) {

      shortScore +=
        tf.weight * 10;

    }


    /*
     * شیب MA20
     */

    if (
      x.maSlopeDirection === "UP"
    ) {

      longScore +=
        tf.weight * 2;

    }

    if (
      x.maSlopeDirection === "DOWN"
    ) {

      shortScore +=
        tf.weight * 2;

    }


    /*
     * ساختار
     */

    if (
      x.structure === "BULLISH"
    ) {

      longScore +=
        tf.weight * 3;

    }

    if (
      x.structure === "BEARISH"
    ) {

      shortScore +=
        tf.weight * 3;

    }


    /*
     * FVG
     */

    if (
      x.fvg === "BULLISH"
    ) {

      longScore +=
        tf.weight * 2;

    }

    if (
      x.fvg === "BEARISH"
    ) {

      shortScore +=
        tf.weight * 2;

    }


    /*
     * Volume
     */

    if (x.volumeSpike) {

      if (
        x.trend === "BULLISH"
      ) {

        longScore +=
          tf.weight * 2;

      }

      if (
        x.trend === "BEARISH"
      ) {

        shortScore +=
          tf.weight * 2;

      }

    }

  });


  /*
   * تأیید چندتایم‌فریمی
   */

  if (bullish >= 3) {
    longScore += 10;
  }

  if (bearish >= 3) {
    shortScore += 10;
  }


  let signal = "WAIT";


  if (
    longScore >= 30 &&
    longScore > shortScore
  ) {

    signal = "LONG";

  }


  if (
    shortScore >= 30 &&
    shortScore > longScore
  ) {

    signal = "SHORT";

  }


  const finalScore =
    Math.min(
      100,
      Math.max(
        longScore,
        shortScore
      )
    );


  /*
   * Entry / SL / TP
   */

  const entry =
    main.close;


  let sl = null;
  let tp1 = null;
  let tp2 = null;
  let tp3 = null;


  if (
    signal === "LONG"
  ) {

    sl =
      main.swingLow;

    if (
      !sl ||
      sl >= entry
    ) {

      sl =
        entry * 0.99;

    }

    const risk =
      entry - sl;

    tp1 =
      entry + risk;

    tp2 =
      entry + risk * 2;

    tp3 =
      entry + risk * 3;

  }


  if (
    signal === "SHORT"
  ) {

    sl =
      main.swingHigh;

    if (
      !sl ||
      sl <= entry
    ) {

      sl =
        entry * 1.01;

    }

    const risk =
      sl - entry;

    tp1 =
      entry - risk;

    tp2 =
      entry - risk * 2;

    tp3 =
      entry - risk * 3;

  }


  return {

    source:
      "Bybit Futures",

    symbol,

    mainTimeframe:
      "15",

    price:
      main.close,

    signal,

    score: {

      long:
        Math.min(
          100,
          longScore
        ),

      short:
        Math.min(
          100,
          shortScore
        ),

      final:
        finalScore

    },

    bullishTimeframes:
      bullish,

    bearishTimeframes:
      bearish,

    entry,
    sl,
    tp1,
    tp2,
    tp3,

    rr:
      "1:3",

    timeframes

  };

}


// =================================================
// TIMEFRAME ANALYSIS
// =================================================

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
    rows[rows.length - 1];

  const previous =
    rows[rows.length - 2];


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


  const previousCloses =
    closes.slice(
      0,
      -1
    );


  const previousMA20 =
    sma(
      previousCloses,
      20
    );


  /*
   * شیب MA20
   */

  let maSlopeDirection =
    "FLAT";


  let maSlope =
    0;


  if (
    previousMA20
  ) {

    maSlope =
      (
        (ma20 - previousMA20) /
        previousMA20
      ) * 100;


    if (
      maSlope > 0.02
    ) {

      maSlopeDirection =
        "UP";

    }
    else if (
      maSlope < -0.02
    ) {

      maSlopeDirection =
        "DOWN";

    }

  }


  const maSlopeStrength =
    Math.abs(maSlope);


  /*
   * روند
   */

  let trend =
    "RANGE";


  if (
    ma7 > ma20 &&
    maSlopeDirection !== "DOWN"
  ) {

    trend =
      "BULLISH";

  }
  else if (
    ma7 < ma20 &&
    maSlopeDirection !== "UP"
  ) {

    trend =
      "BEARISH";

  }


  /*
   * MA20 Touch
   */

  const touchMA20 =
    current.low <= ma20 &&
    current.high >= ma20;


  /*
   * واکنش کندل
   */

  const bullishCandle =
    current.close >
    current.open;


  const bearishCandle =
    current.close <
    current.open;


  let confirmation =
    "NONE";


  if (
    trend === "BULLISH" &&
    touchMA20 &&
    bullishCandle
  ) {

    confirmation =
      "LONG";

  }


  if (
    trend === "BEARISH" &&
    touchMA20 &&
    bearishCandle
  ) {

    confirmation =
      "SHORT";

  }


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
   * Volume
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
   * Swing
   */

  const swingLow =
    findSwingLow(
      rows
    );


  const swingHigh =
    findSwingHigh(
      rows
    );


  return {

    close:
      price,

    ma7,

    ma20,

    maSlope,

    maSlopeDirection,

    maSlopeStrength,

    trend,

    touchMA20,

    confirmation,

    structure,

    fvg,

    volume:
      currentVolume,

    volumeMA20,

    volumeSpike,

    swingLow,

    swingHigh

  };

}


// =================================================
// STRUCTURE
// =================================================

function detectStructure(closes) {

  if (
    !closes ||
    closes.length < 12
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

    return "BULLISH";

  }


  if (
    c < b &&
    b < a
  ) {

    return "BEARISH";

  }


  return "NONE";

}


// =================================================
// FVG
// =================================================

function detectFVG(rows) {

  if (
    rows.length < 3
  ) {

    return "NONE";

  }


  const a =
    rows[rows.length - 3];

  const c =
    rows[rows.length - 1];


  if (
    c.low >
    a.high
  ) {

    return "BULLISH";

  }


  if (
    c.high <
    a.low
  ) {

    return "BEARISH";

  }


  return "NONE";

}


// =================================================
// SWING LOW
// =================================================

function findSwingLow(rows) {

  const start =
    Math.max(
      0,
      rows.length - 10
    );


  let low =
    Infinity;


  for (
    let i = start;
    i < rows.length;
    i++
  ) {

    low =
      Math.min(
        low,
        rows[i].low
      );

  }


  return (
    low === Infinity
      ? null
      : low
  );

}


// =================================================
// SWING HIGH
// =================================================

function findSwingHigh(rows) {

  const start =
    Math.max(
      0,
      rows.length - 10
    );


  let high =
    -Infinity;


  for (
    let i = start;
    i < rows.length;
    i++
  ) {

    high =
      Math.max(
        high,
        rows[i].high
      );

  }


  return (
    high === -Infinity
      ? null
      : high
  );

}


// =================================================
// GET KLINES
// =================================================

async function getKlines(
  symbol,
  interval,
  limit = 100
) {

  const data =
    await bybit(
      "/v5/market/kline" +
      "?category=linear" +
      "&symbol=" +
      encodeURIComponent(symbol) +
      "&interval=" +
      encodeURIComponent(interval) +
      "&limit=" +
      limit
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


// =================================================
// BYBIT REQUEST
// =================================================

async function bybit(path) {

  const response =
    await fetch(
      BYBIT_BASE + path,
      {
        method:
          "GET",

        headers: {
          "Accept":
            "application/json"
        }
      }
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


// =================================================
// SMA
// =================================================

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


  let sum = 0;


  for (
    let i =
      data.length - period;
    i < data.length;
    i++
  ) {

    sum +=
      Number(data[i]);

  }


  return (
    sum / period
  );

}


// =================================================
// SYMBOL NORMALIZER
// =================================================

function normalizeSymbol(
  symbol
) {

  if (!symbol) {
    return "";
  }


  let s =
    symbol
      .trim()
      .toUpperCase();


  s =
    s.replace(
      /[^A-Z0-9]/g,
      ""
    );


  return s;

}


// =================================================
// JSON RESPONSE
// =================================================

function json(
  data,
  status = 200
) {

  return new Response(
    JSON.stringify(data),
    {
      status,

      headers: {
        ...cors,

        "Content-Type":
          "application/json; charset=utf-8"
      }
    }
  );

}
