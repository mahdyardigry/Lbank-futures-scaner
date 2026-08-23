const BYBIT = "https://api.bybit.com";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=UTF-8"
};

const TIMEFRAMES = {
  "1": "1",
  "3": "3",
  "5": "5",
  "15": "15",
  "60": "60"
};

const CACHE = new Map();

function response(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Cache-Control": "no-store"
    }
  });
}

function error(message, status = 400) {
  return response({
    ok: false,
    error: message
  }, status);
}

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

function clamp(v, min = 0, max = 100) {
  return Math.max(min, Math.min(max, v));
}

function percent(a, b) {
  if (!b) return 0;
  return ((a - b) / Math.abs(b)) * 100;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/* =====================================================
   BYBIT REQUEST
===================================================== */

async function bybit(path, params = {}, cacheSeconds = 0) {

  const url = new URL(BYBIT + path);

  Object.entries(params).forEach(([key, value]) => {
    if (
      value !== undefined &&
      value !== null &&
      value !== ""
    ) {
      url.searchParams.set(key, String(value));
    }
  });

  const cacheKey = url.toString();

  if (cacheSeconds > 0) {
    const old = CACHE.get(cacheKey);

    if (
      old &&
      Date.now() - old.time < cacheSeconds * 1000
    ) {
      return old.data;
    }
  }

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "Accept": "application/json"
    }
  });

  const text = await res.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      "پاسخ Bybit قابل پردازش نیست"
    );
  }

  if (!res.ok) {
    throw new Error(
      `Bybit HTTP ${res.status}`
    );
  }

  if (data.retCode !== 0) {
    throw new Error(
      data.retMsg || "خطای Bybit"
    );
  }

  if (cacheSeconds > 0) {
    CACHE.set(cacheKey, {
      time: Date.now(),
      data
    });
  }

  return data;
}

/* =====================================================
   KLINES
===================================================== */

async function getKlines(
  category,
  symbol,
  interval,
  limit = 200
) {

  const data = await bybit(
    "/v5/market/kline",
    {
      category,
      symbol,
      interval,
      limit
    },
    2
  );

  return (data.result.list || [])
    .reverse()
    .map(x => ({
      time: Number(x[0]),
      open: n(x[1]),
      high: n(x[2]),
      low: n(x[3]),
      close: n(x[4]),
      volume: n(x[5]),
      turnover: n(x[6])
    }));
}

/* =====================================================
   EMA / SMA
===================================================== */

function SMA(values, period) {

  if (values.length < period) {
    return null;
  }

  let sum = 0;

  for (
    let i = values.length - period;
    i < values.length;
    i++
  ) {
    sum += values[i];
  }

  return sum / period;
}

function EMA(values, period) {

  if (!values.length) {
    return null;
  }

  if (values.length < period) {
    return SMA(values, values.length);
  }

  let ema = SMA(
    values.slice(0, period),
    period
  );

  const multiplier =
    2 / (period + 1);

  for (
    let i = period;
    i < values.length;
    i++
  ) {
    ema =
      (values[i] - ema) * multiplier +
      ema;
  }

  return ema;
}

function MA(values, period, type = "EMA") {
  return type === "SMA"
    ? SMA(values, period)
    : EMA(values, period);
}

/* =====================================================
   MA CONVERTED
===================================================== */

function convertedMA(candles, period, source = "close") {

  const values = candles.map(
    x => x[source]
  );

  return EMA(values, period);
}

/* =====================================================
   RSI
===================================================== */

function RSI(values, period = 14) {

  if (values.length <= period) {
    return 50;
  }

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {

    const diff =
      values[i] - values[i - 1];

    if (diff > 0) {
      gains += diff;
    } else {
      losses += Math.abs(diff);
    }
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (
    let i = period + 1;
    i < values.length;
    i++
  ) {

    const diff =
      values[i] - values[i - 1];

    const gain =
      diff > 0 ? diff : 0;

    const loss =
      diff < 0 ? Math.abs(diff) : 0;

    avgGain =
      ((avgGain * (period - 1)) + gain) /
      period;

    avgLoss =
      ((avgLoss * (period - 1)) + loss) /
      period;
  }

  if (avgLoss === 0) {
    return 100;
  }

  const rs =
    avgGain / avgLoss;

  return 100 - 100 / (1 + rs);
}

/* =====================================================
   MACD
===================================================== */

function MACD(values) {

  const fast = EMA(values, 12);
  const slow = EMA(values, 26);

  if (
    fast === null ||
    slow === null
  ) {
    return {
      macd: 0,
      signal: 0,
      histogram: 0
    };
  }

  const macdSeries = [];

  for (
    let i = 0;
    i < values.length;
    i++
  ) {

    const part =
      values.slice(0, i + 1);

    const f = EMA(part, 12);
    const s = EMA(part, 26);

    if (
      f !== null &&
      s !== null
    ) {
      macdSeries.push(f - s);
    }
  }

  const signal =
    EMA(macdSeries, 9) || 0;

  const macd =
    macdSeries.length
      ? macdSeries[macdSeries.length - 1]
      : 0;

  return {
    macd,
    signal,
    histogram: macd - signal
  };
}

/* =====================================================
   ATR
===================================================== */

function ATR(candles, period = 14) {

  if (candles.length < period + 1) {
    return 0;
  }

  const trs = [];

  for (
    let i = 1;
    i < candles.length;
    i++
  ) {

    const c = candles[i];
    const p = candles[i - 1];

    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - p.close),
      Math.abs(c.low - p.close)
    );

    trs.push(tr);
  }

  return SMA(
    trs.slice(-period),
    period
  ) || 0;
}

/* =====================================================
   BOLLINGER WIDTH
===================================================== */

function bollinger(candles, period = 20) {

  const closes =
    candles.map(x => x.close);

  if (closes.length < period) {
    return {
      middle: 0,
      upper: 0,
      lower: 0,
      width: 0
    };
  }

  const values =
    closes.slice(-period);

  const middle =
    SMA(values, period);

  let variance = 0;

  for (const x of values) {
    variance +=
      Math.pow(x - middle, 2);
  }

  const deviation =
    Math.sqrt(
      variance / period
    );

  const upper =
    middle + deviation * 2;

  const lower =
    middle - deviation * 2;

  const width =
    middle
      ? ((upper - lower) / middle) * 100
      : 0;

  return {
    middle,
    upper,
    lower,
    width
  };
}

/* =====================================================
   VOLUME — 6 LEVEL
===================================================== */

function volumeAnalysis(
  candles,
  level = 3
) {

  level = Math.max(
    1,
    Math.min(6, Number(level) || 3)
  );

  const volumes =
    candles.map(x => x.volume);

  const current =
    volumes[volumes.length - 1];

  const avg20 =
    SMA(
      volumes.slice(-20),
      Math.min(20, volumes.length)
    ) || current;

  const ratio =
    avg20
      ? current / avg20
      : 1;

  /*
    Level 1:
    تأیید بسیار آسان

    Level 6:
    حجم غیرعادی و بسیار سخت
  */

  const thresholds = {
    1: {
      normal: 0.90,
      good: 1.10,
      strong: 1.40,
      veryStrong: 1.80,
      extreme: 2.50,
      ultra: 3.50
    },

    2: {
      normal: 1.00,
      good: 1.20,
      strong: 1.60,
      veryStrong: 2.00,
      extreme: 3.00,
      ultra: 4.00
    },

    3: {
      normal: 1.10,
      good: 1.30,
      strong: 1.80,
      veryStrong: 2.20,
      extreme: 3.20,
      ultra: 4.50
    },

    4: {
      normal: 1.20,
      good: 1.50,
      strong: 2.00,
      veryStrong: 2.50,
      extreme: 3.50,
      ultra: 5.00
    },

    5: {
      normal: 1.30,
      good: 1.70,
      strong: 2.20,
      veryStrong: 2.80,
      extreme: 4.00,
      ultra: 5.50
    },

    6: {
      normal: 1.40,
      good: 1.90,
      strong: 2.50,
      veryStrong: 3.00,
      extreme: 4.50,
      ultra: 6.00
    }
  };

  const t =
    thresholds[level];

  let score = 0;

  if (ratio >= t.normal)
    score += 8;

  if (ratio >= t.good)
    score += 8;

  if (ratio >= t.strong)
    score += 12;

  if (ratio >= t.veryStrong)
    score += 15;

  if (ratio >= t.extreme)
    score += 17;

  if (ratio >= t.ultra)
    score += 20;

  return {
    level,
    current,
    average20: avg20,
    ratio,
    score: clamp(score, 0, 80),

    normal:
      ratio >= t.normal,

    good:
      ratio >= t.good,

    strong:
      ratio >= t.strong,

    veryStrong:
      ratio >= t.veryStrong,

    extreme:
      ratio >= t.extreme,

    ultra:
      ratio >= t.ultra,

    threshold: t
  };
}

/* =====================================================
   STRUCTURE
===================================================== */

function structureAnalysis(candles) {

  if (candles.length < 30) {

    return {
      trend: "neutral",
      bos: false,
      bosDirection: null,
      choch: false,
      chochDirection: null
    };
  }

  const closes =
    candles.map(x => x.close);

  const ma7 =
    EMA(closes, 7);

  const ma20 =
    EMA(closes, 20);

  const recent =
    candles.slice(-10, -1);

  const swingHigh =
    Math.max(
      ...recent.map(x => x.high)
    );

  const swingLow =
    Math.min(
      ...recent.map(x => x.low)
    );

  const last =
    candles[candles.length - 1];

  let trend = "neutral";

  if (ma7 > ma20) {
    trend = "bullish";
  }

  if (ma7 < ma20) {
    trend = "bearish";
  }

  const bosUp =
    last.close > swingHigh;

  const bosDown =
    last.close < swingLow;

  return {
    trend,

    ma7,
    ma20,

    swingHigh,
    swingLow,

    bos:
      bosUp || bosDown,

    bosDirection:
      bosUp
        ? "bullish"
        : bosDown
        ? "bearish"
        : null,

    /*
      CHoCH را زمانی فعال می‌کنیم که
      حرکت مخالف روند قبلی ساختار را بشکند.
    */

    choch:
      (
        trend === "bullish" &&
        bosDown
      ) ||
      (
        trend === "bearish" &&
        bosUp
      ),

    chochDirection:
      (
        trend === "bullish" &&
        bosDown
      )
        ? "bearish"
        : (
          trend === "bearish" &&
          bosUp
        )
        ? "bullish"
        : null
  };
}

/* =====================================================
   HUNT / LIQUIDITY SWEEP
===================================================== */

function detectHunt(candles) {

  if (candles.length < 12) {

    return {
      detected: false,
      type: null,
      level: null,
      strength: 0
    };
  }

  const last =
    candles[candles.length - 1];

  const previous =
    candles.slice(-8, -1);

  const high =
    Math.max(
      ...previous.map(x => x.high)
    );

  const low =
    Math.min(
      ...previous.map(x => x.low)
    );

  const range =
    Math.max(
      high - low,
      0.00000001
    );

  const upperWick =
    last.high -
    Math.max(
      last.open,
      last.close
    );

  const lowerWick =
    Math.min(
      last.open,
      last.close
    ) -
    last.low;

  const upperSweep =
    last.high > high &&
    last.close < high;

  const lowerSweep =
    last.low < low &&
    last.close > low;

  if (upperSweep) {

    return {
      detected: true,
      type: "bearish",
      level: high,
      strength: clamp(
        (upperWick / range) * 100
      )
    };
  }

  if (lowerSweep) {

    return {
      detected: true,
      type: "bullish",
      level: low,
      strength: clamp(
        (lowerWick / range) * 100
      )
    };
  }

  return {
    detected: false,
    type: null,
    level: null,
    strength: 0
  };
}

/* =====================================================
   FVG
===================================================== */

function findFVG(candles) {

  const result = [];

  for (
    let i = 2;
    i < candles.length;
    i++
  ) {

    const a =
      candles[i - 2];

    const c =
      candles[i];

    if (c.low > a.high) {

      result.push({
        type: "bullish",
        low: a.high,
        high: c.low,
        index: i
      });
    }

    if (c.high < a.low) {

      result.push({
        type: "bearish",
        low: c.high,
        high: a.low,
        index: i
      });
    }
  }

  return result.slice(-20);
}

/* =====================================================
   ORDER BLOCK
===================================================== */

function findOrderBlocks(candles) {

  const result = [];

  for (
    let i = 2;
    i < candles.length - 2;
    i++
  ) {

    const current =
      candles[i];

    const next =
      candles[i + 1];

    const next2 =
      candles[i + 2];

    /*
      Bullish OB:
      کندل نزولی قبل از حرکت صعودی
    */

    if (
      current.close < current.open &&
      next.close > next.open &&
      next2.close > next.open &&
      next2.close > current.high
    ) {

      result.push({
        type: "bullish",
        high: current.high,
        low: current.low,
        index: i
      });
    }

    /*
      Bearish OB
    */

    if (
      current.close > current.open &&
      next.close < next.open &&
      next2.close < next.open &&
      next2.close < current.low
    ) {

      result.push({
        type: "bearish",
        high: current.high,
        low: current.low,
        index: i
      });
    }
  }

  return result.slice(-10);
}

/* =====================================================
   SUPPORT / RESISTANCE
===================================================== */

function supportResistance(candles) {

  const recent =
    candles.slice(-80);

  const highs =
    recent.map(x => x.high);

  const lows =
    recent.map(x => x.low);

  const price =
    candles[candles.length - 1].close;

  const resistance =
    Math.max(...highs);

  const support =
    Math.min(...lows);

  return {

    price,

    support,

    resistance,

    distanceToSupport:
      Math.abs(
        percent(price, support)
      ),

    distanceToResistance:
      Math.abs(
        percent(resistance, price)
      )
  };
}

/* =====================================================
   ORDER BOOK
===================================================== */

async function getOrderBook(
  category,
  symbol
) {

  const data =
    await bybit(
      "/v5/market/orderbook",
      {
        category,
        symbol,
        limit: 200
      },
      1
    );

  const bids =
    (data.result.b || [])
      .map(x => ({
        price: n(x[0]),
        size: n(x[1])
      }));

  const asks =
    (data.result.a || [])
      .map(x => ({
        price: n(x[0]),
        size: n(x[1])
      }));

  const bidTotal =
    bids.reduce(
      (sum, x) => sum + x.size,
      0
    );

  const askTotal =
    asks.reduce(
      (sum, x) => sum + x.size,
      0
    );

  const total =
    bidTotal + askTotal;

  const imbalance =
    total
      ? (bidTotal - askTotal) / total
      : 0;

  /*
    میانگین سفارش‌ها
  */

  const avgBid =
    bids.length
      ? bidTotal / bids.length
      : 0;

  const avgAsk =
    asks.length
      ? askTotal / asks.length
      : 0;

  /*
    Wall = سفارش بزرگ‌تر از چند برابر
    میانگین همان سمت
  */

  const bidWalls =
    bids
      .filter(x =>
        x.size >= avgBid * 3
      )
      .sort(
        (a, b) => b.size - a.size
      )
      .slice(0, 20);

  const askWalls =
    asks
      .filter(x =>
        x.size >= avgAsk * 3
      )
      .sort(
        (a, b) => b.size - a.size
      )
      .slice(0, 20);

  return {

    bids,
    asks,

    bidTotal,
    askTotal,

    imbalance,

    bidWalls,
    askWalls
  };
}

/* =====================================================
   RECENT TRADES / FOOTPRINT
===================================================== */

async function getFootprint(
  category,
  symbol
) {

  const data =
    await bybit(
      "/v5/market/recent-trade",
      {
        category,
        symbol,
        limit: 1000
      },
      1
    );

  const trades =
    (data.result.list || [])
      .map(x => ({
        price: n(x.p),
        size: n(x.v),
        side: x.S,
        time: Number(x.T)
      }));

  let buy = 0;
  let sell = 0;

  const levels = {};

  for (const trade of trades) {

    if (trade.side === "Buy") {
      buy += trade.size;
    } else {
      sell += trade.size;
    }

    const key =
      String(
        Math.round(
          trade.price * 100000000
        ) / 100000000
      );

    if (!levels[key]) {
      levels[key] = {
        price: trade.price,
        buy: 0,
        sell: 0,
        delta: 0
      };
    }

    if (trade.side === "Buy") {
      levels[key].buy += trade.size;
    } else {
      levels[key].sell += trade.size;
    }

    levels[key].delta =
      levels[key].buy -
      levels[key].sell;
  }

  const total =
    buy + sell;

  return {

    trades,

    buy,
    sell,

    delta:
      buy - sell,

    buyPercent:
      total
        ? buy / total * 100
        : 50,

    sellPercent:
      total
        ? sell / total * 100
        : 50,

    levels:
      Object.values(levels)
        .sort(
          (a, b) =>
            b.price - a.price
        )
        .slice(0, 100)
  };
}

/* =====================================================
   OPEN INTEREST
===================================================== */

async function getOpenInterest(
  category,
  symbol
) {

  if (
    category !== "linear" &&
    category !== "inverse"
  ) {

    return {
      supported: false,
      current: 0,
      change: 0,
      list: []
    };
  }

  const data =
    await bybit(
      "/v5/market/open-interest",
      {
        category,
        symbol,
        intervalTime: "5",
        limit: 50
      },
      3
    );

  const list =
    (data.result.list || [])
      .reverse()
      .map(x => ({
        time: Number(x.timestamp),
        oi: n(x.openInterest)
      }));

  const current =
    list.length
      ? list[list.length - 1].oi
      : 0;

  const old =
    list.length > 1
      ? list[0].oi
      : current;

  return {

    supported: true,

    current,

    change:
      percent(current, old),

    list
  };
}

/* =====================================================
   FUNDING
===================================================== */

async function getFunding(
  category,
  symbol
) {

  if (
    category !== "linear" &&
    category !== "inverse"
  ) {

    return {
      supported: false,
      rate: 0,
      history: []
    };
  }

  const data =
    await bybit(
      "/v5/market/funding/history",
      {
        category,
        symbol,
        limit: 20
      },
      5
    );

  const list =
    data.result.list || [];

  const latest =
    list[0];

  return {

    supported: true,

    rate:
      latest
        ? n(latest.fundingRate)
        : 0,

    timestamp:
      latest
        ? Number(
            latest.fundingRateTimestamp
          )
        : null,

    history:
      list.map(x => ({
        rate: n(x.fundingRate),
        timestamp:
          Number(
            x.fundingRateTimestamp
          )
      }))
  };
}

/* =====================================================
   TICKER
===================================================== */

async function getTicker(
  category,
  symbol
) {

  const data =
    await bybit(
      "/v5/market/tickers",
      {
        category,
        symbol
      },
      1
    );

  const x =
    data.result.list?.[0];

  if (!x) {
    throw new Error(
      "این نماد در بازار انتخاب‌شده پیدا نشد"
    );
  }

  return {

    symbol: x.symbol,

    lastPrice:
      n(x.lastPrice),

    change24h:
      n(x.price24hPcnt) * 100,

    volume24h:
      n(x.volume24h),

    turnover24h:
      n(x.turnover24h),

    high24h:
      n(x.highPrice24h),

    low24h:
      n(x.lowPrice24h),

    bid1Price:
      n(x.bid1Price),

    ask1Price:
      n(x.ask1Price),

    openInterest:
      n(x.openInterest),

    fundingRate:
      n(x.fundingRate)
  };
}

/* =====================================================
   MARKET REGIME
===================================================== */

function marketRegime(
  candles,
  volume
) {

  const closes =
    candles.map(x => x.close);

  const ma7 =
    EMA(closes, 7);

  const ma20 =
    EMA(closes, 20);

  const atr =
    ATR(candles, 14);

  const bb =
    bollinger(candles, 20);

  const price =
    closes[closes.length - 1];

  const atrPercent =
    price
      ? atr / price * 100
      : 0;

  const slope =
    ma20
      ? ((ma7 - ma20) / ma20) * 100
      : 0;

  let regime = "RANGE";

  if (
    volume.ratio >= 1.8 &&
    Math.abs(slope) >= 0.15
  ) {
    regime = "ACTIVE";
  }

  if (
    volume.ratio >= 2.2 &&
    Math.abs(slope) >= 0.25 &&
    bb.width >= 1
  ) {
    regime = "BREAKOUT";
  }

  if (
    volume.ratio < 0.85 &&
    Math.abs(slope) < 0.08
  ) {
    regime = "RANGE";
  }

  return {

    regime,

    atr,

    atrPercent,

    bbWidth:
      bb.width,

    maSlope:
      slope
  };
}

/* =====================================================
   SIGNAL ENGINE
===================================================== */

function signalEngine(data) {

  const {
    candles,
    volume,
    structure,
    hunt,
    fvg,
    orderBlocks,
    orderbook,
    footprint,
    openInterest,
    funding,
    regime
  } = data;

  const closes =
    candles.map(x => x.close);

  const ma7 =
    EMA(closes, 7);

  const ma20 =
    EMA(closes, 20);

  const rsi =
    RSI(closes, 14);

  const macd =
    MACD(closes);

  let long = 0;
  let short = 0;

  const reasons = [];

  /* MA */

  if (ma7 > ma20) {

    long += 12;

    reasons.push(
      "MA7 بالاتر از MA20"
    );

  } else {

    short += 12;

    reasons.push(
      "MA7 پایین‌تر از MA20"
    );
  }

  /* RSI */

  if (
    rsi >= 52 &&
    rsi <= 70
  ) {

    long += 8;

    reasons.push(
      "RSI صعودی"
    );
  }

  if (
    rsi <= 48 &&
    rsi >= 30
  ) {

    short += 8;

    reasons.push(
      "RSI نزولی"
    );
  }

  /* MACD */

  if (macd.histogram > 0) {

    long += 10;

    reasons.push(
      "MACD مثبت"
    );

  } else if (
    macd.histogram < 0
  ) {

    short += 10;

    reasons.push(
      "MACD منفی"
    );
  }

  /* Volume */

  if (volume.strong) {

    const last =
      candles[candles.length - 1];

    if (
      last.close >
      last.open
    ) {

      long += 12;

      reasons.push(
        "حجم قوی با کندل صعودی"
      );

    } else {

      short += 12;

      reasons.push(
        "حجم قوی با کندل نزولی"
      );
    }
  }

  if (volume.extreme) {

    if (
      candles[candles.length - 1].close >
      candles[candles.length - 1].open
    ) {

      long += 8;

    } else {

      short += 8;
    }
  }

  /* Structure */

  if (
    structure.trend ===
    "bullish"
  ) {

    long += 10;

    reasons.push(
      "ساختار صعودی"
    );
  }

  if (
    structure.trend ===
    "bearish"
  ) {

    short += 10;

    reasons.push(
      "ساختار نزولی"
    );
  }

  /* BOS */

  if (
    structure.bosDirection ===
    "bullish"
  ) {

    long += 10;

    reasons.push(
      "BOS صعودی"
    );
  }

  if (
    structure.bosDirection ===
    "bearish"
  ) {

    short += 10;

    reasons.push(
      "BOS نزولی"
    );
  }

  /* CHoCH */

  if (
    structure.chochDirection ===
    "bullish"
  ) {

    long += 8;

    reasons.push(
      "CHoCH صعودی"
    );
  }

  if (
    structure.chochDirection ===
    "bearish"
  ) {

    short += 8;

    reasons.push(
      "CHoCH نزولی"
    );
  }

  /* Hunt */

  if (hunt.detected) {

    if (
      hunt.type ===
      "bullish"
    ) {

      long += 15;

      reasons.push(
        "Liquidity Sweep صعودی"
      );
    }

    if (
      hunt.type ===
      "bearish"
    ) {

      short += 15;

      reasons.push(
        "Liquidity Sweep نزولی"
      );
    }
  }

  /* FVG */

  const latestFVG =
    fvg[fvg.length - 1];

  if (latestFVG) {

    if (
      latestFVG.type ===
      "bullish"
    ) {

      long += 5;

      reasons.push(
        "Bullish FVG"
      );
    }

    if (
      latestFVG.type ===
      "bearish"
    ) {

      short += 5;

      reasons.push(
        "Bearish FVG"
      );
    }
  }

  /* Order Block */

  const latestOB =
    orderBlocks[
      orderBlocks.length - 1
    ];

  if (latestOB) {

    if (
      latestOB.type ===
      "bullish"
    ) {

      long += 5;

      reasons.push(
        "Bullish Order Block"
      );
    }

    if (
      latestOB.type ===
      "bearish"
    ) {

      short += 5;

      reasons.push(
        "Bearish Order Block"
      );
    }
  }

  /* Footprint */

  if (
    footprint.delta > 0
  ) {

    long += 8;

    reasons.push(
      "Delta مثبت"
    );

  } else if (
    footprint.delta < 0
  ) {

    short += 8;

    reasons.push(
      "Delta منفی"
    );
  }

  /* Order Book */

  if (
    orderbook.imbalance >
    0.12
  ) {

    long += 8;

    reasons.push(
      "برتری سفارش‌های خرید"
    );
  }

  if (
    orderbook.imbalance <
    -0.12
  ) {

    short += 8;

    reasons.push(
      "برتری سفارش‌های فروش"
    );
  }

  /* OI */

  if (
    openInterest.supported
  ) {

    if (
      openInterest.change > 3
    ) {

      if (long > short) {
        long += 5;
      }

      if (short > long) {
        short += 5;
      }
    }
  }

  /* Funding */

  if (
    funding.supported
  ) {

    if (
      funding.rate >
      0.0015
    ) {

      short += 5;

      reasons.push(
        "Funding بالا"
      );
    }

    if (
      funding.rate <
      -0.0015
    ) {

      long += 5;

      reasons.push(
        "Funding منفی"
      );
    }
  }

  /*
    اگر بازار Range باشد،
    امتیاز نهایی کمی سخت‌تر می‌شود.
  */

  if (
    regime.regime ===
    "RANGE"
  ) {

    long *= 0.85;
    short *= 0.85;
  }

  long = Math.round(
    clamp(long)
  );

  short = Math.round(
    clamp(short)
  );

  const difference =
    Math.abs(long - short);

  let direction =
    "WAIT";

  if (
    long > short &&
    difference >= 12
  ) {
    direction = "LONG";
  }

  if (
    short > long &&
    difference >= 12
  ) {
    direction = "SHORT";
  }

  const score =
    Math.round(
      Math.max(
        long,
        short
      )
    );

  let strength =
    "WEAK";

  if (score >= 30)
    strength = "NORMAL";

  if (score >= 45)
    strength = "STRONG";

  if (score >= 65)
    strength = "VERY_STRONG";

  if (
    score >= 80 &&
    difference >= 20
  ) {
    strength = "EXTREME";
  }

  /*
    سیگنال نهایی فقط وقتی قوی محسوب می‌شود
    که اختلاف Long/Short نیز معنی‌دار باشد.
  */

  const confidence =
    Math.round(
      clamp(
        50 +
        difference * 2
      )
    );

  return {

    direction,

    strength,

    score,

    confidence,

    long,

    short,

    regime:
      regime.regime,

    indicators: {

      ma7,

      ma20,

      rsi,

      macd
    },

    reasons
  };
}

/* =====================================================
   FULL ANALYSIS
===================================================== */

async function analyze(
  category,
  symbol,
  interval,
  volumeLevel
) {

  symbol =
    String(symbol)
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");

  const [
    ticker,
    candles,
    orderbook,
    footprint,
    openInterest,
    funding
  ] = await Promise.all([

    getTicker(
      category,
      symbol
    ),

    getKlines(
      category,
      symbol,
      interval,
      200
    ),

    getOrderBook(
      category,
      symbol
    ),

    getFootprint(
      category,
      symbol
    ),

    getOpenInterest(
      category,
      symbol
    ),

    getFunding(
      category,
      symbol
    )
  ]);

  if (candles.length < 50) {
    throw new Error(
      "داده کافی برای تحلیل این نماد وجود ندارد"
    );
  }

  const volume =
    volumeAnalysis(
      candles,
      volumeLevel
    );

  const structure =
    structureAnalysis(
      candles
    );

  const hunt =
    detectHunt(
      candles
    );

  const fvg =
    findFVG(
      candles
    );

  const orderBlocks =
    findOrderBlocks(
      candles
    );

  const sr =
    supportResistance(
      candles
    );

  const regime =
    marketRegime(
      candles,
      volume
    );

  const signal =
    signalEngine({

      candles,

      volume,

      structure,

      hunt,

      fvg,

      orderBlocks,

      orderbook,

      footprint,

      openInterest,

      funding,

      regime
    });

  return {

    ok: true,

    market: {

      category,

      symbol,

      interval,

      volumeLevel
    },

    ticker,

    candles,

    volume,

    structure,

    hunt,

    fvg,

    orderBlocks,

    supportResistance: sr,

    orderbook,

    footprint,

    openInterest,

    funding,

    regime,

    signal
  };
}

/* =====================================================
   SYMBOLS
===================================================== */

async function getSymbols(
  category
) {

  const data =
    await bybit(
      "/v5/market/instruments-info",
      {
        category,
        limit: 1000
      },
      30
    );

  return (
    data.result.list || []
  )
    .filter(x => {

      if (
        category === "spot"
      ) {

        return (
          x.status === "Trading" &&
          x.quoteCoin === "USDT"
        );
      }

      return (
        x.status === "Trading" &&
        x.quoteCoin === "USDT" &&
        x.contractType ===
          "LinearPerpetual"
      );
    })
    .map(x => x.symbol);
}

/* =====================================================
   SCAN
===================================================== */

async function scan(
  category,
  interval,
  volumeLevel
) {

  const symbols =
    await getSymbols(
      category
    );

  const tickerData =
    await bybit(
      "/v5/market/tickers",
      {
        category
      },
      2
    );

  const tickers =
    (tickerData.result.list || [])
      .filter(x =>
        symbols.includes(x.symbol)
      )
      .map(x => ({

        symbol:
          x.symbol,

        price:
          n(x.lastPrice),

        change24h:
          n(x.price24hPcnt) * 100,

        volume24h:
          n(x.volume24h),

        turnover24h:
          n(x.turnover24h),

        oi:
          n(x.openInterest)
      }))
      .filter(x =>
        x.price > 0
      );

  /*
    اینجا عمداً فیلتر Volume 24h
    برای حذف ارزها نداریم.

    اول ارزها بر اساس حرکت بازار
    مرتب می‌شوند.
  */

  tickers.sort(
    (a, b) => {

      const scoreA =
        Math.abs(a.change24h) *
          0.65 +
        Math.log10(
          a.turnover24h + 1
        ) *
          2;

      const scoreB =
        Math.abs(b.change24h) *
          0.65 +
        Math.log10(
          b.turnover24h + 1
        ) *
          2;

      return scoreB - scoreA;
    }
  );

  /*
    برای جلوگیری از فشار روی گوشی
    و API، تحلیل کامل روی 30 ارز
    اول انجام می‌شود.
  */

  const candidates =
    tickers.slice(0, 30);

  const results = [];

  for (
    let i = 0;
    i < candidates.length;
    i += 5
  ) {

    const batch =
      candidates.slice(
        i,
        i + 5
      );

    const batchResults =
      await Promise.all(
        batch.map(
          async item => {

            try {

              const a =
                await analyze(
                  category,
                  item.symbol,
                  interval,
                  volumeLevel
                );

              return {

                symbol:
                  item.symbol,

                price:
                  item.price,

                change24h:
                  item.change24h,

                volume24h:
                  item.volume24h,

                direction:
                  a.signal.direction,

                strength:
                  a.signal.strength,

                score:
                  a.signal.score,

                confidence:
                  a.signal.confidence,

                long:
                  a.signal.long,

                short:
                  a.signal.short,

                regime:
                  a.signal.regime,

                volumeRatio:
                  a.volume.ratio,

                hunt:
                  a.hunt,

                fvg:
                  a.fvg
                    .slice(-1)[0] ||
                  null,

                oiChange:
                  a.openInterest.change,

                funding:
                  a.funding.rate,

                footprintDelta:
                  a.footprint.delta,

                orderbookImbalance:
                  a.orderbook.imbalance
              };

            } catch (e) {

              return {

                symbol:
                  item.symbol,

                price:
                  item.price,

                change24h:
                  item.change24h,

                direction:
                  "ERROR",

                strength:
                  "ERROR",

                score:
                  0,

                error:
                  e.message
              };
            }
          }
        )
      );

    results.push(
      ...batchResults
    );

    await sleep(80);
  }

  results.sort(
    (a, b) =>
      b.score - a.score
  );

  return {

    ok: true,

    category,

    interval,

    volumeLevel,

    availableSymbols:
      symbols.length,

    scanned:
      candidates.length,

    results:
      results.slice(0, 20)
  };
}

/* =====================================================
   ROUTER
===================================================== */

export default {

  async fetch(
    request
  ) {

    if (
      request.method ===
      "OPTIONS"
    ) {

      return new Response(
        null,
        {
          status: 204,
          headers:
            CORS_HEADERS
        }
      );
    }

    try {

      const url =
        new URL(
          request.url
        );

      const path =
        url.pathname;

      /* -----------------------------------------------
         HEALTH
      ----------------------------------------------- */

      if (
        path === "/" ||
        path === "/health"
      ) {

        return response({

          ok: true,

          service:
            "Crypto Scanner",

          exchange:
            "Bybit",

          version:
            "V13",

          status:
            "online",

          features: [

            "Spot",

            "Futures",

            "Manual Analysis",

            "MA",

            "RSI",

            "MACD",

            "Volume 1-6",

            "Hunt",

            "Liquidity Sweep",

            "FVG",

            "BOS",

            "CHoCH",

            "Order Block",

            "Order Book",

            "Walls",

            "Footprint",

            "Open Interest",

            "Funding",

            "Support Resistance",

            "Market Regime",

            "Pump Dump"
          ]
        });
      }

      /* -----------------------------------------------
         MANUAL ANALYSIS
      ----------------------------------------------- */

      if (
        path ===
        "/api/analyze"
      ) {

        const category =
          url.searchParams.get(
            "category"
          ) || "linear";

        const symbol =
          (
            url.searchParams.get(
              "symbol"
            ) || ""
          )
          .toUpperCase();

        const interval =
          url.searchParams.get(
            "interval"
          ) || "1";

        const volumeLevel =
          Number(
            url.searchParams.get(
              "volumeLevel"
            ) || 3
          );

        if (!symbol) {
          return error(
            "symbol الزامی است"
          );
        }

        if (
          !TIMEFRAMES[
            interval
          ]
        ) {

          return error(
            "تایم‌فریم نامعتبر است"
          );
        }

        if (
          ![
            "spot",
            "linear",
            "inverse"
          ].includes(
            category
          )
        ) {

          return error(
            "market نامعتبر است"
          );
        }

        return response(
          await analyze(
            category,
            symbol,
            interval,
            volumeLevel
          )
        );
      }

      /* -----------------------------------------------
         SCAN
      ----------------------------------------------- */

      if (
        path ===
        "/api/scan"
      ) {

        const category =
          url.searchParams.get(
            "category"
          ) || "linear";

        const interval =
          url.searchParams.get(
            "interval"
          ) || "1";

        const volumeLevel =
          Number(
            url.searchParams.get(
              "volumeLevel"
            ) || 3
          );

        return response(
          await scan(
            category,
            interval,
            volumeLevel
          )
        );
      }

      /* -----------------------------------------------
         TICKER
      ----------------------------------------------- */

      if (
        path ===
        "/api/ticker"
      ) {

        const category =
          url.searchParams.get(
            "category"
          ) || "linear";

        const symbol =
          (
            url.searchParams.get(
              "symbol"
            ) || ""
          )
          .toUpperCase();

        if (!symbol) {
          return error(
            "symbol الزامی است"
          );
        }

        return response(
          await getTicker(
            category,
            symbol
          )
        );
      }

      /* -----------------------------------------------
         ORDER BOOK
      ----------------------------------------------- */

      if (
        path ===
        "/api/orderbook"
      ) {

        const category =
          url.searchParams.get(
            "category"
          ) || "linear";

        const symbol =
          (
            url.searchParams.get(
              "symbol"
            ) || ""
          )
          .toUpperCase();

        return response(
          await getOrderBook(
            category,
            symbol
          )
        );
      }

      /* -----------------------------------------------
         FOOTPRINT
      ----------------------------------------------- */

      if (
        path ===
        "/api/footprint"
      ) {

        const category =
          url.searchParams.get(
            "category"
          ) || "linear";

        const symbol =
          (
            url.searchParams.get(
              "symbol"
            ) || ""
          )
          .toUpperCase();

        return response(
          await getFootprint(
            category,
            symbol
          )
        );
      }

      /* -----------------------------------------------
         KLINES
      ----------------------------------------------- */

      if (
        path ===
        "/api/klines"
      ) {

        const category =
          url.searchParams.get(
            "category"
          ) || "linear";

        const symbol =
          (
            url.searchParams.get(
              "symbol"
            ) || ""
          )
          .toUpperCase();

        const interval =
          url.searchParams.get(
            "interval"
          ) || "1";

        return response(
          await getKlines(
            category,
            symbol,
            interval,
            200
          )
        );
      }

      return error(
        "Endpoint not found",
        404
      );

    } catch (e) {

      return response({

        ok: false,

        error:
          e.message ||
          "خطای ناشناخته Worker",

        timestamp:
          Date.now()

      }, 500);
    }
  }
};
