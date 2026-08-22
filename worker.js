const BYBIT_BASE = "https://api.bybit.com";

const TIMEFRAMES = [
  { key: "1", label: "1m", interval: "1" },
  { key: "3", label: "3m", interval: "3" },
  { key: "5", label: "5m", interval: "5" }
];

const INITIAL_LIMIT = 200;
const DEEP_LIMIT = 20;
const RESULT_LIMIT = 10;

const MIN_SCORE = 55;

// --------------------------------------------------
// عمومی
// --------------------------------------------------

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "cache-control": "no-store"
    }
  });
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function round(v, digits = 8) {
  if (!Number.isFinite(Number(v))) return null;
  return Number(Number(v).toFixed(digits));
}

// --------------------------------------------------
// Bybit request
// --------------------------------------------------

async function bybit(path, params = {}) {

  const url = new URL(BYBIT_BASE + path);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "accept": "application/json"
    }
  });

  if (!res.ok) {
    throw new Error(`Bybit HTTP ${res.status}`);
  }

  const data = await res.json();

  if (data.retCode !== 0) {
    throw new Error(
      data.retMsg || `Bybit error ${data.retCode}`
    );
  }

  return data;
}

// --------------------------------------------------
// Market list
// --------------------------------------------------

async function getMarkets() {

  const data = await bybit(
    "/v5/market/tickers",
    {
      category: "linear"
    }
  );

  const list =
    data?.result?.list || [];

  return list
    .filter(x => {
      const symbol =
        String(x.symbol || "").toUpperCase();

      return (
        symbol.endsWith("USDT") &&
        num(x.lastPrice) > 0 &&
        num(x.turnover24h) > 0
      );
    })
    .map(x => {

      const change =
        num(x.price24hPcnt) * 100;

      const turnover =
        num(x.turnover24h);

      const openInterest =
        num(x.openInterest);

      const funding =
        num(x.fundingRate);

      return {
        symbol: x.symbol,
        price: num(x.lastPrice),
        change24h: change,
        turnover24h: turnover,
        openInterest,
        fundingRate: funding
      };
    });
}

// --------------------------------------------------
// اولویت‌بندی 200 ارز
// --------------------------------------------------

function rankMarkets(markets) {

  return markets
    .map(m => {

      const changeScore =
        clamp(Math.abs(m.change24h) * 5, 0, 30);

      const volumeScore =
        clamp(
          Math.log10(
            Math.max(m.turnover24h, 1)
          ) * 2,
          0,
          25
        );

      const oiScore =
        clamp(
          Math.log10(
            Math.max(m.openInterest, 1)
          ) * 1.5,
          0,
          15
        );

      const movementBonus =
        m.change24h > 2
          ? 10
          : m.change24h < -2
          ? 8
          : 0;

      const score =
        changeScore +
        volumeScore +
        oiScore +
        movementBonus;

      return {
        ...m,
        priorityScore: score
      };
    })
    .sort(
      (a, b) =>
        b.priorityScore -
        a.priorityScore
    )
    .slice(0, INITIAL_LIMIT);
}

// --------------------------------------------------
// Kline
// --------------------------------------------------

async function getKlines(symbol, interval, limit = 100) {

  const data = await bybit(
    "/v5/market/kline",
    {
      category: "linear",
      symbol,
      interval,
      limit
    }
  );

  const raw =
    data?.result?.list || [];

  return raw
    .reverse()
    .map(k => ({
      time: num(k[0]),
      open: num(k[1]),
      high: num(k[2]),
      low: num(k[3]),
      close: num(k[4]),
      volume: num(k[5]),
      turnover: num(k[6])
    }));
}

// --------------------------------------------------
// MA
// --------------------------------------------------

function sma(values, period) {

  if (values.length < period) {
    return avg(values);
  }

  return avg(
    values.slice(-period)
  );
}

function ema(values, period) {

  if (!values.length) return 0;

  const k =
    2 / (period + 1);

  let result =
    values[0];

  for (let i = 1; i < values.length; i++) {

    result =
      values[i] * k +
      result * (1 - k);
  }

  return result;
}

// --------------------------------------------------
// Timeframe analysis
// --------------------------------------------------

function analyzeTF(candles) {

  if (!candles || candles.length < 25) {
    return {
      error: "کندل کافی دریافت نشد."
    };
  }

  const closes =
    candles.map(x => x.close);

  const volumes =
    candles.map(x => x.volume);

  const price =
    closes.at(-1);

  const ma7 =
    sma(closes, 7);

  const ma20 =
    sma(closes, 20);

  const previousMa20 =
    sma(
      closes.slice(0, -1),
      20
    );

  const maSlope =
    ma20 > previousMa20 * 1.00005
      ? "UP"
      : ma20 < previousMa20 * 0.99995
      ? "DOWN"
      : "FLAT";

  const trend =
    price > ma20 && ma7 > ma20
      ? "BULLISH"
      : price < ma20 && ma7 < ma20
      ? "BEARISH"
      : "RANGE";

  const distance =
    Math.abs(price - ma20) /
    Math.max(ma20, 1);

  const touchMA20 =
    distance <= 0.0025;

  // ------------------------------
  // Volume
  // ------------------------------

  const volumeMA7 =
    sma(volumes, 7);

  const volumeMA20 =
    sma(volumes, 20);

  const currentVolume =
    volumes.at(-1);

  const volumeSpike =
    currentVolume >
    volumeMA20 * 1.5 ||
    currentVolume >
    volumeMA7 * 1.8;

  // ------------------------------
  // Market structure
  // ------------------------------

  const recent =
    candles.slice(-12);

  const previous =
    candles.slice(-24, -12);

  const recentHigh =
    Math.max(
      ...recent.map(x => x.high)
    );

  const recentLow =
    Math.min(
      ...recent.map(x => x.low)
    );

  const previousHigh =
    Math.max(
      ...previous.map(x => x.high)
    );

  const previousLow =
    Math.min(
      ...previous.map(x => x.low)
    );

  let structure = "NONE";

  if (recentHigh > previousHigh &&
      recentLow > previousLow) {

    structure = "BULLISH";

  } else if (
    recentHigh < previousHigh &&
    recentLow < previousLow
  ) {

    structure = "BEARISH";
  }

  // ------------------------------
  // FVG
  // ------------------------------

  let fvgType = "NONE";

  if (candles.length >= 4) {

    const a =
      candles.at(-3);

    const c =
      candles.at(-1);

    if (c.low > a.high) {
      fvgType = "BULLISH";
    }

    if (c.high < a.low) {
      fvgType = "BEARISH";
    }
  }

  return {
    trend,
    maSlope,
    ma7,
    ma20,
    touchMA20,
    structure,

    fvg: {
      type: fvgType
    },

    volume: {
      current: currentVolume,
      ma7: volumeMA7,
      ma20: volumeMA20,
      spike: volumeSpike
    }
  };
}

// --------------------------------------------------
// Footprint
// --------------------------------------------------

async function getFootprint(symbol) {

  try {

    const data =
      await bybit(
        "/v5/market/recent-trade",
        {
          category: "linear",
          symbol,
          limit: 500
        }
      );

    const trades =
      data?.result?.list || [];

    if (!trades.length) {
      return {
        error: "معامله‌ای دریافت نشد."
      };
    }

    let buyVolume = 0;
    let sellVolume = 0;

    let largest = 0;

    for (const t of trades) {

      const size =
        num(t.size);

      const side =
        String(t.side || "")
          .toLowerCase();

      const price =
        num(t.price);

      const notional =
        size * price;

      if (notional > largest) {
        largest = notional;
      }

      if (side === "buy") {
        buyVolume += size;
      } else if (side === "sell") {
        sellVolume += size;
      }
    }

    const total =
      buyVolume + sellVolume;

    const delta =
      buyVolume - sellVolume;

    const deltaPercent =
      total > 0
        ? (delta / total) * 100
        : 0;

    const buyRatio =
      total > 0
        ? (buyVolume / total) * 100
        : 50;

    const sellRatio =
      total > 0
        ? (sellVolume / total) * 100
        : 50;

    const averageTrade =
      total / trades.length;

    const largeTrade =
      largest >
      averageTrade * 100;

    return {
      buyVolume,
      sellVolume,
      delta,
      deltaPercent,
      buyRatio,
      sellRatio,
      trades: trades.length,
      largeTrade,
      largeTradeNotional: largest
    };

  } catch (e) {

    return {
      error: e.message
    };
  }
}

// --------------------------------------------------
// Orderbook / walls
// --------------------------------------------------

async function getWalls(symbol, price) {

  try {

    const data =
      await bybit(
        "/v5/market/orderbook",
        {
          category: "linear",
          symbol,
          limit: 50
        }
      );

    const bids =
      data?.result?.b || [];

    const asks =
      data?.result?.a || [];

    let nearestBuy = null;
    let nearestSell = null;

    let maxBid = 0;
    let maxAsk = 0;

    for (const b of bids) {

      const p = num(b[0]);
      const q = num(b[1]);

      const notional =
        p * q;

      if (
        p < price &&
        notional > maxBid
      ) {
        maxBid = notional;
        nearestBuy = p;
      }
    }

    for (const a of asks) {

      const p = num(a[0]);
      const q = num(a[1]);

      const notional =
        p * q;

      if (
        p > price &&
        notional > maxAsk
      ) {
        maxAsk = notional;
        nearestSell = p;
      }
    }

    const buyDistance =
      nearestBuy
        ? Math.abs(price - nearestBuy) /
          price
        : Infinity;

    const sellDistance =
      nearestSell
        ? Math.abs(nearestSell - price) /
          price
        : Infinity;

    return {

      buyWall:
        nearestBuy !== null &&
        buyDistance < 0.01,

      sellWall:
        nearestSell !== null &&
        sellDistance < 0.01,

      buyWallPrice:
        nearestBuy,

      sellWallPrice:
        nearestSell,

      buyWallSize:
        maxBid,

      sellWallSize:
        maxAsk
    };

  } catch (e) {

    return {
      buyWall: false,
      sellWall: false
    };
  }
}

// --------------------------------------------------
// Score
// --------------------------------------------------

function calculateSignal(
  symbol,
  price,
  tfs,
  footprint,
  walls
) {

  let longScore = 0;
  let shortScore = 0;

  let bullish = 0;
  let bearish = 0;

  let confirmations = 0;

  for (const tf of tfs) {

    if (!tf || tf.error) continue;

    if (tf.trend === "BULLISH") {
      bullish++;
      longScore += 8;
    }

    if (tf.trend === "BEARISH") {
      bearish++;
      shortScore += 8;
    }

    if (tf.maSlope === "UP") {
      longScore += 5;
    }

    if (tf.maSlope === "DOWN") {
      shortScore += 5;
    }

    if (tf.structure === "BULLISH") {
      longScore += 8;
      confirmations++;
    }

    if (tf.structure === "BEARISH") {
      shortScore += 8;
      confirmations++;
    }

    if (tf.fvg.type === "BULLISH") {
      longScore += 5;
    }

    if (tf.fvg.type === "BEARISH") {
      shortScore += 5;
    }

    if (tf.touchMA20) {

      if (tf.trend === "BULLISH") {
        longScore += 4;
      }

      if (tf.trend === "BEARISH") {
        shortScore += 4;
      }
    }

    if (tf.volume.spike) {

      if (tf.trend === "BULLISH") {
        longScore += 5;
      }

      if (tf.trend === "BEARISH") {
        shortScore += 5;
      }
    }
  }

  // ------------------------------------------------
  // Footprint
  // ------------------------------------------------

  let footprintLong = false;
  let footprintShort = false;

  if (
    footprint &&
    !footprint.error
  ) {

    const dp =
      num(footprint.deltaPercent);

    if (dp >= 8) {
      longScore += 12;
      footprintLong = true;
    }

    if (dp <= -8) {
      shortScore += 12;
      footprintShort = true;
    }

    // فشار بسیار شدید
    if (dp >= 25) {
      longScore += 5;
    }

    if (dp <= -25) {
      shortScore += 5;
    }
  }

  // ------------------------------------------------
  // Walls
  // ------------------------------------------------

  const reasons = [];

  if (walls?.sellWall) {
    reasons.push(
      "دیوار فروش نزدیک قیمت وجود دارد"
    );
  }

  if (walls?.buyWall) {
    reasons.push(
      "دیوار خرید نزدیک قیمت وجود دارد"
    );
  }

  // ------------------------------------------------
  // انتخاب جهت
  // ------------------------------------------------

  let direction = "WAIT";

  let rawScore =
    Math.max(
      longScore,
      shortScore
    );

  if (longScore > shortScore) {

    direction = "LONG";

  } else if (
    shortScore > longScore
  ) {

    direction = "SHORT";
  }

  // ------------------------------------------------
  // Footprint مخالف جهت
  // ------------------------------------------------

  if (
    direction === "LONG" &&
    footprintShort
  ) {

    reasons.push(
      "Footprint مخالف LONG است"
    );

    rawScore -= 15;
  }

  if (
    direction === "SHORT" &&
    footprintLong
  ) {

    reasons.push(
      "Footprint مخالف SHORT است"
    );

    rawScore -= 15;
  }

  // ------------------------------------------------
  // دیوار مخالف
  // ------------------------------------------------

  if (
    direction === "LONG" &&
    walls?.sellWall
  ) {

    rawScore -= 5;
  }

  if (
    direction === "SHORT" &&
    walls?.buyWall
  ) {

    rawScore -= 5;
  }

  rawScore =
    clamp(rawScore, 0, 100);

  // ------------------------------------------------
  // حداقل شرایط
  // ------------------------------------------------

  const directionalTF =
    direction === "LONG"
      ? bullish
      : bearish;

  const footprintAgainst =
    direction === "LONG"
      ? footprintShort
      : footprintLong;

  if (
    rawScore < MIN_SCORE ||
    directionalTF < 2
  ) {

    direction = "WAIT";
  }

  if (
    direction === "WAIT"
  ) {

    reasons.push(
      `امتیاز کمتر از ${MIN_SCORE} است`
    );
  }

  // ------------------------------------------------
  // Entry / SL / TP
  // ------------------------------------------------

  let entry = null;
  let sl = null;
  let tp1 = null;
  let tp2 = null;
  let tp3 = null;

  if (
    direction === "LONG"
  ) {

    entry = price;

    sl =
      price * 0.995;

    const risk =
      price - sl;

    tp1 =
      price + risk * 1;

    tp2 =
      price + risk * 2;

    tp3 =
      price + risk * 3;
  }

  if (
    direction === "SHORT"
  ) {

    entry = price;

    sl =
      price * 1.005;

    const risk =
      sl - price;

    tp1 =
      price - risk * 1;

    tp2 =
      price - risk * 2;

    tp3 =
      price - risk * 3;
  }

  return {

    symbol,
    price,

    direction,

    score: Math.round(rawScore),

    confirmations,

    bullishTimeframes:
      bullish,

    bearishTimeframes:
      bearish,

    entry,
    sl,
    tp1,
    tp2,
    tp3,

    timeframes: {
      "1": tfs[0],
      "3": tfs[1],
      "5": tfs[2]
    },

    footprint,

    walls,

    reasons
  };
}

// --------------------------------------------------
// Deep analysis
// --------------------------------------------------

async function analyzeSymbol(symbol) {

  symbol =
    String(symbol)
      .trim()
      .toUpperCase();

  const results =
    await Promise.all(
      TIMEFRAMES.map(async tf => {

        try {

          const candles =
            await getKlines(
              symbol,
              tf.interval,
              100
            );

          return analyzeTF(candles);

        } catch (e) {

          return {
            error: e.message
          };
        }
      })
    );

  const price =
    results
      .find(x => x && !x.error)
      ?.ma7 || 0;

  // قیمت دقیق
  let currentPrice = price;

  try {

    const ticker =
      await bybit(
        "/v5/market/tickers",
        {
          category: "linear",
          symbol
        }
      );

    currentPrice =
      num(
        ticker?.result?.list?.[0]?.lastPrice,
        price
      );

  } catch (e) {}

  const footprint =
    await getFootprint(symbol);

  const walls =
    await getWalls(
      symbol,
      currentPrice
    );

  return calculateSignal(
    symbol,
    currentPrice,
    results,
    footprint,
    walls
  );
}

// --------------------------------------------------
// SCAN
// --------------------------------------------------

async function scanMarket() {

  const markets =
    await getMarkets();

  const prioritized =
    rankMarkets(markets);

  const deepCandidates =
    prioritized.slice(
      0,
      DEEP_LIMIT
    );

  const deepResults = [];

  // به صورت گروهی تا فشار زیادی به API وارد نشود
  const batchSize = 4;

  for (
    let i = 0;
    i < deepCandidates.length;
    i += batchSize
  ) {

    const batch =
      deepCandidates.slice(
        i,
        i + batchSize
      );

    const analyzed =
      await Promise.all(
        batch.map(async m => {

          try {

            return await analyzeSymbol(
              m.symbol
            );

          } catch (e) {

            return {
              symbol: m.symbol,
              direction: "WAIT",
              score: 0,
              confirmations: 0,
              bullishTimeframes: 0,
              bearishTimeframes: 0,
              reasons: [
                e.message
              ],
              timeframes: {},
              footprint: {
                error: e.message
              }
            };
          }
        })
      );

    deepResults.push(
      ...analyzed
    );
  }

  // ------------------------------------------------
  // همه 20 نتیجه را امتیازدهی کن
  // ------------------------------------------------

  deepResults.sort(
    (a, b) =>
      b.score - a.score
  );

  // فقط سیگنال‌های بالای حد تأیید
  const confirmed =
    deepResults
      .filter(x =>
        (
          x.direction === "LONG" ||
          x.direction === "SHORT"
        ) &&
        x.score >= MIN_SCORE
      )
      .slice(
        0,
        RESULT_LIMIT
      );

  return {

    ok: true,

    scanned: Math.min(
      markets.length,
      INITIAL_LIMIT
    ),

    deepScanned:
      deepResults.length,

    threshold:
      MIN_SCORE,

    results:
      confirmed,

    allDeepResults:
      deepResults.slice(
        0,
        RESULT_LIMIT
      )
  };
}

// --------------------------------------------------
// Router
// --------------------------------------------------

export default {

  async fetch(request, env) {

    const url =
      new URL(request.url);

    const path =
      url.pathname;

    try {

      // -----------------------------
      // Analyze
      // -----------------------------

      if (
        path === "/api/analyze"
      ) {

        const symbol =
          url.searchParams
            .get("symbol");

        if (!symbol) {

          return json({
            ok: false,
            error:
              "نماد وارد نشده است."
          }, 400);
        }

        const result =
          await analyzeSymbol(
            symbol
          );

        return json({
          ok: true,
          ...result
        });
      }

      // -----------------------------
      // Scan
      // -----------------------------

      if (
        path === "/api/scan"
      ) {

        const result =
          await scanMarket();

        return json(result);
      }

      // -----------------------------
      // Health
      // -----------------------------

      if (
        path === "/api/health"
      ) {

        return json({
          ok: true,
          service:
            "Bybit Futures Scanner",
          initial:
            INITIAL_LIMIT,
          deep:
            DEEP_LIMIT,
          results:
            RESULT_LIMIT,
          threshold:
            MIN_SCORE
        });
      }

      // -----------------------------
      // Assets
      // -----------------------------

      return env.ASSETS.fetch(
        request
      );

    } catch (e) {

      return json({
        ok: false,
        error:
          e.message ||
          "خطای ناشناخته",
        detail:
          String(e.stack || "")
            .slice(0, 1500)
      }, 500);
    }
  }
};
