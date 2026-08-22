const BYBIT_BASE = "https://api.bybit.com";

/*
==================================================
فقط 5 تایم‌فریم
==================================================
*/
const TIMEFRAMES = [
  { key: "1", label: "1m", weight: 1 },
  { key: "3", label: "3m", weight: 1.2 },
  { key: "5", label: "5m", weight: 1.5 },
  { key: "15", label: "15m", weight: 2 },
  { key: "60", label: "1H", weight: 2.5 }
];

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};


/*
==================================================
MAIN WORKER
==================================================
*/

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

      /*
      ================================
      CHECK SYMBOL
      ================================
      */

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

        const data = await bybit(
          "/v5/market/instruments-info?category=linear&limit=1000"
        );

        const list =
          data.result?.list || [];

        const found =
          list.find(x =>
            x.symbol === symbol &&
            x.status === "Trading" &&
            x.quoteCoin === "USDT"
          );

        return json({
          ok: true,
          exists: !!found,
          symbol,
          market: "Bybit Futures"
        });
      }


      /*
      ================================
      FUTURES LIST
      ================================
      */

      if (url.pathname === "/api/futures") {

        const list =
          await getAllFutures();

        return json({
          ok: true,
          source: "Bybit Futures",
          count: list.length,
          futures: list
        });
      }


      /*
      ================================
      KLINE
      ================================
      */

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
            30,
            Math.min(limit, 200)
          );

        if (!symbol) {
          return json({
            ok: false,
            error: "symbol required"
          }, 400);
        }

        if (
          !TIMEFRAMES.some(
            x => x.key === interval
          )
        ) {
          return json({
            ok: false,
            error:
              "Only 1, 3, 5, 15 and 60 intervals are supported."
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


      /*
      ================================
      MANUAL ANALYSIS
      ================================
      */

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


      /*
      ================================
      AUTO SCAN
      ================================
      */

      if (url.pathname === "/api/scan") {

        const symbols =
          await getAllFutures();

        /*
        برای جلوگیری از timeout،
        اسکن را به صورت batch انجام می‌دهیم.
        */

        const results = [];

        const batchSize = 8;

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

                    return await analyzeSymbol(
                      symbol
                    );

                  } catch (e) {

                    return null;

                  }

                }
              )
            );

          for (
            const result of batchResults
          ) {

            if (!result) continue;

            /*
            فقط موقعیت‌های دارای
            تأیید کافی
            */

            if (
              result.signal !== "WAIT" &&
              result.score.final >= 55
            ) {

              results.push(result);

            }

          }

        }


        /*
        قوی‌ترین‌ها اول
        */

        results.sort(
          (a, b) =>
            b.score.final -
            a.score.final
        );


        /*
        فقط 10 موقعیت برتر
        */

        const top10 =
          results.slice(0, 10);


        return json({
          ok: true,
          source: "Bybit Futures",
          scanned: symbols.length,
          found: results.length,
          top: top10,
          results: top10
        });
      }


      return json({
        ok: false,
        error: "API endpoint not found",
        path: url.pathname
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


/*
==================================================
BYBIT REQUEST
==================================================
*/

async function bybit(path) {

  const response =
    await fetch(
      BYBIT_BASE + path,
      {
        method: "GET",
        headers: {
          "Accept": "application/json"
        }
      }
    );

  if (!response.ok) {

    throw new Error(
      `Bybit HTTP ${response.status}`
    );

  }

  const data =
    await response.json();

  if (
    data.retCode !== undefined &&
    data.retCode !== 0
  ) {

    throw new Error(
      data.retMsg ||
      "Bybit API error"
    );

  }

  return data;
}


/*
==================================================
ALL USDT FUTURES
==================================================
*/

async function getAllFutures() {

  let all = [];

  let cursor = "";

  /*
  Bybit ممکن است لیست را
  صفحه‌بندی کند.
  */

  for (
    let page = 0;
    page < 10;
    page++
  ) {

    let path =
      "/v5/market/instruments-info" +
      "?category=linear" +
      "&limit=1000";

    if (cursor) {

      path +=
        "&cursor=" +
        encodeURIComponent(cursor);

    }

    const data =
      await bybit(path);

    const list =
      data.result?.list || [];

    all.push(...list);

    cursor =
      data.result?.nextPageCursor ||
      "";

    if (!cursor) break;

  }


  const symbols =
    [...new Set(
      all
        .filter(x =>
          x.status === "Trading" &&
          x.quoteCoin === "USDT" &&
          x.contractType === "LinearPerpetual" &&
          !x.symbol.includes("-")
        )
        .map(x => x.symbol)
    )];


  return symbols.sort();
}


/*
==================================================
KLINES
==================================================
*/

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


  return (
    data.result?.list || []
  )
    .reverse()
    .map(x => ({

      time: Number(x[0]),

      open: Number(x[1]),

      high: Number(x[2]),

      low: Number(x[3]),

      close: Number(x[4]),

      volume: Number(x[5])

    }));

}


/*
==================================================
FULL SYMBOL ANALYSIS
==================================================
*/

async function analyzeSymbol(symbol) {

  const timeframes = {};

  /*
  هر 5 تایم‌فریم
  */

  for (
    const tf of TIMEFRAMES
  ) {

    try {

      const rows =
        await getKlines(
          symbol,
          tf.key,
          100
        );

      timeframes[tf.key] =
        analyzeTimeframe(
          rows
        );

    }

    catch (error) {

      timeframes[tf.key] = {
        error:
          error?.message ||
          String(error)
      };

    }

  }


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


  /*
  تعداد تایم‌فریم‌های صعودی/نزولی
  */

  let bullish = 0;

  let bearish = 0;

  for (
    const tf of TIMEFRAMES
  ) {

    const x =
      timeframes[tf.key];

    if (!x || x.error) continue;

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

  }


  /*
  امتیاز LONG و SHORT
  */

  let longScore = 0;

  let shortScore = 0;


  for (
    const tf of TIMEFRAMES
  ) {

    const x =
      timeframes[tf.key];

    if (!x || x.error) continue;


    /*
    LONG
    */

    if (
      x.longConfirmed
    ) {

      longScore +=
        tf.weight * 10;

    }


    /*
    SHORT
    */

    if (
      x.shortConfirmed
    ) {

      shortScore +=
        tf.weight * 10;

    }

  }


  /*
  تأیید کلی تایم‌فریم‌ها
  */

  if (bullish >= 3) {

    longScore += 10;

  }

  if (bearish >= 3) {

    shortScore += 10;

  }


  /*
  شیب 15 دقیقه
  */

  if (
    main.slope.direction ===
    "UP"
  ) {

    longScore += 8;

  }

  if (
    main.slope.direction ===
    "DOWN"
  ) {

    shortScore += 8;

  }


  /*
  ساختار 15 دقیقه
  */

  if (
    main.structure ===
    "BULLISH"
  ) {

    longScore += 8;

  }

  if (
    main.structure ===
    "BEARISH"
  ) {

    shortScore += 8;

  }


  /*
  FVG
  */

  if (
    main.fvg.type ===
    "BULLISH"
  ) {

    longScore += 5;

  }

  if (
    main.fvg.type ===
    "BEARISH"
  ) {

    shortScore += 5;

  }


  /*
  Volume
  */

  if (
    main.volume.spike
  ) {

    if (
      main.trend ===
      "BULLISH"
    ) {

      longScore += 5;

    }

    if (
      main.trend ===
      "BEARISH"
    ) {

      shortScore += 5;

    }

  }


  /*
  تعیین سیگنال
  */

  let signal = "WAIT";


  if (
    longScore >= 40 &&
    longScore > shortScore
  ) {

    signal = "LONG";

  }


  if (
    shortScore >= 40 &&
    shortScore > longScore
  ) {

    signal = "SHORT";

  }


  /*
  امتیاز نهایی
  */

  const finalScore =
    Math.min(
      100,
      Math.round(
        Math.max(
          longScore,
          shortScore
        )
      )
    );


  /*
  Entry
  */

  const entry =
    main.close;


  /*
  SL / TP
  */

  let targets = null;


  if (
    signal === "LONG" ||
    signal === "SHORT"
  ) {

    targets =
      calculateTargets(
        main,
        signal
      );

  }


  /*
  خروجی
  */

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
        Math.round(longScore),

      short:
        Math.round(shortScore),

      final:
        finalScore

    },

    bullishTimeframes:
      bullish,

    bearishTimeframes:
      bearish,

    entry,

    sl:
      targets?.sl ||
      null,

    tp1:
      targets?.tp1 ||
      null,

    tp2:
      targets?.tp2 ||
      null,

    tp3:
      targets?.tp3 ||
      null,

    rr:
      targets?.rr ||
      null,

    timeframes

  };

}


/*
==================================================
TIMEFRAME ANALYSIS
==================================================
*/

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


  const price =
    closes[
      closes.length - 1
    ];


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


  const volumeMA7 =
    sma(
      volumes,
      7
    );


  const volumeMA20 =
    sma(
      volumes,
      20
    );


  const current =
    rows[
      rows.length - 1
    ];


  const previous =
    rows[
      rows.length - 2
    ];


  /*
  ================================================
  TREND
  ================================================
  */

  let trend = "RANGE";


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
  ================================================
  MA20 SLOPE
  ================================================
  */

  const slopePercent =
    previousMA20
      ? (
          (ma20 -
            previousMA20) /
          previousMA20
        ) * 100
      : 0;


  let slopeDirection =
    "FLAT";


  if (
    slopePercent > 0.015
  ) {

    slopeDirection =
      "UP";

  }

  else if (
    slopePercent < -0.015
  ) {

    slopeDirection =
      "DOWN";

  }


  /*
  ================================================
  MA20 TOUCH
  ================================================
  */

  const distanceToMA20 =
    Math.abs(
      price - ma20
    ) / ma20;


  const touchMA20 =
    current.low <= ma20 &&
    current.high >= ma20;


  /*
  اگر قیمت خیلی نزدیک MA20 باشد
  نیز برخورد حساب می‌شود.
  */

  const nearMA20 =
    distanceToMA20 <= 0.0025;


  const ma20Touched =
    touchMA20 ||
    nearMA20;


  /*
  ================================================
  CANDLE REACTION
  ================================================
  */

  const bullishCandle =
    current.close >
    current.open;


  const bearishCandle =
    current.close <
    current.open;


  const candleRange =
    current.high -
    current.low;


  const candleBody =
    Math.abs(
      current.close -
      current.open
    );


  const strongBody =
    candleRange > 0
      ? candleBody /
          candleRange >=
        0.45
      : false;


  /*
  ================================================
  STRUCTURE
  ================================================
  */

  const structure =
    detectStructure(
      rows
    );


  /*
  ================================================
  BOS / CHOCH
  ================================================
  */

  const bos =
    detectBOS(
      rows,
      structure
    );


  const choch =
    detectCHoCH(
      rows
    );


  /*
  ================================================
  FVG
  ================================================
  */

  const fvg =
    detectFVG(
      rows
    );


  /*
  ================================================
  VOLUME
  ================================================
  */

  const volumeSpike =
    volumeMA20 > 0 &&
    current.volume >
      volumeMA20 * 1.5;


  /*
  ================================================
  VOLUME CONFIRMATION
  ================================================
  */

  let volumeConfirmation =
    false;


  if (
    volumeSpike
  ) {

    volumeConfirmation =
      true;

  }


  /*
  ================================================
  LONG CONFIRMATION
  ================================================
  */

  const longConfirmed =
    trend === "BULLISH" &&
    ma20Touched &&
    slopeDirection === "UP" &&
    bullishCandle &&
    strongBody;


  /*
  ================================================
  SHORT CONFIRMATION
  ================================================
  */

  const shortConfirmed =
    trend === "BEARISH" &&
    ma20Touched &&
    slopeDirection === "DOWN" &&
    bearishCandle &&
    strongBody;


  /*
  ================================================
  CONFIRMATION TYPE
  ================================================
  */

  let confirmation =
    "NONE";


  if (
    longConfirmed
  ) {

    confirmation =
      "LONG";

  }

  else if (
    shortConfirmed
  ) {

    confirmation =
      "SHORT";

  }


  /*
  ================================================
  SWING LOW / HIGH
  ================================================
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

    volume:
      current.volume,

    volumeMA7,

    volumeMA20,

    volumeSpike,

    trend,

    range:
      Math.abs(ma7 - ma20) /
        ma20 < 0.0015,

    slope: {

      value:
        slopePercent,

      direction:
        slopeDirection

    },

    touchMA20:
      ma20Touched,

    ma20Touched,

    distanceToMA20,

    reaction:
      bullishCandle
        ? "BULLISH"
        : bearishCandle
        ? "BEARISH"
        : "NONE",

    strongBody,

    confirmation,

    longConfirmed,

    shortConfirmed,

    structure,

    bos,

    choch,

    fvg,

    volume: {

      current:
        current.volume,

      ma7:
        volumeMA7,

      ma20:
        volumeMA20,

      spike:
        volumeSpike,

      confirmed:
        volumeConfirmation

    },

    swingLow,

    swingHigh

  };

}


/*
==================================================
STRUCTURE
==================================================
*/

function detectStructure(rows) {

  if (
    rows.length < 10
  ) {

    return "NONE";

  }


  const n =
    rows.length;


  const h1 =
    rows[n - 7].high;

  const h2 =
    rows[n - 4].high;

  const h3 =
    rows[n - 1].high;


  const l1 =
    rows[n - 7].low;

  const l2 =
    rows[n - 4].low;

  const l3 =
    rows[n - 1].low;


  if (
    h3 > h2 &&
    h2 > h1 &&
    l3 > l2 &&
    l2 > l1
  ) {

    return "BULLISH";

  }


  if (
    h3 < h2 &&
    h2 < h1 &&
    l3 < l2 &&
    l2 < l1
  ) {

    return "BEARISH";

  }


  /*
  ساختار با آخرین حرکت
  */

  if (
    h3 > h2 &&
    l3 >= l2
  ) {

    return "BULLISH";

  }


  if (
    l3 < l2 &&
    h3 <= h2
  ) {

    return "BEARISH";

  }


  return "NONE";

}


/*
==================================================
BOS
==================================================
*/

function detectBOS(
  rows,
  structure
) {

  if (
    rows.length < 8
  ) {

    return "NONE";

  }


  const n =
    rows.length;


  const previousHigh =
    Math.max(
      ...rows
        .slice(n - 7, n - 1)
        .map(x => x.high)
    );


  const previousLow =
    Math.min(
      ...rows
        .slice(n - 7, n - 1)
        .map(x => x.low)
    );


  const current =
    rows[n - 1];


  if (
    structure === "BULLISH" &&
    current.close >
      previousHigh
  ) {

    return "BULLISH BOS";

  }


  if (
    structure === "BEARISH" &&
    current.close <
      previousLow
  ) {

    return "BEARISH BOS";

  }


  return "NONE";

}


/*
==================================================
CHoCH
==================================================
*/

function detectCHoCH(rows) {

  if (
    rows.length < 12
  ) {

    return "NONE";

  }


  const n =
    rows.length;


  const old =
    rows.slice(
      n - 10,
      n - 5
    );


  const recent =
    rows.slice(
      n - 5
    );


  const oldHigh =
    Math.max(
      ...old.map(
        x => x.high
      )
    );


  const oldLow =
    Math.min(
      ...old.map(
        x => x.low
      )
    );


  const recentHigh =
    Math.max(
      ...recent.map(
        x => x.high
      )
    );


  const recentLow =
    Math.min(
      ...recent.map(
        x => x.low
      )
    );


  if (
    recentHigh >
      oldHigh &&
    recentLow >
      oldLow
  ) {

    return "BULLISH CHoCH";

  }


  if (
    recentLow <
      oldLow &&
    recentHigh <
      oldHigh
  ) {

    return "BEARISH CHoCH";

  }


  return "NONE";

}


/*
==================================================
FVG
==================================================
*/

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


  /*
  آخرین سه کندل
  */

  const a =
    rows[
      rows.length - 3
    ];

  const c =
    rows[
      rows.length - 1
    ];


  /*
  Bullish FVG
  */

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


  /*
  Bearish FVG
  */

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


/*
==================================================
SWING LOW
==================================================
*/

function findSwingLow(rows) {

  const start =
    Math.max(
      1,
      rows.length - 12
    );


  let low =
    Infinity;


  for (
    let i = start;
    i < rows.length - 1;
    i++
  ) {

    if (
      rows[i].low <
        low
    ) {

      low =
        rows[i].low;

    }

  }


  if (
    !Number.isFinite(low)
  ) {

    return null;

  }


  return low;

}


/*
==================================================
SWING HIGH
==================================================
*/

function findSwingHigh(rows) {

  const start =
    Math.max(
      1,
      rows.length - 12
    );


  let high =
    -Infinity;


  for (
    let i = start;
    i < rows.length - 1;
    i++
  ) {

    if (
      rows[i].high >
        high
    ) {

      high =
        rows[i].high;

    }

  }


  if (
    !Number.isFinite(high)
  ) {

    return null;

  }


  return high;

}


/*
==================================================
SL / TP
==================================================
*/

function calculateTargets(
  x,
  direction
) {

  const entry =
    x.close;


  let sl;


  if (
    direction === "LONG"
  ) {

    /*
    ابتدا Swing Low
    */

    sl =
      x.swingLow;


    /*
    اگر Swing Low مناسب نبود
    */

    if (
      !sl ||
      sl >= entry
    ) {

      sl =
        entry * 0.985;

    }


    /*
    اگر فاصله خیلی کوچک بود
    */

    if (
      (entry - sl) /
        entry < 0.002
    ) {

      sl =
        entry * 0.99;

    }


    const risk =
      entry - sl;


    return {

      entry,

      sl,

      tp1:
        entry +
        risk * 1,

      tp2:
        entry +
        risk * 2,

      tp3:
        entry +
        risk * 3,

      rr:
        "1:3"

    };

  }


  /*
  SHORT
  */

  sl =
    x.swingHigh;


  if (
    !sl ||
    sl <= entry
  ) {

    sl =
      entry * 1.015;

  }


  if (
    (sl - entry) /
      entry < 0.002
  ) {

    sl =
      entry * 1.01;

  }


  const risk =
    sl - entry;


  return {

    entry,

    sl,

    tp1:
      entry -
      risk * 1,

    tp2:
      entry -
      risk * 2,

    tp3:
      entry -
      risk * 3,

    rr:
      "1:3"

  };

}


/*
==================================================
SMA
==================================================
*/

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
      (sum, value) =>
        sum + Number(value),
      0
    ) / period
  );

}


/*
==================================================
NORMALIZE SYMBOL
==================================================
*/

function normalizeSymbol(
  symbol
) {

  if (!symbol) {

    return "";

  }


  return String(symbol)
    .trim()
    .toUpperCase()
    .replace(
      /[^A-Z0-9]/g,
      ""
    );

}


/*
==================================================
JSON RESPONSE
==================================================
*/

function json(
  data,
  status = 200
) {

  return new Response(
    JSON.stringify(
      data,
      null,
      2
    ),
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
