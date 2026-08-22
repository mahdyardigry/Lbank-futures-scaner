const BYBIT_BASE = "https://api.bybit.com";

const TIMEFRAMES = [
  { key: "1", label: "1 دقیقه (1m)" },
  { key: "3", label: "3 دقیقه (3m)" },
  { key: "5", label: "5 دقیقه (5m)" }
];

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

        const symbol = normalizeSymbol(
          url.searchParams.get("symbol")
        );

        const interval =
          url.searchParams.get("interval") || "15";

        let limit = Number(
          url.searchParams.get("limit") || 100
        );

        limit = Math.max(
          30,
          Math.min(limit, 200)
        );

        if (!symbol) {
          return json({
            ok: false,
            error: "symbol required"
          }, 400);
        }

        const data = await bybit(
          "/v5/market/kline" +
          "?category=linear" +
          "&symbol=" + encodeURIComponent(symbol) +
          "&interval=" + encodeURIComponent(interval) +
          "&limit=" + limit
        );

        const rows =
          (data.result?.list || [])
            .reverse()
            .map(x => ({
              time: Number(x[0]),
              open: Number(x[1]),
              high: Number(x[2]),
              low: Number(x[3]),
              close: Number(x[4]),
              volume: Number(x[5])
            }));

        return json({
          ok: true,
          symbol,
          interval,
          rows
        });
      }


      // =========================
      // FOOTPRINT
      // =========================
      if (url.pathname === "/api/footprint") {

        const symbol = normalizeSymbol(
          url.searchParams.get("symbol")
        );

        if (!symbol) {
          return json({
            ok: false,
            error: "symbol required"
          }, 400);
        }

        const footprint =
          await getFootprint(symbol);

        return json({
          ok: true,
          symbol,
          footprint
        });
      }


      // =========================
      // MANUAL ANALYZE
      // =========================
      if (url.pathname === "/api/analyze") {

        const symbol = normalizeSymbol(
          url.searchParams.get("symbol")
        );

        if (!symbol) {
          return json({
            ok: false,
            error: "symbol required"
          }, 400);
        }

        const result =
          await analyzeSymbol(symbol, true);

        return json({
          ok: true,
          ...result
        });
      }


      // =========================
      // FAST MARKET SCAN
      // =========================
      if (url.pathname === "/api/scan") {

        const results =
          await scanMarket();

        return json({
          ok: true,
          source: "Bybit Futures",
          scanned: results.scanned,
          found: results.results.length,
          results: results.results
        });
      }


      return json({
        ok: false,
        error: "API endpoint not found"
      }, 404);

    } catch (error) {

      return json({
        ok: false,
        error: "Worker error",
        detail: error?.message || String(error)
      }, 500);
    }
  }
};


// =================================================
// FAST MARKET SCAN
// =================================================

async function scanMarket() {

  // دریافت تیکرها برای اینکه به جای
  // تحلیل 725 ارز، ابتدا ارزهای فعال‌تر را جدا کنیم.

  const tickerData = await bybit(
    "/v5/market/tickers?category=linear"
  );

  const tickers =
    tickerData.result?.list || [];

  const candidates =
    tickers
      .filter(x =>
        x.symbol &&
        x.symbol.endsWith("USDT") &&
        !x.symbol.includes("-") &&
        Number(x.turnover24h || 0) > 0
      )
      .sort(
        (a,b) =>
          Number(b.turnover24h || 0) -
          Number(a.turnover24h || 0)
      )
      .slice(0, 80);

  const results = [];

  const batchSize = 10;

  for (
    let i = 0;
    i < candidates.length;
    i += batchSize
  ) {

    const batch =
      candidates.slice(
        i,
        i + batchSize
      );

    const batchResults =
      await Promise.all(
        batch.map(async ticker => {

          try {

            return await analyzeSymbol(
              ticker.symbol,
              false
            );

          } catch(e) {

            return null;

          }

        })
      );

    batchResults.forEach(r => {

      if (
        r &&
        r.direction !== "WAIT" &&
        r.score >= 45
      ) {
        results.push(r);
      }

    });
  }


  results.sort(
    (a,b) =>
      b.score - a.score
  );


  // Footprint واقعی فقط برای
  // کاندیدهای برتر گرفته می‌شود
  // تا اسکن بسیار سریع‌تر باشد.

  const topCandidates =
    results.slice(0, 20);

  const enriched =
    await Promise.all(
      topCandidates.map(async r => {

        try {

          r.footprint =
            await getFootprint(
              r.symbol
            );

        } catch(e) {

          r.footprint = {
            error: e.message
          };

        }

        return r;

      })
    );


  enriched.sort(
    (a,b) =>
      b.score - a.score
  );


  return {
    scanned: candidates.length,
    results: enriched.slice(0,10)
  };
}


// =================================================
// ANALYZE SYMBOL
// =================================================

async function analyzeSymbol(
  symbol,
  withFootprint = false
) {

  const timeframes = {};

  /*
  سه تایم‌فریم همزمان دریافت می‌شوند
  */

  const data =
    await Promise.all(
      TIMEFRAMES.map(async tf => {

        try {

          const rows =
            await getKlines(
              symbol,
              tf.key,
              100
            );

          return {
            key: tf.key,
            data: analyzeTimeframe(rows)
          };

        } catch(e) {

          return {
            key: tf.key,
            data: {
              error: e.message
            }
          };

        }

      })
    );


  data.forEach(x => {
    timeframes[x.key] = x.data;
  });


  const analyses =
    TIMEFRAMES
      .map(tf => timeframes[tf.key])
      .filter(x => x && !x.error);


  if (!analyses.length) {
    throw new Error("No market data");
  }


  let bullish = 0;
  let bearish = 0;

  for (const x of analyses) {

    if (x.trend === "BULLISH") bullish++;
    if (x.trend === "BEARISH") bearish++;

  }


  let longScore = 0;
  let shortScore = 0;


  for (const tf of TIMEFRAMES) {

    const x =
      timeframes[tf.key];

    if (!x || x.error) continue;


    const weight =
      tf.key === "5"
      ? 4
      : tf.key === "3"
      ? 3
      : 2;


    if (x.trend === "BULLISH")
      longScore += weight;

    if (x.trend === "BEARISH")
      shortScore += weight;


    if (x.maSlope === "UP")
      longScore += 2;

    if (x.maSlope === "DOWN")
      shortScore += 2;


    if (x.structure === "BULLISH")
      longScore += 3;

    if (x.structure === "BEARISH")
      shortScore += 3;


    if (x.fvg.type === "BULLISH")
      longScore += 2;

    if (x.fvg.type === "BEARISH")
      shortScore += 2;


    if (x.volume.spike) {

      if (x.trend === "BULLISH")
        longScore += 2;

      if (x.trend === "BEARISH")
        shortScore += 2;

    }


    if (x.touchMA20) {

      if (x.trend === "BULLISH")
        longScore += 2;

      if (x.trend === "BEARISH")
        shortScore += 2;

    }

  }


  /*
  تأیید سه تایم‌فریم
  */

  const bullishAll =
    bullish === 3;

  const bearishAll =
    bearish === 3;


  if (bullishAll)
    longScore += 10;

  if (bearishAll)
    shortScore += 10;


  let direction = "WAIT";


  if (
    longScore > shortScore &&
    longScore >= 12
  ) {
    direction = "LONG";
  }


  if (
    shortScore > longScore &&
    shortScore >= 12
  ) {
    direction = "SHORT";
  }


  const main =
    timeframes["5"] ||
    timeframes["3"] ||
    timeframes["1"];


  const score =
    calculateFinalScore(
      main,
      direction,
      bullish,
      bearish,
      longScore,
      shortScore
    );


  let targets = null;


  if (direction !== "WAIT") {

    targets =
      calculateTargets(
        main,
        direction
      );

  }


  let footprint = null;


  if (withFootprint) {

    try {

      footprint =
        await getFootprint(symbol);

    } catch(e) {

      footprint = {
        error: e.message
      };

    }

  }


  return {

    symbol,

    direction,

    score,

    mainTimeframe: "5",

    price: main.price,

    entry: targets?.entry || null,
    sl: targets?.sl || null,
    tp1: targets?.tp1 || null,
    tp2: targets?.tp2 || null,
    tp3: targets?.tp3 || null,

    bullishTimeframes: bullish,
    bearishTimeframes: bearish,

    confirmations:
      countConfirmations(
        main,
        direction,
        bullish,
        bearish
      ),

    timeframes,

    footprint

  };
}


// =================================================
// TIMEFRAME ANALYSIS
// =================================================

function analyzeTimeframe(rows) {

  if (!rows || rows.length < 30)
    throw new Error("Not enough candles");


  const closes =
    rows.map(x => x.close);

  const volumes =
    rows.map(x => x.volume);


  const price =
    closes[closes.length - 1];


  const ma7 =
    sma(closes, 7);

  const ma20 =
    sma(closes, 20);


  const previousMA20 =
    sma(
      closes.slice(0,-1),
      20
    );


  let maSlope = "FLAT";


  if (ma20 > previousMA20)
    maSlope = "UP";

  if (ma20 < previousMA20)
    maSlope = "DOWN";


  let trend = "RANGE";


  if (ma7 > ma20)
    trend = "BULLISH";

  if (ma7 < ma20)
    trend = "BEARISH";


  const current =
    rows[rows.length - 1];

  const previous =
    rows[rows.length - 2];


  const touchMA20 =
    current.low <= ma20 &&
    current.high >= ma20;


  const reaction =
    current.close > current.open
    ? "BULLISH"
    : current.close < current.open
    ? "BEARISH"
    : "NEUTRAL";


  const structure =
    detectStructure(rows);


  const fvg =
    detectFVG(rows);


  const volumeMA7 =
    sma(volumes, 7);

  const volumeMA20 =
    sma(volumes, 20);


  const volumeSpike =
    current.volume >
    volumeMA20 * 1.5;


  return {

    price,

    ma7,

    ma20,

    maSlope,

    trend,

    touchMA20,

    reaction,

    structure,

    fvg,

    volume: {
      current: current.volume,
      ma7: volumeMA7,
      ma20: volumeMA20,
      spike: volumeSpike
    },

    previousClose:
      previous.close

  };
}


// =================================================
// STRUCTURE
// =================================================

function detectStructure(rows) {

  if (rows.length < 12)
    return "NONE";


  const n = rows.length;


  const h1 =
    rows[n-7].high;

  const h2 =
    rows[n-4].high;

  const h3 =
    rows[n-1].high;


  const l1 =
    rows[n-7].low;

  const l2 =
    rows[n-4].low;

  const l3 =
    rows[n-1].low;


  if (
    h3 > h2 &&
    h2 > h1 &&
    l3 > l2
  ) {
    return "BULLISH";
  }


  if (
    h3 < h2 &&
    h2 < h1 &&
    l3 < l2
  ) {
    return "BEARISH";
  }


  return "NONE";
}


// =================================================
// FVG
// =================================================

function detectFVG(rows) {

  if (rows.length < 3) {

    return {
      type: "NONE",
      bottom: null,
      top: null,
      status: "NONE"
    };

  }


  const a =
    rows[rows.length - 3];

  const c =
    rows[rows.length - 1];


  if (c.low > a.high) {

    return {

      type: "BULLISH",

      bottom: a.high,

      top: c.low,

      status: "ACTIVE"

    };

  }


  if (c.high < a.low) {

    return {

      type: "BEARISH",

      bottom: c.high,

      top: a.low,

      status: "ACTIVE"

    };

  }


  return {

    type: "NONE",

    bottom: null,

    top: null,

    status: "NONE"

  };
}


// =================================================
// REAL BYBIT FOOTPRINT
// =================================================

async function getFootprint(symbol) {

  const data =
    await bybit(
      "/v5/market/recent-trade" +
      "?category=linear" +
      "&symbol=" +
      encodeURIComponent(symbol) +
      "&limit=500"
    );


  const trades =
    data.result?.list || [];


  if (!trades.length) {

    return {

      trades: 0,

      buyVolume: 0,

      sellVolume: 0,

      delta: 0,

      deltaPercent: 0,

      buyRatio: 0,

      sellRatio: 0,

      largeTrade: false,

      largeTradeNotional: 0

    };

  }


  let buyVolume = 0;
  let sellVolume = 0;

  let totalNotional = 0;


  const notionals = [];


  for (const t of trades) {

    const price =
      Number(t.price || 0);

    const size =
      Number(t.size || 0);

    const notional =
      price * size;


    notionals.push(notional);

    totalNotional += notional;


    if (String(t.side).toLowerCase() === "buy") {

      buyVolume += size;

    } else {

      sellVolume += size;

    }

  }


  const totalVolume =
    buyVolume + sellVolume;


  const delta =
    buyVolume - sellVolume;


  const deltaPercent =
    totalVolume > 0
    ? (delta / totalVolume) * 100
    : 0;


  const buyRatio =
    totalVolume > 0
    ? (buyVolume / totalVolume) * 100
    : 0;


  const sellRatio =
    totalVolume > 0
    ? (sellVolume / totalVolume) * 100
    : 0;


  const averageNotional =
    totalNotional / trades.length;


  const largeThreshold =
    averageNotional * 5;


  let largestTrade = 0;


  for (const n of notionals) {

    if (n > largestTrade)
      largestTrade = n;

  }


  return {

    trades: trades.length,

    buyVolume,

    sellVolume,

    delta,

    deltaPercent,

    buyRatio,

    sellRatio,

    largeTrade:
      largestTrade >= largeThreshold,

    largeTradeNotional:
      largestTrade,

    averageTradeNotional:
      averageNotional

  };
}


// =================================================
// SCORE
// =================================================

function calculateFinalScore(
  x,
  direction,
  bullish,
  bearish,
  longScore,
  shortScore
) {

  if (!x || direction === "WAIT")
    return 0;


  let score = 0;


  const correctSlope =
    direction === "LONG"
    ? x.maSlope === "UP"
    : x.maSlope === "DOWN";


  if (correctSlope)
    score += 20;


  if (x.touchMA20)
    score += 10;


  const correctStructure =
    direction === "LONG"
    ? x.structure === "BULLISH"
    : x.structure === "BEARISH";


  if (correctStructure)
    score += 20;


  const correctFVG =
    direction === "LONG"
    ? x.fvg.type === "BULLISH"
    : x.fvg.type === "BEARISH";


  if (correctFVG)
    score += 15;


  if (x.volume.spike)
    score += 10;


  if (
    direction === "LONG" &&
    bullish === 3
  )
    score += 25;


  if (
    direction === "SHORT" &&
    bearish === 3
  )
    score += 25;


  return Math.min(
    100,
    Math.round(score)
  );
}


// =================================================
// CONFIRMATIONS
// =================================================

function countConfirmations(
  x,
  direction,
  bullish,
  bearish
) {

  let c = 0;


  if (
    direction === "LONG" &&
    x.maSlope === "UP"
  )
    c++;


  if (
    direction === "SHORT" &&
    x.maSlope === "DOWN"
  )
    c++;


  if (x.touchMA20)
    c++;


  if (
    direction === "LONG" &&
    x.structure === "BULLISH"
  )
    c++;


  if (
    direction === "SHORT" &&
    x.structure === "BEARISH"
  )
    c++;


  if (
    direction === "LONG" &&
    x.fvg.type === "BULLISH"
  )
    c++;


  if (
    direction === "SHORT" &&
    x.fvg.type === "BEARISH"
  )
    c++;


  if (x.volume.spike)
    c++;


  if (
    bullish === 3 ||
    bearish === 3
  )
    c++;


  return c;
}


// =================================================
// TARGETS
// =================================================

function calculateTargets(
  x,
  direction
) {

  const price =
    x.price;


  let risk;


  if (direction === "LONG") {

    const sl =
      price * 0.985;

    risk =
      price - sl;


    return {

      entry: price,

      sl,

      tp1: price + risk,

      tp2: price + risk * 2,

      tp3: price + risk * 3,

      rr: "1:3"

    };

  }


  const sl =
    price * 1.015;

  risk =
    sl - price;


  return {

    entry: price,

    sl,

    tp1: price - risk,

    tp2: price - risk * 2,

    tp3: price - risk * 3,

    rr: "1:3"

  };
}


// =================================================
// KLINES
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


// =================================================
// BYBIT REQUEST
// =================================================

async function bybit(path) {

  const response =
    await fetch(
      BYBIT_BASE + path,
      {
        headers: {
          "Accept": "application/json"
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


// =================================================
// HELPERS
// =================================================

function normalizeSymbol(symbol) {

  if (!symbol)
    return "";

  return String(symbol)
    .trim()
    .toUpperCase()
    .replace("/", "")
    .replace("-", "");
}


function sma(data, period) {

  if (
    !data ||
    data.length < period
  )
    return null;


  const part =
    data.slice(
      data.length - period
    );


  return part.reduce(
    (a,b) => a + Number(b),
    0
  ) / period;
}


function json(data, status = 200) {

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
