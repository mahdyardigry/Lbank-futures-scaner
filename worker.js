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
  const old = cache.get(url);

  if (old && Date.now() - old.time < CACHE_TTL) {
    return old.data;
  }

  const res = await fetch(url, {
    headers: { Accept: "application/json" }
  });

  if (!res.ok) {
    throw new Error(`Bybit HTTP ${res.status}`);
  }

  const data = await res.json();

  if (data.retCode !== 0) {
    throw new Error(data.retMsg || "Bybit API error");
  }

  cache.set(url, {
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

function sum(arr) {
  return arr.reduce((a, b) => a + b, 0);
}

function pct(a, b) {
  if (!b) return 0;
  return ((a - b) / b) * 100;
}

function round(v, digits = 6) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

/* =========================================================
   KLINES
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
  return avg(values.slice(-period));
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

function maSlope(values, period, type = "EMA", lookback = 5) {
  if (values.length < period + lookback) return null;

  const current = getMA(values, period, type);
  const previous = getMA(
    values.slice(0, -lookback),
    period,
    type
  );

  if (current === null || previous === null) return null;

  return {
    current,
    previous,
    absolute: current - previous,
    percent: pct(current, previous),
    perCandle: pct(current, previous) / lookback
  };
}

/* =========================================================
   MA20 DETAILED ANALYSIS
========================================================= */

function analyzeMA20(candles) {
  const closes = candles.map(x => x.close);
  const last = candles[candles.length - 1];
  const previous = candles[candles.length - 2];

  const ma20 = getMA(closes, 20, "EMA");
  const ma20Prev1 = maPrevious(closes, 20, "EMA");

  const slope5 = maSlope(
    closes,
    20,
    "EMA",
    5
  );

  const slope10 = maSlope(
    closes,
    20,
    "EMA",
    10
  );

  if (!ma20) {
    return {
      available: false
    };
  }

  const distancePercent =
    pct(last.close, ma20);

  const distanceAbs =
    last.close - ma20;

  const touch =
    last.low <= ma20 &&
    last.high >= ma20;

  const above =
    last.close > ma20;

  const below =
    last.close < ma20;

  const previousAbove =
    previous.close > ma20Prev1;

  const previousBelow =
    previous.close < ma20Prev1;

  const crossUp =
    previousAbove === false &&
    above === true;

  const crossDown =
    previousBelow === false &&
    below === true;

  const body =
    Math.abs(last.close - last.open);

  const range =
    last.high - last.low;

  const upperWick =
    last.high - Math.max(
      last.open,
      last.close
    );

  const lowerWick =
    Math.min(
      last.open,
      last.close
    ) - last.low;

  const bullishCandle =
    last.close > last.open;

  const bearishCandle =
    last.close < last.open;

  let confirmation = "NONE";
  let confirmationScore = 0;

  if (touch && bullishCandle && last.close > ma20) {
    confirmation = "BULLISH_REJECTION";
    confirmationScore = 100;
  }

  if (touch && bearishCandle && last.close < ma20) {
    confirmation = "BEARISH_REJECTION";
    confirmationScore = 100;
  }

  if (crossUp && bullishCandle && last.close > ma20) {
    confirmation = "BULLISH_CROSS";
    confirmationScore = 95;
  }

  if (crossDown && bearishCandle && last.close < ma20) {
    confirmation = "BEARISH_CROSS";
    confirmationScore = 95;
  }

  if (
    touch &&
    bullishCandle &&
    lowerWick > body &&
    last.close > ma20
  ) {
    confirmation = "BULLISH_WICK_REJECTION";
    confirmationScore = 90;
  }

  if (
    touch &&
    bearishCandle &&
    upperWick > body &&
    last.close < ma20
  ) {
    confirmation = "BEARISH_WICK_REJECTION";
    confirmationScore = 90;
  }

  let slopeState = "FLAT";

  const slope =
    slope5?.percent || 0;

  if (slope > 0.03) {
    slopeState = "STRONG_UP";
  } else if (slope > 0.005) {
    slopeState = "UP";
  } else if (slope < -0.03) {
    slopeState = "STRONG_DOWN";
  } else if (slope < -0.005) {
    slopeState = "DOWN";
  }

  const candlePosition =
    range > 0
      ? ((last.close - last.low) / range) * 100
      : 50;

  let interaction = "AWAY";

  if (touch) interaction = "TOUCH";
  else if (Math.abs(distancePercent) <= 0.15) interaction = "VERY_NEAR";
  else if (Math.abs(distancePercent) <= 0.35) interaction = "NEAR";

  let bias = "RANGE";

  if (
    above &&
    slope > 0 &&
    confirmation !== "BEARISH_REJECTION" &&
    confirmation !== "BEARISH_WICK_REJECTION"
  ) {
    bias = "BULLISH";
  }

  if (
    below &&
    slope < 0 &&
    confirmation !== "BULLISH_REJECTION" &&
    confirmation !== "BULLISH_WICK_REJECTION"
  ) {
    bias = "BEARISH";
  }

  return {
    available: true,

    period: 20,
    type: "EMA",

    value: round(ma20),
    previousValue: round(ma20Prev1),

    price: round(last.close),

    distance: round(distanceAbs),
    distancePercent: round(distancePercent, 4),

    above,
    below,
    touch,
    interaction,

    crossUp,
    crossDown,

    slope: {
      fiveCandles: slope5
        ? {
            current: round(slope5.current),
            previous: round(slope5.previous),
            absolute: round(slope5.absolute),
            percent: round(slope5.percent, 5),
            perCandle: round(slope5.perCandle, 5)
          }
        : null,

      tenCandles: slope10
        ? {
            current: round(slope10.current),
            previous: round(slope10.previous),
            absolute: round(slope10.absolute),
            percent: round(slope10.percent, 5),
            perCandle: round(slope10.perCandle, 5)
          }
        : null,

      state: slopeState
    },

    candleConfirmation: {
      state: confirmation,
      score: confirmationScore,

      open: round(last.open),
      high: round(last.high),
      low: round(last.low),
      close: round(last.close),

      body: round(body),
      range: round(range),

      upperWick: round(upperWick),
      lowerWick: round(lowerWick),

      bullish: bullishCandle,
      bearish: bearishCandle,

      closePositionPercent:
        round(candlePosition, 2)
    },

    bias
  };
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

    avgGain =
      ((avgGain * (period - 1)) + gain) /
      period;

    avgLoss =
      ((avgLoss * (period - 1)) + loss) /
      period;
  }

  if (avgLoss === 0) return 100;

  return 100 -
    (100 / (1 + avgGain / avgLoss));
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
    fast.push(
      ema(values.slice(0, i + 1), 12)
    );

    slow.push(
      ema(values.slice(0, i + 1), 26)
    );
  }

  const line = [];

  for (let i = 0; i < values.length; i++) {
    if (
      fast[i] !== null &&
      slow[i] !== null
    ) {
      line.push(
        fast[i] - slow[i]
      );
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

function bollinger(
  values,
  period = 20,
  mult = 2
) {
  if (values.length < period) return null;

  const a = values.slice(-period);
  const middle = avg(a);

  const variance =
    avg(
      a.map(
        x => Math.pow(x - middle, 2)
      )
    );

  const sd = Math.sqrt(variance);

  const upper =
    middle + mult * sd;

  const lower =
    middle - mult * sd;

  return {
    middle,
    upper,
    lower,
    width:
      middle
        ? ((upper - lower) / middle) * 100
        : 0
  };
}

/* =========================================================
   VOLUME
========================================================= */

function volumeStats(
  candles,
  period = 20
) {
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

function findSwings(
  candles,
  strength = 2
) {
  const highs = [];
  const lows = [];

  for (
    let i = strength;
    i < candles.length - strength;
    i++
  ) {
    let high = true;
    let low = true;

    for (
      let j = 1;
      j <= strength;
      j++
    ) {
      if (
        candles[i].high <=
          candles[i - j].high ||
        candles[i].high <=
          candles[i + j].high
      ) {
        high = false;
      }

      if (
        candles[i].low >=
          candles[i - j].low ||
        candles[i].low >=
          candles[i + j].low
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
   SUPPORT / RESISTANCE
========================================================= */

function supportResistance(candles) {
  const swings =
    findSwings(candles, 2);

  const highs = swings.highs
    .slice(-8)
    .map(x => x.price);

  const lows = swings.lows
    .slice(-8)
    .map(x => x.price);

  const price =
    candles[candles.length - 1].close;

  const resistance =
    highs
      .filter(x => x >= price)
      .sort((a, b) => a - b)[0] ||
    highs.sort((a, b) => b - a)[0] ||
    null;

  const support =
    lows
      .filter(x => x <= price)
      .sort((a, b) => b - a)[0] ||
    lows.sort((a, b) => a - b)[0] ||
    null;

  return {
    resistance,
    support,

    distanceToResistance:
      resistance
        ? pct(price, resistance)
        : null,

    distanceToSupport:
      support
        ? pct(price, support)
        : null,

    swingHighs:
      swings.highs.slice(-8),

    swingLows:
      swings.lows.slice(-8)
  };
}

/* =========================================================
   BOS / CHOCH
========================================================= */

function structureAnalysis(candles) {
  const swings =
    findSwings(candles, 2);

  const highs = swings.highs;
  const lows = swings.lows;

  if (
    highs.length < 2 ||
    lows.length < 2
  ) {
    return {
      available: false,
      trend: "UNKNOWN",
      bos: null,
      choch: null,
      swingHigh: null,
      swingLow: null
    };
  }

  const lastHigh =
    highs[highs.length - 1];

  const prevHigh =
    highs[highs.length - 2];

  const lastLow =
    lows[lows.length - 1];

  const prevLow =
    lows[lows.length - 2];

  const close =
    candles[candles.length - 1].close;

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

  for (
    let i = 2;
    i < candles.length - 2;
    i++
  ) {
    const c = candles[i];
    const n1 = candles[i + 1];
    const n2 = candles[i + 2];

    const body =
      Math.abs(c.close - c.open);

    if (body === 0) continue;

    const bullishExpansion =
      n1.close > n1.open &&
      n2.close > n2.open &&
      n2.close > c.high;

    const bearishExpansion =
      n1.close < n1.open &&
      n2.close < n2.open &&
      n2.close < c.low;

    if (
      c.close < c.open &&
      bullishExpansion
    ) {
      blocks.push({
        type: "BULLISH",
        high: c.high,
        low: c.low,
        index: i,
        time: c.time
      });
    }

    if (
      c.close > c.open &&
      bearishExpansion
    ) {
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
   LIQUIDITY HUNT
========================================================= */

function liquiditySweep(
  candles,
  structure
) {
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

  const c =
    candles[candles.length - 1];

  const high =
    structure.swingHigh.price;

  const low =
    structure.swingLow.price;

  if (
    c.high > high &&
    c.close < high
  ) {
    const wick =
      c.high - high;

    const wickPercent =
      high
        ? (wick / high) * 100
        : 0;

    const estimatedValue =
      wick * c.volume;

    return {
      available: true,
      type: "BEARISH",
      level: high,
      wickHigh: c.high,
      close: c.close,
      wickSize: wick,
      wickPercent,
      candleVolume: c.volume,
      estimatedSweepValue: estimatedValue,
      candleTurnover: c.turnover
    };
  }

  if (
    c.low < low &&
    c.close > low
  ) {
    const wick =
      low - c.low;

    const wickPercent =
      low
        ? (wick / low) * 100
        : 0;

    const estimatedValue =
      wick * c.volume;

    return {
      available: true,
      type: "BULLISH",
      level: low,
      wickLow: c.low,
      close: c.close,
      wickSize: wick,
      wickPercent,
      candleVolume: c.volume,
      estimatedSweepValue: estimatedValue,
      candleTurnover: c.turnover
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
        limit: ORDERBOOK_LIMIT
      }
    );

  const r =
    data.result || {};

  const bids =
    (r.b || []).map(x => ({
      price: num(x[0]),
      volume: num(x[1]),
      value:
        num(x[0]) * num(x[1])
    }));

  const asks =
    (r.a || []).map(x => ({
      price: num(x[0]),
      volume: num(x[1]),
      value:
        num(x[0]) * num(x[1])
    }));

  const bidValue =
    sum(bids.map(x => x.value));

  const askValue =
    sum(asks.map(x => x.value));

  const total =
    bidValue + askValue;

  return {
    bids,
    asks,

    bestBid:
      bids[0]?.price || 0,

    bestAsk:
      asks[0]?.price || 0,

    bidLiquidity: bidValue,
    askLiquidity: askValue,

    bidShare:
      total
        ? bidValue / total * 100
        : 0,

    askShare:
      total
        ? askValue / total * 100
        : 0
  };
}

/* =========================================================
   WALLS
========================================================= */

function getWalls(
  levels,
  side
) {
  if (!levels.length) return [];

  const values =
    levels.map(x => x.value);

  const mean =
    avg(values);

  const threshold =
    mean * 3;

  return levels
    .filter(
      x => x.value >= threshold
    )
    .sort(
      (a, b) =>
        b.value - a.value
    )
    .slice(0, 10)
    .map(x => ({
      ...x,
      side
    }));
}

/* =========================================================
   WALLS AROUND SUPPORT / RESISTANCE
========================================================= */

function wallsAroundLevels(
  orderbook,
  sr,
  price
) {
  const tolerance =
    Math.max(
      price * 0.0025,
      0.00000001
    );

  const all = [
    ...orderbook.bids.map(x => ({
      ...x,
      side: "BUY"
    })),

    ...orderbook.asks.map(x => ({
      ...x,
      side: "SELL"
    }))
  ];

  const supportWalls =
    sr.support
      ? all
          .filter(
            x =>
              x.price <= sr.support &&
              Math.abs(
                x.price - sr.support
              ) <= tolerance
          )
          .sort(
            (a, b) =>
              b.value - a.value
          )
          .slice(0, 10)
      : [];

  const resistanceWalls =
    sr.resistance
      ? all
          .filter(
            x =>
              x.price >= sr.resistance &&
              Math.abs(
                x.price - sr.resistance
              ) <= tolerance
          )
          .sort(
            (a, b) =>
              b.value - a.value
          )
          .slice(0, 10)
      : [];

  return {
    supportWalls,
    resistanceWalls
  };
}

/* =========================================================
   PUBLIC TRADES / FOOTPRINT
========================================================= */

async function getTrades(
  category,
  symbol
) {
  const data =
    await bybit(
      "/v5/market/recent-trade",
      {
        category,
        symbol,
        limit: TRADES_LIMIT
      }
    );

  const trades =
    data.result?.list || [];

  let buy = 0;
  let sell = 0;

  let buyVolume = 0;
  let sellVolume = 0;

  const rows = [];

  for (const t of trades) {
    const price = num(t.price);
    const size = num(t.size);

    const value =
      price * size;

    if (t.side === "Buy") {
      buy += value;
      buyVolume += size;
    } else {
      sell += value;
      sellVolume += size;
    }

    rows.push({
      time: num(t.time),
      price,
      size,
      value,
      side: t.side
    });
  }

  const total =
    buy + sell;

  const delta =
    buy - sell;

  const deltaPercent =
    total
      ? delta / total * 100
      : 0;

  return {
    trades: rows,

    buy,
    sell,

    buyVolume,
    sellVolume,

    delta,
    deltaPercent,

    total,

    buyShare:
      total
        ? buy / total * 100
        : 0,

    sellShare:
      total
        ? sell / total * 100
        : 0
  };
}

/* =========================================================
   FOOTPRINT AROUND LEVEL
========================================================= */

function footprintAtLevel(
  trades,
  level,
  tolerancePercent = 0.20
) {
  if (!level) {
    return {
      level: null,
      buy: 0,
      sell: 0,
      delta: 0,
      total: 0,
      deltaPercent: 0,
      trades: 0
    };
  }

  const tolerance =
    level *
    tolerancePercent /
    100;

  const selected =
    trades.filter(
      t =>
        Math.abs(t.price - level) <=
        tolerance
    );

  let buy = 0;
  let sell = 0;

  for (const t of selected) {
    if (t.side === "Buy") {
      buy += t.value;
    } else {
      sell += t.value;
    }
  }

  const total =
    buy + sell;

  const delta =
    buy - sell;

  return {
    level,
    tolerance,
    buy,
    sell,
    delta,
    total,
    deltaPercent:
      total
        ? delta / total * 100
        : 0,
    buyShare:
      total
        ? buy / total * 100
        : 0,
    sellShare:
      total
        ? sell / total * 100
        : 0,
    trades: selected.length
  };
}

/* =========================================================
   TIMEFRAME ANALYSIS
========================================================= */

function analyzeTimeframe(
  candles
) {
  const closes =
    candles.map(x => x.close);

  const price =
    closes[closes.length - 1];

  const ma7 =
    getMA(closes, 7);

  const ma20 =
    getMA(closes, 20);

  const previousMA20 =
    maPrevious(closes, 20);

  const r =
    rsi(closes, 14);

  const a =
    atr(candles, 14);

  const volume =
    volumeStats(candles, 20);

  const bb =
    bollinger(closes, 20);

  const m =
    macd(closes);

  const slope =
    previousMA20 && ma20
      ? pct(
          ma20,
          previousMA20
        )
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
    const last =
      candles[candles.length - 1];

    touch =
      last.low <= ma20 &&
      last.high >= ma20;

    const distance =
      Math.abs(
        price - ma20
      ) / ma20 * 100;

    near =
      distance <= 0.35;

    if (previousMA20 !== null) {
      const prevClose =
        candles[
          candles.length - 2
        ].close;

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
    const last =
      candles[candles.length - 1];

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

    atrPct:
      a && price
        ? a / price * 100
        : null,

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
   SMART MONEY
========================================================= */

function smartMoney(candles) {
  const structure =
    structureAnalysis(candles);

  const fvg =
    findFVG(candles);

  const orderBlocks =
    findOrderBlocks(candles);

  const sweep =
    liquiditySweep(
      candles,
      structure
    );

  const price =
    candles[
      candles.length - 1
    ].close;

  const activeFVG =
    fvg
      .filter(
        x =>
          price >= x.bottom &&
          price <= x.top
      )
      .slice(-3);

  const activeOB =
    orderBlocks
      .filter(
        x =>
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
   TRADING STYLE
========================================================= */

function classifyTradingStyle({
  candles,
  ma20,
  smart,
  footprint,
  orderbook
}) {
  const structure =
    smart.structure;

  let bullish = 0;
  let bearish = 0;
  let range = 0;

  const reasons = [];

  /* STRUCTURE */

  if (structure.trend === "BULLISH") {
    bullish += 30;
    reasons.push(
      "ساختار HH/HL صعودی"
    );
  }

  if (structure.trend === "BEARISH") {
    bearish += 30;
    reasons.push(
      "ساختار LH/LL نزولی"
    );
  }

  if (structure.trend === "RANGE") {
    range += 30;
    reasons.push(
      "ساختار رنج"
    );
  }

  /* MA20 */

  if (ma20?.bias === "BULLISH") {
    bullish += 20;
    reasons.push(
      "قیمت و شیب EMA20 صعودی"
    );
  }

  if (ma20?.bias === "BEARISH") {
    bearish += 20;
    reasons.push(
      "قیمت و شیب EMA20 نزولی"
    );
  }

  if (
    ma20?.slope?.state === "FLAT"
  ) {
    range += 15;
  }

  /* FOOTPRINT */

  if (
    footprint.deltaPercent > 10
  ) {
    bullish += 15;
    reasons.push(
      "دلتا معاملات مثبت"
    );
  }

  if (
    footprint.deltaPercent < -10
  ) {
    bearish += 15;
    reasons.push(
      "دلتا معاملات منفی"
    );
  }

  /* ORDER BOOK */

  if (
    orderbook.bidShare >
    orderbook.askShare + 8
  ) {
    bullish += 10;
    reasons.push(
      "نقدینگی Bid بیشتر"
    );
  }

  if (
    orderbook.askShare >
    orderbook.bidShare + 8
  ) {
    bearish += 10;
    reasons.push(
      "نقدینگی Ask بیشتر"
    );
  }

  /* SWEEP */

  if (
    smart.sweep.type === "BULLISH"
  ) {
    bullish += 15;
    reasons.push(
      "هانت نقدینگی سمت فروش"
    );
  }

  if (
    smart.sweep.type === "BEARISH"
  ) {
    bearish += 15;
    reasons.push(
      "هانت نقدینگی سمت خرید"
    );
  }

  const max =
    Math.max(
      bullish,
      bearish,
      range
    );

  let style = "RANGE";

  if (
    max === bullish &&
    bullish >= 45
  ) {
    style = "SMART_MONEY_BULLISH";
  }

  if (
    max === bearish &&
    bearish >= 45
  ) {
    style = "SMART_MONEY_BEARISH";
  }

  if (
    max === range ||
    Math.abs(bullish - bearish) < 15
  ) {
    style = "RANGE";
  }

  return {
    style,

    label:
      style === "SMART_MONEY_BULLISH"
        ? "اسمارت مانی صعودی"
        : style === "SMART_MONEY_BEARISH"
          ? "اسمارت مانی نزولی"
          : "رنج",

    scores: {
      bullish,
      bearish,
      range
    },

    reasons
  };
}

/* =========================================================
   SIGNAL ENGINE
   فقط 1M در سیگنال دخالت دارد.
   15M فقط Context است.
========================================================= */

function signalEngine({
  one,
  smart,
  footprint,
  orderbook,
  ma20,
  difficulty = 11
}) {
  const hard =
    clamp(
      num(difficulty),
      0,
      100
    );

  const threshold =
    clamp(
      DEFAULT_THRESHOLD +
        hard * 0.48,
      32,
      80
    );

  let bull = 0;
  let bear = 0;

  const reasonsBull = [];
  const reasonsBear = [];

  /* =========================================
     MA20 PRIMARY
  ========================================= */

  if (
    ma20.touch &&
    ma20.confirmationState ===
      "BULLISH"
  ) {
    bull += 20;
    reasonsBull.push(
      "برخورد و واکنش صعودی قیمت به EMA20 یک دقیقه"
    );
  }

  if (
    ma20.touch &&
    ma20.confirmationState ===
      "BEARISH"
  ) {
    bear += 20;
    reasonsBear.push(
      "برخورد و واکنش نزولی قیمت به EMA20 یک دقیقه"
    );
  }

  if (ma20.crossUp) {
    bull += 18;
    reasonsBull.push(
      "عبور صعودی قیمت از EMA20"
    );
  }

  if (ma20.crossDown) {
    bear += 18;
    reasonsBear.push(
      "عبور نزولی قیمت از EMA20"
    );
  }

  /* MA SLOPE */

  const slope =
    ma20.slope?.fiveCandles?.percent || 0;

  if (slope > 0.03) {
    bull += 15;
    reasonsBull.push(
      "شیب EMA20 یک دقیقه صعودی قوی"
    );
  } else if (slope > 0.005) {
    bull += 9;
    reasonsBull.push(
      "شیب EMA20 یک دقیقه صعودی"
    );
  }

  if (slope < -0.03) {
    bear += 15;
    reasonsBear.push(
      "شیب EMA20 یک دقیقه نزولی قوی"
    );
  } else if (slope < -0.005) {
    bear += 9;
    reasonsBear.push(
      "شیب EMA20 یک دقیقه نزولی"
    );
  }

  /* CANDLE CONFIRMATION */

  if (
    ma20.candleConfirmation.state ===
      "BULLISH_REJECTION" ||
    ma20.candleConfirmation.state ===
      "BULLISH_WICK_REJECTION" ||
    ma20.candleConfirmation.state ===
      "BULLISH_CROSS"
  ) {
    bull += 12;
    reasonsBull.push(
      "کندل تأییدیه صعودی روی EMA20"
    );
  }

  if (
    ma20.candleConfirmation.state ===
      "BEARISH_REJECTION" ||
    ma20.candleConfirmation.state ===
      "BEARISH_WICK_REJECTION" ||
    ma20.candleConfirmation.state ===
      "BEARISH_CROSS"
  ) {
    bear += 12;
    reasonsBear.push(
      "کندل تأییدیه نزولی روی EMA20"
    );
  }

  /* =========================================
     RSI 1M
  ========================================= */

  if (
    one.rsi !== null &&
    one.rsi >= 50
  ) {
    bull += 5;
    reasonsBull.push(
      "RSI یک دقیقه بالای 50"
    );
  }

  if (
    one.rsi !== null &&
    one.rsi < 50
  ) {
    bear += 5;
    reasonsBear.push(
      "RSI یک دقیقه زیر 50"
    );
  }

  /* =========================================
     MACD 1M
  ========================================= */

  if (
    one.macd.macd !== null &&
    one.macd.signal !== null
  ) {
    if (
      one.macd.macd >
      one.macd.signal
    ) {
      bull += 7;
      reasonsBull.push(
        "MACD یک دقیقه صعودی"
      );
    }

    if (
      one.macd.macd <
      one.macd.signal
    ) {
      bear += 7;
      reasonsBear.push(
        "MACD یک دقیقه نزولی"
      );
    }
  }

  /* =========================================
     VOLUME 1M
  ========================================= */

  if (one.volume.spike) {
    if (
      one.price >
      one.ma20
    ) {
      bull += 6;
      reasonsBull.push(
        "افزایش حجم روی قیمت بالای EMA20"
      );
    }

    if (
      one.price <
      one.ma20
    ) {
      bear += 6;
      reasonsBear.push(
        "افزایش حجم روی قیمت زیر EMA20"
      );
    }
  }

  /* =========================================
     FOOTPRINT
  ========================================= */

  if (footprint.total > 0) {
    const deltaPct =
      footprint.deltaPercent;

    if (deltaPct > 15) {
      bull += 10;
      reasonsBull.push(
        "دلتا فوت‌پرینت مثبت"
      );
    }

    if (deltaPct < -15) {
      bear += 10;
      reasonsBear.push(
        "دلتا فوت‌پرینت منفی"
      );
    }
  }

  /* =========================================
     ORDERBOOK
  ========================================= */

  if (
    orderbook.bidShare >
    orderbook.askShare + 8
  ) {
    bull += 5;
    reasonsBull.push(
      "غلبه نقدینگی دیوارهای خرید"
    );
  }

  if (
    orderbook.askShare >
    orderbook.bidShare + 8
  ) {
    bear += 5;
    reasonsBear.push(
      "غلبه نقدینگی دیوارهای فروش"
    );
  }

  /* =========================================
     STRUCTURE 1M
  ========================================= */

  if (
    smart.structure.bos?.side ===
    "BULLISH"
  ) {
    bull += 10;
    reasonsBull.push(
      "BOS صعودی در یک دقیقه"
    );
  }

  if (
    smart.structure.bos?.side ===
    "BEARISH"
  ) {
    bear += 10;
    reasonsBear.push(
      "BOS نزولی در یک دقیقه"
    );
  }

  if (
    smart.structure.choch?.side ===
    "BULLISH"
  ) {
    bull += 10;
    reasonsBull.push(
      "CHoCH صعودی در یک دقیقه"
    );
  }

  if (
    smart.structure.choch?.side ===
    "BEARISH"
  ) {
    bear += 10;
    reasonsBear.push(
      "CHoCH نزولی در یک دقیقه"
    );
  }

  /* =========================================
     FVG
  ========================================= */

  if (
    smart.activeFVG.length
  ) {
    const f =
      smart.activeFVG[
        smart.activeFVG.length - 1
      ];

    if (f.type === "BULLISH") {
      bull += 7;
      reasonsBull.push(
        "قیمت داخل FVG صعودی"
      );
    }

    if (f.type === "BEARISH") {
      bear += 7;
      reasonsBear.push(
        "قیمت داخل FVG نزولی"
      );
    }
  }

  /* =========================================
     ORDER BLOCK
  ========================================= */

  if (
    smart.activeOB.length
  ) {
    const ob =
      smart.activeOB[
        smart.activeOB.length - 1
      ];

    if (ob.type === "BULLISH") {
      bull += 7;
      reasonsBull.push(
        "قیمت داخل Order Block صعودی"
      );
    }

    if (ob.type === "BEARISH") {
      bear += 7;
      reasonsBear.push(
        "قیمت داخل Order Block نزولی"
      );
    }
  }

  /* =========================================
     LIQUIDITY HUNT
  ========================================= */

  if (
    smart.sweep.type === "BULLISH"
  ) {
    bull += 15;
    reasonsBull.push(
      "هانت نقدینگی صعودی"
    );
  }

  if (
    smart.sweep.type === "BEARISH"
  ) {
    bear += 15;
    reasonsBear.push(
      "هانت نقدینگی نزولی"
    );
  }

  bull =
    clamp(bull, 0, 100);

  bear =
    clamp(bear, 0, 100);

  let direction = "WAIT";

  const score =
    Math.max(bull, bear);

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

    primaryTimeframe: "1m",

    higherTimeframeUsedInSignal: false,

    reasons: {
      bull: reasonsBull,
      bear: reasonsBear
    }
  };
}

/* =========================================================
   HIGHER TIMEFRAME CONTEXT
   این قسمت در سیگنال دخالت نمی‌کند.
========================================================= */

function higherTimeframeContext(
  candles,
  smart
) {
  const analysis =
    analyzeTimeframe(candles);

  const structure =
    structureAnalysis(candles);

  const ma =
    analyzeMA20(candles);

  let expectation = "RANGE";

  if (
    structure.trend === "BULLISH" &&
    ma.bias === "BULLISH"
  ) {
    expectation = "BULLISH";
  }

  if (
    structure.trend === "BEARISH" &&
    ma.bias === "BEARISH"
  ) {
    expectation = "BEARISH";
  }

  if (
    Math.abs(
      (ma.slope?.fiveCandles?.percent || 0)
    ) < 0.005
  ) {
    expectation = "RANGE";
  }

  return {
    timeframe: "15m",

    usedInSignal: false,

    expectation,

    trend: analysis.trend,

    price: analysis.price,

    ma20: ma,

    rsi: analysis.rsi,

    macd: analysis.macd,

    volume: analysis.volume,

    bollinger: analysis.bollinger,

    structure,

    BOS: structure.bos,

    CHoCH: structure.choch,

    FVG: smart.fvg,

    activeFVG: smart.activeFVG,

    OrderBlocks: smart.orderBlocks,

    activeOrderBlocks:
      smart.activeOB,

    liquiditySweep:
      smart.sweep
  };
}

/* =========================================================
   COMPLETE SYMBOL ANALYSIS
========================================================= */

async function analyzeSymbol(
  symbol,
  category = "linear",
  difficulty = 11
) {
  const s =
    symbol.toUpperCase();

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
    analyzeTimeframe(
      oneCandles
    );

  const fifteen =
    analyzeTimeframe(
      fifteenCandles
    );

  /* MA20 DETAILED 1M */

  const ma20 =
    analyzeMA20(
      oneCandles
    );

  /* SMART MONEY 1M */

  const smart =
    smartMoney(
      oneCandles
    );

  /* SUPPORT / RESISTANCE 1M */

  const sr =
    supportResistance(
      oneCandles
    );

  /* WALLS */

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

  const levelWalls =
    wallsAroundLevels(
      orderbook,
      sr,
      one.price
    );

  /* FOOTPRINT AT LEVELS */

  const supportFootprint =
    footprintAtLevel(
      footprint.trades,
      sr.support
    );

  const resistanceFootprint =
    footprintAtLevel(
      footprint.trades,
      sr.resistance
    );

  /* TRADING STYLE */

  const style =
    classifyTradingStyle({
      candles: oneCandles,
      ma20,
      smart,
      footprint,
      orderbook
    });

  /* 15M CONTEXT */

  const context15m =
    higherTimeframeContext(
      fifteenCandles,
      smartMoney(
        fifteenCandles
      )
    );

  /* SIGNAL */

  const signal =
    signalEngine({
      one,
      smart,
      footprint,
      orderbook,
      ma20,
      difficulty
    });

  const price =
    one.price;

  const distance =
    one.ma20
      ? pct(
          price,
          one.ma20
        )
      : null;

  return {
    ok: true,

    symbol: s,
    category,

    price,

    /* =====================================
       SIGNAL
    ===================================== */

    signal,

    /* =====================================
       MARKET
    ===================================== */

    market: {
      primarySignalTimeframe: "1m",
      higherTimeframe: "15m",

      trend1m: one.trend,
      trend15m: fifteen.trend,

      fifteenMinuteExpectation:
        context15m.expectation
    },

    /* =====================================
       MA20 PRIMARY
    ===================================== */

    MA20: {
      timeframe: "1m",

      period: 20,
      type: "EMA",

      value: ma20.value,

      previousValue:
        ma20.previousValue,

      price: ma20.price,

      distance:
        ma20.distance,

      distancePercent:
        ma20.distancePercent,

      interaction:
        ma20.interaction,

      touch:
        ma20.touch,

      crossUp:
        ma20.crossUp,

      crossDown:
        ma20.crossDown,

      above:
        ma20.above,

      below:
        ma20.below,

      slope:
        ma20.slope,

      candleConfirmation:
        ma20.candleConfirmation,

      bias:
        ma20.bias
    },

    /* =====================================
       1M ANALYSIS
    ===================================== */

    oneMinute: {
      ...one,

      distanceToMA20:
        distance,

      contact:
        one.touch,

      nearMA20:
        one.near,

      ma20Detailed:
        ma20
    },

    /* =====================================
       15M — CONTEXT ONLY
    ===================================== */

    fifteenMinute: {
      ...fifteen,

      higherTimeframeContext:
        context15m,

      signalWeight: 0,

      signalParticipation: false
    },

    /* =====================================
       TRADING STYLE
    ===================================== */

    tradingStyle: style,

    styles: {
      smartMoney: {
        label:
          style.label,

        style:
          style.style,

        scores:
          style.scores,

        reasons:
          style.reasons
      }
    },

    /* =====================================
       SMART MONEY 1M
    ===================================== */

    smartMoney: {
      timeframe: "1m",

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

    /* =====================================
       SUPPORT / RESISTANCE
    ===================================== */

    supportResistance: {
      timeframe: "1m",

      support:
        sr.support,

      resistance:
        sr.resistance,

      distanceToSupport:
        sr.distanceToSupport,

      distanceToResistance:
        sr.distanceToResistance,

      swingHighs:
        sr.swingHighs,

      swingLows:
        sr.swingLows
    },

    /* =====================================
       FOOTPRINT
    ===================================== */

    footprint: {
      timeframe: "recent Bybit trades",

      buy:
        footprint.buy,

      sell:
        footprint.sell,

      buyVolume:
        footprint.buyVolume,

      sellVolume:
        footprint.sellVolume,

      delta:
        footprint.delta,

      deltaPercent:
        footprint.deltaPercent,

      total:
        footprint.total,

      buyShare:
        footprint.buyShare,

      sellShare:
        footprint.sellShare,

      supportLevel:
        supportFootprint,

      resistanceLevel:
        resistanceFootprint
    },

    /* =====================================
       ORDER BOOK / WALLS
    ===================================== */

    orderBook: {
      bestBid:
        orderbook.bestBid,

      bestAsk:
        orderbook.bestAsk,

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

      supportWalls:
        levelWalls.supportWalls,

      resistanceWalls:
        levelWalls.resistanceWalls,

      bids:
        orderbook.bids,

      asks:
        orderbook.asks
    },

    /* =====================================
       LIQUIDITY / HUNT
    ===================================== */

    liquidity: {
      hunt:
        smart.sweep,

      type:
        smart.sweep.type,

      level:
        smart.sweep.level || null,

      wickSize:
        smart.sweep.wickSize || 0,

      wickPercent:
        smart.sweep.wickPercent || 0,

      candleVolume:
        smart.sweep.candleVolume || 0,

      estimatedSweepValue:
        smart.sweep.estimatedSweepValue || 0,

      candleTurnover:
        smart.sweep.candleTurnover || 0
    },

    /* =====================================
       INDICATORS
    ===================================== */

    indicators: {
      RSI1m:
        one.rsi,

      RSI15m:
        fifteen.rsi,

      MACD1m:
        one.macd,

      MACD15m:
        fifteen.macd,

      ATR1m:
        one.atr,

      ATR15m:
        fifteen.atr,

      Bollinger1m:
        one.bollinger,

      Bollinger15m:
        fifteen.bollinger
    },

    /* =====================================
       VOLUME
    ===================================== */

    volume: {
      oneMinute:
        one.volume,

      fifteenMinute:
        fifteen.volume
    },

    timestamp:
      Date.now()
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
      .replace(
        /[^A-Z0-9]/g,
        ""
      );

  if (!q) return [];

  const results = [];

  for (
    const category of [
      "spot",
      "linear"
    ]
  ) {
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
          String(
            x.symbol || ""
          ).toUpperCase();

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

  for (
    const category of [
      "linear",
      "spot"
    ]
  ) {
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
          String(
            x.symbol
          ).endsWith("USDT")
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

  return [
    ...unique.values()
  ];
}

/* =========================================================
   QUICK SCAN
========================================================= */

async function quickScan(
  symbol,
  category
) {
  try {
    const candles =
      await getKlines(
        category,
        symbol,
        "1",
        60
      );

    if (
      candles.length < 30
    ) {
      return null;
    }

    const a =
      analyzeTimeframe(
        candles
      );

    if (!a.ma20) {
      return null;
    }

    const distance =
      Math.abs(
        pct(
          a.price,
          a.ma20
        )
      );

    return {
      symbol,
      category,

      price:
        a.price,

      ma20:
        a.ma20,

      distance,

      trend:
        a.trend,

      volumeRatio:
        a.volume.ratio,

      rsi:
        a.rsi
    };
  } catch {
    return null;
  }
}

/* =========================================================
   SCAN MARKET
========================================================= */

async function scanMarket(
  difficulty = 11
) {
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
            x.category
          )
        )
      );

    for (const r of out) {
      if (!r) continue;

      if (
        r.distance <= 0.60
      ) {
        results.push(r);
      }
    }

    if (
      results.length >=
      RADAR_LIMIT
    ) {
      break;
    }

    await sleep(80);
  }

  results.sort(
    (a, b) =>
      a.distance -
      b.distance
  );

  const deep =
    results.slice(
      0,
      DEEP_LIMIT
    );

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
        signals.push(
          analysis
        );
      }
    } catch {}
  }

  return {
    ok: true,

    checked:
      symbols.length,

    candidates:
      results.length,

    signals,

    difficulty,

    signalTimeframe:
      "1m",

    higherTimeframe:
      "15m",

    timestamp:
      Date.now()
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
        return new Response(
          null,
          {
            headers: {
              "access-control-allow-origin":
                "*",

              "access-control-allow-methods":
                "GET,POST,OPTIONS",

              "access-control-allow-headers":
                "Content-Type"
            }
          }
        );
      }

      /* HEALTH */

      if (
        path === "/" ||
        path === "/health"
      ) {
        return json({
          ok: true,

          service:
            "Bybit Personal Scanner",

          connected:
            true,

          time:
            Date.now()
        });
      }

      /* SEARCH */

      if (
        path ===
        "/api/search"
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
        path ===
        "/api/analyze"
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
          return json(
            {
              ok: false,
              error:
                "symbol required"
            },
            400
          );
        }

        const result =
          await analyzeSymbol(
            symbol,
            category,
            difficulty
          );

        return json(
          result
        );
      }

      /* SCAN */

      if (
        path ===
        "/api/scan"
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

        return json(
          result
        );
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

          total:
            symbols.length,

          symbols
        });
      }

      return json(
        {
          ok: false,
          error:
            "Not found"
        },
        404
      );

    } catch (err) {
      return json(
        {
          ok: false,

          error:
            err?.message ||
            String(err),

          timestamp:
            Date.now()
        },
        500
      );
    }
  }
};
