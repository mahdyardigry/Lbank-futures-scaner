let futuresCache = [];
let futuresSavedAt = null;
let futuresCacheTime = 0;

const CACHE_MS = 5 * 60 * 1000;

const TIMEFRAMES = [
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

export default {
  async fetch(request) {

    const url = new URL(request.url);

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    try {

      // ==========================================
      // CHECK SYMBOL
      // /api/check?symbol=BTCUSDT
      // ==========================================

      if (
        url.pathname === "/api/check" &&
        request.method === "GET"
      ) {

        const symbol =
          String(
            url.searchParams.get("symbol") || ""
          )
          .trim()
          .toUpperCase();

        if (!symbol) {
          return json({
            ok: false,
            error: "symbol required"
          }, corsHeaders, 400);
        }

        const result =
          await getBybitSymbols();

        const exists =
          result.symbols.includes(symbol);

        return json({
          ok: true,
          exists,
          symbol,
          market: "Bybit Futures"
        }, corsHeaders);
      }


      // ==========================================
      // FUTURES LIST
      // /api/futures
      // ==========================================

      if (
        url.pathname === "/api/futures" &&
        request.method === "GET"
      ) {

        const now = Date.now();

        if (
          futuresCache.length === 0 ||
          now - futuresCacheTime > CACHE_MS
        ) {

          const result =
            await getBybitSymbols();

          futuresCache =
            result.symbols;

          futuresSavedAt =
            new Date().toISOString();

          futuresCacheTime =
            now;
        }

        return json({
          ok: true,
          source: "Bybit Futures",
          count: futuresCache.length,
          futures: futuresCache,
          savedAt: futuresSavedAt
        }, corsHeaders);
      }


      // ==========================================
      // KLINE
      // /api/kline?symbol=BTCUSDT&interval=15
      // ==========================================

      if (
        url.pathname === "/api/kline" &&
        request.method === "GET"
      ) {

        const symbol =
          String(
            url.searchParams.get("symbol") || ""
          )
          .trim()
          .toUpperCase();

        const interval =
          String(
            url.searchParams.get("interval") || "15"
          );

        let limit =
          Number(
            url.searchParams.get("limit") || 100
          );

        if (!Number.isFinite(limit)) {
          limit = 100;
        }

        limit =
          Math.min(
            Math.max(limit, 20),
            1000
          );

        if (!symbol) {
          return json({
            ok: false,
            error: "symbol required"
          }, corsHeaders, 400);
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
        }, corsHeaders);
      }


      // ==========================================
      // FULL SCAN
      // /api/scan?symbol=BTCUSDT
      // ==========================================

      if (
        url.pathname === "/api/scan" &&
        request.method === "GET"
      ) {

        const symbol =
          String(
            url.searchParams.get("symbol") || ""
          )
          .trim()
          .toUpperCase();

        if (!symbol) {
          return json({
            ok: false,
            error: "symbol required"
          }, corsHeaders, 400);
        }

        const result =
          await scanSymbol(symbol);

        return json({
          ok: true,
          source: "Bybit Futures",
          ...result
        }, corsHeaders);
      }


      // ==========================================
      // DEFAULT
      // ==========================================

      return json({
        ok: false,
        error: "API endpoint not found",
        path: url.pathname
      }, corsHeaders, 404);

    }

    catch (error) {

      return json({
        ok: false,
        error: "Worker error",
        detail:
          error?.message ||
          String(error)
      }, corsHeaders, 500);
    }
  }
};


// ==================================================
// BYBIT SYMBOLS
// ==================================================

async function getBybitSymbols() {

  const url =
    "https://api.bybit.com/v5/market/instruments-info" +
    "?category=linear" +
    "&limit=1000";

  const response =
    await fetch(url);

  const text =
    await response.text();

  let data;

  try {
    data = JSON.parse(text);
  }
  catch {
    throw new Error(
      "Bybit symbols returned invalid response"
    );
  }

  if (data.retCode !== 0) {

    throw new Error(
      data.retMsg ||
      "Bybit instruments error"
    );
  }

  const list =
    data.result?.list || [];

  const symbols =
    list
      .filter(item =>
        item.status === "Trading" &&
        item.quoteCoin === "USDT"
      )
      .map(item =>
        String(item.symbol).toUpperCase()
      )
      .filter(Boolean)
      .sort();

  return {
    symbols
  };
}


// ==================================================
// KLINES
// ==================================================

async function getKlines(
  symbol,
  interval,
  limit = 100
) {

  const url =
    "https://api.bybit.com/v5/market/kline" +
    "?category=linear" +
    "&symbol=" +
    encodeURIComponent(symbol) +
    "&interval=" +
    encodeURIComponent(interval) +
    "&limit=" +
    limit;

  const response =
    await fetch(url);

  const text =
    await response.text();

  let data;

  try {
    data = JSON.parse(text);
  }
  catch {
    throw new Error(
      "Bybit Kline returned invalid response"
    );
  }

  if (data.retCode !== 0) {

    throw new Error(
      data.retMsg ||
      "Bybit Kline error"
    );
  }

  const rows =
    (data.result?.list || [])
      .reverse()
      .map(item => ({
        time: Number(item[0]),
        open: Number(item[1]),
        high: Number(item[2]),
        low: Number(item[3]),
        close: Number(item[4]),
        volume: Number(item[5])
      }));

  return rows;
}


// ==================================================
// FULL SYMBOL SCAN
// ==================================================

async function scanSymbol(symbol) {

  const symbolResult =
    await getBybitSymbols();

  if (!symbolResult.symbols.includes(symbol)) {

    throw new Error(
      `${symbol} در Bybit Futures پیدا نشد`
    );
  }

  const scans = {};

  for (const tf of TIMEFRAMES) {

    const rows =
      await getKlines(
        symbol,
        tf,
        100
      );

    scans[tf] =
      analyzeTimeframe(rows);
  }


  // ===============================================
  // MAIN TIMEFRAME
  // ===============================================

  const main =
    scans["15"];


  // ===============================================
  // MULTI TIMEFRAME
  // ===============================================

  let bullish = 0;
  let bearish = 0;

  for (const tf of TIMEFRAMES) {

    if (
      scans[tf].trend === "BULLISH"
    ) {
      bullish++;
    }

    if (
      scans[tf].trend === "BEARISH"
    ) {
      bearish++;
    }
  }


  // ===============================================
  // SIGNAL SCORE
  // ===============================================

  let longScore = 0;
  let shortScore = 0;

  if (
    main.trend === "BULLISH"
  ) {
    longScore += 25;
  }

  if (
    main.trend === "BEARISH"
  ) {
    shortScore += 25;
  }

  if (
    main.pullback
  ) {

    if (
      main.trend === "BULLISH"
    ) {
      longScore += 20;
    }

    if (
      main.trend === "BEARISH"
    ) {
      shortScore += 20;
    }
  }

  if (
    main.structure === "BULLISH"
  ) {
    longScore += 15;
  }

  if (
    main.structure === "BEARISH"
  ) {
    shortScore += 15;
  }

  if (
    main.fvg === "BULLISH"
  ) {
    longScore += 10;
  }

  if (
    main.fvg === "BEARISH"
  ) {
    shortScore += 10;
  }

  if (
    bullish >= 6
  ) {
    longScore += 20;
  }

  if (
    bearish >= 6
  ) {
    shortScore += 20;
  }


  longScore =
    Math.min(longScore, 100);

  shortScore =
    Math.min(shortScore, 100);


  let signal =
    "WAIT";

  let score =
    Math.max(
      longScore,
      shortScore
    );

  if (
    longScore > shortScore &&
    longScore >= 60
  ) {

    signal = "LONG";

  }
  else if (
    shortScore > longScore &&
    shortScore >= 60
  ) {

    signal = "SHORT";

  }


  return {

    symbol,

    mainTimeframe: "15",

    price:
      main.price,

    trend:
      main.trend,

    range:
      main.range,

    pullback:
      main.pullback,

    structure:
      main.structure,

    bos:
      main.bos,

    choch:
      main.choch,

    fvg:
      main.fvg,

    fvgZone:
      main.fvgZone,

    volume:
      main.volume,

    volumeMA7:
      main.volumeMA7,

    volumeMA20:
      main.volumeMA20,

    volumeSpike:
      main.volumeSpike,

    bullishTimeframes:
      bullish,

    bearishTimeframes:
      bearish,

    timeframeCount:
      TIMEFRAMES.length,

    scores: {
      long: longScore,
      short: shortScore,
      final: score
    },

    signal,

    timeframes: scans,

    footprint: {
      available: false,
      message:
        "Footprint/Delta واقعی در مرحله بعد اضافه می‌شود."
    }
  };
}


// ==================================================
// TIMEFRAME ANALYSIS
// ==================================================

function analyzeTimeframe(rows) {

  if (!rows || rows.length < 20) {

    throw new Error(
      "داده کافی برای تحلیل تایم‌فریم وجود ندارد"
    );
  }

  const closes =
    rows.map(x => x.close);

  const highs =
    rows.map(x => x.high);

  const lows =
    rows.map(x => x.low);

  const volumes =
    rows.map(x => x.volume);

  const price =
    closes[closes.length - 1];

  const ma7 =
    sma(closes, 7);

  const ma20 =
    sma(closes, 20);

  const volumeMA7 =
    sma(volumes, 7);

  const volumeMA20 =
    sma(volumes, 20);


  // ===============================================
  // TREND
  // ===============================================

  let trend =
    "RANGE";

  if (ma7 > ma20) {
    trend = "BULLISH";
  }
  else if (ma7 < ma20) {
    trend = "BEARISH";
  }


  // ===============================================
  // RANGE
  // ===============================================

  const distance =
    Math.abs(ma7 - ma20) /
    ma20;

  const range =
    distance < 0.0015;


  // ===============================================
  // PULLBACK
  // ===============================================

  const previous =
    closes[closes.length - 2];

  let pullback = false;

  if (
    trend === "BULLISH" &&
    previous <= ma7 &&
    price > ma7
  ) {
    pullback = true;
  }

  if (
    trend === "BEARISH" &&
    previous >= ma7 &&
    price < ma7
  ) {
    pullback = true;
  }


  // ===============================================
  // VOLUME
  // ===============================================

  const currentVolume =
    volumes[volumes.length - 1];

  const volumeSpike =
    currentVolume >
    volumeMA20 * 1.5;


  // ===============================================
  // MARKET STRUCTURE
  // ===============================================

  const structure =
    detectStructure(
      highs,
      lows
    );


  // ===============================================
  // BOS / CHOCH
  // ===============================================

  const bos =
    detectBOS(
      highs,
      lows,
      price
    );

  const choch =
    detectCHoCH(
      highs,
      lows,
      trend
    );


  // ===============================================
  // FVG
  // ===============================================

  const fvg =
    detectFVG(rows);


  return {

    price,

    ma7,

    ma20,

    trend,

    range,

    pullback,

    structure,

    bos,

    choch,

    fvg:
      fvg.type,

    fvgZone:
      fvg.zone,

    volume:
      currentVolume,

    volumeMA7,

    volumeMA20,

    volumeSpike
  };
}


// ==================================================
// SMA
// ==================================================

function sma(data, period) {

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
    ) / period
  );
}


// ==================================================
// STRUCTURE
// ==================================================

function detectStructure(
  highs,
  lows
) {

  const n =
    highs.length;

  const h1 =
    highs[n - 1];

  const h2 =
    highs[n - 6];

  const l1 =
    lows[n - 1];

  const l2 =
    lows[n - 6];


  if (
    h1 > h2 &&
    l1 > l2
  ) {
    return "BULLISH";
  }

  if (
    h1 < h2 &&
    l1 < l2
  ) {
    return "BEARISH";
  }

  return "RANGE";
}


// ==================================================
// BOS
// ==================================================

function detectBOS(
  highs,
  lows,
  price
) {

  const n =
    highs.length;

  const previousHigh =
    Math.max(
      ...highs.slice(
        n - 11,
        n - 1
      )
    );

  const previousLow =
    Math.min(
      ...lows.slice(
        n - 11,
        n - 1
      )
    );

  if (
    price > previousHigh
  ) {
    return "BULLISH BOS";
  }

  if (
    price < previousLow
  ) {
    return "BEARISH BOS";
  }

  return "NONE";
}


// ==================================================
// CHOCH
// ==================================================

function detectCHoCH(
  highs,
  lows,
  trend
) {

  const n =
    highs.length;

  const recentHigh =
    highs[n - 1];

  const oldHigh =
    highs[n - 8];

  const recentLow =
    lows[n - 1];

  const oldLow =
    lows[n - 8];


  if (
    trend === "BEARISH" &&
    recentHigh > oldHigh
  ) {
    return "BULLISH CHoCH";
  }

  if (
    trend === "BULLISH" &&
    recentLow < oldLow
  ) {
    return "BEARISH CHoCH";
  }

  return "NONE";
}


// ==================================================
// FVG
// ==================================================

function detectFVG(rows) {

  if (
    rows.length < 3
  ) {

    return {
      type: "NONE",
      zone: null
    };
  }

  const a =
    rows[rows.length - 3];

  const b =
    rows[rows.length - 2];

  const c =
    rows[rows.length - 1];


  // Bullish FVG
  if (
    c.low > a.high
  ) {

    return {

      type: "BULLISH",

      zone: {
        bottom: a.high,
        top: c.low
      }
    };
  }


  // Bearish FVG
  if (
    c.high < a.low
  ) {

    return {

      type: "BEARISH",

      zone: {
        bottom: c.high,
        top: a.low
      }
    };
  }


  return {

    type: "NONE",

    zone: null
  };
}


// ==================================================
// JSON
// ==================================================

function json(
  data,
  corsHeaders,
  status = 200
) {

  return new Response(
    JSON.stringify(data),
    {
      status,

      headers: {
        "Content-Type":
          "application/json; charset=UTF-8",

        ...corsHeaders
      }
    }
  );
}
