const BYBIT = "https://api.bybit.com";

export default {
  async fetch(request) {
    const url = new URL(request.url);

    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    try {

      // =========================
      // SYMBOLS
      // =========================
      if (url.pathname === "/api/symbols") {

        const symbols = await getSymbols();

        return json({
          ok: true,
          source: "Bybit Futures",
          count: symbols.length,
          futures: symbols
        }, cors);
      }


      // =========================
      // CHECK SYMBOL
      // =========================
      if (url.pathname === "/api/check") {

        let symbol =
          (url.searchParams.get("symbol") || "")
          .trim()
          .toUpperCase();

        if (!symbol.endsWith("USDT")) {
          symbol += "USDT";
        }

        const symbols = await getSymbols();

        const exists = symbols.includes(symbol);

        return json({
          ok: true,
          exists,
          symbol,
          market: "Bybit Futures"
        }, cors);
      }


      // =========================
      // KLINE
      // =========================
      if (url.pathname === "/api/kline") {

        const symbol =
          (url.searchParams.get("symbol") || "")
          .trim()
          .toUpperCase();

        const interval =
          url.searchParams.get("interval") || "15";

        const limit =
          Math.min(
            Math.max(
              Number(url.searchParams.get("limit") || 100),
              20
            ),
            200
          );

        if (!symbol) {
          return json({
            ok: false,
            error: "symbol required"
          }, cors, 400);
        }

        const rows =
          await getKline(symbol, interval, limit);

        return json({
          ok: true,
          source: "Bybit Futures",
          symbol,
          interval,
          rows
        }, cors);
      }


      // =========================
      // ANALYZE
      // =========================
      if (url.pathname === "/api/analyze") {

        let symbol =
          (url.searchParams.get("symbol") || "")
          .trim()
          .toUpperCase();

        if (!symbol.endsWith("USDT")) {
          symbol += "USDT";
        }

        const result =
          await analyzeSymbol(symbol);

        return json(result, cors);
      }


      return json({
        ok: false,
        error: "Endpoint not found",
        path: url.pathname
      }, cors, 404);

    } catch (error) {

      return json({
        ok: false,
        error: "Worker error",
        detail: error?.message || String(error)
      }, cors, 500);
    }
  }
};


// =====================================================
// SYMBOLS
// =====================================================

async function getSymbols() {

  const response =
    await fetch(
      BYBIT +
      "/v5/market/instruments-info" +
      "?category=linear" +
      "&limit=1000"
    );

  const data = await response.json();

  if (data.retCode !== 0) {
    throw new Error(
      data.retMsg || "Bybit symbols error"
    );
  }

  return (data.result?.list || [])
    .filter(x =>
      x.quoteCoin === "USDT" &&
      x.status === "Trading" &&
      x.contractType === "LinearPerpetual"
    )
    .map(x => x.symbol)
    .sort();
}


// =====================================================
// KLINE
// =====================================================

async function getKline(
  symbol,
  interval,
  limit = 100
) {

  const response =
    await fetch(
      BYBIT +
      "/v5/market/kline" +
      "?category=linear" +
      "&symbol=" +
      encodeURIComponent(symbol) +
      "&interval=" +
      encodeURIComponent(interval) +
      "&limit=" +
      limit
    );

  const data = await response.json();

  if (data.retCode !== 0) {
    throw new Error(
      data.retMsg || "Bybit Kline error"
    );
  }

  return (data.result?.list || [])
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


// =====================================================
// SMA
// =====================================================

function sma(values, period) {

  if (values.length < period) {
    return null;
  }

  const part =
    values.slice(
      values.length - period
    );

  return (
    part.reduce(
      (a, b) => a + b,
      0
    ) / period
  );
}


// =====================================================
// ATR
// =====================================================

function atr(rows, period = 14) {

  if (rows.length < period + 1) {
    return null;
  }

  const trs = [];

  for (let i = 1; i < rows.length; i++) {

    const current = rows[i];
    const previous = rows[i - 1];

    const tr =
      Math.max(
        current.high - current.low,
        Math.abs(
          current.high - previous.close
        ),
        Math.abs(
          current.low - previous.close
        )
      );

    trs.push(tr);
  }

  const part =
    trs.slice(trs.length - period);

  return (
    part.reduce(
      (a, b) => a + b,
      0
    ) / part.length
  );
}


// =====================================================
// ANALYZE TIMEFRAME
// =====================================================

async function analyzeTF(
  symbol,
  interval
) {

  const rows =
    await getKline(
      symbol,
      interval,
      100
    );

  if (rows.length < 30) {
    return null;
  }

  const closes =
    rows.map(x => x.close);

  const price =
    closes[closes.length - 1];

  const ma7 =
    sma(closes, 7);

  const ma20 =
    sma(closes, 20);

  const current =
    rows[rows.length - 1];

  const previous =
    rows[rows.length - 2];

  const volume =
    current.volume;

  const volumeMA7 =
    sma(
      rows.map(x => x.volume),
      7
    );

  const volumeMA20 =
    sma(
      rows.map(x => x.volume),
      20
    );

  const atrValue =
    atr(rows, 14);

  const distance =
    Math.abs(price - ma20) /
    ma20;

  const nearMA20 =
    distance <= 0.003;

  let trend = "RANGE";

  if (ma7 > ma20) {
    trend = "BULLISH";
  }

  if (ma7 < ma20) {
    trend = "BEARISH";
  }

  // ----------------------------------
  // MA20 TOUCH + REJECTION
  // ----------------------------------

  const bullishTouch =
    current.low <= ma20 &&
    current.close > ma20;

  const bearishTouch =
    current.high >= ma20 &&
    current.close < ma20;

  const bullishConfirm =
    bullishTouch &&
    current.close > current.open &&
    current.close > previous.close;

  const bearishConfirm =
    bearishTouch &&
    current.close < current.open &&
    current.close < previous.close;

  // ----------------------------------
  // VOLUME
  // ----------------------------------

  const volumeConfirm =
    volumeMA20 &&
    volume > volumeMA20 * 1.15;

  // ----------------------------------
  // STRUCTURE
  // ----------------------------------

  const recentHigh =
    Math.max(
      ...rows
        .slice(-10, -1)
        .map(x => x.high)
    );

  const recentLow =
    Math.min(
      ...rows
        .slice(-10, -1)
        .map(x => x.low)
    );

  let bos = "NONE";

  if (price > recentHigh) {
    bos = "BULLISH BOS";
  }

  if (price < recentLow) {
    bos = "BEARISH BOS";
  }

  // ----------------------------------
  // FVG
  // ----------------------------------

  let fvg = "NONE";
  let fvgZone = null;

  if (rows.length >= 3) {

    const a = rows[rows.length - 3];
    const c = rows[rows.length - 1];

    if (c.low > a.high) {

      fvg = "BULLISH";

      fvgZone = {
        bottom: a.high,
        top: c.low
      };
    }

    if (c.high < a.low) {

      fvg = "BEARISH";

      fvgZone = {
        bottom: c.high,
        top: a.low
      };
    }
  }

  // ----------------------------------
  // SCORE
  // ----------------------------------

  let longScore = 0;
  let shortScore = 0;

  if (trend === "BULLISH")
    longScore += 20;

  if (trend === "BEARISH")
    shortScore += 20;

  if (bullishConfirm)
    longScore += 30;

  if (bearishConfirm)
    shortScore += 30;

  if (volumeConfirm) {

    if (bullishConfirm)
      longScore += 15;

    if (bearishConfirm)
      shortScore += 15;
  }

  if (bos === "BULLISH BOS")
    longScore += 20;

  if (bos === "BEARISH BOS")
    shortScore += 20;

  if (fvg === "BULLISH")
    longScore += 15;

  if (fvg === "BEARISH")
    shortScore += 15;


  let direction = "WAIT";

  if (
    bullishConfirm &&
    longScore >= 55
  ) {
    direction = "LONG";
  }

  if (
    bearishConfirm &&
    shortScore >= 55
  ) {
    direction = "SHORT";
  }


  // ----------------------------------
  // SL / TP
  // ----------------------------------

  let entry = price;
  let sl = null;
  let tp1 = null;
  let tp2 = null;
  let tp3 = null;
  let rr = null;

  if (
    direction === "LONG" &&
    atrValue
  ) {

    const swingLow =
      Math.min(
        ...rows
          .slice(-8)
          .map(x => x.low)
      );

    sl =
      Math.min(
        swingLow,
        ma20 - atrValue * 0.35
      );

    const risk =
      entry - sl;

    tp1 =
      entry + risk * 1;

    tp2 =
      entry + risk * 2;

    tp3 =
      entry + risk * 3;

    rr = 3;
  }


  if (
    direction === "SHORT" &&
    atrValue
  ) {

    const swingHigh =
      Math.max(
        ...rows
          .slice(-8)
          .map(x => x.high)
      );

    sl =
      Math.max(
        swingHigh,
        ma20 + atrValue * 0.35
      );

    const risk =
      sl - entry;

    tp1 =
      entry - risk * 1;

    tp2 =
      entry - risk * 2;

    tp3 =
      entry - risk * 3;

    rr = 3;
  }


  return {

    interval,

    price,

    ma7,
    ma20,

    trend,

    nearMA20,

    touch:
      bullishTouch ||
      bearishTouch,

    confirmation:
      bullishConfirm ||
      bearishConfirm,

    volume,
    volumeMA7,
    volumeMA20,
    volumeConfirm,

    structure: bos,

    fvg,
    fvgZone,

    longScore,
    shortScore,

    direction,

    entry,
    sl,
    tp1,
    tp2,
    tp3,
    rr
  };
}


// =====================================================
// FULL ANALYSIS
// =====================================================

async function analyzeSymbol(symbol) {

  const symbols =
    await getSymbols();

  if (!symbols.includes(symbol)) {

    return {
      ok: true,
      exists: false,
      symbol,
      market: "Bybit Futures"
    };
  }


  const timeframes = [
    "1",
    "3",
    "5",
    "15",
    "30",
    "60",
    "120",
    "240",
    "D"
  ];


  const results = {};

  for (const tf of timeframes) {

    try {

      results[tf] =
        await analyzeTF(
          symbol,
          tf
        );

    } catch (e) {

      results[tf] = {
        error: e.message
      };
    }
  }


  // ----------------------------------
  // SELECT BEST SIGNAL
  // ----------------------------------

  let best = null;

  for (const tf of timeframes) {

    const r = results[tf];

    if (!r || r.error) continue;

    if (
      r.direction === "LONG" ||
      r.direction === "SHORT"
    ) {

      if (
        !best ||
        Math.max(
          r.longScore,
          r.shortScore
        ) >
        Math.max(
          best.longScore,
          best.shortScore
        )
      ) {

        best = r;
      }
    }
  }


  return {

    ok: true,

    exists: true,

    source: "Bybit Futures",

    symbol,

    signal: best
      ? best.direction
      : "WAIT",

    best,

    timeframes: results
  };
}


// =====================================================
// JSON
// =====================================================

function json(
  data,
  headers,
  status = 200
) {

  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type":
          "application/json; charset=UTF-8",
        ...headers
      }
    }
  );
}
