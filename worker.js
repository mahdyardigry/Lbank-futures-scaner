const BYBIT = "https://api.bybit.com";

const SCAN_BATCH = 20;
const DEEP_LIMIT = 5;
const RADAR_LIMIT = 8;

const KLINE_1M = 250;
const KLINE_15M = 250;

const ORDERBOOK_LIMIT = 50;
const TRADES_LIMIT = 1000;

const DEFAULT_THRESHOLD = 32;
const CACHE_TTL = 8000;

const cache = new Map();

/* =========================================================
   RESPONSE
========================================================= */

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "Content-Type"
    }
  });

const sleep = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

/* =========================================================
   BYBIT
========================================================= */

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
    headers: {
      Accept: "application/json"
    }
  });

  if (!res.ok) {
    throw new Error(`Bybit HTTP ${res.status}`);
  }

  const data = await res.json();

  if (data.retCode !== 0) {
    throw new Error(
      data.retMsg || "Bybit API error"
    );
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
  if (!arr?.length) return 0;

  return arr.reduce(
    (a, b) => a + b,
    0
  ) / arr.length;
}

function sum(arr) {
  return arr?.reduce(
    (a, b) => a + b,
    0
  ) || 0;
}

function pct(a, b) {
  if (!b) return 0;

  return ((a - b) / b) * 100;
}

function round(v, d = 4) {
  if (!Number.isFinite(Number(v))) {
    return 0;
  }

  const p = 10 ** d;

  return Math.round(
    Number(v) * p
  ) / p;
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
    .sort(
      (a, b) => a.time - b.time
    );
}

async function getKlines(
  category,
  symbol,
  interval,
  limit
) {
  const data = await bybit(
    "/v5/market/kline",
    {
      category,
      symbol,
      interval,
      limit
    }
  );

  return normalizeKlines(
    data.result?.list || []
  );
}

/* =========================================================
   MOVING AVERAGE
========================================================= */

function sma(values, period) {
  if (
    !values ||
    values.length < period
  ) {
    return null;
  }

  return avg(
    values.slice(-period)
  );
}

function ema(values, period) {
  if (
    !values ||
    values.length < period
  ) {
    return null;
  }

  const k =
    2 / (period + 1);

  let e =
    avg(values.slice(0, period));

  for (
    let i = period;
    i < values.length;
    i++
  ) {
    e =
      values[i] * k +
      e * (1 - k);
  }

  return e;
}

function getMA(
  values,
  period,
  type = "EMA"
) {
  return type === "SMA"
    ? sma(values, period)
    : ema(values, period);
}

function maAt(
  values,
  period,
  type = "EMA",
  removeLast = 0
) {
  const arr =
    removeLast
      ? values.slice(0, -removeLast)
      : values;

  return getMA(
    arr,
    period,
    type
  );
}

/* =========================================================
   MA20 REAL ANALYSIS
========================================================= */

function analyzeMA20(candles) {
  if (candles.length < 30) {
    return {
      available: false,
      reason: "not enough candles"
    };
  }

  const closes =
    candles.map(x => x.close);

  const current =
    getMA(
      closes,
      20,
      "EMA"
    );

  const previous1 =
    maAt(
      closes,
      20,
      "EMA",
      1
    );

  const previous3 =
    maAt(
      closes,
      20,
      "EMA",
      3
    );

  const previous5 =
    maAt(
      closes,
      20,
      "EMA",
      5
    );

  const previous10 =
    maAt(
      closes,
      20,
      "EMA",
      10
    );

  const price =
    closes.at(-1);

  const prevPrice =
    closes.at(-2);

  const last =
    candles.at(-1);

  const prev =
    candles.at(-2);

  const slope1 =
    previous1
      ? pct(current, previous1)
      : 0;

  const slope3 =
    previous3
      ? pct(current, previous3) / 3
      : 0;

  const slope5 =
    previous5
      ? pct(current, previous5) / 5
      : 0;

  const slope10 =
    previous10
      ? pct(current, previous10) / 10
      : 0;

  const distance =
    pct(price, current);

  const priceAbove =
    price > current;

  const priceBelow =
    price < current;

  const touched =
    last.low <= current &&
    last.high >= current;

  const previousTouched =
    previous1 !== null &&
    prev.low <= previous1 &&
    prev.high >= previous1;

  const body =
    Math.abs(
      last.close -
      last.open
    );

  const range =
    Math.max(
      last.high -
      last.low,
      0
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

  const bullishBody =
    last.close >
    last.open;

  const bearishBody =
    last.close <
    last.open;

  const bodyRatio =
    range > 0
      ? body / range
      : 0;

  const bullishRejection =
    touched &&
    bullishBody &&
    last.close > current &&
    lowerWick >
      body * 0.35;

  const bearishRejection =
    touched &&
    bearishBody &&
    last.close < current &&
    upperWick >
      body * 0.35;

  const bullishConfirmation =
    touched &&
    bullishBody &&
    last.close > current &&
    last.close > prev.high;

  const bearishConfirmation =
    touched &&
    bearishBody &&
    last.close < current &&
    last.close < prev.low;

  const crossUp =
    previous1 !== null &&
    prevPrice <= previous1 &&
    price > current;

  const crossDown =
    previous1 !== null &&
    prevPrice >= previous1 &&
    price < current;

  let slopeDirection =
    "FLAT";

  if (slope3 > 0.015) {
    slopeDirection = "UP";
  }

  if (slope3 < -0.015) {
    slopeDirection = "DOWN";
  }

  let position = "ON_MA";

  if (distance > 0.15) {
    position = "ABOVE";
  }

  if (distance < -0.15) {
    position = "BELOW";
  }

  let rejection =
    "NONE";

  if (bullishRejection) {
    rejection = "BULLISH";
  }

  if (bearishRejection) {
    rejection = "BEARISH";
  }

  let confirmation =
    "NONE";

  if (bullishConfirmation) {
    confirmation = "BULLISH";
  }

  if (bearishConfirmation) {
    confirmation = "BEARISH";
  }

  let bias =
    "RANGE";

  if (
    priceAbove &&
    slope1 > 0 &&
    slope5 > 0
  ) {
    bias = "BULLISH";
  }

  if (
    priceBelow &&
    slope1 < 0 &&
    slope5 < 0
  ) {
    bias = "BEARISH";
  }

  return {
    available: true,

    period: 20,
    type: "EMA",

    value:
      round(current, 8),

    previous1m:
      round(previous1, 8),

    previous3m:
      round(previous3, 8),

    previous5m:
      round(previous5, 8),

    previous10m:
      round(previous10, 8),

    price:
      round(price, 8),

    distancePct:
      round(distance, 4),

    absoluteDistancePct:
      round(
        Math.abs(distance),
        4
      ),

    slope1mPct:
      round(slope1, 5),

    slope3mPct:
      round(slope3, 5),

    slope5mPct:
      round(slope5, 5),

    slope10mPct:
      round(slope10, 5),

    slopeDirection,
    position,
    bias,

    touched,
    previousTouched,

    candle: {
      open: last.open,
      high: last.high,
      low: last.low,
      close: last.close,

      body:
        round(body, 8),

      range:
        round(range, 8),

      bodyRatio:
        round(
          bodyRatio * 100,
          2
        ),

      upperWick:
        round(
          upperWick,
          8
        ),

      lowerWick:
        round(
          lowerWick,
          8
        ),

      bullish:
        bullishBody,

      bearish:
        bearishBody
    },

    rejection,
    confirmation,

    crossUp,
    crossDown,

    validLongSetup:
      touched &&
      bullishRejection &&
      slope5 > 0,

    validShortSetup:
      touched &&
      bearishRejection &&
      slope5 < 0
  };
}

/* =========================================================
   RSI
========================================================= */

function rsi(
  values,
  period = 14
) {
  if (
    values.length <= period
  ) {
    return null;
  }

  let gains = 0;
  let losses = 0;

  for (
    let i = 1;
    i <= period;
    i++
  ) {
    const d =
      values[i] -
      values[i - 1];

    if (d >= 0) {
      gains += d;
    } else {
      losses +=
        Math.abs(d);
    }
  }

  let avgGain =
    gains / period;

  let avgLoss =
    losses / period;

  for (
    let i = period + 1;
    i < values.length;
    i++
  ) {
    const d =
      values[i] -
      values[i - 1];

    const gain =
      d > 0 ? d : 0;

    const loss =
      d < 0
        ? Math.abs(d)
        : 0;

    avgGain =
      (
        avgGain *
        (period - 1) +
        gain
      ) / period;

    avgLoss =
      (
        avgLoss *
        (period - 1) +
        loss
      ) / period;
  }

  if (avgLoss === 0) {
    return 100;
  }

  return (
    100 -
    100 /
      (
        1 +
        avgGain /
        avgLoss
      )
  );
}

/* =========================================================
   ATR
========================================================= */

function atr(
  candles,
  period = 14
) {
  if (
    candles.length <= period
  ) {
    return null;
  }

  const tr = [];

  for (
    let i = 1;
    i < candles.length;
    i++
  ) {
    const c =
      candles[i];

    const p =
      candles[i - 1];

    tr.push(
      Math.max(
        c.high - c.low,
        Math.abs(
          c.high -
          p.close
        ),
        Math.abs(
          c.low -
          p.close
        )
      )
    );
  }

  return avg(
    tr.slice(-period)
  );
}

/* =========================================================
   MACD
========================================================= */

function macd(values) {
  if (
    values.length < 35
  ) {
    return {
      macd: null,
      signal: null,
      histogram: null,
      previousHistogram: null,
      cross: "NONE"
    };
  }

  const line = [];

  for (
    let i = 0;
    i < values.length;
    i++
  ) {
    const fast =
      ema(
        values.slice(
          0,
          i + 1
        ),
        12
      );

    const slow =
      ema(
        values.slice(
          0,
          i + 1
        ),
        26
      );

    if (
      fast !== null &&
      slow !== null
    ) {
      line.push(
        fast - slow
      );
    }
  }

  const signalValues = [];

  for (
    let i = 0;
    i < line.length;
    i++
  ) {
    signalValues.push(
      ema(
        line.slice(
          0,
          i + 1
        ),
        9
      )
    );
  }

  const m =
    line.at(-1);

  const s =
    signalValues.at(-1);

  const pm =
    line.at(-2);

  const ps =
    signalValues.at(-2);

  let cross =
    "NONE";

  if (
    pm !== null &&
    ps !== null &&
    pm <= ps &&
    m > s
  ) {
    cross = "BULLISH";
  }

  if (
    pm !== null &&
    ps !== null &&
    pm >= ps &&
    m < s
  ) {
    cross = "BEARISH";
  }

  return {
    macd: m,
    signal: s,

    histogram:
      m !== null &&
      s !== null
        ? m - s
        : null,

    previousHistogram:
      pm !== null &&
      ps !== null
        ? pm - ps
        : null,

    cross
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
  if (
    values.length < period
  ) {
    return null;
  }

  const a =
    values.slice(-period);

  const middle =
    avg(a);

  const variance =
    avg(
      a.map(x =>
        Math.pow(
          x - middle,
          2
        )
      )
    );

  const sd =
    Math.sqrt(variance);

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
        ? (
            (upper - lower) /
            middle
          ) * 100
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
  if (
    candles.length <
    period + 1
  ) {
    return {
      current: 0,
      average: 0,
      ratio: 0,
      spike: false,
      strongSpike: false
    };
  }

  const current =
    candles.at(-1).volume;

  const previous =
    candles
      .slice(
        -(period + 1),
        -1
      )
      .map(
        x => x.volume
      );

  const average =
    avg(previous);

  const ratio =
    average > 0
      ? current / average
      : 0;

  return {
    current,
    average,
    ratio,

    spike:
      ratio >= 1.5,

    strongSpike:
      ratio >= 2
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
    i <
      candles.length -
        strength;
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
        price:
          candles[i].high,
        time:
          candles[i].time
      });
    }

    if (low) {
      lows.push({
        index: i,
        price:
          candles[i].low,
        time:
          candles[i].time
      });
    }
  }

  return {
    highs,
    lows
  };
}

/* =========================================================
   STRUCTURE
========================================================= */

function structureAnalysis(
  candles
) {
  const swings =
    findSwings(
      candles,
      2
    );

  const highs =
    swings.highs;

  const lows =
    swings.lows;

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
    highs.at(-1);

  const prevHigh =
    highs.at(-2);

  const lastLow =
    lows.at(-1);

  const prevLow =
    lows.at(-2);

  const close =
    candles.at(-1).close;

  let trend =
    "RANGE";

  if (
    lastHigh.price >
      prevHigh.price &&
    lastLow.price >
      prevLow.price
  ) {
    trend = "BULLISH";
  }

  if (
    lastHigh.price <
      prevHigh.price &&
    lastLow.price <
      prevLow.price
  ) {
    trend = "BEARISH";
  }

  let bos = null;
  let choch = null;

  if (
    close >
    lastHigh.price
  ) {
    bos = {
      side: "BULLISH",
      price:
        lastHigh.price,
      index:
        lastHigh.index,
      distancePct:
        pct(
          close,
          lastHigh.price
        )
    };

    if (
      trend === "BEARISH"
    ) {
      choch = {
        side: "BULLISH",
        price:
          lastHigh.price
      };
    }
  }

  if (
    close <
    lastLow.price
  ) {
    bos = {
      side: "BEARISH",
      price:
        lastLow.price,
      index:
        lastLow.index,
      distancePct:
        pct(
          close,
          lastLow.price
        )
    };

    if (
      trend === "BULLISH"
    ) {
      choch = {
        side: "BEARISH",
        price:
          lastLow.price
      };
    }
  }

  return {
    available: true,

    trend,

    swingHigh:
      lastHigh,

    previousSwingHigh:
      prevHigh,

    swingLow:
      lastLow,

    previousSwingLow:
      prevLow,

    bos,
    choch
  };
}

/* =========================================================
   FVG
========================================================= */

function findFVG(
  candles
) {
  const found = [];

  for (
    let i = 2;
    i < candles.length;
    i++
  ) {
    const a =
      candles[i - 2];

    const c =
      candles[i];

    if (
      c.low > a.high
    ) {
      found.push({
        type: "BULLISH",

        top:
          c.low,

        bottom:
          a.high,

        index: i,

        time:
          c.time,

        size:
          c.low - a.high,

        sizePct:
          pct(
            c.low,
            a.high
          ),

        middle:
          (
            c.low +
            a.high
          ) / 2
      });
    }

    if (
      c.high < a.low
    ) {
      found.push({
        type: "BEARISH",

        top:
          a.low,

        bottom:
          c.high,

        index: i,

        time:
          c.time,

        size:
          a.low - c.high,

        sizePct:
          pct(
            a.low,
            c.high
          ),

        middle:
          (
            a.low +
            c.high
          ) / 2
      });
    }
  }

  return found.slice(-15);
}

/* =========================================================
   ORDER BLOCK
========================================================= */

function findOrderBlocks(
  candles
) {
  const blocks = [];

  for (
    let i = 2;
    i <
      candles.length - 2;
    i++
  ) {
    const c =
      candles[i];

    const n1 =
      candles[i + 1];

    const n2 =
      candles[i + 2];

    const body =
      Math.abs(
        c.close -
        c.open
      );

    if (!body) continue;

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
        time: c.time,
        size:
          c.high - c.low
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
        time: c.time,
        size:
          c.high - c.low
      });
    }
  }

  return blocks.slice(-15);
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
    candles.at(-1);

  const high =
    structure.swingHigh.price;

  const low =
    structure.swingLow.price;

  const highSweep =
    c.high > high &&
    c.close < high;

  const lowSweep =
    c.low < low &&
    c.close > low;

  if (highSweep) {
    return {
      available: true,

      type: "BEARISH",

      level: high,

      wick: c.high,

      close: c.close,

      sweepAmount:
        c.high - high,

      sweepPct:
        pct(
          c.high,
          high
        ),

      candleVolume:
        c.volume
    };
  }

  if (lowSweep) {
    return {
      available: true,

      type: "BULLISH",

      level: low,

      wick: c.low,

      close: c.close,

      sweepAmount:
        low - c.low,

      sweepPct:
        pct(
          c.low,
          low
        ),

      candleVolume:
        c.volume
    };
  }

  return {
    available: true,
    type: "NONE",
    level: null
  };
}

/* =========================================================
   TIMEFRAME ANALYSIS
========================================================= */

function analyzeTimeframe(
  candles
) {
  const closes =
    candles.map(
      x => x.close
    );

  const price =
    closes.at(-1);

  const ma7 =
    getMA(
      closes,
      7,
      "EMA"
    );

  const ma20 =
    getMA(
      closes,
      20,
      "EMA"
    );

  const previousMA20 =
    maAt(
      closes,
      20,
      "EMA",
      1
    );

  const r =
    rsi(
      closes,
      14
    );

  const a =
    atr(
      candles,
      14
    );

  const volume =
    volumeStats(
      candles,
      20
    );

  const bb =
    bollinger(
      closes,
      20
    );

  const m =
    macd(closes);

  const maSlope =
    previousMA20 &&
    ma20
      ? pct(
          ma20,
          previousMA20
        )
      : 0;

  let trend =
    "RANGE";

  if (
    ma7 &&
    ma20 &&
    ma7 > ma20 &&
    maSlope > 0
  ) {
    trend = "BULLISH";
  }

  if (
    ma7 &&
    ma20 &&
    ma7 < ma20 &&
    maSlope < 0
  ) {
    trend = "BEARISH";
  }

  const last =
    candles.at(-1);

  const touch =
    ma20 &&
    last.low <= ma20 &&
    last.high >= ma20;

  const distance =
    ma20
      ? pct(
          price,
          ma20
        )
      : null;

  const near =
    ma20 &&
    Math.abs(distance) <=
      0.35;

  const crossUp =
    previousMA20 !== null &&
    candles.at(-2).close <=
      previousMA20 &&
    price > ma20;

  const crossDown =
    previousMA20 !== null &&
    candles.at(-2).close >=
      previousMA20 &&
    price < ma20;

  let rejection =
    "NONE";

  if (
    touch &&
    last.close > ma20 &&
    last.close > last.open
  ) {
    rejection =
      "BULLISH";
  }

  if (
    touch &&
    last.close < ma20 &&
    last.close < last.open
  ) {
    rejection =
      "BEARISH";
  }

  return {
    price,

    ma7,
    ma20,
    previousMA20,

    maSlope,
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

    distanceToMA20:
      distance,

    crossUp,
    crossDown,

    rejection
  };
}

/* =========================================================
   SMART MONEY
========================================================= */

function classifySmartMoney(
  candles
) {
  const structure =
    structureAnalysis(
      candles
    );

  const fvg =
    findFVG(candles);

  const orderBlocks =
    findOrderBlocks(
      candles
    );

  const sweep =
    liquiditySweep(
      candles,
      structure
    );

  const price =
    candles.at(-1).close;

  const activeFVG =
    fvg.filter(x =>
      price >= x.bottom &&
      price <= x.top
    );

  const activeOB =
    orderBlocks.filter(x =>
      price >= x.low &&
      price <= x.high
    );

  let bullish = 0;
  let bearish = 0;

  if (
    structure.trend ===
    "BULLISH"
  ) {
    bullish += 30;
  }

  if (
    structure.trend ===
    "BEARISH"
  ) {
    bearish += 30;
  }

  if (
    structure.bos?.side ===
    "BULLISH"
  ) {
    bullish += 25;
  }

  if (
    structure.bos?.side ===
    "BEARISH"
  ) {
    bearish += 25;
  }

  if (
    structure.choch?.side ===
    "BULLISH"
  ) {
    bullish += 20;
  }

  if (
    structure.choch?.side ===
    "BEARISH"
  ) {
    bearish += 20;
  }

  if (
    sweep.type ===
    "BULLISH"
  ) {
    bullish += 20;
  }

  if (
    sweep.type ===
    "BEARISH"
  ) {
    bearish += 20;
  }

  if (
    activeFVG.at(-1)?.type ===
    "BULLISH"
  ) {
    bullish += 15;
  }

  if (
    activeFVG.at(-1)?.type ===
    "BEARISH"
  ) {
    bearish += 15;
  }

  if (
    activeOB.at(-1)?.type ===
    "BULLISH"
  ) {
    bullish += 15;
  }

  if (
    activeOB.at(-1)?.type ===
    "BEARISH"
  ) {
    bearish += 15;
  }

  let style =
    "RANGE";

  if (
    bullish >= 45 &&
    bullish >
      bearish + 10
  ) {
    style =
      "SMART_MONEY_BULLISH";
  }

  if (
    bearish >= 45 &&
    bearish >
      bullish + 10
  ) {
    style =
      "SMART_MONEY_BEARISH";
  }

  return {
    style,

    bullishScore:
      clamp(
        bullish,
        0,
        100
      ),

    bearishScore:
      clamp(
        bearish,
        0,
        100
      ),

    structure,
    fvg,
    activeFVG,
    orderBlocks,
    activeOB,
    sweep
  };
}

/* =========================================================
   TRADING STYLE CLASSIFICATION
========================================================= */

function classifyTradingStyle({
  one,
  fifteen,
  smart,
  footprint,
  orderbook
}) {
  const bull = [];
  const bear = [];

  const ma =
    one.ma20Analysis;

  if (
    ma?.validLongSetup
  ) {
    bull.push(
      "MA20_RETEST"
    );
  }

  if (
    ma?.validShortSetup
  ) {
    bear.push(
      "MA20_RETEST"
    );
  }

  if (
    smart.sweep.type ===
    "BULLISH"
  ) {
    bull.push(
      "LIQUIDITY_HUNT"
    );
  }

  if (
    smart.sweep.type ===
    "BEARISH"
  ) {
    bear.push(
      "LIQUIDITY_HUNT"
    );
  }

  if (
    smart.structure.bos?.side ===
    "BULLISH"
  ) {
    bull.push(
      "BOS"
    );
  }

  if (
    smart.structure.bos?.side ===
    "BEARISH"
  ) {
    bear.push(
      "BOS"
    );
  }

  if (
    smart.structure.choch?.side ===
    "BULLISH"
  ) {
    bull.push(
      "CHoCH"
    );
  }

  if (
    smart.structure.choch?.side ===
    "BEARISH"
  ) {
    bear.push(
      "CHoCH"
    );
  }

  if (
    smart.activeFVG.at(-1)?.type ===
    "BULLISH"
  ) {
    bull.push(
      "FVG"
    );
  }

  if (
    smart.activeFVG.at(-1)?.type ===
    "BEARISH"
  ) {
    bear.push(
      "FVG"
    );
  }

  if (
    smart.activeOB.at(-1)?.type ===
    "BULLISH"
  ) {
    bull.push(
      "ORDER_BLOCK"
    );
  }

  if (
    smart.activeOB.at(-1)?.type ===
    "BEARISH"
  ) {
    bear.push(
      "ORDER_BLOCK"
    );
  }

  if (
    footprint.deltaPct >=
    15
  ) {
    bull.push(
      "BUY_PRESSURE"
    );
  }

  if (
    footprint.deltaPct <=
    -15
  ) {
    bear.push(
      "SELL_PRESSURE"
    );
  }

  if (
    orderbook.bidShare >
    orderbook.askShare + 8
  ) {
    bull.push(
      "BID_DOMINANCE"
    );
  }

  if (
    orderbook.askShare >
    orderbook.bidShare + 8
  ) {
    bear.push(
      "ASK_DOMINANCE"
    );
  }

  let style =
    "RANGE / NO CLEAR STYLE";

  let side =
    "NEUTRAL";

  let confidence = 0;

  if (
    bull.length >= 3 &&
    bull.length >
      bear.length
  ) {
    style =
      "SMART MONEY LONG";

    side =
      "LONG";

    confidence =
      clamp(
        50 +
        bull.length * 8 -
        bear.length * 5,
        0,
        100
      );
  }

  if (
    bear.length >= 3 &&
    bear.length >
      bull.length
  ) {
    style =
      "SMART MONEY SHORT";

    side =
      "SHORT";

    confidence =
      clamp(
        50 +
        bear.length * 8 -
        bull.length * 5,
        0,
        100
      );
  }

  if (
    ma?.validLongSetup &&
    smart.sweep.type ===
      "BULLISH"
  ) {
    style =
      "MA20 + LIQUIDITY HUNT LONG";

    side =
      "LONG";

    confidence =
      Math.max(
        confidence,
        78
      );
  }

  if (
    ma?.validShortSetup &&
    smart.sweep.type ===
      "BEARISH"
  ) {
    style =
      "MA20 + LIQUIDITY HUNT SHORT";

    side =
      "SHORT";

    confidence =
      Math.max(
        confidence,
        78
      );
  }

  if (
    fifteen.expectation ===
      "BULLISH" &&
    side === "LONG"
  ) {
    confidence =
      clamp(
        confidence + 8,
        0,
        100
      );
  }

  if (
    fifteen.expectation ===
      "BEARISH" &&
    side === "SHORT"
  ) {
    confidence =
      clamp(
        confidence + 8,
        0,
        100
      );
  }

  return {
    style,
    side,

    confidence:

      round(
        confidence,
        0
      ),

    bullishFactors:
      bull,

    bearishFactors:
      bear,

    dataBased: true
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
        limit:
          ORDERBOOK_LIMIT
      }
    );

  const r =
    data.result || {};

  const bids =
    (r.b || []).map(x => ({
      price:
        num(x[0]),

      volume:
        num(x[1]),

      value:
        num(x[0]) *
        num(x[1])
    }));

  const asks =
    (r.a || []).map(x => ({
      price:
        num(x[0]),

      volume:
        num(x[1]),

      value:
        num(x[0]) *
        num(x[1])
    }));

  const bidLiquidity =
    sum(
      bids.map(
        x => x.value
      )
    );

  const askLiquidity =
    sum(
      asks.map(
        x => x.value
      )
    );

  const total =
    bidLiquidity +
    askLiquidity;

  return {
    bids,
    asks,

    bestBid:
      bids[0]?.price || 0,

    bestAsk:
      asks[0]?.price || 0,

    bidLiquidity,
    askLiquidity,

    bidShare:
      total
        ? bidLiquidity /
          total *
          100
        : 0,

    askShare:
      total
        ? askLiquidity /
          total *
          100
        : 0
  };
}

/* =========================================================
   WALLS
========================================================= */

function getWalls(
  levels,
  side,
  price = 0
) {
  if (!levels.length) {
    return [];
  }

  const values =
    levels.map(
      x => x.value
    );

  const mean =
    avg(values);

  const sorted =
    [...levels].sort(
      (a, b) =>
        b.value -
        a.value
    );

  const maxValue =
    sorted[0]?.value ||
    0;

  const threshold =
    Math.max(
      mean * 3,
      maxValue * 0.20
    );

  return sorted
    .filter(
      x =>
        x.value >=
        threshold
    )
    .slice(0, 10)
    .map(x => ({
      ...x,

      side,

      distancePct:
        price
          ? pct(
              x.price,
              price
            )
          : null,

      strength:
        mean
          ? x.value / mean
          : 0
    }));
}

/* =========================================================
   LIQUIDITY AROUND LEVEL
========================================================= */

function liquidityAroundLevel(
  orderbook,
  level,
  rangePct = 0.35
) {
  if (!level) {
    return {
      bidValue: 0,
      askValue: 0,
      bidVolume: 0,
      askVolume: 0,
      delta: 0
    };
  }

  const low =
    level *
    (
      1 -
      rangePct / 100
    );

  const high =
    level *
    (
      1 +
      rangePct / 100
    );

  const bids =
    orderbook.bids.filter(
      x =>
        x.price >= low &&
        x.price <= high
    );

  const asks =
    orderbook.asks.filter(
      x =>
        x.price >= low &&
        x.price <= high
    );

  const bidValue =
    sum(
      bids.map(
        x => x.value
      )
    );

  const askValue =
    sum(
      asks.map(
        x => x.value
      )
    );

  return {
    level,
    rangePct,

    bidValue,
    askValue,

    bidVolume:
      sum(
        bids.map(
          x => x.volume
        )
      ),

    askVolume:
      sum(
        asks.map(
          x => x.volume
        )
      ),

    delta:
      bidValue -
      askValue
  };
}

/* =========================================================
   TRADES / FOOTPRINT
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
        limit:
          TRADES_LIMIT
      }
    );

  const trades =
    data.result?.list ||
    [];

  let buy = 0;
  let sell = 0;

  let buyVolume = 0;
  let sellVolume = 0;

  const rows = [];

  for (
    const t of trades
  ) {
    const price =
      num(t.price);

    const size =
      num(t.size);

    const value =
      price * size;

    if (
      t.side === "Buy"
    ) {
      buy += value;
      buyVolume += size;
    } else {
      sell += value;
      sellVolume += size;
    }

    rows.push({
      time:
        num(t.time),

      price,
      size,
      value,

      side:
        t.side
    });
  }

  const total =
    buy + sell;

  const delta =
    buy - sell;

  return {
    trades: rows,

    buy,
    sell,

    buyVolume,
    sellVolume,

    delta,
    total,

    deltaPct:
      total
        ? delta /
          total *
          100
        : 0,

    buyShare:
      total
        ? buy /
          total *
          100
        : 0,

    sellShare:
      total
        ? sell /
          total *
          100
        : 0
  };
}

/* =========================================================
   FOOTPRINT LEVELS
========================================================= */

function buildFootprintLevels(
  trades,
  currentPrice
) {
  if (!trades.length) {
    return [];
  }

  let step = 0.0001;

  if (currentPrice >= 1000) {
    step = 1;
  } else if (
    currentPrice >= 100
  ) {
    step = 0.1;
  } else if (
    currentPrice >= 1
  ) {
    step = 0.01;
  }

  const map =
    new Map();

  for (
    const t of trades
  ) {
    const level =
      Math.round(
        t.price / step
      ) * step;

    if (
      !map.has(level)
    ) {
      map.set(
        level,
        {
          price: level,
          buy: 0,
          sell: 0,
          buyVolume: 0,
          sellVolume: 0,
          trades: 0
        }
      );
    }

    const row =
      map.get(level);

    if (
      t.side === "Buy"
    ) {
      row.buy += t.value;
      row.buyVolume +=
        t.size;
    } else {
      row.sell += t.value;
      row.sellVolume +=
        t.size;
    }

    row.trades++;
  }

  return [...map.values()]
    .map(x => ({
      ...x,

      total:
        x.buy +
        x.sell,

      delta:
        x.buy -
        x.sell,

      deltaPct:
        x.buy + x.sell
          ? (
              x.buy -
              x.sell
            ) /
            (
              x.buy +
              x.sell
            ) *
            100
          : 0
    }))
    .sort(
      (a, b) =>
        b.total -
        a.total
    )
    .slice(0, 30);
}

/* =========================================================
   SUPPORT / RESISTANCE
========================================================= */

function supportResistance(
  candles
) {
  const swings =
    findSwings(
      candles,
      2
    );

  const current =
    candles.at(-1).close;

  const supports =
    swings.lows
      .filter(
        x =>
          x.price <
          current
      )
      .sort(
        (a, b) =>
          b.price -
          a.price
      )
      .slice(0, 8);

  const resistances =
    swings.highs
      .filter(
        x =>
          x.price >
          current
      )
      .sort(
        (a, b) =>
          a.price -
          b.price
      )
      .slice(0, 8);

  return {
    supports,
    resistances
  };
}

/* =========================================================
   ENRICH LEVELS
========================================================= */

function enrichLevelsWithOrderbook(
  levels,
  orderbook
) {
  return levels.map(
    level => ({
      ...level,

      orderbook:
        liquidityAroundLevel(
          orderbook,
          level.price,
          0.25
        )
    })
  );
}

/* =========================================================
   SIGNAL ENGINE
========================================================= */

function signalEngine({
  one,
  smart,
  footprint,
  orderbook,
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

  const ma =
    one.ma20Analysis;

  /* MA20 POSITION */

  if (ma) {
    if (
      ma.position === "ABOVE" &&
      ma.slope5mPct > 0
    ) {
      bull += 10;

      reasonsBull.push(
        "قیمت بالای MA20 و شیب MA20 مثبت"
      );
    }

    if (
      ma.position === "BELOW" &&
      ma.slope5mPct < 0
    ) {
      bear += 10;

      reasonsBear.push(
        "قیمت زیر MA20 و شیب MA20 منفی"
      );
    }

    if (
      ma.rejection ===
      "BULLISH"
    ) {
      bull += 15;

      reasonsBull.push(
        "رد صعودی واقعی از MA20"
      );
    }

    if (
      ma.rejection ===
      "BEARISH"
    ) {
      bear += 15;

      reasonsBear.push(
        "رد نزولی واقعی از MA20"
      );
    }

    if (
      ma.confirmation ===
      "BULLISH"
    ) {
      bull += 18;

      reasonsBull.push(
        "تأیید صعودی MA20"
      );
    }

    if (
      ma.confirmation ===
      "BEARISH"
    ) {
      bear += 18;

      reasonsBear.push(
        "تأیید نزولی MA20"
      );
    }
  }

  /* CROSS */

  if (
    ma?.crossUp
  ) {
    bull += 10;

    reasonsBull.push(
      "عبور قیمت به بالای MA20"
    );
  }

  if (
    ma?.crossDown
  ) {
    bear += 10;

    reasonsBear.push(
      "عبور قیمت به زیر MA20"
    );
  }

  /* SLOPE */

  if (
    ma &&
    ma.slope1mPct > 0 &&
    ma.slope5mPct > 0 &&
    ma.slope10mPct > 0
  ) {
    bull += 12;

    reasonsBull.push(
      "هم‌جهتی شیب MA20 در 1،5 و10 دقیقه"
    );
  }

  if (
    ma &&
    ma.slope1mPct < 0 &&
    ma.slope5mPct < 0 &&
    ma.slope10mPct < 0
  ) {
    bear += 12;

    reasonsBear.push(
      "هم‌جهتی نزولی شیب MA20 در 1،5 و10 دقیقه"
    );
  }

  /* RSI */

  if (
    one.rsi !== null
  ) {
    if (
      one.rsi >= 52
    ) {
      bull += 5;

      reasonsBull.push(
        "RSI یک دقیقه بالای 52"
      );
    }

    if (
      one.rsi <= 48
    ) {
      bear += 5;

      reasonsBear.push(
        "RSI یک دقیقه زیر 48"
      );
    }
  }

  /* MACD */

  if (
    one.macd?.cross ===
    "BULLISH"
  ) {
    bull += 8;

    reasonsBull.push(
      "تقاطع صعودی MACD"
    );
  }

  if (
    one.macd?.cross ===
    "BEARISH"
  ) {
    bear += 8;

    reasonsBear.push(
      "تقاطع نزولی MACD"
    );
  }

  /* VOLUME */

  if (
    one.volume?.spike
  ) {
    if (
      one.price >
      one.ma20
    ) {
      bull += 6;

      reasonsBull.push(
        "افزایش حجم بالای MA20"
      );
    }

    if (
      one.price <
      one.ma20
    ) {
      bear += 6;

      reasonsBear.push(
        "افزایش حجم زیر MA20"
      );
    }
  }

  /* FOOTPRINT */

  if (
    footprint.total > 0
  ) {
    const d =
      footprint.deltaPct;

    if (
      d >= 15
    ) {
      bull += 10;

      reasonsBull.push(
        `Delta مثبت قوی ${round(d, 2)}%`
      );
    }

    if (
      d <= -15
    ) {
      bear += 10;

      reasonsBear.push(
        `Delta منفی قوی ${round(d, 2)}%`
      );
    }
  }

  /* ORDERBOOK */

  if (
    orderbook.bidShare >
    orderbook.askShare + 8
  ) {
    bull += 5;

    reasonsBull.push(
      "برتری نقدینگی Bid"
    );
  }

  if (
    orderbook.askShare >
    orderbook.bidShare + 8
  ) {
    bear += 5;

    reasonsBear.push(
      "برتری نقدینگی Ask"
    );
  }

  /* STRUCTURE */

  if (
    smart.structure.bos?.side ===
    "BULLISH"
  ) {
    bull += 8;

    reasonsBull.push(
      "BOS صعودی"
    );
  }

  if (
    smart.structure.bos?.side ===
    "BEARISH"
  ) {
    bear += 8;

    reasonsBear.push(
      "BOS نزولی"
    );
  }

  if (
    smart.structure.choch?.side ===
    "BULLISH"
  ) {
    bull += 10;

    reasonsBull.push(
      "CHoCH صعودی"
    );
  }

  if (
    smart.structure.choch?.side ===
    "BEARISH"
  ) {
    bear += 10;

    reasonsBear.push(
      "CHoCH نزولی"
    );
  }

  /* FVG */

  const fvg =
    smart.activeFVG.at(-1);

  if (
    fvg?.type ===
    "BULLISH"
  ) {
    bull += 6;

    reasonsBull.push(
      "قیمت داخل FVG صعودی"
    );
  }

  if (
    fvg?.type ===
    "BEARISH"
  ) {
    bear += 6;

    reasonsBear.push(
      "قیمت داخل FVG نزولی"
    );
  }

  /* ORDER BLOCK */

  const ob =
    smart.activeOB.at(-1);

  if (
    ob?.type ===
    "BULLISH"
  ) {
    bull += 6;

    reasonsBull.push(
      "قیمت داخل Order Block صعودی"
    );
  }

  if (
    ob?.type ===
    "BEARISH"
  ) {
    bear += 6;

    reasonsBear.push(
      "قیمت داخل Order Block نزولی"
    );
  }

  /* HUNT */

  if (
    smart.sweep.type ===
    "BULLISH"
  ) {
    bull += 12;

    reasonsBull.push(
      "Liquidity Hunt صعودی"
    );
  }

  if (
    smart.sweep.type ===
    "BEARISH"
  ) {
    bear += 12;

    reasonsBear.push(
      "Liquidity Hunt نزولی"
    );
  }

  bull =
    clamp(
      bull,
      0,
      100
    );

  bear =
    clamp(
      bear,
      0,
      100
    );

  let direction =
    "WAIT";

  if (
    bull >= threshold &&
    bull > bear
  ) {
    direction =
      "LONG";
  }

  if (
    bear >= threshold &&
    bear > bull
  ) {
    direction =
      "SHORT";
  }

  return {
    direction,

    score:
      Math.max(
        bull,
        bear
      ),

    bull,
    bear,

    threshold,
    difficulty,

    basis:
      "1M_MA20",

    reasons: {
      bull:
        reasonsBull,

      bear:
        reasonsBear
    },

    calculated:
      true
  };
}

/* =========================================================
   15M CONTEXT
========================================================= */

function analyze15MContext(
  candles
) {
  const base =
    analyzeTimeframe(
      candles
    );

  const smart =
    classifySmartMoney(
      candles
    );

  const sr =
    supportResistance(
      candles
    );

  const price =
    candles.at(-1).close;

  let expectation =
    "RANGE";

  if (
    base.trend ===
      "BULLISH" &&
    smart.bullishScore >
      smart.bearishScore
  ) {
    expectation =
      "BULLISH";
  }

  if (
    base.trend ===
      "BEARISH" &&
    smart.bearishScore >
      smart.bullishScore
  ) {
    expectation =
      "BEARISH";
  }

  return {
    timeframe: "15M",

    expectation,

    price,

    trend:
      base.trend,

    MA7:
      base.ma7,

    MA20:
      base.ma20,

    MA20Slope:
      base.maSlope,

    RSI:
      base.rsi,

    MACD:
      base.macd,

    ATR:
      base.atr,

    ATRPct:
      base.atrPct,

    volume:
      base.volume,

    bollinger:
      base.bollinger,

    smartMoney: {
      style:
        smart.style,

      bullishScore:
        smart.bullishScore,

      bearishScore:
        smart.bearishScore,

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

    supportResistance:
      sr,

    note:
      "15M برای تشخیص جهت تایم بالاتر استفاده می‌شود و مستقیماً امتیاز سیگنال 1M را تعیین نمی‌کند."
  };
}

/* =========================================================
   COMPLETE ANALYSIS
========================================================= */

async function analyzeSymbol(
  symbol,
  category = "linear",
  difficulty = 11
) {
  const s =
    String(symbol)
      .toUpperCase()
      .trim();

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

  /* 1M */

  const one =
    analyzeTimeframe(
      oneCandles
    );

  const ma20 =
    analyzeMA20(
      oneCandles
    );

  one.ma20Analysis =
    ma20;

  const smart =
    classifySmartMoney(
      oneCandles
    );

  const sr =
    supportResistance(
      oneCandles
    );

  const buyWalls =
    getWalls(
      orderbook.bids,
      "BUY",
      one.price
    );

  const sellWalls =
    getWalls(
      orderbook.asks,
      "SELL",
      one.price
    );

  const supports =
    enrichLevelsWithOrderbook(
      sr.supports,
      orderbook
    );

  const resistances =
    enrichLevelsWithOrderbook(
      sr.resistances,
      orderbook
    );

  const footprintLevels =
    buildFootprintLevels(
      footprint.trades,
      one.price
    );

  const signal =
    signalEngine({
      one,
      smart,
      footprint,
      orderbook,
      difficulty
    });

  /* 15M */

  const fifteen =
    analyze15MContext(
      fifteenCandles
    );

  /* TRADING STYLE */

  const tradingStyle =
    classifyTradingStyle({
      one,
      fifteen,
      smart,
      footprint,
      orderbook
    });

  /* WALLS */

  const resistanceWalls =
    resistances.map(
      level => ({
        ...level,

        nearbySellWalls:
          sellWalls.filter(
            w =>
              Math.abs(
                pct(
                  w.price,
                  level.price
                )
              ) <= 0.5
          )
      })
    );

  const supportWalls =
    supports.map(
      level => ({
        ...level,

        nearbyBuyWalls:
          buyWalls.filter(
            w =>
              Math.abs(
                pct(
                  w.price,
                  level.price
                )
              ) <= 0.5
          )
      })
    );

  /* HUNT */

  const hunt =
    smart.sweep;

  let huntLiquidity =
    null;

  if (hunt?.level) {
    huntLiquidity =
      liquidityAroundLevel(
        orderbook,
        hunt.level,
        0.5
      );
  }

  return {
    ok: true,

    symbol: s,

    category,

    price:
      one.price,

    /* SIGNAL */

    signal,

    tradingStyle,

    styles: {
      calculated: true,

      current:
        tradingStyle.style,

      side:
        tradingStyle.side,

      confidence:
        tradingStyle.confidence,

      bullishFactors:
        tradingStyle.bullishFactors,

      bearishFactors:
        tradingStyle.bearishFactors,

      smartMoney:
        smart.style
    },

    signalMethod: {
      primaryTimeframe:
        "1M",

      primaryTrigger:
        "MA20",

      higherTimeframe:
        "15M",

      higherTimeframeUsedForSignal:
        false,

      calculation:
        "REAL_BYBIT_DATA"
    },

    /* MARKET */

    market: {
      trend1m:
        one.trend,

      trend15m:
        fifteen.expectation,

      style:
        tradingStyle.style
    },

    /* 1M */

    oneMinute: {
      ...one,

      MA20Analysis:
        ma20,

      price:
        one.price,

      MA7:
        one.ma7,

      MA20:
        one.ma20,

      MA20Slope:
        one.maSlope,

      distanceToMA20:
        one.distanceToMA20,

      contact:
        one.touch,

      nearMA20:
        one.near
    },

    /* MA20 */

    MA20: {
      timeframe:
        "1M",

      value:
        ma20.value,

      previous1m:
        ma20.previous1m,

      previous3m:
        ma20.previous3m,

      previous5m:
        ma20.previous5m,

      previous10m:
        ma20.previous10m,

      slope1mPct:
        ma20.slope1mPct,

      slope3mPct:
        ma20.slope3mPct,

      slope5mPct:
        ma20.slope5mPct,

      slope10mPct:
        ma20.slope10mPct,

      slopeDirection:
        ma20.slopeDirection,

      position:
        ma20.position,

      bias:
        ma20.bias,

      touched:
        ma20.touched,

      rejection:
        ma20.rejection,

      confirmation:
        ma20.confirmation,

      crossUp:
        ma20.crossUp,

      crossDown:
        ma20.crossDown,

      candle:
        ma20.candle,

      validLongSetup:
        ma20.validLongSetup,

      validShortSetup:
        ma20.validShortSetup,

      calculated:
        true
    },

    /* 15M */

    fifteenMinute:
      fifteen,

    higherTimeframe: {
      timeframe:
        "15M",

      expectation:
        fifteen.expectation,

      trend:
        fifteen.trend,

      MA7:
        fifteen.MA7,

      MA20:
        fifteen.MA20,

      MA20Slope:
        fifteen.MA20Slope,

      RSI:
        fifteen.RSI,

      MACD:
        fifteen.MACD,

      ATR:
        fifteen.ATR,

      volume:
        fifteen.volume,

      smartMoney:
        fifteen.smartMoney,

      supportResistance:
        fifteen.supportResistance
    },

    /* SMART MONEY */

    smartMoney: {
      available:
        smart.structure.available,

      style:
        smart.style,

      bullishScore:
        smart.bullishScore,

      bearishScore:
        smart.bearishScore,

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

    /* FOOTPRINT */

    footprint: {
      buy:
        footprint.buy,

      sell:
        footprint.sell,

      delta:
        footprint.delta,

      deltaPct:
        footprint.deltaPct,

      total:
        footprint.total,

      buyVolume:
        footprint.buyVolume,

      sellVolume:
        footprint.sellVolume,

      buyShare:
        footprint.buyShare,

      sellShare:
        footprint.sellShare,

      levels:
        footprintLevels,

      calculated:
        true
    },

    /* ORDERBOOK */

    orderBook: {
      bestBid:
        orderbook.bestBid,

      bestAsk:
        orderbook.bestAsk,

      spread:
        orderbook.bestAsk -
        orderbook.bestBid,

      spreadPct:
        orderbook.bestBid
          ? pct(
              orderbook.bestAsk,
              orderbook.bestBid
            )
          : 0,

      bidLiquidity:
        orderbook.bidLiquidity,

      askLiquidity:
        orderbook.askLiquidity,

      bidShare:
        orderbook.bidShare,

      askShare:
        orderbook.askShare,

      imbalance:
        orderbook.bidLiquidity -
        orderbook.askLiquidity,

      buyWalls,
      sellWalls,

      bids:
        orderbook.bids,

      asks:
        orderbook.asks,

      calculated:
        true
    },

    /* LEVELS */

    levels: {
      supports,
      resistances,

      supportWalls,
      resistanceWalls
    },

    /* HUNT */

    liquidityHunt: {
      detected:
        hunt?.type !==
        "NONE",

      type:
        hunt?.type ||
        "NONE",

      level:
        hunt?.level ||
        null,

      wick:
        hunt?.wick ||
        null,

      close:
        hunt?.close ||
        null,

      sweepAmount:
        hunt?.sweepAmount ||
        0,

      sweepPct:
        hunt?.sweepPct ||
        0,

      candleVolume:
        hunt?.candleVolume ||
        0,

      liquidityAroundLevel:
        huntLiquidity
    },

    /* INDICATORS */

    indicators: {
      RSI1m:
        one.rsi,

      RSI15m:
        fifteen.RSI,

      MACD1m:
        one.macd,

      MACD15m:
        fifteen.MACD,

      ATR1m:
        one.atr,

      ATR15m:
        fifteen.ATR,

      Bollinger1m:
        one.bollinger,

      Bollinger15m:
        fifteen.bollinger
    },

    /* VOLUME */

    volume: {
      oneMinute:
        one.volume,

      fifteenMinute:
        fifteen.volume
    },

    dataStatus: {
      price:
        "REAL",

      klines1m:
        "REAL_BYBIT",

      klines15m:
        "REAL_BYBIT",

      orderBook:
        "REAL_BYBIT",

      footprint:
        "REAL_BYBIT",

      indicators:
        "CALCULATED",

      signal:
        "CALCULATED",

      tradingStyle:
        "CALCULATED"
    },

    timestamp:
      Date.now()
  };
}

/* =========================================================
   SYMBOL SEARCH
========================================================= */

async function findSymbol(
  query
) {
  const q =
    String(query || "")
      .trim()
      .toUpperCase()
      .replace(
        /[^A-Z0-9]/g,
        ""
      );

  if (!q) {
    return [];
  }

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
        data.result?.list ||
        [];

      for (
        const x of list
      ) {
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
            status:
              x.status
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
        data.result?.list ||
        [];

      for (
        const x of list
      ) {
        if (
          x.status ===
            "Trading" &&
          String(
            x.symbol
          ).endsWith("USDT")
        ) {
          all.push({
            symbol:
              x.symbol,

            category
          });
        }
      }
    } catch {}
  }

  const unique =
    new Map();

  for (
    const x of all
  ) {
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

    if (
      candles.length < 30
    ) {
      return null;
    }

    const a =
      analyzeTimeframe(
        candles
      );

    const ma =
      analyzeMA20(
        candles
      );

    if (
      !a.ma20 ||
      !ma.available
    ) {
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

      maSlope:
        ma.slope5mPct,

      maBias:
        ma.bias,

      touched:
        ma.touched,

      rejection:
        ma.rejection,

      confirmation:
        ma.confirmation,

      volumeRatio:
        a.volume.ratio,

      rsi:
        a.rsi,

      difficulty:
        num(difficulty),

      dataBased:
        true
    };
  } catch {
    return null;
  }
}

/* =========================================================
   MARKET SCAN
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
        batch.map(
          x =>
            quickScan(
              x.symbol,
              x.category,
              difficulty
            )
        )
      );

    for (
      const r of out
    ) {
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
  const analyzed = [];

  for (
    const r of deep
  ) {
    try {
      const analysis =
        await analyzeSymbol(
          r.symbol,
          r.category,
          difficulty
        );

      analyzed.push(
        analysis
      );

      if (
        analysis.signal
          .direction !==
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

    candidatesDetail:
      results,

    analyzed,

    signals,

    difficulty,

    signalTimeframe:
      "1M",

    higherTimeframe:
      "15M",

    signalMethod:
      "1M MA20 + REAL ORDER FLOW + SMART MONEY",

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
      new URL(
        request.url
      );

    const path =
      url.pathname;

    try {
      /* OPTIONS */

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

          engine:
            "1M MA20 + 15M CONTEXT",

          data:
            "REAL_BYBIT",

          time:
            Date.now()
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

        return json(
          result
        );
      }

      /* SYMBOLS */

      if (
        path === "/api/symbols"
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
