const DATA_API = "https://api.bybit.com";

const SCAN_BATCH = 20;
const DEEP_LIMIT = 3;
const RADAR_LIMIT = 5;
const DEEP_1M_LIMIT = 500;

const DEFAULT_SIGNAL_SCORE = 75;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*"
    }
  });

const n = (v, d = 0) =>
  Number.isFinite(Number(v)) ? Number(v) : d;

const clamp = (v, a, b) =>
  Math.max(a, Math.min(b, v));

const avg = a =>
  a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;

function pct(a, b) {
  if (!b) return 0;
  return ((a - b) / b) * 100;
}

function absPct(a, b) {
  if (!b) return 999;
  return Math.abs((a - b) / b) * 100;
}

async function api(path, params = {}) {
  const u = new URL(DATA_API + path);

  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") {
      u.searchParams.set(k, String(v));
    }
  }

  const r = await fetch(u, {
    headers: {
      accept: "application/json"
    }
  });

  if (!r.ok) {
    throw new Error(`DATA_HTTP_${r.status}`);
  }

  const d = await r.json();

  if (d.retCode !== 0) {
    throw new Error(d.retMsg || `DATA_${d.retCode}`);
  }

  return d;
}

/* =========================================================
   KLINES
========================================================= */

async function klines(category, symbol, interval, limit = 100) {
  const d = await api("/v5/market/kline", {
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

/* =========================================================
   MA
========================================================= */

function sma(a, p) {
  if (!a.length) return 0;
  return avg(a.slice(-p));
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

/* =========================================================
   RSI
========================================================= */

function rsi(c, p = 14) {
  if (c.length < p + 1) return 50;

  let gain = 0;
  let loss = 0;

  for (let i = c.length - p; i < c.length; i++) {
    const d = c[i].close - c[i - 1].close;

    if (d > 0) gain += d;
    else loss += Math.abs(d);
  }

  if (!loss) return 100;

  const rs = gain / loss;

  return 100 - 100 / (1 + rs);
}

/* =========================================================
   MACD
========================================================= */

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

  const histogram =
    line.at(-1) - signal;

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

/* =========================================================
   ATR / ADX / BOLLINGER
========================================================= */

function atr(c, p = 14) {
  if (c.length < 2) return 0;

  const tr = [];

  for (let i = 1; i < c.length; i++) {
    const x = c[i];
    const q = c[i - 1];

    tr.push(
      Math.max(
        x.high - x.low,
        Math.abs(x.high - q.close),
        Math.abs(x.low - q.close)
      )
    );
  }

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

  const dx = [];

  for (let i = p; i < trs.length; i++) {
    const tr = avg(trs.slice(i - p, i)) || 1;

    const dp =
      100 * avg(plus.slice(i - p, i)) / tr;

    const dm =
      100 * avg(minus.slice(i - p, i)) / tr;

    dx.push(
      dp + dm
        ? 100 * Math.abs(dp - dm) / (dp + dm)
        : 0
    );
  }

  return avg(dx.slice(-p));
}

function bollWidth(c, p = 20) {
  const a = c.slice(-p).map(x => x.close);

  if (!a.length) return 0;

  const m = avg(a);

  const sd = Math.sqrt(
    avg(a.map(x => (x - m) ** 2))
  );

  return m ? 4 * sd / m * 100 : 0;
}

/* =========================================================
   SWINGS
========================================================= */

function swingLevels(c, lookback = 2) {
  const highs = [];
  const lows = [];

  for (
    let i = lookback;
    i < c.length - lookback;
    i++
  ) {
    let high = true;
    let low = true;

    for (let j = 1; j <= lookback; j++) {
      if (
        c[i].high <= c[i - j].high ||
        c[i].high < c[i + j].high
      ) {
        high = false;
      }

      if (
        c[i].low >= c[i - j].low ||
        c[i].low > c[i + j].low
      ) {
        low = false;
      }
    }

    if (high) {
      highs.push({
        price: c[i].high,
        time: c[i].time
      });
    }

    if (low) {
      lows.push({
        price: c[i].low,
        time: c[i].time
      });
    }
  }

  return { highs, lows };
}

/* =========================================================
   HUNT
========================================================= */

function hunt(c) {
  if (c.length < 25) {
    return {
      side: "NONE",
      confirmed: false,
      type: "NONE"
    };
  }

  const x = c.at(-1);

  const prev = c.slice(-21, -1);

  const hi = Math.max(
    ...prev.map(z => z.high)
  );

  const lo = Math.min(
    ...prev.map(z => z.low)
  );

  const range = x.high - x.low || 1;

  const lower =
    Math.min(x.open, x.close) - x.low;

  const upper =
    x.high - Math.max(x.open, x.close);

  const va = sma(
    prev.map(z => z.volume),
    20
  );

  const volumeConfirmed =
    va > 0 &&
    x.volume >= va * 1.15;

  const longSweep =
    x.low < lo &&
    x.close > lo &&
    lower / range >= 0.25;

  const shortSweep =
    x.high > hi &&
    x.close < hi &&
    upper / range >= 0.25;

  if (longSweep) {
    return {
      type: "LIQUIDITY_SWEEP",
      side: "LONG",
      level: lo,
      confirmed:
        volumeConfirmed ||
        lower / range >= 0.4,
      volumeConfirmed
    };
  }

  if (shortSweep) {
    return {
      type: "LIQUIDITY_SWEEP",
      side: "SHORT",
      level: hi,
      confirmed:
        volumeConfirmed ||
        upper / range >= 0.4,
      volumeConfirmed
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

function detectFVG(c) {
  if (c.length < 3) {
    return { type: "NONE" };
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

  return { type: "NONE" };
}

/* =========================================================
   STRUCTURE
========================================================= */

function structure(c) {
  const s = swingLevels(c, 2);

  const h = s.highs;
  const l = s.lows;

  const lastH = h.at(-1)?.price || null;
  const prevH = h.at(-2)?.price || null;

  const lastL = l.at(-1)?.price || null;
  const prevL = l.at(-2)?.price || null;

  const price = c.at(-1)?.close || 0;

  let bos = "NONE";
  let choch = "NONE";

  if (lastH && price > lastH) {
    bos = "BULLISH";
  }

  if (lastL && price < lastL) {
    bos = "BEARISH";
  }

  if (
    prevL &&
    lastL &&
    prevH &&
    lastH
  ) {
    if (
      lastL > prevL &&
      lastH > prevH &&
      price < lastL
    ) {
      choch = "BEARISH";
    }

    if (
      lastL < prevL &&
      lastH < prevH &&
      price > lastH
    ) {
      choch = "BULLISH";
    }
  }

  return {
    bos,
    choch,
    swingHigh: lastH,
    swingLow: lastL
  };
}

/* =========================================================
   ORDER BLOCK
========================================================= */

function orderBlock(c) {
  if (c.length < 8) {
    return { type: "NONE" };
  }

  const x = c.at(-1);

  for (
    let i = c.length - 4;
    i >= Math.max(0, c.length - 12);
    i--
  ) {
    const z = c[i];

    if (
      z.close < z.open &&
      x.close > z.high
    ) {
      return {
        type: "BULLISH",
        low: z.low,
        high: z.high
      };
    }

    if (
      z.close > z.open &&
      x.close < z.low
    ) {
      return {
        type: "BEARISH",
        low: z.low,
        high: z.high
      };
    }
  }

  return { type: "NONE" };
}

/* =========================================================
   CANDLE
========================================================= */

function candle(c) {
  const x = c.at(-1);
  const p = c.at(-2);

  if (!x || !p) {
    return { type: "NONE" };
  }

  const range = x.high - x.low || 1;

  const body =
    Math.abs(x.close - x.open);

  const upper =
    x.high - Math.max(x.open, x.close);

  const lower =
    Math.min(x.open, x.close) - x.low;

  let type = "NORMAL";

  if (
    lower > body * 2 &&
    lower / range > 0.45
  ) {
    type = "HAMMER";
  }

  if (
    upper > body * 2 &&
    upper / range > 0.45
  ) {
    type = "SHOOTING_STAR";
  }

  if (
    x.close > p.open &&
    x.open < p.close &&
    x.close >= p.close &&
    x.open <= p.open
  ) {
    type = "BULLISH_ENGULFING";
  }

  if (
    x.close < p.open &&
    x.open > p.close &&
    x.close <= p.close &&
    x.open >= p.open
  ) {
    type = "BEARISH_ENGULFING";
  }

  if (body / range < 0.15) {
    type = "DOJI";
  }

  return {
    type,
    bullish: x.close > x.open,
    bearish: x.close < x.open,
    bodyRatio: body / range,
    upperWick: upper,
    lowerWick: lower
  };
}

/* =========================================================
   ICHIMOKU
========================================================= */

function ichimoku(c) {
  if (c.length < 52) {
    return {
      direction: "NONE",
      score: 0
    };
  }

  const mid = (a, b) => (a + b) / 2;

  const high9 = Math.max(
    ...c.slice(-9).map(x => x.high)
  );

  const low9 = Math.min(
    ...c.slice(-9).map(x => x.low)
  );

  const high26 = Math.max(
    ...c.slice(-26).map(x => x.high)
  );

  const low26 = Math.min(
    ...c.slice(-26).map(x => x.low)
  );

  const tenkan = mid(high9, low9);
  const kijun = mid(high26, low26);

  const price = c.at(-1).close;

  let score = 0;

  if (price > tenkan) score += 1;
  if (price > kijun) score += 1;
  if (tenkan > kijun) score += 1;

  return {
    tenkan,
    kijun,
    direction:
      score >= 2
        ? "LONG"
        : score <= 1
          ? "SHORT"
          : "NONE",
    score
  };
}

/* =========================================================
   ANALYSIS
========================================================= */

function analyze(c) {
  if (c.length < 30) {
    return {
      error: "INSUFFICIENT_DATA"
    };
  }

  const close = c.map(x => x.close);
  const price = close.at(-1);

  const ma7 = sma(close, 7);
  const ma20 = sma(close, 20);

  const prev20 =
    sma(close.slice(0, -1), 20);

  const slope =
    prev20
      ? (ma20 - prev20) / prev20
      : 0;

  const vol7 =
    sma(c.map(x => x.volume), 7);

  const vol20 =
    sma(c.map(x => x.volume), 20);

  const volumeSpike =
    c.at(-1).volume >
      vol20 * 1.5 ||
    c.at(-1).volume >
      vol7 * 1.8;

  const h = hunt(c);
  const st = structure(c);
  const fvg = detectFVG(c);
  const ob = orderBlock(c);
  const cd = candle(c);
  const mac = macd(c);
  const rs = rsi(c);
  const ichi = ichimoku(c);

  const trend =
    price > ma20 && ma7 > ma20
      ? "BULLISH"
      : price < ma20 && ma7 < ma20
        ? "BEARISH"
        : "RANGE";

  const adxV = adx(c);

  return {
    price,
    ma7,
    ma20,

    maSlope:
      slope > 0.00007
        ? "UP"
        : slope < -0.00007
          ? "DOWN"
          : "FLAT",

    trend,

    touchMA20:
      Math.abs(price - ma20) / ma20 <= 0.002 ||
      (
        c.at(-1).low <= ma20 &&
        c.at(-1).high >= ma20
      ),

    touchMA7:
      Math.abs(price - ma7) / ma7 <= 0.002 ||
      (
        c.at(-1).low <= ma7 &&
        c.at(-1).high >= ma7
      ),

    volume: {
      current: c.at(-1).volume,
      ma7: vol7,
      ma20: vol20,
      spike: volumeSpike,
      ratio:
        vol20
          ? c.at(-1).volume / vol20
          : 0
    },

    market: {
      adx: adxV,
      atr: atr(c),
      bollWidth: bollWidth(c),
      state:
        adxV < 18
          ? "RANGE"
          : "ACTIVE"
    },

    hunt: h,
    fvg,
    bos: st.bos,
    choch: st.choch,
    structure: st,
    orderBlock: ob,
    candle: cd.type,
    candleDetails: cd,

    macd: mac,
    rsi: rs,
    ichimoku: ichi
  };
}

/* =========================================================
   FOOTPRINT
========================================================= */

async function footprint(category, symbol) {
  try {
    const d = await api(
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

    for (const t of trades) {
      const size = n(t.size);

      if (
        String(t.side).toLowerCase() === "buy"
      ) {
        buy += size;
      } else {
        sell += size;
      }
    }

    const total = buy + sell;

    return {
      buyVolume: buy,
      sellVolume: sell,
      delta: buy - sell,
      deltaPercent:
        total
          ? (buy - sell) / total * 100
          : 0,
      trades: trades.length
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

async function walls(category, symbol, price) {
  try {
    const d = await api(
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
            x.price > 0 &&
            x.size > 0 &&
            absPct(x.price, price) <= 3
        )
        .map(x => ({
          ...x,
          notional: x.price * x.size,
          distancePct:
            absPct(x.price, price)
        }))
        .sort(
          (a, b) =>
            b.notional - a.notional
        );

    const sellLevels =
      asks
        .map(x => ({
          price: n(x[0]),
          size: n(x[1])
        }))
        .filter(
          x =>
            x.price > 0 &&
            x.size > 0 &&
            absPct(x.price, price) <= 3
        )
        .map(x => ({
          ...x,
          notional: x.price * x.size,
          distancePct:
            absPct(x.price, price)
        }))
        .sort(
          (a, b) =>
            b.notional - a.notional
        );

    const buy = buyLevels[0] || null;
    const sell = sellLevels[0] || null;

    return {
      buy,
      sell,

      buyLevels: buyLevels.slice(0, 10),
      sellLevels: sellLevels.slice(0, 10),

      buyNear:
        !!buy && buy.distancePct <= 1,

      sellNear:
        !!sell && sell.distancePct <= 1,

      buyStrength:
        buy
          ? 100
          : 0,

      sellStrength:
        sell
          ? 100
          : 0
    };
  } catch (e) {
    return {
      error: e.message
    };
  }
}

/* =========================================================
   MARKET INFO
========================================================= */

async function marketInfo(category, symbol) {
  try {
    const d = await api(
      "/v5/market/tickers",
      {
        category,
        symbol
      }
    );

    const x =
      d?.result?.list?.[0];

    if (!x) {
      return {};
    }

    return {
      openInterest:
        category === "linear"
          ? n(x.openInterest)
          : null,

      fundingRate:
        category === "linear"
          ? n(x.fundingRate)
          : null,

      turnover24h:
        n(x.turnover24h),

      change24h:
        n(x.price24hPcnt) * 100,

      markPrice:
        category === "linear"
          ? n(x.markPrice)
          : null,

      indexPrice:
        category === "linear"
          ? n(x.indexPrice)
          : null
    };
  } catch (e) {
    return {
      error: e.message
    };
  }
}

/* =========================================================
   INSTRUMENTS
========================================================= */

async function instruments(category) {
  const all = [];

  let cursor = "";

  for (let page = 0; page < 5; page++) {
    const d = await api(
      "/v5/market/instruments-info",
      {
        category,
        limit: 1000,
        cursor: cursor || undefined
      }
    );

    const list =
      d?.result?.list || [];

    all.push(...list);

    cursor =
      d?.result?.nextPageCursor || "";

    if (!cursor || !list.length) {
      break;
    }
  }

  return all;
}

function validLinear(list) {
  return list.filter(
    x =>
      x.status === "Trading" &&
      x.quoteCoin === "USDT" &&
      x.contractType === "LinearPerpetual"
  );
}

function validSpot(list) {
  return list.filter(
    x =>
      x.status === "Trading" &&
      x.quoteCoin === "USDT"
  );
}

/* =========================================================
   AUTOMATIC SYMBOL SEARCH
========================================================= */

async function searchSymbol(input) {
  const raw =
    String(input || "")
      .trim()
      .toUpperCase();

  if (!raw) {
    return null;
  }

  const bare =
    raw
      .replace(/[-_/:\s]/g, "")
      .replace(/USDT$/, "");

  const target =
    bare + "USDT";

  const [linear, spot] =
    await Promise.all([
      instruments("linear"),
      instruments("spot")
    ]);

  const futures =
    validLinear(linear)
      .find(
        x =>
          String(x.symbol).toUpperCase() === target ||
          String(x.symbol).toUpperCase() === raw
      );

  if (futures) {
    return {
      category: "linear",
      symbol: futures.symbol,
      type: "FUTURES"
    };
  }

  const spotMarket =
    validSpot(spot)
      .find(
        x =>
          String(x.symbol).toUpperCase() === target ||
          String(x.symbol).toUpperCase() === raw
      );

  if (spotMarket) {
    return {
      category: "spot",
      symbol: spotMarket.symbol,
      type: "SPOT"
    };
  }

  return null;
}

/* =========================================================
   SCORING
========================================================= */

function calculateScore(a, fp, wall, enabled = []) {
  const use =
    name =>
      !enabled.length ||
      enabled.includes(name);

  let L = 0;
  let S = 0;

  const lr = [];
  const sr = [];

  function add(dir, score, reason) {
    if (dir === "L") {
      L += score;
      lr.push(reason);
    }

    if (dir === "S") {
      S += score;
      sr.push(reason);
    }
  }

  if (use("ma")) {
    if (
      a.trend === "BULLISH" &&
      a.maSlope === "UP"
    ) {
      add(
        "L",
        8,
        "مووینگ میانگین در جهت صعود"
      );
    }

    if (
      a.trend === "BEARISH" &&
      a.maSlope === "DOWN"
    ) {
      add(
        "S",
        8,
        "مووینگ میانگین در جهت نزول"
      );
    }
  }

  if (use("smart")) {
    if (a.hunt.side === "LONG" && a.hunt.confirmed) {
      add(
        "L",
        12,
        "شکار نقدینگی صعودی تأیید شد"
      );
    }

    if (a.hunt.side === "SHORT" && a.hunt.confirmed) {
      add(
        "S",
        12,
        "شکار نقدینگی نزولی تأیید شد"
      );
    }

    if (a.bos === "BULLISH") {
      add("L", 8, "شکست ساختار صعودی");
    }

    if (a.bos === "BEARISH") {
      add("S", 8, "شکست ساختار نزولی");
    }

    if (a.choch === "BULLISH") {
      add("L", 10, "تغییر شخصیت صعودی");
    }

    if (a.choch === "BEARISH") {
      add("S", 10, "تغییر شخصیت نزولی");
    }

    if (a.orderBlock.type === "BULLISH") {
      add("L", 5, "Order Block صعودی");
    }

    if (a.orderBlock.type === "BEARISH") {
      add("S", 5, "Order Block نزولی");
    }
  }

  if (use("ict")) {
    if (a.fvg.type === "BULLISH") {
      add("L", 6, "FVG صعودی");
    }

    if (a.fvg.type === "BEARISH") {
      add("S", 6, "FVG نزولی");
    }
  }

  if (use("macd")) {
    if (a.macd.direction === "LONG") {
      add("L", 8, "MACD صعودی");
    }

    if (a.macd.direction === "SHORT") {
      add("S", 8, "MACD نزولی");
    }
  }

  if (use("rsi")) {
    if (a.rsi <= 30) {
      add("L", 8, "RSI در ناحیه اشباع فروش");
    }

    if (a.rsi >= 70) {
      add("S", 8, "RSI در ناحیه اشباع خرید");
    }
  }

  if (use("ichimoku")) {
    if (a.ichimoku.direction === "LONG") {
      add("L", 7, "ایچیموکو صعودی");
    }

    if (a.ichimoku.direction === "SHORT") {
      add("S", 7, "ایچیموکو نزولی");
    }
  }

  if (use("volume") && a.volume.spike) {
    if (a.trend === "BULLISH") {
      add("L", 7, "افزایش حجم در جهت صعود");
    }

    if (a.trend === "BEARISH") {
      add("S", 7, "افزایش حجم در جهت نزول");
    }
  }

  if (
    use("orderflow") &&
    fp &&
    !fp.error
  ) {
    if (fp.deltaPercent >= 8) {
      add("L", 10, "جریان سفارش خریداران قوی‌تر است");
    }

    if (fp.deltaPercent <= -8) {
      add("S", 10, "جریان سفارش فروشندگان قوی‌تر است");
    }
  }

  if (
    use("liquidity") &&
    wall &&
    !wall.error
  ) {
    if (
      wall.buyNear &&
      wall.buyStrength >= 60
    ) {
      add("L", 6, "نقدینگی خرید نزدیک قیمت");
    }

    if (
      wall.sellNear &&
      wall.sellStrength >= 60
    ) {
      add("S", 6, "نقدینگی فروش نزدیک قیمت");
    }
  }

  if (
    use("sr")
  ) {
    if (
      a.hunt.side === "LONG"
    ) {
      add("L", 4, "واکنش احتمالی از حمایت");
    }

    if (
      a.hunt.side === "SHORT"
    ) {
      add("S", 4, "واکنش احتمالی از مقاومت");
    }
  }

  if (
    use("oi") &&
    a.market?.openInterest
  ) {
    if (
      a.trend === "BULLISH"
    ) {
      add("L", 4, "OI در تحلیل صعودی");
    }

    if (
      a.trend === "BEARISH"
    ) {
      add("S", 4, "OI در تحلیل نزولی");
    }
  }

  return {
    long: Math.round(clamp(L, 0, 100)),
    short: Math.round(clamp(S, 0, 100)),
    longReasons: lr,
    shortReasons: sr
  };
}

/* =========================================================
   DEEP ANALYSIS
========================================================= */

async function deepAnalyze(
  category,
  symbol,
  enabled = [],
  threshold = DEFAULT_SIGNAL_SCORE
) {
  const intervals = [
    ["1", "1"],
    ["3", "3"],
    ["5", "5"],
    ["15", "15"],
    ["60", "60"]
  ];

  const tf = {};

  const results =
    await Promise.all(
      intervals.map(
        async ([key, interval]) => {
          try {
            const c =
              await klines(
                category,
                symbol,
                interval,
                interval === "1"
                  ? DEEP_1M_LIMIT
                  : 150
              );

            return [
              key,
              c,
              analyze(c)
            ];
          } catch (e) {
            return [
              key,
              [],
              {
                error: e.message
              }
            ];
          }
        }
      )
    );

  for (const [key, c, a] of results) {
    tf[key] = a;
  }

  const base =
    tf["1"]?.error
      ? null
      : tf["1"];

  if (!base) {
    throw new Error("ANALYSIS_DATA_UNAVAILABLE");
  }

  const fp =
    await footprint(
      category,
      symbol
    );

  const wall =
    await walls(
      category,
      symbol,
      base.price
    );

  const market =
    await marketInfo(
      category,
      symbol
    );

  const sc =
    calculateScore(
      base,
      fp,
      wall,
      enabled
    );

  const direction =
    sc.long > sc.short &&
    sc.long >= threshold
      ? "LONG"
      : sc.short > sc.long &&
        sc.short >= threshold
        ? "SHORT"
        : "WAIT";

  const finalScore =
    Math.max(
      sc.long,
      sc.short
    );

  const pump =
    tf["1"]?.price &&
    tf["1"]?.volume
      ? 0
      : 0;

  const styles = {
    ma:
      sc.long > sc.short
        ? sc.long
        : sc.short,

    smart:
      (
        base.bos !== "NONE" ||
        base.choch !== "NONE" ||
        base.hunt.confirmed ||
        base.orderBlock.type !== "NONE"
      )
        ? 80
        : 0,

    ict:
      base.fvg.type !== "NONE"
        ? 75
        : 0,

    macd:
      base.macd.direction !== "NONE"
        ? 70
        : 0,

    rsi:
      base.rsi <= 30 ||
      base.rsi >= 70
        ? 80
        : 40,

    ichimoku:
      base.ichimoku.direction !== "NONE"
        ? 70
        : 40,

    volume:
      base.volume.spike
        ? 80
        : 40,

    orderflow:
      fp &&
      !fp.error &&
      Math.abs(fp.deltaPercent) >= 8
        ? 85
        : 40,

    liquidity:
      wall &&
      !wall.error &&
      (
        wall.buyNear ||
        wall.sellNear
      )
        ? 80
        : 40
  };

  return {
    symbol,
    category,

    price: base.price,

    direction,

    score: finalScore,

    longScore: sc.long,
    shortScore: sc.short,

    threshold,

    signalLevel:
      finalScore >= 90
        ? "VERY_STRONG"
        : finalScore >= threshold
          ? "CONFIRMED"
          : finalScore >= 60
            ? "WATCH"
            : "NONE",

    timeframes: tf,

    footprint: fp,

    walls: wall,

    market,

    styles,

    reasons:
      direction === "LONG"
        ? sc.longReasons
        : direction === "SHORT"
          ? sc.shortReasons
          : [
              ...sc.longReasons,
              ...sc.shortReasons
            ],

    pumpScore: pump,
    dumpScore: pump,

    generatedAt: Date.now(),

    source: "internal"
  };
}

/* =========================================================
   SCAN
========================================================= */

async function scan(
  threshold = DEFAULT_SIGNAL_SCORE,
  enabled = []
) {
  const markets =
    validLinear(
      await instruments("linear")
    );

  const batch =
    markets.slice(
      0,
      SCAN_BATCH
    );

  const results = [];

  for (const m of batch) {
    try {
      const c =
        await klines(
          "linear",
          m.symbol,
          "1",
          60
        );

      const a =
        analyze(c);

      if (a.error) continue;

      const score =
        calculateScore(
          a,
          null,
          null,
          enabled
        );

      const s =
        Math.max(
          score.long,
          score.short
        );

      if (s >= threshold) {
        results.push(
          await deepAnalyze(
            "linear",
            m.symbol,
            enabled,
            threshold
          )
        );
      }
    } catch {}
  }

  results.sort(
    (a, b) =>
      b.score - a.score
  );

  return {
    ok: true,
    results,
    threshold
  };
}

/* =========================================================
   RADAR
========================================================= */

async function radar(
  threshold = DEFAULT_SIGNAL_SCORE,
  enabled = []
) {
  const markets =
    validLinear(
      await instruments("linear")
    );

  const candidates = [];

  for (
    const m of markets.slice(
      0,
      SCAN_BATCH
    )
  ) {
    try {
      const c =
        await klines(
          "linear",
          m.symbol,
          "1",
          40
        );

      if (c.length < 30) continue;

      const price =
        c.at(-1).close;

      const change =
        pct(
          price,
          c.at(-15).close
        );

      const vol =
        c.at(-1).volume;

      const av =
        sma(
          c.slice(-21, -1)
            .map(x => x.volume),
          20
        );

      const activity =
        Math.abs(change) * 5 +
        (av ? vol / av * 10 : 0);

      candidates.push({
        symbol: m.symbol,
        activity
      });
    } catch {}
  }

  candidates.sort(
    (a, b) =>
      b.activity - a.activity
  );

  const selected =
    candidates.slice(
      0,
      RADAR_LIMIT
    );

  const results =
    await Promise.all(
      selected.map(
        x =>
          deepAnalyze(
            "linear",
            x.symbol,
            enabled,
            threshold
          )
      )
    );

  return {
    ok: true,

    pump:
      results
        .filter(x => x.pumpScore >= 50),

    dump:
      results
        .filter(x => x.dumpScore >= 50),

    reversal: [],

    results
  };
}

/* =========================================================
   ROUTER
========================================================= */

export default {
  async fetch(request, env) {
    const u =
      new URL(request.url);

    const path =
      u.pathname;

    try {
      /* SEARCH */

      if (path === "/api/search") {
        const input =
          u.searchParams.get(
            "symbol"
          );

        if (!input) {
          return json({
            ok: false,
            error: "SYMBOL_REQUIRED"
          }, 400);
        }

        const found =
          await searchSymbol(
            input
          );

        if (!found) {
          return json({
            ok: false,
            error: "SYMBOL_NOT_FOUND"
          }, 404);
        }

        const threshold =
          clamp(
            n(
              u.searchParams.get(
                "threshold"
              ),
              DEFAULT_SIGNAL_SCORE
            ),
            1,
            100
          );

        let enabled = [];

        try {
          enabled =
            JSON.parse(
              u.searchParams.get(
                "methods"
              ) || "[]"
            );
        } catch {}

        const analysis =
          await deepAnalyze(
            found.category,
            found.symbol,
            enabled,
            threshold
          );

        return json({
          ok: true,
          ...analysis
        });
      }

      /* DEEP */

      if (path === "/api/analyze") {
        const symbol =
          u.searchParams.get(
            "symbol"
          );

        if (!symbol) {
          return json({
            ok: false,
            error: "SYMBOL_REQUIRED"
          }, 400);
        }

        const found =
          await searchSymbol(
            symbol
          );

        if (!found) {
          return json({
            ok: false,
            error: "SYMBOL_NOT_FOUND"
          }, 404);
        }

        let enabled = [];

        try {
          enabled =
            JSON.parse(
              u.searchParams.get(
                "methods"
              ) || "[]"
            );
        } catch {}

        const threshold =
          clamp(
            n(
              u.searchParams.get(
                "threshold"
              ),
              DEFAULT_SIGNAL_SCORE
            ),
            1,
            100
          );

        return json({
          ok: true,
          ...await deepAnalyze(
            found.category,
            found.symbol,
            enabled,
            threshold
          )
        });
      }

      /* SCAN */

      if (path === "/api/scan") {
        let enabled = [];

        try {
          enabled =
            JSON.parse(
              u.searchParams.get(
                "methods"
              ) || "[]"
            );
        } catch {}

        const threshold =
          clamp(
            n(
              u.searchParams.get(
                "threshold"
              ),
              DEFAULT_SIGNAL_SCORE
            ),
            1,
            100
          );

        return json(
          await scan(
            threshold,
            enabled
          )
        );
      }

      /* RADAR */

      if (path === "/api/radar") {
        let enabled = [];

        try {
          enabled =
            JSON.parse(
              u.searchParams.get(
                "methods"
              ) || "[]"
            );
        } catch {}

        const threshold =
          clamp(
            n(
              u.searchParams.get(
                "threshold"
              ),
              DEFAULT_SIGNAL_SCORE
            ),
            1,
            100
          );

        return json(
          await radar(
            threshold,
            enabled
          )
        );
      }

      /* HEALTH */

      if (path === "/api/health") {
        return json({
          ok: true,
          service: "Market Scanner",
          version: "V10",
          threshold:
            DEFAULT_SIGNAL_SCORE,
          features: [
            "Automatic Market Detection",
            "Futures",
            "Spot",
            "Moving Average",
            "Smart Money",
            "ICT",
            "MACD",
            "RSI",
            "Divergence",
            "Ichimoku",
            "Volume",
            "Order Flow",
            "Liquidity",
            "FVG",
            "BOS",
            "CHoCH",
            "Order Block",
            "Support Resistance",
            "OI",
            "Funding",
            "Radar"
          ]
        });
      }

      /* STATIC FILES */

      if (
        env &&
        env.ASSETS &&
        typeof env.ASSETS.fetch === "function"
      ) {
        return env.ASSETS.fetch(request);
      }

      return new Response(
        "Not Found",
        {
          status: 404
        }
      );

    } catch (e) {
      return json({
        ok: false,
        error: e.message || "SERVER_ERROR"
      }, 500);
    }
  }
};
