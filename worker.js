// فایل کامل worker.js
// Bybit Smart Money Scanner

const BYBIT = "https://api.bybit.com";

const SCAN_BATCH = 20;
const DEEP_LIMIT = 3;
const RADAR_LIMIT = 5;

const MIN_SIGNAL_SCORE = 45;
const WATCH_SCORE = 35;

const DEFAULT_STRICTNESS = 3;
const DEFAULT_METHODS = [
  "MA",
  "MACD",
  "RSI",
  "ICHIMOKU",
  "DIVERGENCE",
  "HUNT",
  "FVG",
  "BOS",
  "CHOCH",
  "ORDER_BLOCK",
  "VOLUME",
  "FOOTPRINT",
  "WALLS"
];

const CONVERTED_MAS = {
  "1m": [
    { source: "3m", period: 7 },
    { source: "3m", period: 20 },
    { source: "5m", period: 7 },
    { source: "5m", period: 20 },
    { source: "15m", period: 7 },
    { source: "15m", period: 20 },
    { source: "1h", period: 20 }
  ]
};

const TF = [
  { interval: "1", label: "1m", limit: 150 },
  { interval: "3", label: "3m", limit: 150 },
  { interval: "5", label: "5m", limit: 150 },
  { interval: "15", label: "15m", limit: 150 },
  { interval: "60", label: "1h", limit: 150 }
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
  a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;

const pct = (a, b) =>
  b ? ((a - b) / b) * 100 : 0;

const absPct = (a, b) =>
  b ? Math.abs((a - b) / b) * 100 : 0;

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

/* ---------------- BASIC MATH ---------------- */

function sma(a, p) {
  if (!a.length) return 0;
  return a.length < p ? avg(a) : avg(a.slice(-p));
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

function highest(a) {
  return a.length ? Math.max(...a) : 0;
}

function lowest(a) {
  return a.length ? Math.min(...a) : 0;
}

/* ---------------- KLINES ---------------- */

async function klines(category, symbol, interval, limit = 100) {
  const d = await bybit("/v5/market/kline", {
    category,
    symbol,
    interval,
    limit
  });

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

/* ---------------- ATR / ADX ---------------- */

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

function adx(c, p = 14) {
  if (c.length < p * 2 + 1) return 0;

  const trs = [];
  const plus = [];
  const minus = [];

  for (let i = 1; i < c.length; i++) {
    const x = c[i];
    const q = c[i - 1];

    trs.push(
      Math.max(
        x.high - x.low,
        Math.abs(x.high - q.close),
        Math.abs(x.low - q.close)
      )
    );

    const up = x.high - q.high;
    const dn = q.low - x.low;

    plus.push(up > dn && up > 0 ? up : 0);
    minus.push(dn > up && dn > 0 ? dn : 0);
  }

  const out = [];

  for (let i = p; i < trs.length; i++) {
    const tr = avg(trs.slice(i - p, i)) || 1;

    const diP =
      100 * avg(plus.slice(i - p, i)) / tr;

    const diM =
      100 * avg(minus.slice(i - p, i)) / tr;

    const dx =
      diP + diM
        ? 100 * Math.abs(diP - diM) / (diP + diM)
        : 0;

    out.push(dx);
  }

  return avg(out.slice(-p));
}

function bollWidth(c, p = 20) {
  const a = c.slice(-p).map(x => x.close);

  if (!a.length) return 0;

  const m = avg(a);

  const sd = Math.sqrt(
    avg(a.map(x => (x - m) ** 2))
  );

  return m ? (sd * 2 / m) * 100 : 0;
}

/* ---------------- RSI ---------------- */

function rsi(c, p = 14) {
  if (c.length < p + 1) return 50;

  const closes = c.map(x => x.close);

  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= p; i++) {
    const d = closes[i] - closes[i - 1];

    if (d >= 0) gain += d;
    else loss -= d;
  }

  gain /= p;
  loss /= p;

  for (let i = p + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];

    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;

    gain = (gain * (p - 1) + g) / p;
    loss = (loss * (p - 1) + l) / p;
  }

  if (loss === 0) return 100;

  const rs = gain / loss;

  return 100 - 100 / (1 + rs);
}

/* ---------------- MACD ---------------- */

function macd(c) {
  const closes = c.map(x => x.close);

  if (closes.length < 35) {
    return {
      macd: 0,
      signal: 0,
      histogram: 0,
      direction: "NONE"
    };
  }

  const fast = [];
  const slow = [];

  for (let i = 0; i < closes.length; i++) {
    fast.push(ema(closes.slice(0, i + 1), 12));
    slow.push(ema(closes.slice(0, i + 1), 26));
  }

  const line = fast.map((x, i) => x - slow[i]);
  const signal = ema(line, 9);
  const histogram = line.at(-1) - signal;

  return {
    macd: line.at(-1),
    signal,
    histogram,
    direction:
      histogram > 0
        ? "LONG"
        : histogram < 0
          ? "SHORT"
          : "NONE"
  };
}

/* ---------------- ICHIMOKU ---------------- */

function ichimoku(c) {
  if (c.length < 52) {
    return {
      tenkan: 0,
      kijun: 0,
      spanA: 0,
      spanB: 0,
      direction: "NONE"
    };
  }

  const hh = arr =>
    highest(arr.map(x => x.high));

  const ll = arr =>
    lowest(arr.map(x => x.low));

  const last9 = c.slice(-9);
  const last26 = c.slice(-26);
  const last52 = c.slice(-52);

  const tenkan =
    (hh(last9) + ll(last9)) / 2;

  const kijun =
    (hh(last26) + ll(last26)) / 2;

  const spanA =
    (tenkan + kijun) / 2;

  const spanB =
    (hh(last52) + ll(last52)) / 2;

  const price = c.at(-1).close;

  let direction = "NONE";

  if (
    price > spanA &&
    price > spanB &&
    tenkan > kijun
  ) {
    direction = "LONG";
  } else if (
    price < spanA &&
    price < spanB &&
    tenkan < kijun
  ) {
    direction = "SHORT";
  }

  return {
    tenkan,
    kijun,
    spanA,
    spanB,
    direction
  };
}

/* ---------------- DIVERGENCE ---------------- */

function divergence(c) {
  if (c.length < 40) {
    return {
      type: "NONE",
      side: "NONE"
    };
  }

  const price = c.at(-1).close;
  const currentRsi = rsi(c);

  const old = c.slice(-20, -5);

  const oldPrice =
    old.length
      ? old.at(-1).close
      : price;

  const oldRsi =
    rsi(c.slice(0, -15));

  if (
    price < oldPrice &&
    currentRsi > oldRsi + 3
  ) {
    return {
      type: "BULLISH_DIVERGENCE",
      side: "LONG"
    };
  }

  if (
    price > oldPrice &&
    currentRsi < oldRsi - 3
  ) {
    return {
      type: "BEARISH_DIVERGENCE",
      side: "SHORT"
    };
  }

  return {
    type: "NONE",
    side: "NONE"
  };
}

/* ---------------- CANDLE ANALYSIS ---------------- */

function candleAnalysis(c) {
  if (!c.length) {
    return {
      type: "NONE",
      direction: "NONE",
      strength: 0
    };
  }

  const x = c.at(-1);

  const body = Math.abs(x.close - x.open);
  const range = Math.max(x.high - x.low, 1e-12);

  const upper =
    x.high - Math.max(x.open, x.close);

  const lower =
    Math.min(x.open, x.close) - x.low;

  const bodyPct = body / range * 100;

  if (
    lower > body * 2 &&
    upper < body &&
    x.close > x.open
  ) {
    return {
      type: "HAMMER",
      direction: "LONG",
      strength: clamp(lower / range * 100, 0, 100)
    };
  }

  if (
    upper > body * 2 &&
    lower < body &&
    x.close < x.open
  ) {
    return {
      type: "SHOOTING_STAR",
      direction: "SHORT",
      strength: clamp(upper / range * 100, 0, 100)
    };
  }

  if (bodyPct >= 70) {
    return {
      type: "STRONG_BODY",
      direction:
        x.close > x.open
          ? "LONG"
          : "SHORT",
      strength: bodyPct
    };
  }

  return {
    type: "NORMAL",
    direction:
      x.close > x.open
        ? "LONG"
        : x.close < x.open
          ? "SHORT"
          : "NONE",
    strength: bodyPct
  };
}

/* ---------------- VOLUME ---------------- */

function volumeAnalysis(c) {
  if (!c.length) {
    return {
      current: 0,
      average: 0,
      ratio: 0,
      spike: false,
      state: "NORMAL"
    };
  }

  const current = c.at(-1).volume;

  const previous =
    c.length > 21
      ? c.slice(-21, -1).map(x => x.volume)
      : c.slice(0, -1).map(x => x.volume);

  const average = avg(previous);

  const ratio =
    average ? current / average : 0;

  return {
    current,
    average,
    ratio,
    spike: ratio >= 1.5,
    state:
      ratio >= 3
        ? "EXTREME"
        : ratio >= 2
          ? "HIGH"
          : ratio >= 1.5
            ? "SPIKE"
            : "NORMAL"
  };
}

/* ---------------- LIQUIDITY HUNT ---------------- */

function hunt(c) {
  if (c.length < 10) {
    return {
      side: "NONE",
      confirmed: false,
      sweepPrice: 0,
      strength: 0
    };
  }

  const x = c.at(-1);

  const previous =
    c.slice(-8, -1);

  const high =
    highest(previous.map(z => z.high));

  const low =
    lowest(previous.map(z => z.low));

  const range =
    Math.max(x.high - x.low, 1e-12);

  const upper =
    x.high - Math.max(x.open, x.close);

  const lower =
    Math.min(x.open, x.close) - x.low;

  if (
    x.high > high &&
    x.close < high &&
    upper / range > 0.25
  ) {
    return {
      side: "SHORT",
      confirmed: true,
      sweepPrice: x.high,
      strength: clamp(
        upper / range * 100,
        0,
        100
      )
    };
  }

  if (
    x.low < low &&
    x.close > low &&
    lower / range > 0.25
  ) {
    return {
      side: "LONG",
      confirmed: true,
      sweepPrice: x.low,
      strength: clamp(
        lower / range * 100,
        0,
        100
      )
    };
  }

  return {
    side: "NONE",
    confirmed: false,
    sweepPrice: 0,
    strength: 0
  };
}

/* ---------------- STRUCTURE ---------------- */

function detectStructure(c) {
  if (c.length < 12) {
    return {
      bos: "NONE",
      choch: "NONE"
    };
  }

  const x = c.at(-1);

  const prev = c.slice(-10, -1);

  const prevHigh =
    highest(prev.map(z => z.high));

  const prevLow =
    lowest(prev.map(z => z.low));

  let bos = "NONE";
  let choch = "NONE";

  if (x.close > prevHigh) {
    bos = "BULLISH";
    choch = "BULLISH";
  } else if (x.close < prevLow) {
    bos = "BEARISH";
    choch = "BEARISH";
  }

  return {
    bos,
    choch
  };
}

/* ---------------- FVG ---------------- */

function detectFVG(c) {
  if (c.length < 3) {
    return {
      type: "NONE",
      top: 0,
      bottom: 0,
      sizePct: 0
    };
  }

  const a = c.at(-3);
  const b = c.at(-2);
  const x = c.at(-1);

  if (x.low > a.high) {
    const bottom = a.high;
    const top = x.low;

    return {
      type: "BULLISH",
      top,
      bottom,
      sizePct: pct(top, bottom)
    };
  }

  if (x.high < a.low) {
    const bottom = x.high;
    const top = a.low;

    return {
      type: "BEARISH",
      top,
      bottom,
      sizePct: pct(top, bottom)
    };
  }

  return {
    type: "NONE",
    top: 0,
    bottom: 0,
    sizePct: 0
  };
}

/* ---------------- ORDER BLOCK ---------------- */

function orderBlock(c) {
  if (c.length < 6) {
    return {
      type: "NONE",
      price: 0,
      strength: 0
    };
  }

  const x = c.at(-1);
  const prev = c.at(-2);

  const avgVol =
    avg(
      c.slice(-20, -1)
        .map(z => z.volume)
    ) || 1;

  if (
    prev.close < prev.open &&
    x.close > prev.high &&
    x.volume > avgVol * 1.5
  ) {
    return {
      type: "BULLISH",
      price: prev.low,
      strength: clamp(
        x.volume / avgVol * 30,
        0,
        100
      )
    };
  }

  if (
    prev.close > prev.open &&
    x.close < prev.low &&
    x.volume > avgVol * 1.5
  ) {
    return {
      type: "BEARISH",
      price: prev.high,
      strength: clamp(
        x.volume / avgVol * 30,
        0,
        100
      )
    };
  }

  return {
    type: "NONE",
    price: 0,
    strength: 0
  };
}

/* ---------------- SUPPORT / RESISTANCE ---------------- */

function supportResistance(c) {
  if (c.length < 20) {
    return {
      support: 0,
      resistance: 0
    };
  }

  const last = c.slice(-50);

  const support =
    lowest(last.map(x => x.low));

  const resistance =
    highest(last.map(x => x.high));

  return {
    support,
    resistance
  };
}

/* ---------------- CANDLE ANALYSIS BUNDLE ---------------- */

function analyzeCandles(c) {
  if (!c.length) {
    return {
      error: "داده کندل دریافت نشد."
    };
  }

  const price = c.at(-1).close;

  const ma7 = sma(
    c.map(x => x.close),
    7
  );

  const ma20 = sma(
    c.map(x => x.close),
    20
  );

  const prevMa20 =
    c.length >= 21
      ? sma(
          c.slice(0, -1).map(x => x.close),
          20
        )
      : ma20;

  const trend =
    price > ma20 && ma7 > ma20
      ? "BULLISH"
      : price < ma20 && ma7 < ma20
        ? "BEARISH"
        : "NEUTRAL";

  const maSlope =
    ma20 > prevMa20
      ? "UP"
      : ma20 < prevMa20
        ? "DOWN"
        : "FLAT";

  const atrValue = atr(c);
  const distanceMA20 =
    absPct(price, ma20);

  const touchMA20 =
    distanceMA20 <=
    Math.max(
      0.35,
      price
        ? atrValue / price * 100
        : 0
    );

  const distanceMA7 =
    absPct(price, ma7);

  const touchMA7 =
    distanceMA7 <=
    Math.max(
      0.25,
      price
        ? atrValue / price * 100 * 0.7
        : 0
    );

  const volume =
    volumeAnalysis(c);

  const h =
    hunt(c);

  const structure =
    detectStructure(c);

  const candle =
    candleAnalysis(c);

  const fvg =
    detectFVG(c);

  const ob =
    orderBlock(c);

  const sr =
    supportResistance(c);

  const rsiValue =
    rsi(c);

  const macdValue =
    macd(c);

  const ichi =
    ichimoku(c);

  const div =
    divergence(c);

  const adxValue =
    adx(c);

  const boll =
    bollWidth(c);

  return {
    price,
    ma7,
    ma20,
    trend,
    maSlope,
    touchMA20,
    touchMA7,
    volume,
    hunt: h,
    bos: structure.bos,
    choch: structure.choch,
    candle,
    fvg,
    orderBlock: ob,
    support: sr.support,
    resistance: sr.resistance,
    rsi: rsiValue,
    macd: macdValue,
    ichimoku: ichi,
    divergence: div,
    atr: atrValue,
    adx: adxValue,
    bollingerWidth: boll,
    market: {
      state:
        volume.ratio >= 1.5
          ? "ACTIVE"
          : "NORMAL"
    }
  };
}

/* ---------------- EXTRA SIGNALS ---------------- */

function extraSignals(c) {
  const m = macd(c);
  const rs = rsi(c);
  const ic = ichimoku(c);
  const dv = divergence(c);

  return {
    MACD: m,

    RSI: {
      value: rs,
      direction:
        rs > 55
          ? "LONG"
          : rs < 45
            ? "SHORT"
            : "NONE"
    },

    ICHIMOKU: ic,

    DIVERGENCE: dv
  };
}

/* ---------------- MARKET TICKER ---------------- */

async function ticker(category, symbol) {
  const d =
    await bybit(
      "/v5/market/tickers",
      {
        category,
        symbol
      }
    );

  return (
    d?.result?.list?.[0] || {}
  );
}

async function oiFunding(symbol) {
  try {
    const t =
      await ticker(
        "linear",
        symbol
      );

    return {
      openInterest:
        n(t.openInterest),

      fundingRate:
        n(t.fundingRate),

      turnover24h:
        n(t.turnover24h),

      change24h:
        n(t.price24hPcnt) * 100
    };
  } catch (e) {
    return {
      error: e.message
    };
  }
}

/* ---------------- FOOTPRINT ---------------- */

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

    const t =
      d?.result?.list || [];

    let buy = 0;
    let sell = 0;
    let largest = 0;

    let buyNotional = 0;
    let sellNotional = 0;

    for (const x of t) {
      const q = n(x.size);
      const p = n(x.price);
      const no = q * p;

      largest =
        Math.max(
          largest,
          no
        );

      if (
        String(x.side).toLowerCase() ===
        "buy"
      ) {
        buy += q;
        buyNotional += no;
      } else {
        sell += q;
        sellNotional += no;
      }
    }

    const total =
      buy + sell;

    const delta =
      buy - sell;

    const totalNotional =
      buyNotional +
      sellNotional;

    return {
      buyVolume: buy,
      sellVolume: sell,

      delta,

      deltaPercent:
        total
          ? delta / total * 100
          : 0,

      buyNotional,
      sellNotional,

      buyNotionalShare:
        totalNotional
          ? buyNotional /
            totalNotional * 100
          : 0,

      sellNotionalShare:
        totalNotional
          ? sellNotional /
            totalNotional * 100
          : 0,

      trades: t.length,

      largeTradeNotional:
        largest,

      pressure:
        Math.abs(
          delta /
          Math.max(total, 1)
        ) * 100 >= 8
          ? delta > 0
            ? "BUY"
            : "SELL"
          : "NEUTRAL"
    };
  } catch (e) {
    return {
      error: e.message
    };
  }
}

/* ---------------- ORDER BOOK ---------------- */

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

    const buyLevels = [];
    const sellLevels = [];

    for (const q of bids) {
      const p = n(q[0]);
      const sz = n(q[1]);

      if (p <= 0 || sz <= 0)
        continue;

      const notional =
        p * sz;

      const distance =
        absPct(
          p,
          price
        );

      if (distance <= 3) {
        buyLevels.push({
          price: p,
          size: sz,
          notional,
          distancePct: distance
        });
      }
    }

    for (const q of asks) {
      const p = n(q[0]);
      const sz = n(q[1]);

      if (p <= 0 || sz <= 0)
        continue;

      const notional =
        p * sz;

      const distance =
        absPct(
          p,
          price
        );

      if (distance <= 3) {
        sellLevels.push({
          price: p,
          size: sz,
          notional,
          distancePct: distance
        });
      }
    }

    buyLevels.sort(
      (a, b) =>
        b.notional -
        a.notional
    );

    sellLevels.sort(
      (a, b) =>
        b.notional -
        a.notional
    );

    const buyLiquidity =
      buyLevels.reduce(
        (s, x) =>
          s + x.notional,
        0
      );

    const sellLiquidity =
      sellLevels.reduce(
        (s, x) =>
          s + x.notional,
        0
      );

    const totalLiquidity =
      buyLiquidity +
      sellLiquidity;

    const buyWall =
      buyLevels[0] || null;

    const sellWall =
      sellLevels[0] || null;

    const avgBuy =
      buyLevels.length
        ? avg(
            buyLevels.map(
              x => x.notional
            )
          )
        : 0;

    const avgSell =
      sellLevels.length
        ? avg(
            sellLevels.map(
              x => x.notional
            )
          )
        : 0;

    const buyStrength =
      buyWall && avgBuy
        ? clamp(
            buyWall.notional /
            avgBuy * 20,
            0,
            100
          )
        : 0;

    const sellStrength =
      sellWall && avgSell
        ? clamp(
            sellWall.notional /
            avgSell * 20,
            0,
            100
          )
        : 0;

    return {
      buy: buyWall,
      sell: sellWall,

      buyLevels:
        buyLevels.slice(0, 10),

      sellLevels:
        sellLevels.slice(0, 10),

      buyLiquidity,
      sellLiquidity,
      totalLiquidity,

      buyShare:
        totalLiquidity
          ? buyLiquidity /
            totalLiquidity * 100
          : 0,

      sellShare:
        totalLiquidity
          ? sellLiquidity /
            totalLiquidity * 100
          : 0,

      buyStrength,
      sellStrength,

      buyNear:
        !!buyWall &&
        buyWall.distancePct <= 1,

      sellNear:
        !!sellWall &&
        sellWall.distancePct <= 1
    };
  } catch (e) {
    return {
      error: e.message
    };
  }
}

/* ---------------- SIGNAL SCORE ---------------- */

function score(
  tf,
  converted = { events: [] },
  strictness = DEFAULT_STRICTNESS,
  methods = DEFAULT_METHODS
) {
  let L = 0;
  let S = 0;

  const reasons = [];

  const enabled =
    new Set(methods);

  const add = (
    dir,
    value,
    text
  ) => {
    if (dir === "L") L += value;
    else S += value;

    if (text) {
      reasons.push({
        side:
          dir === "L"
            ? "LONG"
            : "SHORT",
        text
      });
    }
  };

  for (const [k, x] of Object.entries(tf)) {
    if (!x || x.error)
      continue;

    const w =
      k === "1"
        ? 1.5
        : k === "60"
          ? 1.3
          : 1;

    if (
      enabled.has("MA") &&
      x.touchMA20
    ) {
      if (x.trend === "BULLISH") {
        add(
          "L",
          12 * w,
          `برخورد MA20 در ${k}m`
        );
      }

      if (x.trend === "BEARISH") {
        add(
          "S",
          12 * w,
          `برخورد MA20 در ${k}m`
        );
      }
    }

    if (
      enabled.has("MA") &&
      x.touchMA7
    ) {
      if (x.trend === "BULLISH") {
        add(
          "L",
          10 * w,
          `برخورد MA7 در ${k}m`
        );
      }

      if (x.trend === "BEARISH") {
        add(
          "S",
          10 * w,
          `برخورد MA7 در ${k}m`
        );
      }
    }

    if (
      enabled.has("MA") &&
      x.maSlope === "UP"
    ) {
      add(
        "L",
        5 * w,
        `شیب MA صعودی ${k}m`
      );
    }

    if (
      enabled.has("MA") &&
      x.maSlope === "DOWN"
    ) {
      add(
        "S",
        5 * w,
        `شیب MA نزولی ${k}m`
      );
    }

    if (
      enabled.has("HUNT") &&
      x.hunt?.side === "LONG"
    ) {
      add(
        "L",
        12 * w,
        "Hunt / Liquidity Sweep صعودی"
      );
    }

    if (
      enabled.has("HUNT") &&
      x.hunt?.side === "SHORT"
    ) {
      add(
        "S",
        12 * w,
        "Hunt / Liquidity Sweep نزولی"
      );
    }

    if (
      enabled.has("BOS") &&
      x.bos === "BULLISH"
    ) {
      add(
        "L",
        7 * w,
        "BOS صعودی"
      );
    }

    if (
      enabled.has("BOS") &&
      x.bos === "BEARISH"
    ) {
      add(
        "S",
        7 * w,
        "BOS نزولی"
      );
    }

    if (
      enabled.has("CHOCH") &&
      x.choch === "BULLISH"
    ) {
      add(
        "L",
        7 * w,
        "CHoCH صعودی"
      );
    }

    if (
      enabled.has("CHOCH") &&
      x.choch === "BEARISH"
    ) {
      add(
        "S",
        7 * w,
        "CHoCH نزولی"
      );
    }

    if (
      enabled.has("VOLUME") &&
      x.volume?.spike
    ) {
      add(
        x.trend === "BEARISH"
          ? "S"
          : "L",
        5 * w,
        "افزایش غیرعادی حجم کوتاه‌مدت"
      );
    }

    if (
      enabled.has("MACD") &&
      x.macd?.direction === "LONG"
    ) {
      add(
        "L",
        5 * w,
        `MACD صعودی ${k}m`
      );
    }

    if (
      enabled.has("MACD") &&
      x.macd?.direction === "SHORT"
    ) {
      add(
        "S",
        5 * w,
        `MACD نزولی ${k}m`
      );
    }

    if (
      enabled.has("RSI") &&
      x.rsi > 55
    ) {
      add(
        "L",
        4 * w,
        `RSI صعودی ${k}m`
      );
    }

    if (
      enabled.has("RSI") &&
      x.rsi < 45
    ) {
      add(
        "S",
        4 * w,
        `RSI نزولی ${k}m`
      );
    }

    if (
      enabled.has("ICHIMOKU") &&
      x.ichimoku?.direction === "LONG"
    ) {
      add(
        "L",
        5 * w,
        `Ichimoku صعودی ${k}m`
      );
    }

    if (
      enabled.has("ICHIMOKU") &&
      x.ichimoku?.direction === "SHORT"
    ) {
      add(
        "S",
        5 * w,
        `Ichimoku نزولی ${k}m`
      );
    }

    if (
      enabled.has("DIVERGENCE") &&
      x.divergence?.side === "LONG"
    ) {
      add(
        "L",
        8 * w,
        `واگرایی صعودی ${k}m`
      );
    }

    if (
      enabled.has("DIVERGENCE") &&
      x.divergence?.side === "SHORT"
    ) {
      add(
        "S",
        8 * w,
        `واگرایی نزولی ${k}m`
      );
    }

    if (
      enabled.has("FVG") &&
      x.fvg?.type === "BULLISH"
    ) {
      add(
        "L",
        4 * w,
        `FVG صعودی ${k}m`
      );
    }

    if (
      enabled.has("FVG") &&
      x.fvg?.type === "BEARISH"
    ) {
      add(
        "S",
        4 * w,
        `FVG نزولی ${k}m`
      );
    }

    if (
      enabled.has("ORDER_BLOCK") &&
      x.orderBlock?.type === "BULLISH"
    ) {
      add(
        "L",
        5 * w,
        `Order Block صعودی ${k}m`
      );
    }

    if (
      enabled.has("ORDER_BLOCK") &&
      x.orderBlock?.type === "BEARISH"
    ) {
      add(
        "S",
        5 * w,
        `Order Block نزولی ${k}m`
      );
    }
  }

  for (
    const e of
    (converted.events || [])
      .filter(x => x.type !== "NONE")
  ) {
    const w =
      e.source === "1h"
        ? 1.5
        : e.source === "15m"
          ? 1.3
          : e.source === "5m"
            ? 1.15
            : 1;

    if (
      e.confirmation ===
      "CONFIRMED_LONG"
    ) {
      add(
        "L",
        12 * w,
        `${e.ma} ${e.source} → MA${e.period1m} روی 1m: برخورد و تأیید صعودی`
      );
    } else if (
      e.confirmation ===
      "CONFIRMED_SHORT"
    ) {
      add(
        "S",
        12 * w,
        `${e.ma} ${e.source} → MA${e.period1m} روی 1m: برخورد و تأیید نزولی`
      );
    }
  }

  const strictFactor =
    0.75 +
    clamp(
      n(strictness, 3),
      1,
      6
    ) * 0.05;

  L *= strictFactor;
  S *= strictFactor;

  return {
    L,
    S,
    reasons,
    strictness
  };
}

/* ---------------- CONVERTED MA ---------------- */

function convertedMA(
  tf,
  oneMinute
) {
  const events = [];

  for (
    const cfg of CONVERTED_MAS["1m"]
  ) {
    const source =
      tf[cfg.source === "1h"
        ? "60"
        : cfg.source.replace("m", "")
      ];

    if (!source)
      continue;

    const sourceMA =
      cfg.period === 7
        ? source.ma7
        : source.ma20;

    const price =
      oneMinute?.price || 0;

    if (!sourceMA || !price)
      continue;

    const distance =
      absPct(
        price,
        sourceMA
      );

    if (distance <= 0.4) {
      events.push({
        type: "TOUCH",
        source: cfg.source,
        period1m: cfg.period,
        ma: `MA${cfg.period}`,
        value: sourceMA,
        distancePct: distance,
        slope:
          source.maSlope === "UP"
            ? "UP"
            : source.maSlope === "DOWN"
              ? "DOWN"
              : "FLAT",
        confirmation:
          price > sourceMA &&
          source.maSlope === "UP"
            ? "CONFIRMED_LONG"
            : price < sourceMA &&
                source.maSlope === "DOWN"
              ? "CONFIRMED_SHORT"
              : "NONE"
      });
    }
  }

  return {
    events
  };
}

/* ---------------- DEEP ANALYSIS ---------------- */

async function deepAnalyze(
  category,
  symbol,
  settings = {}
) {
  const tf = {};

  for (const t of TF) {
    try {
      const c =
        await klines(
          category,
          symbol,
          t.interval,
          t.limit
        );

      tf[t.interval] =
        analyzeCandles(c);

      tf[t.interval].extra =
        extraSignals(c);
    } catch (e) {
      tf[t.interval] = {
        error: e.message
      };
    }
  }

  const one =
    tf["1"];

  const converted =
    convertedMA(
      tf,
      one
    );

  const market =
    await oiFunding(symbol);

  const price =
    one?.price || 0;

  const fp =
    await footprint(
      category,
      symbol
    );

  const wall =
    await walls(
      category,
      symbol,
      price
    );

  const sc =
    score(
      tf,
      converted,
      settings.strictness ??
        DEFAULT_STRICTNESS,
      settings.methods ??
        DEFAULT_METHODS
    );

  if (
    fp &&
    !fp.error
  ) {
    if (fp.deltaPercent >= 8)
      sc.L += 10;

    if (fp.deltaPercent <= -8)
      sc.S += 10;
  }

  if (wall.sellNear)
    sc.S += 3;

  if (wall.buyNear)
    sc.L += 3;

  const direction =
    sc.L > sc.S &&
    sc.L >= MIN_SIGNAL_SCORE
      ? "LONG"
      : sc.S > sc.L &&
          sc.S >= MIN_SIGNAL_SCORE
        ? "SHORT"
        : "WAIT";

  const top =
    direction === "LONG"
      ? sc.L
      : direction === "SHORT"
        ? sc.S
        : Math.max(sc.L, sc.S);

  const pump =
    clamp(
      sc.L * 1.2 +
      (
        market.change24h > 0
          ? market.change24h * 2
          : 0
      ) +
      (
        tf["1"]?.volume?.spike
          ? 15
          : 0
      ) +
      (
        tf["5"]?.volume?.spike
          ? 10
          : 0
      ),
      0,
      100
    );

  const dump =
    clamp(
      sc.S * 1.2 +
      (
        market.change24h < 0
          ? Math.abs(
              market.change24h
            ) * 2
          : 0
      ) +
      (
        tf["1"]?.volume?.spike
          ? 15
          : 0
      ) +
      (
        tf["5"]?.volume?.spike
          ? 10
          : 0
      ),
      0,
      100
    );

  return {
    symbol,
    category,
    price,

    direction,

    score:
      Math.round(
        clamp(
          top,
          0,
          100
        )
      ),

    longScore:
      Math.round(
        clamp(
          sc.L,
          0,
          100
        )
      ),

    shortScore:
      Math.round(
        clamp(
          sc.S,
          0,
          100
        )
      ),

    pumpScore:
      Math.round(pump),

    dumpScore:
      Math.round(dump),

    timeframes: tf,

    convertedMA1m:
      converted,

    footprint: fp,

    walls: wall,

    market,

    reasons:
      sc.reasons,

    generatedAt:
      Date.now(),

    liquidation: {
      available: false,
      message:
        "داده لیکوئیدیشن تجمیعی از REST عمومی Bybit برای این اسکنر در دسترس نیست."
    }
  };
}

/* ---------------- MARKET INSTRUMENTS ---------------- */

async function instruments(
  category
) {
  const all = [];
  let cursor = "";

  for (
    let page = 0;
    page < 5;
    page++
  ) {
    const d =
      await bybit(
        "/v5/market/instruments-info",
        {
          category,
          limit: 1000,
          ...(cursor
            ? { cursor }
            : {})
        }
      );

    all.push(
      ...(d?.result?.list || [])
    );

    cursor =
      d?.result?.nextPageCursor ||
      "";

    if (!cursor)
      break;
  }

  return all;
}

function validFutures(list) {
  return list.filter(
    x =>
      x.status === "Trading" &&
      x.quoteCoin === "USDT" &&
      x.contractType ===
        "LinearPerpetual"
  );
}

/* ---------------- MANUAL SEARCH ---------------- */

async function findSymbol(input) {
  const raw =
    String(input || "")
      .trim()
      .toUpperCase();

  const bare =
    raw
      .replace(
        /[-_/:\s]/g,
        ""
      )
      .replace(
        /USDT$/,
        ""
      );

  const [
    lin,
    spot
  ] = await Promise.all([
    instruments("linear"),
    instruments("spot")
  ]);

  const l =
    lin.find(
      x =>
        String(x.symbol)
          .toUpperCase() === raw ||
        String(x.symbol)
          .toUpperCase() ===
          bare + "USDT"
    );

  const s =
    spot.find(
      x =>
        String(x.symbol)
          .toUpperCase() === raw ||
        String(x.symbol)
          .toUpperCase() ===
          bare + "USDT"
    );

  return {
    input: raw,

    selected:
      l
        ? "FUTURES"
        : s
          ? "SPOT"
          : null,

    futures:
      l
        ? {
            symbol: l.symbol,
            status: l.status,
            baseCoin: l.baseCoin,
            quoteCoin: l.quoteCoin
          }
        : null,

    spot:
      s
        ? {
            symbol: s.symbol,
            status: s.status,
            baseCoin: s.baseCoin,
            quoteCoin: s.quoteCoin
          }
        : null
  };
}

/* ---------------- SCAN ---------------- */

async function scan(
  offset = 0,
  settings = {}
) {
  const ms =
    validFutures(
      await instruments(
        "linear"
      )
    ).sort(
      (a, b) =>
        String(a.symbol)
          .localeCompare(
            String(b.symbol)
          )
    );

  if (!ms.length) {
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
          ms.length - 1
        )
      )
    );

  const batch =
    ms.slice(
      safeOffset,
      safeOffset +
        SCAN_BATCH
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

      if (a.error)
        continue;

      let activity = 0;

      if (a.touchMA20)
        activity += 20;

      if (a.touchMA7)
        activity += 10;

      if (a.volume.spike)
        activity += 20;

      if (
        a.market.state ===
        "ACTIVE"
      )
        activity += 15;

      if (a.hunt.confirmed)
        activity += 20;

      if (a.bos !== "NONE")
        activity += 10;

      if (a.choch !== "NONE")
        activity += 15;

      if (
        a.fvg.type !== "NONE"
      )
        activity += 5;

      light.push({
        symbol: m.symbol,
        activity
      });
    } catch (e) {}
  }

  light.sort(
    (a, b) =>
      b.activity -
      a.activity
  );

  const deep =
    await Promise.all(
      light
        .slice(
          0,
          DEEP_LIMIT
        )
        .map(
          x =>
            deepAnalyze(
              "linear",
              x.symbol,
              settings
            )
        )
    );

  deep.sort(
    (a, b) =>
      b.score - a.score
  );

  const next =
    (safeOffset +
      SCAN_BATCH) %
    ms.length;

  return {
    ok: true,

    totalMarkets:
      ms.length,

    offset:
      safeOffset,

    batchSize:
      batch.length,

    nextOffset:
      next,

    results:
      deep,

    scannedSymbols:
      batch.map(
        x => x.symbol
      ),

    note:
      "حجم ۲۴ساعته فقط اطلاعات جانبی است و معیار انتخاب نیست؛ اسکن بازار به‌صورت چرخشی انجام می‌شود تا محدودیت درخواست Cloudflare رعایت شود."
  };
}

/* ---------------- ROUTER ---------------- */

export default {
  async fetch(
    request,
    env
  ) {
    const u =
      new URL(
        request.url
      );

    const p =
      u.pathname;

    try {
      if (
        p ===
        "/api/search"
      ) {
        const q =
          u.searchParams.get(
            "symbol"
          );

        if (!q) {
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
          await findSymbol(q);

        return json({
          ok: true,
          ...found
        });
      }

      if (
        p ===
        "/api/analyze"
      ) {
        const symbol =
          u.searchParams.get(
            "symbol"
          );

        const category =
          (
            u.searchParams.get(
              "category"
            ) || "auto"
          ).toLowerCase();

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
            : category === "linear"
              ? found.futures
              : (
                  found.futures ||
                  found.spot
                );

        if (!chosen) {
          return json(
            {
              ok: false,
              error:
                `${symbol} در Spot یا Futures Bybit پیدا نشد.`,
              search: found
            },
            404
          );
        }

        const chosenCategory =
          chosen ===
          found.futures
            ? "linear"
            : "spot";

        return json({
          ok: true,

          ...await deepAnalyze(
            chosenCategory,
            chosen.symbol,
            {}
          ),

          search: found
        });
      }

      if (
        p ===
        "/api/scan"
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

      if (
        p ===
        "/api/health"
      ) {
        return json({
          ok: true,

          service:
            "Bybit Smart Money Scanner",

          version:
            "V10",

          timeframes:
            TF.map(
              x => x.interval
            ),

          scanBatch:
            SCAN_BATCH,

          deepLimit:
            DEEP_LIMIT,

          minimumSignalScore:
            MIN_SIGNAL_SCORE,

          watchScore:
            WATCH_SCORE,

          defaultStrictness:
            DEFAULT_STRICTNESS,

          signalMethods:
            DEFAULT_METHODS,

          convertedMA:
            CONVERTED_MAS,

          features: [
            "MA",
            "MACD",
            "RSI",
            "Ichimoku",
            "Divergence",
            "Liquidity Hunt",
            "FVG",
            "BOS",
            "CHoCH",
            "Order Block",
            "Candle Analysis",
            "Volume Spike",
            "ADX",
            "ATR",
            "Bollinger Width",
            "Order Book",
            "Buy Wall",
            "Sell Wall",
            "Support",
            "Resistance",
            "OI Current/Previous/Change",
            "Funding Current/Previous/Change",
            "Footprint",
            "Delta"
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
          error: e.message,
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
