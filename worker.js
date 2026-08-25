const BYBIT = "https://api.bybit.com";

const SCAN_BATCH = 20;
const DEEP_LIMIT = 3;
const RADAR_LIMIT = 5;

const KLINE_1M = 250;
const KLINE_15M = 250;

const ORDERBOOK_LIMIT = 50;
const TRADES_LIMIT = 1000;

const DEFAULT_THRESHOLD = 32;

const CACHE_TTL = 8000;
const cache = new Map();

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*"
    }
  });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function bybit(path, params = {}) {
  const qs = new URLSearchParams();

  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") {
      qs.set(k, String(v));
    }
  }

  const url = `${BYBIT}${path}?${qs.toString()}`;

  const key = url;
  const old = cache.get(key);

  if (old && Date.now() - old.time < CACHE_TTL) {
    return old.data;
  }

  const res = await fetch(url, {
    headers: {
      "Accept": "application/json"
    }
  });

  if (!res.ok) {
    throw new Error(`Bybit HTTP ${res.status}`);
  }

  const data = await res.json();

  if (data.retCode !== 0) {
    throw new Error(data.retMsg || "Bybit API error");
  }

  cache.set(key, {
    time: Date.now(),
    data
  });

  return data;
}

/* =========================================================
   BASIC
========================================================= */

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function pct(a, b) {
  if (!b) return 0;
  return ((a - b) / b) * 100;
}

/* =========================================================
   KLINE
========================================================= */

function normalizeKlines(list) {
  return (list || [])
    .map(x => ({
      time: num(x[0]),
      open: num(x[1]),
      high: num(x[2]),
      low: num(x[3]),
      close: num(x[4]),
      volume: num(x[5]),
      turnover: num(x[6])
    }))
    .sort((a, b) => a.time - b.time);
}

async function getKlines(category, symbol, interval, limit) {
  const data = await bybit("/v5/market/kline", {
    category,
    symbol,
    interval,
    limit
  });

  return normalizeKlines(data.result?.list || []);
}

/* =========================================================
   MA
========================================================= */

function sma(values, period) {
  if (values.length < period) return null;

  const a = values.slice(-period);

  return avg(a);
}

function ema(values, period) {
  if (values.length < period) return null;

  const k = 2 / (period + 1);

  let e = avg(values.slice(0, period));

  for (let i = period; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
  }

  return e;
}

function getMA(values, period, type = "EMA") {
  return type === "SMA"
    ? sma(values, period)
    : ema(values, period);
}

function maPrevious(values, period, type = "EMA") {
  if (values.length <= period) return null;

  return getMA(values.slice(0, -1), period, type);
}

/* =========================================================
   RSI
========================================================= */

function rsi(values, period = 14) {
  if (values.length <= period) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];

    if (d >= 0) gains += d;
    else losses += Math.abs(d);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];

    const gain = d > 0 ? d : 0;
    const loss = d < 0 ? Math.abs(d) : 0;

    avgGain = ((avgGain * (period - 1)) + gain) / period;
    avgLoss = ((avgLoss * (period - 1)) + loss) / period;
  }

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;

  return 100 - (100 / (1 + rs));
}

/* =========================================================
   ATR
========================================================= */

function atr(candles, period = 14) {
  if (candles.length <= period) return null;

  const tr = [];

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];

    tr.push(
      Math.max(
        c.high - c.low,
        Math.abs(c.high - p.close),
        Math.abs(c.low - p.close)
      )
    );
  }

  return avg(tr.slice(-period));
}

/* =========================================================
   MACD
========================================================= */

function macd(values) {
  if (values.length < 35) {
    return {
      macd: null,
      signal: null,
      histogram: null
    };
  }

  const fast = [];
  const slow = [];

  for (let i = 0; i < values.length; i++) {
    fast.push(ema(values.slice(0, i + 1), 12));
    slow.push(ema(values.slice(0, i + 1), 26));
  }

  const line = [];

  for (let i = 0; i < values.length; i++) {
    if (fast[i] !== null && slow[i] !== null) {
      line.push(fast[i] - slow[i]);
    }
  }

  const signal = ema(line, 9);

  const m = line[line.length - 1];

  return {
    macd: m,
    signal,
    histogram:
      m !== null && signal !== null
        ? m - signal
        : null
  };
}

/* =========================================================
   BOLLINGER
========================================================= */

function bollinger(values, period = 20, mult = 2) {
  if (values.length < period) return null;

  const a = values.slice(-period);

  const mid = avg(a);

  const variance =
    avg(a.map(x => Math.pow(x - mid, 2)));

  const sd = Math.sqrt(variance);

  const upper = mid + mult * sd;
  const lower = mid - mult * sd;

  return {
    middle: mid,
    upper,
    lower,
    width: mid ? ((upper - lower) / mid) * 100 : 0
  };
}

/* =========================================================
   VOLUME
========================================================= */

function volumeStats(candles, period = 20) {
  if (candles.length < period + 1) {
    return {
      current: 0,
      average: 0,
      ratio: 0,
      spike: false
    };
  }

  const current =
    candles[candles.length - 1].volume;

  const previous =
    candles
      .slice(-(period + 1), -1)
      .map(x => x.volume);

  const average = avg(previous);

  const ratio =
    average > 0
      ? current / average
      : 0;

  return {
    current,
    average,
    ratio,
    spike: ratio >= 1.5
  };
}

/* =========================================================
   SWINGS
========================================================= */

function findSwings(candles, strength = 2) {
  const highs = [];
  const lows = [];

  for (
    let i = strength;
    i < candles.length - strength;
    i++
  ) {
    let high = true;
    let low = true;

    for (let j = 1; j <= strength; j++) {
      if (
        candles[i].high <= candles[i - j].high ||
        candles[i].high <= candles[i + j].high
      ) {
        high = false;
      }

      if (
        candles[i].low >= candles[i - j].low ||
        candles[i].low >= candles[i + j].low
      ) {
        low = false;
      }
    }

    if (high) {
      highs.push({
        index: i,
        price: candles[i].high,
        time: candles[i].time
      });
    }

    if (low) {
      lows.push({
        index: i,
        price: candles[i].low,
        time: candles[i].time
      });
    }
  }

  return {
    highs,
    lows
  };
}

/* =========================================================
   BOS / CHOCH
========================================================= */

function structureAnalysis(candles) {
  const swings = findSwings(candles, 2);

  const highs = swings.highs;
  const lows = swings.lows;

  if (highs.length < 2 || lows.length < 2) {
    return {
      available: false,
      trend: "UNKNOWN",
      bos: null,
      choch: null,
      swingHigh: null,
      swingLow: null
    };
  }

  const lastHigh = highs[highs.length - 1];
  const prevHigh = highs[highs.length - 2];

  const lastLow = lows[lows.length - 1];
  const prevLow = lows[lows.length - 2];

  const close = candles[candles.length - 1].close;

  let trend = "RANGE";

  if (
    lastHigh.price > prevHigh.price &&
    lastLow.price > prevLow.price
  ) {
    trend = "BULLISH";
  }

  if (
    lastHigh.price < prevHigh.price &&
    lastLow.price < prevLow.price
  ) {
    trend = "BEARISH";
  }

  let bos = null;
  let choch = null;

  if (close > lastHigh.price) {
    bos = {
      side: "BULLISH",
      price: lastHigh.price,
      index: lastHigh.index
    };

    if (trend === "BEARISH") {
      choch = {
        side: "BULLISH",
        price: lastHigh.price
      };
    }
  }

  if (close < lastLow.price) {
    bos = {
      side: "BEARISH",
      price: lastLow.price,
      index: lastLow.index
    };

    if (trend === "BULLISH") {
      choch = {
        side: "BEARISH",
        price: lastLow.price
      };
    }
  }

  return {
    available: true,
    trend,
    bos,
    choch,
    swingHigh: lastHigh,
    swingLow: lastLow,
    previousSwingHigh: prevHigh,
    previousSwingLow: prevLow
  };
}

/* =========================================================
   FVG
========================================================= */

function findFVG(candles) {
  const found = [];

  for (let i = 2; i < candles.length; i++) {
    const a = candles[i - 2];
    const b = candles[i - 1];
    const c = candles[i];

    if (c.low > a.high) {
      found.push({
        type: "BULLISH",
        top: c.low,
        bottom: a.high,
        index: i,
        time: c.time,
        size: c.low - a.high
      });
    }

    if (c.high < a.low) {
      found.push({
        type: "BEARISH",
        top: a.low,
        bottom: c.high,
        index: i,
        time: c.time,
        size: a.low - c.high
      });
    }
  }

  return found.slice(-10);
}

/* =========================================================
   ORDER BLOCK
========================================================= */

function findOrderBlocks(candles) {
  const blocks = [];

  for (let i = 2; i < candles.length - 2; i++) {
    const c = candles[i];
    const n1 = candles[i + 1];
    const n2 = candles[i + 2];

    const body = Math.abs(c.close - c.open);

    if (body === 0) continue;

    const bullishExpansion =
      n1.close > n1.open &&
      n2.close > n2.open &&
      n2.close > c.high;

    const bearishExpansion =
      n1.close < n1.open &&
      n2.close < n2.open &&
      n2.close < c.low;

    if (c.close < c.open && bullishExpansion) {
      blocks.push({
        type: "BULLISH",
        high: c.high,
        low: c.low,
        index: i,
        time: c.time
      });
    }

    if (c.close > c.open && bearishExpansion) {
      blocks.push({
        type: "BEARISH",
        high: c.high,
        low: c.low,
        index: i,
        time: c.time
      });
    }
  }

  return blocks.slice(-10);
}

/* =========================================================
   LIQUIDITY SWEEP / HUNT
========================================================= */

function liquiditySweep(candles, structure) {
  if (
    !structure.available ||
    !structure.swingHigh ||
    !structure.swingLow
  ) {
    return {
      available: false,
      type: "NONE"
    };
  }

  const c = candles[candles.length - 1];

  const high = structure.swingHigh.price;
  const low = structure.swingLow.price;

  if (
    c.high > high &&
    c.close < high
  ) {
    return {
      available: true,
      type: "BEARISH",
      level: high,
      wick: c.high,
      close: c.close
    };
  }

  if (
    c.low < low &&
    c.close > low
  ) {
    return {
      available: true,
      type: "BULLISH",
      level: low,
      wick: c.low,
      close: c.close
    };
  }

  return {
    available: true,
    type: "NONE"
  };
}

/* =========================================================
   ORDER BOOK
========================================================= */

async function getOrderBook(category, symbol) {
  const data = await bybit("/v5/market/orderbook", {
    category,
    symbol,
    limit: ORDERBOOK_LIMIT
  });

  const r = data.result || {};

  const bids = (r.b || []).map(x => ({
    price: num(x[0]),
    volume: num(x[1]),
    value: num(x[0]) * num(x[1])
  }));

  const asks = (r.a || []).map(x => ({
    price: num(x[0]),
    volume: num(x[1]),
    value: num(x[0]) * num(x[1])
  }));

  const bidValue = bids.reduce(
    (a, b) => a + b.value,
    0
  );

  const askValue = asks.reduce(
    (a, b) => a + b.value,
    0
  );

  const total = bidValue + askValue;

  return {
    bids,
    asks,
    bestBid: bids[0]?.price || 0,
    bestAsk: asks[0]?.price || 0,
    bidLiquidity: bidValue,
    askLiquidity: askValue,
    bidShare: total ? bidValue / total * 100 : 0,
    askShare: total ? askValue / total * 100 : 0
  };
}

/* =========================================================
   WALLS
========================================================= */

function getWalls(levels, side) {
  if (!levels.length) return [];

  const values = levels.map(x => x.value);

  const mean = avg(values);

  const threshold = mean * 3;

  return levels
    .filter(x => x.value >= threshold)
    .sort((a, b) => b.value - a.value)
    .slice(0, 10)
    .map(x => ({
      ...x,
      side
    }));
}

/* =========================================================
   PUBLIC TRADES / FOOTPRINT
========================================================= */

async function getTrades(category, symbol) {
  const data = await bybit(
    "/v5/market/recent-trade",
    {
      category,
      symbol,
      limit: TRADES_LIMIT
    }
  );

  const trades = data.result?.list || [];

  let buy = 0;
  let sell = 0;

  const rows = [];

  for (const t of trades) {
    const price = num(t.price);
    const size = num(t.size);
    const value = price * size;

    if (t.side === "Buy") {
      buy += value;
    } else {
      sell += value;
    }

    rows.push({
      time: num(t.time),
      price,
      size,
      value,
      side: t.side
    });
  }

  const total = buy + sell;

  return {
    trades: rows,
    buy,
    sell,
    delta: buy - sell,
    total,
    buyShare: total ? buy / total * 100 : 0,
    sellShare: total ? sell / total * 100 : 0
  };
}

/* =========================================================
   TIMEFRAME ANALYSIS
========================================================= */

function analyzeTimeframe(candles) {
  const closes = candles.map(x => x.close);

  const price = closes[closes.length - 1];

  const ma7 = getMA(closes, 7);
  const ma20 = getMA(closes, 20);

  const previousMA20 =
    maPrevious(closes, 20);

  const r = rsi(closes, 14);

  const a = atr(candles, 14);

  const volume = volumeStats(candles, 20);

  const bb = bollinger(closes, 20);

  const m = macd(closes);

  const slope =
    previousMA20 && ma20
      ? pct(ma20, previousMA20)
      : null;

  let trend = "RANGE";

  if (
    ma7 &&
    ma20 &&
    ma7 > ma20 &&
    slope !== null &&
    slope > 0
  ) {
    trend = "BULLISH";
  }

  if (
    ma7 &&
    ma20 &&
    ma7 < ma20 &&
    slope !== null &&
    slope < 0
  ) {
    trend = "BEARISH";
  }

  let touch = false;
  let near = false;
  let crossUp = false;
  let crossDown = false;

  if (ma20) {
    const last = candles[candles.length - 1];

    touch =
      last.low <= ma20 &&
      last.high >= ma20;

    const distance =
      Math.abs(price - ma20) / ma20 * 100;

    near = distance <= 0.35;

    if (previousMA20 !== null) {
      const prevClose =
        candles[candles.length - 2].close;

      crossUp =
        prevClose <= previousMA20 &&
        price > ma20;

      crossDown =
        prevClose >= previousMA20 &&
        price < ma20;
    }
  }

  let rejection = "NONE";

  if (ma20) {
    const last = candles[candles.length - 1];

    if (
      last.low <= ma20 &&
      last.close > ma20 &&
      last.close > last.open
    ) {
      rejection = "BULLISH";
    }

    if (
      last.high >= ma20 &&
      last.close < ma20 &&
      last.close < last.open
    ) {
      rejection = "BEARISH";
    }
  }

  return {
    price,
    ma7,
    ma20,
    previousMA20,
    slope,
    trend,
    rsi: r,
    atr: a,
    atrPct: a && price ? a / price * 100 : null,
    volume,
    bollinger: bb,
    macd: m,
    touch,
    near,
    crossUp,
    crossDown,
    rejection
  };
}

/* =========================================================
   SMART MONEY ANALYSIS
========================================================= */

function smartMoney(candles) {
  const structure = structureAnalysis(candles);

  const fvg = findFVG(candles);

  const orderBlocks =
    findOrderBlocks(candles);

  const sweep =
    liquiditySweep(candles, structure);

  const price =
    candles[candles.length - 1].close;

  const activeFVG =
    fvg
      .filter(x =>
        price >= x.bottom &&
        price <= x.top
      )
      .slice(-3);

  const activeOB =
    orderBlocks
      .filter(x =>
        price >= x.low &&
        price <= x.high
      )
      .slice(-3);

  return {
    structure,
    fvg,
    activeFVG,
    orderBlocks,
    activeOB,
    sweep
  };
}

/* =========================================================
   SIGNAL ENGINE
========================================================= */

function signalEngine({
  one,
  fifteen,
  smart,
  footprint,
  orderbook,
  difficulty = 11
}) {
  const hard =
    clamp(num(difficulty), 0, 100);

  const threshold =
    clamp(
      DEFAULT_THRESHOLD + hard * 0.48,
      32,
      80
    );

  let bull = 0;
  let bear = 0;

  const reasonsBull = [];
  const reasonsBear = [];

  /* MA20 1M */
  if (one.touch) {
    if (one.rejection === "BULLISH") {
      bull += 18;
      reasonsBull.push("MA20 1m bullish rejection");
    }

    if (one.rejection === "BEARISH") {
      bear += 18;
      reasonsBear.push("MA20 1m bearish rejection");
    }
  }

  if (one.crossUp) {
    bull += 22;
    reasonsBull.push("MA20 1m bullish cross");
  }

  if (one.crossDown) {
    bear += 22;
    reasonsBear.push("MA20 1m bearish cross");
  }

  /* 15M TREND */
  if (fifteen.trend === "BULLISH") {
    bull += 20;
    reasonsBull.push("15m bullish trend");
  }

  if (fifteen.trend === "BEARISH") {
    bear += 20;
    reasonsBear.push("15m bearish trend");
  }

  /* RSI */
  if (fifteen.rsi !== null) {
    if (fifteen.rsi >= 50) {
      bull += 7;
      reasonsBull.push("15m RSI bullish");
    }

    if (fifteen.rsi < 50) {
      bear += 7;
      reasonsBear.push("15m RSI bearish");
    }
  }

  /* MACD */
  if (
    fifteen.macd.macd !== null &&
    fifteen.macd.signal !== null
  ) {
    if (
      fifteen.macd.macd >
      fifteen.macd.signal
    ) {
      bull += 10;
      reasonsBull.push("15m MACD bullish");
    }

    if (
      fifteen.macd.macd <
      fifteen.macd.signal
    ) {
      bear += 10;
      reasonsBear.push("15m MACD bearish");
    }
  }

  /* VOLUME */
  if (one.volume.spike) {
    if (one.price > one.ma20) {
      bull += 7;
      reasonsBull.push("1m volume spike");
    }

    if (one.price < one.ma20) {
      bear += 7;
      reasonsBear.push("1m volume spike");
    }
  }

  /* FOOTPRINT */
  if (footprint.total > 0) {
    const deltaPct =
      footprint.delta /
      footprint.total;

    if (deltaPct > 0.15) {
      bull += 10;
      reasonsBull.push("positive footprint delta");
    }

    if (deltaPct < -0.15) {
      bear += 10;
      reasonsBear.push("negative footprint delta");
    }
  }

  /* ORDERBOOK */
  if (
    orderbook.bidShare >
    orderbook.askShare + 8
  ) {
    bull += 5;
    reasonsBull.push("bid liquidity stronger");
  }

  if (
    orderbook.askShare >
    orderbook.bidShare + 8
  ) {
    bear += 5;
    reasonsBear.push("ask liquidity stronger");
  }

  /* BOS */
  if (smart.structure.bos) {
    if (
      smart.structure.bos.side ===
      "BULLISH"
    ) {
      bull += 12;
      reasonsBull.push("BOS bullish");
    }

    if (
      smart.structure.bos.side ===
      "BEARISH"
    ) {
      bear += 12;
      reasonsBear.push("BOS bearish");
    }
  }

  /* CHOCH */
  if (smart.structure.choch) {
    if (
      smart.structure.choch.side ===
      "BULLISH"
    ) {
      bull += 12;
      reasonsBull.push("CHoCH bullish");
    }

    if (
      smart.structure.choch.side ===
      "BEARISH"
    ) {
      bear += 12;
      reasonsBear.push("CHoCH bearish");
    }
  }

  /* FVG */
  if (smart.activeFVG.length) {
    const f =
      smart.activeFVG[
        smart.activeFVG.length - 1
      ];

    if (f.type === "BULLISH") {
      bull += 8;
      reasonsBull.push("price inside bullish FVG");
    }

    if (f.type === "BEARISH") {
      bear += 8;
      reasonsBear.push("price inside bearish FVG");
    }
  }

  /* ORDER BLOCK */
  if (smart.activeOB.length) {
    const ob =
      smart.activeOB[
        smart.activeOB.length - 1
      ];

    if (ob.type === "BULLISH") {
      bull += 8;
      reasonsBull.push("price inside bullish OB");
    }

    if (ob.type === "BEARISH") {
      bear += 8;
      reasonsBear.push("price inside bearish OB");
    }
  }

  /* LIQUIDITY SWEEP */
  if (smart.sweep.type === "BULLISH") {
    bull += 15;
    reasonsBull.push("bullish liquidity sweep");
  }

  if (smart.sweep.type === "BEARISH") {
    bear += 15;
    reasonsBear.push("bearish liquidity sweep");
  }

  bull = clamp(bull, 0, 100);
  bear = clamp(bear, 0, 100);

  let direction = "WAIT";
  let score = Math.max(bull, bear);

  if (
    bull >= threshold &&
    bull > bear
  ) {
    direction = "LONG";
  }

  if (
    bear >= threshold &&
    bear > bull
  ) {
    direction = "SHORT";
  }

  return {
    direction,
    score,
    bull,
    bear,
    threshold,
    difficulty: hard,
    reasons: {
      bull: reasonsBull,
      bear: reasonsBear
    }
  };
}

/* =========================================================
   COMPLETE SYMBOL ANALYSIS
========================================================= */

async function analyzeSymbol(symbol, category = "linear", difficulty = 11) {
  const s = symbol.toUpperCase();

  const [
    oneCandles,
    fifteenCandles,
    orderbook,
    footprint
  ] = await Promise.all([
    getKlines(
      category,
      s,
      "1",
      KLINE_1M
    ),

    getKlines(
      category,
      s,
      "15",
      KLINE_15M
    ),

    getOrderBook(
      category,
      s
    ),

    getTrades(
      category,
      s
    )
  ]);

  if (
    oneCandles.length < 30 ||
    fifteenCandles.length < 30
  ) {
    throw new Error(
      "داده کافی برای تحلیل وجود ندارد"
    );
  }

  const one =
    analyzeTimeframe(oneCandles);

  const fifteen =
    analyzeTimeframe(fifteenCandles);

  const smart =
    smartMoney(oneCandles);

  const signal =
    signalEngine({
      one,
      fifteen,
      smart,
      footprint,
      orderbook,
      difficulty
    });

  const price =
    one.price;

  const distance =
    one.ma20
      ? pct(price, one.ma20)
      : null;

  const buyWalls =
    getWalls(
      orderbook.bids,
      "BUY"
    );

  const sellWalls =
    getWalls(
      orderbook.asks,
      "SELL"
    );

  return {
    ok: true,

    symbol: s,
    category,

    price,

    signal,

    market: {
      trend1m: one.trend,
      trend15m: fifteen.trend
    },

    oneMinute: {
      ...one,
      distanceToMA20: distance,
      contact: one.touch,
      nearMA20: one.near
    },

    fifteenMinute: {
      ...fifteen
    },

    smartMoney: {
      available:
        smart.structure.available,

      structure:
        smart.structure,

      BOS:
        smart.structure.bos,

      CHoCH:
        smart.structure.choch,

      FVG:
        smart.fvg,

      activeFVG:
        smart.activeFVG,

      OrderBlocks:
        smart.orderBlocks,

      activeOrderBlocks:
        smart.activeOB,

      liquiditySweep:
        smart.sweep
    },

    footprint: {
      buy: footprint.buy,
      sell: footprint.sell,
      delta: footprint.delta,
      total: footprint.total,
      buyShare: footprint.buyShare,
      sellShare: footprint.sellShare
    },

    orderBook: {
      bestBid: orderbook.bestBid,
      bestAsk: orderbook.bestAsk,

      bidLiquidity:
        orderbook.bidLiquidity,

      askLiquidity:
        orderbook.askLiquidity,

      bidShare:
        orderbook.bidShare,

      askShare:
        orderbook.askShare,

      buyWalls,
      sellWalls,

      bids:
        orderbook.bids,

      asks:
        orderbook.asks
    },

    indicators: {
      RSI1m: one.rsi,
      RSI15m: fifteen.rsi,

      MACD: fifteen.macd,

      ATR1m: one.atr,
      ATR15m: fifteen.atr,

      Bollinger1m:
        one.bollinger,

      Bollinger15m:
        fifteen.bollinger
    },

    volume: {
      oneMinute:
        one.volume,

      fifteenMinute:
        fifteen.volume
    },

    timestamp: Date.now()
  };
}

/* =========================================================
   SYMBOL SEARCH
========================================================= */

async function findSymbol(query) {
  const q =
    query
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");

  if (!q) return [];

  const results = [];

  for (const category of [
    "spot",
    "linear"
  ]) {
    try {
      const data =
        await bybit(
          "/v5/market/instruments-info",
          {
            category,
            limit: 1000
          }
        );

      const list =
        data.result?.list || [];

      for (const x of list) {
        const symbol =
          String(x.symbol || "")
            .toUpperCase();

        if (
          symbol === q ||
          symbol.includes(q)
        ) {
          results.push({
            symbol,
            category,
            status: x.status
          });
        }
      }
    } catch {}
  }

  return results;
}

/* =========================================================
   MARKET SYMBOLS
========================================================= */

async function getMarketSymbols() {
  const all = [];

  for (const category of [
    "linear",
    "spot"
  ]) {
    try {
      const data =
        await bybit(
          "/v5/market/instruments-info",
          {
            category,
            limit: 1000
          }
        );

      const list =
        data.result?.list || [];

      for (const x of list) {
        if (
          x.status === "Trading" &&
          String(x.symbol).endsWith("USDT")
        ) {
          all.push({
            symbol: x.symbol,
            category
          });
        }
      }
    } catch {}
  }

  const unique =
    new Map();

  for (const x of all) {
    unique.set(
      `${x.category}:${x.symbol}`,
      x
    );
  }

  return [...unique.values()];
}

/* =========================================================
   QUICK SCAN
========================================================= */

async function quickScan(
  symbol,
  category,
  difficulty
) {
  try {
    const candles =
      await getKlines(
        category,
        symbol,
        "1",
        60
      );

    if (candles.length < 30) {
      return null;
    }

    const a =
      analyzeTimeframe(candles);

    if (!a.ma20) {
      return null;
    }

    const distance =
      Math.abs(
        pct(a.price, a.ma20)
      );

    return {
      symbol,
      category,
      price: a.price,
      ma20: a.ma20,
      distance,
      trend: a.trend,
      volumeRatio:
        a.volume.ratio,
      rsi: a.rsi
    };
  } catch {
    return null;
  }
}

/* =========================================================
   SCAN MARKET
========================================================= */

async function scanMarket(difficulty = 11) {
  const symbols =
    await getMarketSymbols();

  const results = [];

  for (
    let i = 0;
    i < symbols.length;
    i += SCAN_BATCH
  ) {
    const batch =
      symbols.slice(
        i,
        i + SCAN_BATCH
      );

    const out =
      await Promise.all(
        batch.map(x =>
          quickScan(
            x.symbol,
            x.category,
            difficulty
          )
        )
      );

    for (const r of out) {
      if (!r) continue;

      /*
       * ابتدا فقط ارزهایی که واقعاً
       * نزدیک MA20 یک دقیقه هستند
       * وارد تحلیل عمیق می‌شوند.
       */

      if (r.distance <= 0.60) {
        results.push(r);
      }
    }

    if (results.length >= RADAR_LIMIT) {
      break;
    }

    await sleep(80);
  }

  results.sort(
    (a, b) =>
      a.distance - b.distance
  );

  const deep =
    results.slice(0, DEEP_LIMIT);

  const signals = [];

  for (const r of deep) {
    try {
      const analysis =
        await analyzeSymbol(
          r.symbol,
          r.category,
          difficulty
        );

      if (
        analysis.signal.direction !==
        "WAIT"
      ) {
        signals.push(analysis);
      }
    } catch {}
  }

  return {
    ok: true,
    checked: symbols.length,
    candidates: results.length,
    signals,
    difficulty,
    timestamp: Date.now()
  };
}

/* =========================================================
   ROUTER
========================================================= */

export default {
  async fetch(request) {
    const url =
      new URL(request.url);

    const path =
      url.pathname;

    try {
      if (
        request.method ===
        "OPTIONS"
      ) {
        return new Response(null, {
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-methods":
              "GET,POST,OPTIONS",
            "access-control-allow-headers":
              "Content-Type"
          }
        });
      }

      /* HEALTH */

      if (
        path === "/" ||
        path === "/health"
      ) {
        return json({
          ok: true,
          service: "Bybit Personal Scanner",
          connected: true,
          time: Date.now()
        });
      }

      /* SEARCH */

      if (
        path === "/api/search"
      ) {
        const q =
          url.searchParams.get(
            "q"
          ) || "";

        const results =
          await findSymbol(q);

        return json({
          ok: true,
          query: q,
          results
        });
      }

      /* ANALYZE */

      if (
        path === "/api/analyze"
      ) {
        const symbol =
          url.searchParams.get(
            "symbol"
          );

        const category =
          url.searchParams.get(
            "category"
          ) || "linear";

        const difficulty =
          num(
            url.searchParams.get(
              "difficulty"
            ) || 11
          );

        if (!symbol) {
          return json({
            ok: false,
            error:
              "symbol required"
          }, 400);
        }

        const result =
          await analyzeSymbol(
            symbol,
            category,
            difficulty
          );

        return json(result);
      }

      /* SCAN */

      if (
        path === "/api/scan"
      ) {
        const difficulty =
          num(
            url.searchParams.get(
              "difficulty"
            ) || 11
          );

        const result =
          await scanMarket(
            difficulty
          );

        return json(result);
      }

      /* SYMBOL LIST */

      if (
        path ===
        "/api/symbols"
      ) {
        const symbols =
          await getMarketSymbols();

        return json({
          ok: true,
          total: symbols.length,
          symbols
        });
      }

      return json({
        ok: false,
        error: "Not found"
      }, 404);

    } catch (err) {
      return json({
        ok: false,
        error:
          err?.message ||
          String(err),
        timestamp: Date.now()
      }, 500);
    }
  }
};
