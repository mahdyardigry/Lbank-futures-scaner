const BYBIT = "https://api.bybit.com";

const SCAN_BATCH = 20;
const DEEP_LIMIT = 3;
const DEEP_1M_LIMIT = 1300;

const DEFAULT_MODE = "strict";
const DEFAULT_METHODS = [
  "ma",
  "rsi",
  "rsiDiv",
  "macd",
  "macdDiv",
  "ichimoku",
  "smc",
  "ict",
  "liquidity",
  "fvg",
  "structure",
  "ob",
  "volume",
  "orderflow",
  "oi",
  "funding",
  "walls"
];

const MODES = {
  ultra: {
    label: "خیلی سخت‌گیرانه",
    minimum: 85,
    minConfirmations: 5,
    minGroups: 4,
    requireVolume: true,
    requireStructure: true,
    requireTrend: true,
    maxOpposite: 20
  },

  strict: {
    label: "سخت‌گیرانه",
    minimum: 75,
    minConfirmations: 4,
    minGroups: 3,
    requireVolume: true,
    requireStructure: true,
    requireTrend: true,
    maxOpposite: 30
  },

  balanced: {
    label: "متعادل",
    minimum: 65,
    minConfirmations: 3,
    minGroups: 3,
    requireVolume: false,
    requireStructure: false,
    requireTrend: false,
    maxOpposite: 40
  },

  early: {
    label: "زودهنگام",
    minimum: 55,
    minConfirmations: 2,
    minGroups: 2,
    requireVolume: false,
    requireStructure: false,
    requireTrend: false,
    maxOpposite: 50
  }
};

const METHOD_INFO = {
  ma: {
    label: "مووینگ میانگین",
    group: "trend",
    weight: 1
  },

  rsi: {
    label: "RSI",
    group: "momentum",
    weight: 1
  },

  rsiDiv: {
    label: "واگرایی RSI",
    group: "momentum",
    weight: 1.25
  },

  macd: {
    label: "MACD",
    group: "momentum",
    weight: 1.1
  },

  macdDiv: {
    label: "واگرایی MACD",
    group: "momentum",
    weight: 1.25
  },

  ichimoku: {
    label: "ایچیموکو",
    group: "trend",
    weight: 1.15
  },

  smc: {
    label: "اسمارت مانی",
    group: "structure",
    weight: 1.35
  },

  ict: {
    label: "ICT",
    group: "liquidity",
    weight: 1.35
  },

  liquidity: {
    label: "نقدینگی / Hunt",
    group: "liquidity",
    weight: 1.3
  },

  fvg: {
    label: "FVG",
    group: "liquidity",
    weight: 1
  },

  structure: {
    label: "BOS / CHoCH",
    group: "structure",
    weight: 1.35
  },

  ob: {
    label: "Order Block",
    group: "structure",
    weight: 1
  },

  volume: {
    label: "حجم",
    group: "volume",
    weight: 1.25
  },

  orderflow: {
    label: "جریان سفارش",
    group: "orderflow",
    weight: 1.35
  },

  oi: {
    label: "Open Interest",
    group: "derivatives",
    weight: 1
  },

  funding: {
    label: "Funding",
    group: "derivatives",
    weight: .8
  },

  walls: {
    label: "Buy Wall / Sell Wall",
    group: "liquidity",
    weight: 1
  }
};

const TF = [
  { key: "1", label: "1 دقیقه", interval: "1" },
  { key: "3", label: "3 دقیقه", interval: "3" },
  { key: "5", label: "5 دقیقه", interval: "5" },
  { key: "15", label: "15 دقیقه", interval: "15" },
  { key: "60", label: "1 ساعت", interval: "60" }
];

const CONVERTED_MAS = [
  { source: "1m", ma: 20, period: 20 },
  { source: "3m", ma: 7, period: 21 },
  { source: "3m", ma: 20, period: 60 },
  { source: "5m", ma: 7, period: 35 },
  { source: "5m", ma: 20, period: 100 },
  { source: "15m", ma: 7, period: 105 },
  { source: "15m", ma: 20, period: 300 },
  { source: "1h", ma: 7, period: 420 },
  { source: "1h", ma: 20, period: 1200 }
];

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "cache-control": "no-store"
    }
  });

const n = (v, d = 0) =>
  Number.isFinite(Number(v)) ? Number(v) : d;

const clamp = (v, a, b) =>
  Math.max(a, Math.min(b, v));

const avg = a =>
  a.length
    ? a.reduce((x, y) => x + y, 0) / a.length
    : 0;

function pct(a, b) {
  return b ? ((a - b) / b) * 100 : 0;
}

function absPct(a, b) {
  return b ? Math.abs((a - b) / b) * 100 : 999;
}

/* =========================================================
   BYBIT
========================================================= */

async function bybit(path, params = {}) {

  const u = new URL(BYBIT + path);

  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) {
      u.searchParams.set(k, String(v));
    }
  }

  const r = await fetch(u, {
    headers: {
      accept: "application/json"
    }
  });

  if (!r.ok) {
    throw new Error(`Bybit HTTP ${r.status}`);
  }

  const d = await r.json();

  if (d.retCode !== 0) {
    throw new Error(d.retMsg || `Bybit ${d.retCode}`);
  }

  return d;
}

async function klines(
  category,
  symbol,
  interval,
  limit = 100
) {

  const d = await bybit(
    "/v5/market/kline",
    {
      category,
      symbol,
      interval,
      limit
    }
  );

  return (d?.result?.list || [])
    .reverse()
    .map(k => ({
      time: n(k[0]),
      open: n(k[1]),
      high: n(k[2]),
      low: n(k[3]),
      close: n(k[4]),
      volume: n(k[5]),
      turnover: n(k[6])
    }));
}

/* =========================================================
   BASIC INDICATORS
========================================================= */

function sma(a, p) {
  if (!a.length) return 0;
  return a.length < p
    ? avg(a)
    : avg(a.slice(-p));
}

function ema(a, p) {

  if (!a.length) return 0;

  const k = 2 / (p + 1);

  let x = a[0];

  for (let i = 1; i < a.length; i++) {
    x = a[i] * k + x * (1 - k);
  }

  return x;
}

function atr(c, p = 14) {

  if (c.length < 2) return 0;

  const tr = c.slice(1).map((x, i) => {

    const prev = c[i].close;

    return Math.max(
      x.high - x.low,
      Math.abs(x.high - prev),
      Math.abs(x.low - prev)
    );
  });

  return sma(tr, p);
}

function rsi(c, p = 14) {

  if (c.length < p + 2) return 50;

  const closes = c.map(x => x.close);

  const gains = [];
  const losses = [];

  for (let i = 1; i < closes.length; i++) {

    const d = closes[i] - closes[i - 1];

    gains.push(Math.max(d, 0));
    losses.push(Math.max(-d, 0));
  }

  const g = sma(gains, p);
  const l = sma(losses, p);

  if (l === 0) return 100;

  const rs = g / l;

  return 100 - 100 / (1 + rs);
}

/* =========================================================
   MACD
========================================================= */

function macd(c) {

  const closes = c.map(x => x.close);

  if (closes.length < 35) {
    return {
      value: 0,
      signal: 0,
      histogram: 0,
      direction: "NONE"
    };
  }

  const fast = ema(closes, 12);
  const slow = ema(closes, 26);

  const value = fast - slow;

  const macdSeries = [];

  for (let i = 26; i <= closes.length; i++) {

    const part = closes.slice(0, i);

    macdSeries.push(
      ema(part, 12) -
      ema(part, 26)
    );
  }

  const signal = ema(macdSeries, 9);

  const histogram = value - signal;

  const prevValue =
    macdSeries.length > 1
      ? macdSeries.at(-2)
      : value;

  const prevSignal =
    macdSeries.length > 2
      ? ema(macdSeries.slice(0, -1), 9)
      : signal;

  const crossUp =
    prevValue <= prevSignal &&
    value > signal;

  const crossDown =
    prevValue >= prevSignal &&
    value < signal;

  return {
    value,
    signal,
    histogram,

    crossUp,
    crossDown,

    direction:
      value > signal
        ? "BULLISH"
        : value < signal
          ? "BEARISH"
          : "NEUTRAL"
  };
}

/* =========================================================
   RSI DIVERGENCE
========================================================= */

function rsiDivergence(c) {

  if (c.length < 35) {
    return {
      type: "NONE",
      confirmed: false
    };
  }

  const rsis = [];

  for (let i = 0; i < c.length; i++) {
    rsis.push(
      rsi(c.slice(0, i + 1), 14)
    );
  }

  const priceNow = c.at(-1).close;
  const pricePrev = c.at(-8).close;

  const rsiNow = rsis.at(-1);
  const rsiPrev = rsis.at(-8);

  if (
    priceNow < pricePrev &&
    rsiNow > rsiPrev
  ) {

    return {
      type: "BULLISH",
      confirmed: true,
      priceNow,
      pricePrev,
      rsiNow,
      rsiPrev
    };
  }

  if (
    priceNow > pricePrev &&
    rsiNow < rsiPrev
  ) {

    return {
      type: "BEARISH",
      confirmed: true,
      priceNow,
      pricePrev,
      rsiNow,
      rsiPrev
    };
  }

  return {
    type: "NONE",
    confirmed: false,
    rsiNow
  };
}

/* =========================================================
   MACD DIVERGENCE
========================================================= */

function macdDivergence(c) {

  if (c.length < 45) {
    return {
      type: "NONE",
      confirmed: false
    };
  }

  const values = [];

  for (let i = 0; i < c.length; i++) {
    values.push(
      macd(c.slice(0, i + 1)).histogram
    );
  }

  const priceNow = c.at(-1).close;
  const pricePrev = c.at(-10).close;

  const mNow = values.at(-1);
  const mPrev = values.at(-10);

  if (
    priceNow < pricePrev &&
    mNow > mPrev
  ) {

    return {
      type: "BULLISH",
      confirmed: true,
      valueNow: mNow,
      valuePrev: mPrev
    };
  }

  if (
    priceNow > pricePrev &&
    mNow < mPrev
  ) {

    return {
      type: "BEARISH",
      confirmed: true,
      valueNow: mNow,
      valuePrev: mPrev
    };
  }

  return {
    type: "NONE",
    confirmed: false
  };
}

/* =========================================================
   ICHIMOKU
========================================================= */

function ichimoku(c) {

  if (c.length < 60) {
    return {
      direction: "NONE"
    };
  }

  const highest = arr =>
    Math.max(...arr.map(x => x.high));

  const lowest = arr =>
    Math.min(...arr.map(x => x.low));

  const last = c.at(-1);

  const tenkan =
    (
      highest(c.slice(-9)) +
      lowest(c.slice(-9))
    ) / 2;

  const kijun =
    (
      highest(c.slice(-26)) +
      lowest(c.slice(-26))
    ) / 2;

  const spanA =
    (tenkan + kijun) / 2;

  const spanB =
    (
      highest(c.slice(-52)) +
      lowest(c.slice(-52))
    ) / 2;

  const cloudTop = Math.max(spanA, spanB);
  const cloudBottom = Math.min(spanA, spanB);

  const bullish =
    last.close > cloudTop &&
    tenkan > kijun;

  const bearish =
    last.close < cloudBottom &&
    tenkan < kijun;

  return {
    tenkan,
    kijun,
    spanA,
    spanB,
    cloudTop,
    cloudBottom,

    direction:
      bullish
        ? "BULLISH"
        : bearish
          ? "BEARISH"
          : "NEUTRAL"
  };
}

/* =========================================================
   MARKET STRUCTURE
========================================================= */

function swingLevels(c, lookback = 2) {

  const highs = [];
  const lows = [];

  for (
    let i = lookback;
    i < c.length - lookback;
    i++
  ) {

    let hi = true;
    let lo = true;

    for (let j = 1; j <= lookback; j++) {

      if (
        c[i].high <= c[i - j].high ||
        c[i].high < c[i + j].high
      ) {
        hi = false;
      }

      if (
        c[i].low >= c[i - j].low ||
        c[i].low > c[i + j].low
      ) {
        lo = false;
      }
    }

    if (hi) {
      highs.push({
        price: c[i].high,
        index: i,
        time: c[i].time
      });
    }

    if (lo) {
      lows.push({
        price: c[i].low,
        index: i,
        time: c[i].time
      });
    }
  }

  return {
    highs,
    lows
  };
}

function structureAnalysis(c) {

  const s = swingLevels(c, 2);

  const highs = s.highs;
  const lows = s.lows;

  const lastHigh =
    highs.at(-1)?.price || null;

  const prevHigh =
    highs.at(-2)?.price || null;

  const lastLow =
    lows.at(-1)?.price || null;

  const prevLow =
    lows.at(-2)?.price || null;

  const price = c.at(-1).close;

  let bos = "NONE";
  let choch = "NONE";

  if (lastHigh && price > lastHigh) {
    bos = "BULLISH";
  }

  if (lastLow && price < lastLow) {
    bos = "BEARISH";
  }

  if (
    prevLow &&
    lastLow &&
    prevHigh &&
    lastHigh
  ) {

    if (
      lastLow > prevLow &&
      price < lastLow
    ) {
      choch = "BEARISH";
    }

    if (
      lastHigh < prevHigh &&
      price > lastHigh
    ) {
      choch = "BULLISH";
    }
  }

  return {
    bos,
    choch,
    lastHigh,
    lastLow,
    prevHigh,
    prevLow
  };
}

/* =========================================================
   HUNT / SWEEP
========================================================= */

function hunt(c) {

  if (c.length < 25) {
    return {
      type: "NONE",
      side: "NONE",
      confirmed: false
    };
  }

  const x = c.at(-1);

  const previous = c.slice(-21, -1);

  const hi =
    Math.max(...previous.map(x => x.high));

  const lo =
    Math.min(...previous.map(x => x.low));

  const range =
    x.high - x.low || 1;

  const upper =
    x.high -
    Math.max(x.open, x.close);

  const lower =
    Math.min(x.open, x.close) -
    x.low;

  const volumeAverage =
    sma(
      previous.map(x => x.volume),
      20
    );

  const volumeConfirmed =
    x.volume >= volumeAverage * 1.15;

  if (
    x.low < lo &&
    x.close > lo
  ) {

    return {
      type: "LIQUIDITY_SWEEP",
      side: "LONG",
      level: lo,
      wickPct: lower / range * 100,
      volumeConfirmed,
      confirmed:
        volumeConfirmed ||
        lower / range >= .4
    };
  }

  if (
    x.high > hi &&
    x.close < hi
  ) {

    return {
      type: "LIQUIDITY_SWEEP",
      side: "SHORT",
      level: hi,
      wickPct: upper / range * 100,
      volumeConfirmed,
      confirmed:
        volumeConfirmed ||
        upper / range >= .4
    };
  }

  return {
    type: "NONE",
    side: "NONE",
    confirmed: false
  };
}

/* =========================================================
   FVG
========================================================= */

function fvg(c) {

  if (c.length < 3) {
    return {
      type: "NONE"
    };
  }

  const a = c.at(-3);
  const x = c.at(-1);

  if (x.low > a.high) {

    return {
      type: "BULLISH",
      low: a.high,
      high: x.low,
      size: x.low - a.high
    };
  }

  if (x.high < a.low) {

    return {
      type: "BEARISH",
      low: x.high,
      high: a.low,
      size: a.low - x.high
    };
  }

  return {
    type: "NONE"
  };
}

/* =========================================================
   ORDER BLOCK
========================================================= */

function orderBlock(c) {

  if (c.length < 10) {
    return {
      type: "NONE"
    };
  }

  const current = c.at(-1);

  for (
    let i = c.length - 4;
    i >= Math.max(0, c.length - 12);
    i--
  ) {

    const x = c[i];

    if (
      x.close < x.open &&
      current.close > x.high
    ) {

      return {
        type: "BULLISH",
        high: x.high,
        low: x.low,
        time: x.time
      };
    }

    if (
      x.close > x.open &&
      current.close < x.low
    ) {

      return {
        type: "BEARISH",
        high: x.high,
        low: x.low,
        time: x.time
      };
    }
  }

  return {
    type: "NONE"
  };
}

/* =========================================================
   CANDLE
========================================================= */

function candleAnalysis(c) {

  const x = c.at(-1);
  const p = c.at(-2);

  const range =
    x.high - x.low || 1;

  const body =
    Math.abs(x.close - x.open);

  const upper =
    x.high -
    Math.max(x.open, x.close);

  const lower =
    Math.min(x.open, x.close) -
    x.low;

  let type = "NORMAL";

  if (
    lower > body * 2 &&
    lower / range > .45
  ) {
    type = "HAMMER";
  }

  if (
    upper > body * 2 &&
    upper / range > .45
  ) {
    type = "SHOOTING_STAR";
  }

  if (
    x.close > p.open &&
    x.open < p.close
  ) {
    type = "BULLISH_ENGULFING";
  }

  if (
    x.close < p.open &&
    x.open > p.close
  ) {
    type = "BEARISH_ENGULFING";
  }

  if (body / range < .15) {
    type = "DOJI";
  }

  return {
    type,
    bullish: x.close > x.open,
    bearish: x.close < x.open,
    body,
    range,
    upperWick: upper,
    lowerWick: lower
  };
}

/* =========================================================
   FULL CANDLE ANALYSIS
========================================================= */

function analyzeCandles(c) {

  if (c.length < 30) {
    return {
      error: "کندل کافی نیست"
    };
  }

  const closes =
    c.map(x => x.close);

  const volumes =
    c.map(x => x.volume);

  const price =
    closes.at(-1);

  const ma7 =
    sma(closes, 7);

  const ma20 =
    sma(closes, 20);

  const prevMA20 =
    sma(closes.slice(0, -1), 20);

  const slope =
    prevMA20
      ? (ma20 - prevMA20) / prevMA20
      : 0;

  const volumeMA =
    sma(volumes, 20);

  const volumeRatio =
    volumeMA
      ? volumes.at(-1) / volumeMA
      : 0;

  const volumeSpike =
    volumeRatio >= 1.5;

  const previous =
    closes.at(-2);

  const touchMA20 =
    Math.abs(price - ma20) / ma20 <= .0015 ||
    (
      c.at(-1).low <= ma20 &&
      c.at(-1).high >= ma20
    ) ||
    (
      (previous - ma20) *
      (price - ma20) <= 0
    );

  const touchMA7 =
    Math.abs(price - ma7) / ma7 <= .0015 ||
    (
      c.at(-1).low <= ma7 &&
      c.at(-1).high >= ma7
    );

  const trend =
    price > ma20 && ma7 > ma20
      ? "BULLISH"
      : price < ma20 && ma7 < ma20
        ? "BEARISH"
        : "RANGE";

  const rsiValue =
    rsi(c);

  const macdValue =
    macd(c);

  const rsiDiv =
    rsiDivergence(c);

  const macdDiv =
    macdDivergence(c);

  const ichi =
    ichimoku(c);

  const structure =
    structureAnalysis(c);

  const liquidity =
    hunt(c);

  const gap =
    fvg(c);

  const ob =
    orderBlock(c);

  const candle =
    candleAnalysis(c);

  return {

    price,

    ma: {
      ma7,
      ma20,
      slopePct: slope * 100,

      slope:
        slope > .00007
          ? "UP"
          : slope < -.00007
            ? "DOWN"
            : "FLAT",

      touchMA7,
      touchMA20,

      direction:
        trend
    },

    rsi: {
      value: rsiValue,

      direction:
        rsiValue >= 50
          ? "BULLISH"
          : "BEARISH",

      overbought:
        rsiValue >= 70,

      oversold:
        rsiValue <= 30
    },

    macd: macdValue,

    rsiDivergence: rsiDiv,

    macdDivergence: macdDiv,

    ichimoku: ichi,

    structure,

    liquidity,

    fvg: gap,

    orderBlock: ob,

    candle,

    volume: {
      current: volumes.at(-1),
      ma20: volumeMA,
      ratio: volumeRatio,
      spike: volumeSpike,

      direction:
        c.at(-1).close >
        c.at(-1).open
          ? "BULLISH"
          : "BEARISH"
    },

    trend,

    timestamp:
      c.at(-1).time
  };
}

/* =========================================================
   CONVERTED MA
========================================================= */

function maSeries(c, period) {

  const result = [];

  for (let i = 0; i < c.length; i++) {

    if (i + 1 < period) {
      result.push(null);
      continue;
    }

    result.push(
      avg(
        c
          .slice(i - period + 1, i + 1)
          .map(x => x.close)
      )
    );
  }

  return result;
}

function convertedMAEvents(c) {

  const events = [];

  const price =
    c.at(-1)?.close || 0;

  for (const m of CONVERTED_MAS) {

    const values =
      maSeries(c, m.period);

    const ma =
      values.at(-1);

    const prevMA =
      values.at(-2);

    if (!ma || !prevMA) {
      continue;
    }

    const previous =
      c.at(-2)?.close || price;

    const current =
      c.at(-1);

    const distance =
      (price - ma) / ma * 100;

    const touch =
      Math.abs(distance) <= .15 ||
      (
        current.low <= ma &&
        current.high >= ma
      );

    const crossUp =
      previous <= prevMA &&
      price > ma;

    const crossDown =
      previous >= prevMA &&
      price < ma;

    const bullishReject =
      current.low <= ma &&
      current.close > ma &&
      current.close > current.open;

    const bearishReject =
      current.high >= ma &&
      current.close < ma &&
      current.close < current.open;

    let direction = "NONE";

    if (
      crossUp ||
      bullishReject
    ) {
      direction = "LONG";
    }

    if (
      crossDown ||
      bearishReject
    ) {
      direction = "SHORT";
    }

    events.push({
      source: m.source,
      ma: `MA${m.ma}`,
      period1m: m.period,

      price,
      maValue: ma,

      touch,

      crossUp,
      crossDown,

      bullishReject,
      bearishReject,

      direction,

      slopePct:
        (ma - prevMA) /
        prevMA *
        100,

      confirmation:
        direction === "LONG" &&
        ma > prevMA &&
        price > ma
          ? "CONFIRMED_LONG"
          : direction === "SHORT" &&
            ma < prevMA &&
            price < ma
            ? "CONFIRMED_SHORT"
            : "WAIT"
    });
  }

  return {
    events,

    confirmed:
      events.filter(
        x =>
          x.confirmation ===
            "CONFIRMED_LONG" ||
          x.confirmation ===
            "CONFIRMED_SHORT"
      )
  };
}

/* =========================================================
   FOOTPRINT
========================================================= */

async function footprint(
  category,
  symbol
) {

  try {

    const d =
      await bybit(
        "/v5/market/recent-trade",
        {
          category,
          symbol,
          limit: 200
        }
      );

    const trades =
      d?.result?.list || [];

    let buy = 0;
    let sell = 0;
    let largest = 0;

    for (const x of trades) {

      const size = n(x.size);
      const price = n(x.price);

      const notional =
        size * price;

      largest =
        Math.max(
          largest,
          notional
        );

      if (
        String(x.side)
          .toLowerCase() === "buy"
      ) {
        buy += size;
      } else {
        sell += size;
      }
    }

    const total =
      buy + sell;

    const delta =
      buy - sell;

    return {

      buyVolume: buy,

      sellVolume: sell,

      delta,

      deltaPercent:
        total
          ? delta / total * 100
          : 0,

      trades:
        trades.length,

      largestTrade:
        largest,

      direction:
        delta > 0
          ? "BULLISH"
          : delta < 0
            ? "BEARISH"
            : "NEUTRAL"
    };

  } catch (e) {

    return {
      error: e.message
    };
  }
}

/* =========================================================
   ORDER BOOK
========================================================= */

async function walls(
  category,
  symbol,
  price
) {

  try {

    const d =
      await bybit(
        "/v5/market/orderbook",
        {
          category,
          symbol,
          limit: 50
        }
      );

    const bids =
      d?.result?.b || [];

    const asks =
      d?.result?.a || [];

    const buyLevels =
      bids
        .map(x => ({
          price: n(x[0]),
          size: n(x[1])
        }))
        .filter(
          x =>
            x.price < price &&
            absPct(x.price, price) <= 3
        )
        .map(x => ({
          ...x,
          notional:
            x.price * x.size,
          distancePct:
            absPct(
              x.price,
              price
            )
        }))
        .sort(
          (a, b) =>
            b.notional -
            a.notional
        );

    const sellLevels =
      asks
        .map(x => ({
          price: n(x[0]),
          size: n(x[1])
        }))
        .filter(
          x =>
            x.price > price &&
            absPct(x.price, price) <= 3
        )
        .map(x => ({
          ...x,
          notional:
            x.price * x.size,
          distancePct:
            absPct(
              x.price,
              price
            )
        }))
        .sort(
          (a, b) =>
            b.notional -
            a.notional
        );

    const buy =
      buyLevels[0] || null;

    const sell =
      sellLevels[0] || null;

    const buyAvg =
      avg(
        buyLevels
          .slice(0, 10)
          .map(x => x.notional)
      );

    const sellAvg =
      avg(
        sellLevels
          .slice(0, 10)
          .map(x => x.notional)
      );

    return {

      buy,

      sell,

      buyLevels:
        buyLevels.slice(0, 10),

      sellLevels:
        sellLevels.slice(0, 10),

      buyNear:
        !!buy &&
        buy.distancePct <= 1,

      sellNear:
        !!sell &&
        sell.distancePct <= 1,

      buyStrength:
        buy && buyAvg
          ? clamp(
              buy.notional /
              buyAvg *
              20,
              0,
              100
            )
          : 0,

      sellStrength:
        sell && sellAvg
          ? clamp(
              sell.notional /
              sellAvg *
              20,
              0,
              100
            )
          : 0
    };

  } catch (e) {

    return {
      error: e.message
    };
  }
}

/* =========================================================
   OI / FUNDING
========================================================= */

async function oiFunding(symbol) {

  try {

    const d =
      await bybit(
        "/v5/market/tickers",
        {
          category: "linear",
          symbol
        }
      );

    const t =
      d?.result?.list?.[0] || {};

    return {

      openInterest:
        n(t.openInterest),

      fundingRate:
        n(t.fundingRate),

      turnover24h:
        n(t.turnover24h),

      change24h:
        n(t.price24hPcnt) * 100,

      markPrice:
        n(t.markPrice),

      indexPrice:
        n(t.indexPrice)
    };

  } catch (e) {

    return {
      error: e.message
    };
  }
}

/* =========================================================
   SELECTED SIGNAL ENGINE
========================================================= */

function normalizeMethods(input) {

  if (!input) {
    return [...DEFAULT_METHODS];
  }

  const arr =
    String(input)
      .split(",")
      .map(x => x.trim())
      .filter(Boolean);

  const valid =
    arr.filter(
      x =>
        METHOD_INFO[x]
    );

  return valid.length
    ? [...new Set(valid)]
    : [...DEFAULT_METHODS];
}

function normalizeMode(input) {

  return MODES[input]
    ? input
    : DEFAULT_MODE;
}

function signalEngine(
  analysis,
  methods,
  mode
) {

  const config =
    MODES[mode];

  let longWeight = 0;
  let shortWeight = 0;

  let longConfirmations = 0;
  let shortConfirmations = 0;

  const longReasons = [];
  const shortReasons = [];

  const groupsLong = new Set();
  const groupsShort = new Set();

  const details = {};

  function add(
    method,
    direction,
    strength,
    reason
  ) {

    const info =
      METHOD_INFO[method];

    if (!info) return;

    const value =
      info.weight *
      strength;

    if (direction === "LONG") {

      longWeight += value;

      longConfirmations++;

      groupsLong.add(
        info.group
      );

      longReasons.push({
        method,
        title: info.label,
        text: reason,
        strength
      });

    }

    if (direction === "SHORT") {

      shortWeight += value;

      shortConfirmations++;

      groupsShort.add(
        info.group
      );

      shortReasons.push({
        method,
        title: info.label,
        text: reason,
        strength
      });
    }
  }

  /* MA */

  if (methods.includes("ma")) {

    const x = analysis.ma;

    let dir = "NONE";

    if (
      x.direction === "BULLISH" &&
      x.slope === "UP"
    ) {
      dir = "LONG";
    }

    if (
      x.direction === "BEARISH" &&
      x.slope === "DOWN"
    ) {
      dir = "SHORT";
    }

    details.ma = {
      status:
        dir === "LONG"
          ? "صعودی"
          : dir === "SHORT"
            ? "نزولی"
            : "خنثی",

      ma7: x.ma7,
      ma20: x.ma20,
      slope: x.slope,
      touchMA7: x.touchMA7,
      touchMA20: x.touchMA20,

      explanation:
        dir === "LONG"
          ? "قیمت بالای MA20 و MA7 قرار دارد و شیب میانگین‌ها صعودی است."
          : dir === "SHORT"
            ? "قیمت زیر MA20 و MA7 قرار دارد و شیب میانگین‌ها نزولی است."
            : "چیدمان میانگین‌ها برای سیگنال قوی کافی نیست."
    };

    if (dir !== "NONE") {

      add(
        "ma",
        dir,
        x.touchMA20 ? 100 : 75,
        dir === "LONG"
          ? "چیدمان MA7/MA20 صعودی است."
          : "چیدمان MA7/MA20 نزولی است."
      );
    }
  }

  /* RSI */

  if (methods.includes("rsi")) {

    const x = analysis.rsi;

    let dir = "NONE";

    if (
      x.value >= 50 &&
      x.value < 70
    ) {
      dir = "LONG";
    }

    if (
      x.value < 50 &&
      x.value > 30
    ) {
      dir = "SHORT";
    }

    details.rsi = {
      value: x.value,
      status:
        dir === "LONG"
          ? "صعودی"
          : dir === "SHORT"
            ? "نزولی"
            : "خنثی",

      overbought: x.overbought,
      oversold: x.oversold
    };

    if (dir !== "NONE") {

      add(
        "rsi",
        dir,
        70,
        `RSI روی ${x.value.toFixed(1)} قرار دارد.`
      );
    }
  }

  /* RSI DIVERGENCE */

  if (methods.includes("rsiDiv")) {

    const x =
      analysis.rsiDivergence;

    details.rsiDiv = x;

    if (
      x.confirmed &&
      x.type === "BULLISH"
    ) {

      add(
        "rsiDiv",
        "LONG",
        100,
        "واگرایی مثبت RSI مشاهده شد؛ قیمت پایین‌تر ولی RSI بالاتر است."
      );
    }

    if (
      x.confirmed &&
      x.type === "BEARISH"
    ) {

      add(
        "rsiDiv",
        "SHORT",
        100,
        "واگرایی منفی RSI مشاهده شد؛ قیمت بالاتر ولی RSI پایین‌تر است."
      );
    }
  }

  /* MACD */

  if (methods.includes("macd")) {

    const x =
      analysis.macd;

    details.macd = x;

    if (
      x.direction === "BULLISH"
    ) {

      add(
        "macd",
        "LONG",
        x.crossUp ? 100 : 70,
        x.crossUp
          ? "کراس صعودی MACD تأیید شد."
          : "MACD بالای خط سیگنال قرار دارد."
      );
    }

    if (
      x.direction === "BEARISH"
    ) {

      add(
        "macd",
        "SHORT",
        x.crossDown ? 100 : 70,
        x.crossDown
          ? "کراس نزولی MACD تأیید شد."
          : "MACD زیر خط سیگنال قرار دارد."
      );
    }
  }

  /* MACD DIVERGENCE */

  if (methods.includes("macdDiv")) {

    const x =
      analysis.macdDivergence;

    details.macdDiv = x;

    if (
      x.confirmed &&
      x.type === "BULLISH"
    ) {

      add(
        "macdDiv",
        "LONG",
        100,
        "واگرایی مثبت MACD مشاهده شد."
      );
    }

    if (
      x.confirmed &&
      x.type === "BEARISH"
    ) {

      add(
        "macdDiv",
        "SHORT",
        100,
        "واگرایی منفی MACD مشاهده شد."
      );
    }
  }

  /* ICHIMOKU */

  if (methods.includes("ichimoku")) {

    const x =
      analysis.ichimoku;

    details.ichimoku = x;

    if (
      x.direction === "BULLISH"
    ) {

      add(
        "ichimoku",
        "LONG",
        90,
        "قیمت بالای ابر ایچیموکو و Tenkan بالای Kijun است."
      );
    }

    if (
      x.direction === "BEARISH"
    ) {

      add(
        "ichimoku",
        "SHORT",
        90,
        "قیمت زیر ابر ایچیموکو و Tenkan زیر Kijun است."
      );
    }
  }

  /* SMC */

  if (methods.includes("smc")) {

    const x =
      analysis.structure;

    details.smc = {
      bos: x.bos,
      choch: x.choch
    };

    if (
      x.bos === "BULLISH" ||
      x.choch === "BULLISH"
    ) {

      add(
        "smc",
        "LONG",
        x.choch === "BULLISH"
          ? 100
          : 85,
        x.choch === "BULLISH"
          ? "CHoCH صعودی؛ تغییر شخصیت بازار به سمت خریداران."
          : "BOS صعودی؛ ساختار بازار شکسته شده است."
      );
    }

    if (
      x.bos === "BEARISH" ||
      x.choch === "BEARISH"
    ) {

      add(
        "smc",
        "SHORT",
        x.choch === "BEARISH"
          ? 100
          : 85,
        x.choch === "BEARISH"
          ? "CHoCH نزولی؛ تغییر شخصیت بازار به سمت فروشندگان."
          : "BOS نزولی؛ ساختار بازار شکسته شده است."
      );
    }
  }

  /* ICT */

  if (methods.includes("ict")) {

    const x =
      analysis.liquidity;

    const gap =
      analysis.fvg;

    details.ict = {
      hunt: x,
      fvg: gap
    };

    if (
      x.side === "LONG" ||
      gap.type === "BULLISH"
    ) {

      add(
        "ict",
        "LONG",
        x.confirmed ? 100 : 75,
        x.confirmed
          ? "Sweep نقدینگی فروش و برگشت قیمت مشاهده شد."
          : "نشانه FVG / نقدینگی صعودی مشاهده شد."
      );
    }

    if (
      x.side === "SHORT" ||
      gap.type === "BEARISH"
    ) {

      add(
        "ict",
        "SHORT",
        x.confirmed ? 100 : 75,
        x.confirmed
          ? "Sweep نقدینگی خرید و برگشت قیمت مشاهده شد."
          : "نشانه FVG / نقدینگی نزولی مشاهده شد."
      );
    }
  }

  /* LIQUIDITY */

  if (methods.includes("liquidity")) {

    const x =
      analysis.liquidity;

    details.liquidity = x;

    if (
      x.confirmed &&
      x.side === "LONG"
    ) {

      add(
        "liquidity",
        "LONG",
        100,
        "Sell-side Liquidity Sweep تأیید شد."
      );
    }

    if (
      x.confirmed &&
      x.side === "SHORT"
    ) {

      add(
        "liquidity",
        "SHORT",
        100,
        "Buy-side Liquidity Sweep تأیید شد."
      );
    }
  }

  /* FVG */

  if (methods.includes("fvg")) {

    const x =
      analysis.fvg;

    details.fvg = x;

    if (x.type === "BULLISH") {

      add(
        "fvg",
        "LONG",
        75,
        "FVG صعودی تشکیل شده است."
      );
    }

    if (x.type === "BEARISH") {

      add(
        "fvg",
        "SHORT",
        75,
        "FVG نزولی تشکیل شده است."
      );
    }
  }

  /* STRUCTURE */

  if (methods.includes("structure")) {

    const x =
      analysis.structure;

    details.structure = x;

    if (
      x.bos === "BULLISH" ||
      x.choch === "BULLISH"
    ) {

      add(
        "structure",
        "LONG",
        x.choch === "BULLISH"
          ? 100
          : 85,
        "ساختار صعودی بازار تأیید شده است."
      );
    }

    if (
      x.bos === "BEARISH" ||
      x.choch === "BEARISH"
    ) {

      add(
        "structure",
        "SHORT",
        x.choch === "BEARISH"
          ? 100
          : 85,
        "ساختار نزولی بازار تأیید شده است."
      );
    }
  }

  /* ORDER BLOCK */

  if (methods.includes("ob")) {

    const x =
      analysis.orderBlock;

    details.ob = x;

    if (x.type === "BULLISH") {

      add(
        "ob",
        "LONG",
        80,
        "Bullish Order Block شناسایی شد."
      );
    }

    if (x.type === "BEARISH") {

      add(
        "ob",
        "SHORT",
        80,
        "Bearish Order Block شناسایی شد."
      );
    }
  }

  /* VOLUME */

  if (methods.includes("volume")) {

    const x =
      analysis.volume;

    details.volume = x;

    if (x.spike) {

      add(
        "volume",
        x.direction === "BULLISH"
          ? "LONG"
          : "SHORT",
        100,
        `Volume Spike؛ حجم ${x.ratio.toFixed(2)} برابر میانگین است.`
      );
    }
  }

  /* ORDER FLOW */

  if (methods.includes("orderflow")) {

    const x =
      analysis.footprint;

    details.orderflow = x;

    if (
      x &&
      !x.error &&
      Math.abs(x.deltaPercent) >= 8
    ) {

      add(
        "orderflow",
        x.deltaPercent > 0
          ? "LONG"
          : "SHORT",
        100,
        x.deltaPercent > 0
          ? "Delta مثبت؛ حجم معاملات تهاجمی خریداران بیشتر است."
          : "Delta منفی؛ حجم معاملات تهاجمی فروشندگان بیشتر است."
      );
    }
  }

  /* OI */

  if (methods.includes("oi")) {

    const x =
      analysis.market;

    details.oi = x;

    if (
      x &&
      !x.error &&
      x.openInterest > 0
    ) {

      if (
        analysis.trend === "BULLISH"
      ) {

        add(
          "oi",
          "LONG",
          65,
          "OI فعال است و ساختار قیمت صعودی است."
        );
      }

      if (
        analysis.trend === "BEARISH"
      ) {

        add(
          "oi",
          "SHORT",
          65,
          "OI فعال است و ساختار قیمت نزولی است."
        );
      }
    }
  }

  /* FUNDING */

  if (methods.includes("funding")) {

    const x =
      analysis.market;

    details.funding = x;

    if (
      x &&
      !x.error
    ) {

      const f =
        n(x.fundingRate);

      if (f < -0.0001) {

        add(
          "funding",
          "LONG",
          70,
          "Funding منفی است و فشار پرداختی سمت شورت بیشتر است."
        );
      }

      if (f > 0.0001) {

        add(
          "funding",
          "SHORT",
          70,
          "Funding مثبت است و فشار پرداختی سمت لانگ بیشتر است."
        );
      }
    }
  }

  /* WALLS */

  if (methods.includes("walls")) {

    const x =
      analysis.walls;

    details.walls = x;

    if (
      x &&
      !x.error &&
      x.buyNear &&
      x.buyStrength >= 60
    ) {

      add(
        "walls",
        "LONG",
        85,
        "Buy Wall قدرتمند نزدیک قیمت قرار دارد."
      );
    }

    if (
      x &&
      !x.error &&
      x.sellNear &&
      x.sellStrength >= 60
    ) {

      add(
        "walls",
        "SHORT",
        85,
        "Sell Wall قدرتمند نزدیک قیمت قرار دارد."
      );
    }
  }

  /* =====================================================
     NORMALIZED SCORE
  ===================================================== */

  let maxPossible = 0;

  for (const method of methods) {

    const info =
      METHOD_INFO[method];

    maxPossible +=
      info.weight * 100;
  }

  const longScore =
    maxPossible
      ? clamp(
          longWeight /
          maxPossible *
          100,
          0,
          100
        )
      : 0;

  const shortScore =
    maxPossible
      ? clamp(
          shortWeight /
          maxPossible *
          100,
          0,
          100
        )
      : 0;

  const direction =
    longScore > shortScore
      ? "LONG"
      : shortScore > longScore
        ? "SHORT"
        : "WAIT";

  const finalScore =
    Math.round(
      Math.max(
        longScore,
        shortScore
      )
    );

  const selectedGroups =
    direction === "LONG"
      ? groupsLong
      : groupsShort;

  const confirmations =
    direction === "LONG"
      ? longConfirmations
      : shortConfirmations;

  const oppositeScore =
    direction === "LONG"
      ? shortScore
      : longScore;

  const trendOK =
    !config.requireTrend ||
    (
      direction === "LONG"
        ? analysis.trend === "BULLISH"
        : analysis.trend === "BEARISH"
    );

  const structureOK =
    !config.requireStructure ||
    (
      direction === "LONG"
        ?
          (
            analysis.structure.bos === "BULLISH" ||
            analysis.structure.choch === "BULLISH"
          )
        :
          (
            analysis.structure.bos === "BEARISH" ||
            analysis.structure.choch === "BEARISH"
          )
    );

  const volumeOK =
    !config.requireVolume ||
    analysis.volume.spike ||
    (
      analysis.footprint &&
      !analysis.footprint.error &&
      Math.abs(
        analysis.footprint.deltaPercent
      ) >= 8
    );

  const valid =
    direction !== "WAIT" &&
    finalScore >= config.minimum &&
    confirmations >= config.minConfirmations &&
    selectedGroups.size >= config.minGroups &&
    trendOK &&
    structureOK &&
    volumeOK &&
    oppositeScore <= config.maxOpposite;

  let level = "NONE";

  if (valid) {

    level =
      finalScore >= 90
        ? "VERY_STRONG"
        : finalScore >= 80
          ? "STRONG"
          : "CONFIRMED";

  } else if (
    direction !== "WAIT" &&
    finalScore >= 55
  ) {

    level = "WATCH";
  }

  return {

    direction:
      valid
        ? direction
        : "WAIT",

    rawDirection: direction,

    score: finalScore,

    longScore:
      Math.round(longScore),

    shortScore:
      Math.round(shortScore),

    level,

    confirmed: valid,

    mode,

    modeLabel:
      config.label,

    selectedMethods:
      methods.map(
        x => METHOD_INFO[x].label
      ),

    confirmations,

    groups:
      [...selectedGroups],

    requirements: {
      minimumScore:
        config.minimum,

      minimumConfirmations:
        config.minConfirmations,

      minimumGroups:
        config.minGroups,

      trendRequired:
        config.requireTrend,

      structureRequired:
        config.requireStructure,

      volumeRequired:
        config.requireVolume,

      oppositeScoreLimit:
        config.maxOpposite
    },

    reasons:
      direction === "LONG"
        ? longReasons
        : shortReasons,

    oppositeReasons:
      direction === "LONG"
        ? shortReasons
        : longReasons,

    details
  };
}

/* =========================================================
   MOVEMENT RADAR
========================================================= */

function movementAnalysis(
  c,
  analysis
) {

  const price =
    c.at(-1).close;

  const p15 =
    c.at(-15)?.close || price;

  const p30 =
    c.at(-30)?.close || price;

  const change15 =
    pct(price, p15);

  const change30 =
    pct(price, p30);

  const volumeRatio =
    analysis.volume.ratio;

  let pump = 0;
  let dump = 0;

  if (change15 >= 3)
    pump += 30;

  if (change30 >= 5)
    pump += 20;

  if (change15 <= -3)
    dump += 30;

  if (change30 <= -5)
    dump += 20;

  if (volumeRatio >= 1.5) {
    pump += 15;
    dump += 15;
  }

  if (
    analysis.liquidity.side === "SHORT"
  )
    pump += 10;

  if (
    analysis.liquidity.side === "LONG"
  )
    dump += 10;

  if (
    analysis.structure.bos === "BULLISH"
  )
    pump += 10;

  if (
    analysis.structure.bos === "BEARISH"
  )
    dump += 10;

  return {

    change15m: change15,

    change30m: change30,

    volumeRatio,

    pumpScore:
      Math.round(
        clamp(pump, 0, 100)
      ),

    dumpScore:
      Math.round(
        clamp(dump, 0, 100)
      ),

    pumpReversalScore:
      change15 >= 5 &&
      (
        analysis.structure.choch === "BEARISH" ||
        analysis.candle.type === "SHOOTING_STAR"
      )
        ? 80
        : 0,

    dumpReversalScore:
      change15 <= -5 &&
      (
        analysis.structure.choch === "BULLISH" ||
        analysis.candle.type === "HAMMER"
      )
        ? 80
        : 0
  };
}

/* =========================================================
   DEEP ANALYSIS
========================================================= */

async function deepAnalyze(
  category,
  symbol,
  methods = DEFAULT_METHODS,
  mode = DEFAULT_MODE
) {

  const tf = {};

  let oneMinute = [];

  try {

    oneMinute =
      await klines(
        category,
        symbol,
        "1",
        DEEP_1M_LIMIT
      );

    tf["1"] =
      analyzeCandles(
        oneMinute.slice(-300)
      );

  } catch (e) {

    tf["1"] = {
      error: e.message
    };
  }

  for (
    const t of TF.filter(
      x => x.interval !== "1"
    )
  ) {

    try {

      tf[t.key] =
        analyzeCandles(
          await klines(
            category,
            symbol,
            t.interval,
            150
          )
        );

    } catch (e) {

      tf[t.key] = {
        error: e.message
      };
    }
  }

  const base =
    tf["1"]?.error
      ? null
      : tf["1"];

  if (!base) {
    throw new Error(
      "تحلیل تایم‌فریم یک دقیقه دریافت نشد."
    );
  }

  const fp =
    await footprint(
      category,
      symbol
    );

  const price =
    base.price;

  const wall =
    await walls(
      category,
      symbol,
      price
    );

  const market =
    category === "linear"
      ? await oiFunding(symbol)
      : {};

  /*
     اطلاعات Footprint را به تحلیل پایه اضافه می‌کنیم
     تا موتور انتخابی بتواند از آن استفاده کند.
  */

  base.footprint = fp;
  base.walls = wall;
  base.market = market;

  const converted =
    convertedMAEvents(
      oneMinute
    );

  const signal =
    signalEngine(
      base,
      methods,
      mode
    );

  const movement =
    movementAnalysis(
      oneMinute,
      base
    );

  const pumpDumpStatus =
    movement.pumpScore >= 75
      ? "PUMP"
      : movement.dumpScore >= 75
        ? "DUMP"
        : "NORMAL";

  return {

    symbol,

    category,

    price,

    signal,

    direction:
      signal.direction,

    score:
      signal.score,

    longScore:
      signal.longScore,

    shortScore:
      signal.shortScore,

    signalLevel:
      signal.level,

    timeframes: tf,

    convertedMA1m:
      converted,

    footprint: fp,

    walls: wall,

    market,

    movement,

    pumpScore:
      movement.pumpScore,

    dumpScore:
      movement.dumpScore,

    pumpDumpStatus,

    reversal: {

      pumpScore:
        movement.pumpReversalScore,

      dumpScore:
        movement.dumpReversalScore
    },

    liquidation: {

      available: false,

      message:
        "داده لیکوئیدیشن تجمیعی ساختگی نمایش داده نمی‌شود."
    },

    generatedAt:
      Date.now()
  };
}

/* =========================================================
   INSTRUMENTS
========================================================= */

async function instruments(category) {

  const d =
    await bybit(
      "/v5/market/instruments-info",
      {
        category,
        limit: 1000
      }
    );

  return d?.result?.list || [];
}

function validFutures(list) {

  return list.filter(
    x =>
      x.status === "Trading" &&
      x.quoteCoin === "USDT" &&
      x.contractType === "LinearPerpetual"
  );
}

async function findSymbol(input) {

  const raw =
    String(input || "")
      .trim()
      .toUpperCase();

  const bare =
    raw
      .replace(/[-_/:\s]/g, "")
      .replace(/USDT$/, "");

  const [linear, spot] =
    await Promise.all([
      instruments("linear"),
      instruments("spot")
    ]);

  const futures =
    linear.find(
      x =>
        String(x.symbol).toUpperCase() === raw ||
        String(x.symbol).toUpperCase() ===
          bare + "USDT"
    );

  const spotCoin =
    spot.find(
      x =>
        String(x.symbol).toUpperCase() === raw ||
        String(x.symbol).toUpperCase() ===
          bare + "USDT"
    );

  return {

    input: raw,

    futures:
      futures
        ? {
            symbol: futures.symbol,
            status: futures.status,
            baseCoin: futures.baseCoin,
            quoteCoin: futures.quoteCoin
          }
        : null,

    spot:
      spotCoin
        ? {
            symbol: spotCoin.symbol,
            status: spotCoin.status,
            baseCoin: spotCoin.baseCoin,
            quoteCoin: spotCoin.quoteCoin
          }
        : null
  };
}

/* =========================================================
   SCAN
========================================================= */

async function scan(offset = 0) {

  const list =
    validFutures(
      await instruments("linear")
    )
      .sort(
        (a, b) =>
          String(a.symbol)
            .localeCompare(
              String(b.symbol)
            )
      );

  if (!list.length) {

    return {
      ok: false,
      error:
        "هیچ قرارداد USDT Perpetual فعال پیدا نشد."
    };
  }

  const safeOffset =
    Math.max(
      0,
      Math.min(
        offset,
        Math.max(
          0,
          list.length - 1
        )
      )
    );

  const batch =
    list.slice(
      safeOffset,
      safeOffset + SCAN_BATCH
    );

  const light = [];

  for (const m of batch) {

    try {

      const c =
        await klines(
          "linear",
          m.symbol,
          "1",
          80
        );

      const a =
        analyzeCandles(c);

      if (a.error) continue;

      const activity =
        (a.ma.touchMA20 ? 20 : 0) +
        (a.ma.touchMA7 ? 10 : 0) +
        (a.volume.spike ? 20 : 0) +
        (a.liquidity.confirmed ? 20 : 0) +
        (a.structure.bos !== "NONE" ? 15 : 0) +
        (a.structure.choch !== "NONE" ? 15 : 0) +
        (a.rsiDivergence.confirmed ? 10 : 0) +
        (a.macdDivergence.confirmed ? 10 : 0);

      light.push({
        symbol: m.symbol,
        activity
      });

    } catch (e) {}
  }

  light.sort(
    (a, b) =>
      b.activity - a.activity
  );

  const deep =
    await Promise.all(
      light
        .slice(0, DEEP_LIMIT)
        .map(
          x =>
            deepAnalyze(
              "linear",
              x.symbol
            )
        )
    );

  deep.sort(
    (a, b) =>
      b.score - a.score
  );

  return {

    ok: true,

    totalMarkets:
      list.length,

    offset:
      safeOffset,

    batchSize:
      batch.length,

    nextOffset:
      (
        safeOffset +
        SCAN_BATCH
      ) % list.length,

    results:
      deep,

    scannedSymbols:
      batch.map(
        x => x.symbol
      ),

    note:
      "اسکن به‌صورت چرخشی انجام می‌شود و فقط ارزهای فعال‌تر برای تحلیل عمیق انتخاب می‌شوند."
  };
}

/* =========================================================
   WORKER ROUTER
========================================================= */

export default {

  async fetch(
    request,
    env
  ) {

    const u =
      new URL(request.url);

    const path =
      u.pathname;

    try {

      /* -------------------------
         SEARCH
      ------------------------- */

      if (
        path === "/api/search"
      ) {

        const symbol =
          u.searchParams.get(
            "symbol"
          );

        if (!symbol) {

          return json(
            {
              ok: false,
              error:
                "نماد وارد نشده است."
            },
            400
          );
        }

        return json({
          ok: true,
          ...await findSymbol(
            symbol
          )
        });
      }

      /* -------------------------
         ANALYZE
      ------------------------- */

      if (
        path === "/api/analyze"
      ) {

        const symbol =
          u.searchParams.get(
            "symbol"
          );

        const category =
          u.searchParams.get(
            "category"
          ) === "spot"
            ? "spot"
            : "linear";

        const mode =
          normalizeMode(
            u.searchParams.get(
              "mode"
            )
          );

        const methods =
          normalizeMethods(
            u.searchParams.get(
              "methods"
            )
          );

        if (!symbol) {

          return json(
            {
              ok: false,
              error:
                "نماد وارد نشده است."
            },
            400
          );
        }

        const found =
          await findSymbol(
            symbol
          );

        const chosen =
          category === "spot"
            ? found.spot
            : found.futures;

        if (!chosen) {

          return json(
            {
              ok: false,

              error:
                `${category === "spot" ? "Spot" : "Futures"} برای ${symbol} در Bybit پیدا نشد.`,

              search:
                found
            },
            404
          );
        }

        const result =
          await deepAnalyze(
            category,
            chosen.symbol,
            methods,
            mode
          );

        return json({
          ok: true,

          ...result,

          search:
            found
        });
      }

      /* -------------------------
         SCAN
      ------------------------- */

      if (
        path === "/api/scan"
      ) {

        return json(
          await scan(
            n(
              u.searchParams.get(
                "offset"
              ),
              0
            )
          )
        );
      }

      /* -------------------------
         SIGNAL CONFIG
      ------------------------- */

      if (
        path === "/api/signal-config"
      ) {

        return json({

          ok: true,

          modes: MODES,

          methods:
            METHOD_INFO,

          defaultMode:
            DEFAULT_MODE,

          defaultMethods:
            DEFAULT_METHODS
        });
      }

      /* -------------------------
         HEALTH
      ------------------------- */

      if (
        path === "/api/health"
      ) {

        return json({

          ok: true,

          service:
            "Bybit Smart Signal Engine",

          version:
            "V9",

          signalModes:
            Object.keys(
              MODES
            ),

          methods:
            Object.keys(
              METHOD_INFO
            ),

          timeframes:
            TF.map(
              x => x.interval
            ),

          features: [

            "MA",

            "RSI",

            "RSI Divergence",

            "MACD",

            "MACD Divergence",

            "Ichimoku",

            "SMC",

            "ICT",

            "Liquidity Hunt",

            "Liquidity Sweep",

            "FVG",

            "BOS",

            "CHoCH",

            "Order Block",

            "Volume",

            "Order Flow",

            "OI",

            "Funding",

            "Buy Wall",

            "Sell Wall",

            "Pump Radar",

            "Dump Radar",

            "Reversal Radar",

            "Selectable Signal Methods",

            "Strict Signal Engine"
          ]
        });
      }

      return env.ASSETS.fetch(
        request
      );

    } catch (e) {

      return json(
        {
          ok: false,

          error:
            e.message,

          detail:
            String(
              e.stack || ""
            ).slice(
              0,
              1500
            )
        },
        500
      );
    }
  }
};
