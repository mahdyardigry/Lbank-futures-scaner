const BYBIT = "https://api.bybit.com";

const SCAN_BATCH = 20;
const DEEP_LIMIT = 5;
const DEEP_1M_LIMIT = 300;
const DEFAULT_STRICTNESS = 50;

const STYLE_NAMES = {
  TREND: "روندی",
  BREAKOUT: "شکست",
  REVERSAL: "برگشتی",
  LIQUIDITY: "نقدینگی / اسمارت‌مانی",
  ORDERFLOW: "جریان سفارش",
  MOMENTUM: "مومنتوم / پامپ و دامپ"
};

const METHOD_NAMES = {
  ALL: "همه مبناها",
  MA: "میانگین متحرک",
  RSI: "RSI",
  MACD: "MACD",
  DIVERGENCE: "واگرایی",
  TREND: "روندی",
  BREAKOUT: "شکست",
  REVERSAL: "برگشتی",
  LIQUIDITY: "نقدینگی / اسمارت‌مانی",
  ORDERFLOW: "جریان سفارش",
  MOMENTUM: "مومنتوم / پامپ و دامپ"
};

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
  Math.max(a, Math.min(b, Number(v) || 0));

const avg = a =>
  a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;

const pct = (a, b) =>
  !b ? 0 : ((a - b) / b) * 100;

const absPct = (a, b) =>
  !b ? 999 : Math.abs((a - b) / b) * 100;


/* =========================================================
   BYBIT
========================================================= */

async function bybit(path, params = {}) {

  const u = new URL(BYBIT + path);

  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "")
      u.searchParams.set(k, String(v));
  }

  const r = await fetch(u, {
    headers: {
      accept: "application/json"
    }
  });

  if (!r.ok)
    throw new Error(`خطای ارتباط با Bybit: HTTP ${r.status}`);

  const d = await r.json();

  if (d.retCode !== 0)
    throw new Error(d.retMsg || `خطای Bybit: ${d.retCode}`);

  return d;
}


/* =========================================================
   KLINE
========================================================= */

async function klines(category, symbol, interval, limit = 100) {

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
   INDICATORS
========================================================= */

function sma(a, p) {

  if (!a.length)
    return 0;

  return a.length < p
    ? avg(a)
    : avg(a.slice(-p));
}


function ema(a, p) {

  if (!a.length)
    return 0;

  const k = 2 / (p + 1);

  let x = a[0];

  for (let i = 1; i < a.length; i++)
    x = a[i] * k + x * (1 - k);

  return x;
}


function atr(c, p = 14) {

  if (c.length < 2)
    return 0;

  const tr = [];

  for (let i = 1; i < c.length; i++) {

    const x = c[i];
    const prev = c[i - 1].close;

    tr.push(
      Math.max(
        x.high - x.low,
        Math.abs(x.high - prev),
        Math.abs(x.low - prev)
      )
    );
  }

  return sma(tr, p);
}


function rsi(c, p = 14) {

  if (c.length < p + 2)
    return 50;

  let gain = 0;
  let loss = 0;

  for (let i = c.length - p; i < c.length; i++) {

    const d = c[i].close - c[i - 1].close;

    if (d > 0)
      gain += d;
    else
      loss -= d;
  }

  if (!loss)
    return 100;

  const rs = (gain / p) / (loss / p);

  return 100 - 100 / (1 + rs);
}


function macd(c, fast = 12, slow = 26, signalPeriod = 9) {

  const a = c.map(x => x.close);

  if (a.length < slow + signalPeriod)
    return {
      value: null,
      signal: null,
      histogram: null,
      direction: "رنج",
      crossUp: false,
      crossDown: false,
      valid: false
    };

  const line = [];

  for (let i = slow - 1; i < a.length; i++) {

    const part = a.slice(0, i + 1);

    line.push(
      ema(part, fast) -
      ema(part, slow)
    );
  }

  const value = line.at(-1);
  const signal = ema(line, signalPeriod);
  const histogram = value - signal;

  const prevValue = line.at(-2) ?? value;
  const prevSignal = line.length > 1
    ? ema(line.slice(0, -1), signalPeriod)
    : signal;

  const crossUp =
    prevValue <= prevSignal &&
    value > signal;

  const crossDown =
    prevValue >= prevSignal &&
    value < signal;

  let direction = "رنج";

  if (value > signal && histogram > 0)
    direction = "صعودی";

  if (value < signal && histogram < 0)
    direction = "نزولی";

  return {
    value,
    signal,
    histogram,
    direction,
    crossUp,
    crossDown,
    valid: true
  };
}


function adx(c, p = 14) {

  if (c.length < p * 2 + 1)
    return 0;

  const tr = [];
  const plus = [];
  const minus = [];

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

    const up = x.high - q.high;
    const down = q.low - x.low;

    plus.push(
      up > down && up > 0 ? up : 0
    );

    minus.push(
      down > up && down > 0 ? down : 0
    );
  }

  const values = [];

  for (let i = p; i < tr.length; i++) {

    const trAvg =
      avg(tr.slice(i - p, i)) || 1;

    const pdi =
      100 * avg(plus.slice(i - p, i)) / trAvg;

    const mdi =
      100 * avg(minus.slice(i - p, i)) / trAvg;

    values.push(
      pdi + mdi
        ? 100 * Math.abs(pdi - mdi) / (pdi + mdi)
        : 0
    );
  }

  return avg(values.slice(-p));
}


/* =========================================================
   SWING / STRUCTURE
========================================================= */

function swingLevels(c, lookback = 3) {

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
      )
        high = false;

      if (
        c[i].low >= c[i - j].low ||
        c[i].low > c[i + j].low
      )
        low = false;
    }

    if (high)
      highs.push({
        price: c[i].high,
        time: c[i].time,
        index: i
      });

    if (low)
      lows.push({
        price: c[i].low,
        time: c[i].time,
        index: i
      });
  }

  return {
    highs,
    lows
  };
}


function structure(c) {

  const s = swingLevels(c, 2);

  const highs = s.highs;
  const lows = s.lows;

  const lastHigh =
    highs.length ? highs.at(-1).price : null;

  const prevHigh =
    highs.length > 1 ? highs.at(-2).price : null;

  const lastLow =
    lows.length ? lows.at(-1).price : null;

  const prevLow =
    lows.length > 1 ? lows.at(-2).price : null;

  const price = c.at(-1)?.close || 0;

  let bos = "رنج";
  let choch = "رنج";

  if (lastHigh && price > lastHigh)
    bos = "صعودی";

  if (lastLow && price < lastLow)
    bos = "نزولی";

  if (
    prevHigh &&
    prevLow &&
    lastHigh &&
    lastLow
  ) {

    if (
      lastHigh > prevHigh &&
      lastLow > prevLow &&
      price < lastLow
    )
      choch = "نزولی";

    if (
      lastHigh < prevHigh &&
      lastLow < prevLow &&
      price > lastHigh
    )
      choch = "صعودی";
  }

  return {
    bos,
    choch,
    swingHigh: lastHigh,
    swingLow: lastLow,
    previousSwingHigh: prevHigh,
    previousSwingLow: prevLow
  };
}


/* =========================================================
   HUNT / LIQUIDITY SWEEP
========================================================= */

function liquidityHunt(c) {

  if (c.length < 25)
    return {
      type: "داده ناکافی",
      side: "رنج",
      confirmed: false
    };

  const x = c.at(-1);

  const prev = c.slice(-21, -1);

  const high =
    Math.max(...prev.map(z => z.high));

  const low =
    Math.min(...prev.map(z => z.low));

  const range =
    x.high - x.low || 1;

  const lower =
    Math.min(x.open, x.close) - x.low;

  const upper =
    x.high - Math.max(x.open, x.close);

  const avgVolume =
    sma(prev.map(z => z.volume), 20);

  const volumeConfirmed =
    avgVolume > 0 &&
    x.volume >= avgVolume * 1.15;

  const lowSweep =
    x.low < low &&
    x.close > low &&
    lower / range >= .25;

  const highSweep =
    x.high > high &&
    x.close < high &&
    upper / range >= .25;

  if (lowSweep) {

    return {
      type: "شکار نقدینگی پایین",
      side: "صعودی",
      level: low,
      wickPct: lower / range * 100,
      volumeConfirmed,
      confirmed:
        volumeConfirmed ||
        lower / range >= .40
    };
  }

  if (highSweep) {

    return {
      type: "شکار نقدینگی بالا",
      side: "نزولی",
      level: high,
      wickPct: upper / range * 100,
      volumeConfirmed,
      confirmed:
        volumeConfirmed ||
        upper / range >= .40
    };
  }

  return {
    type: "بدون شکار تأییدشده",
    side: "رنج",
    confirmed: false
  };
}


/* =========================================================
   FVG
========================================================= */

function fvg(c) {

  if (c.length < 3)
    return {
      type: "رنج",
      low: null,
      high: null,
      valid: false
    };

  const a = c.at(-3);
  const b = c.at(-2);
  const x = c.at(-1);

  if (x.low > a.high) {

    return {
      type: "صعودی",
      low: a.high,
      high: x.low,
      size: x.low - a.high,
      time: b.time,
      valid: true
    };
  }

  if (x.high < a.low) {

    return {
      type: "نزولی",
      low: x.high,
      high: a.low,
      size: a.low - x.high,
      time: b.time,
      valid: true
    };
  }

  return {
    type: "رنج",
    low: null,
    high: null,
    valid: false
  };
}


/* =========================================================
   ORDER BLOCK
========================================================= */

function orderBlock(c) {

  if (c.length < 8)
    return {
      type: "رنج",
      valid: false
    };

  const x = c.at(-1);

  for (
    let i = c.length - 4;
    i >= Math.max(0, c.length - 15);
    i--
  ) {

    const z = c[i];

    if (
      z.close < z.open &&
      x.close > z.high
    ) {

      return {
        type: "صعودی",
        low: z.low,
        high: z.high,
        time: z.time,
        valid: true
      };
    }

    if (
      z.close > z.open &&
      x.close < z.low
    ) {

      return {
        type: "نزولی",
        low: z.low,
        high: z.high,
        time: z.time,
        valid: true
      };
    }
  }

  return {
    type: "رنج",
    valid: false
  };
}


/* =========================================================
   CANDLE ANALYSIS
========================================================= */

function candle(c) {

  if (c.length < 2)
    return {
      type: "داده ناکافی"
    };

  const x = c.at(-1);
  const p = c.at(-2);

  const body =
    Math.abs(x.close - x.open);

  const range =
    x.high - x.low || 1;

  const upper =
    x.high - Math.max(x.open, x.close);

  const lower =
    Math.min(x.open, x.close) - x.low;

  let type = "عادی";

  if (
    lower > body * 2 &&
    lower / range > .45
  )
    type = "چکش";

  if (
    upper > body * 2 &&
    upper / range > .45
  )
    type = "شهاب";

  if (
    x.close > p.open &&
    x.open < p.close &&
    x.close >= p.close &&
    x.open <= p.open
  )
    type = "پوشای صعودی";

  if (
    x.close < p.open &&
    x.open > p.close &&
    x.close <= p.close &&
    x.open >= p.open
  )
    type = "پوشای نزولی";

  if (body / range < .15)
    type = "دوجی";

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
   DIVERGENCE
========================================================= */

function divergence(c) {

  if (c.length < 45)
    return {
      type: "داده ناکافی",
      side: "رنج",
      valid: false
    };

  const price = c.at(-1).close;

  const currentRSI = rsi(c);

  const old = c.slice(-25, -8);

  const oldPrice =
    old.at(-1)?.close || price;

  const oldRSI =
    rsi(c.slice(0, -15));

  if (
    price < oldPrice &&
    currentRSI > oldRSI + 3
  ) {

    return {
      type: "واگرایی مثبت",
      side: "صعودی",
      valid: true
    };
  }

  if (
    price > oldPrice &&
    currentRSI < oldRSI - 3
  ) {

    return {
      type: "واگرایی منفی",
      side: "نزولی",
      valid: true
    };
  }

  return {
    type: "بدون واگرایی",
    side: "رنج",
    valid: false
  };
}


/* =========================================================
   1 MINUTE ANALYSIS
========================================================= */

function analyze1m(c) {

  if (c.length < 40)
    return {
      error: "کندل کافی نیست"
    };

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

  const previousMA20 =
    sma(closes.slice(0, -1), 20);

  const slope =
    previousMA20
      ? (ma20 - previousMA20) / previousMA20
      : 0;

  const previousPrice =
    closes.at(-2);

  const last =
    c.at(-1);

  const touched =
    Math.abs(price - ma20) / ma20 <= .0015 ||
    (
      last.low <= ma20 &&
      last.high >= ma20
    ) ||
    (
      (previousPrice - ma20) *
      (price - ma20) <= 0
    );

  const crossedUp =
    previousPrice <= previousMA20 &&
    price > ma20;

  const crossedDown =
    previousPrice >= previousMA20 &&
    price < ma20;

  const rejectionUp =
    last.low <= ma20 &&
    last.close > ma20 &&
    last.close > last.open;

  const rejectionDown =
    last.high >= ma20 &&
    last.close < ma20 &&
    last.close < last.open;

  const volumeMA =
    sma(volumes, 20);

  const volumeRatio =
    volumeMA
      ? last.volume / volumeMA
      : 0;

  const volumeSpike =
    volumeRatio >= 1.5;

  const RSI =
    rsi(c);

  const MACD =
    macd(c);

  const ATR =
    atr(c);

  const structureData =
    structure(c);

  const hunt =
    liquidityHunt(c);

  const gap =
    fvg(c);

  const ob =
    orderBlock(c);

  const div =
    divergence(c);

  const adxValue =
    adx(c);

  let trend = "رنج";

  if (
    price > ma20 &&
    ma7 > ma20 &&
    slope > .00005
  )
    trend = "صعودی";

  if (
    price < ma20 &&
    ma7 < ma20 &&
    slope < -.00005
  )
    trend = "نزولی";

  if (
    adxValue < 17 &&
    Math.abs(slope) < .00008
  )
    trend = "رنج";

  return {

    price,

    ma7,
    ma20,
    previousMA20,

    maSlopePct:
      slope * 100,

    slope:
      slope > .00005
        ? "صعودی"
        : slope < -.00005
          ? "نزولی"
          : "رنج",

    distancePct:
      (price - ma20) / ma20 * 100,

    touched,

    near:
      Math.abs(price - ma20) / ma20 <= .003,

    crossedUp,
    crossedDown,

    rejectionUp,
    rejectionDown,

    rsi: RSI,

    macd: MACD,

    atr: ATR,

    atrPct:
      price
        ? ATR / price * 100
        : 0,

    volumeRatio,

    volumeSpike,

    trend,

    adx: adxValue,

    hunt,

    fvg: gap,

    orderBlock: ob,

    divergence: div,

    candle:
      candle(c),

    ...structureData
  };
}


/* =========================================================
   15 MINUTE
========================================================= */

function analyze15m(c) {

  const x = analyze1m(c);

  if (x.error)
    return x;

  return {
    price: x.price,
    ma7: x.ma7,
    ma20: x.ma20,
    slopePct: x.maSlopePct,
    direction: x.trend,
    rsi: x.rsi,
    macd: x.macd,
    atr: x.atr,
    adx: x.adx,
    bos: x.bos,
    choch: x.choch,
    fvg: x.fvg,
    orderBlock: x.orderBlock
  };
}


/* =========================================================
   PUBLIC TRADES / FOOTPRINT
========================================================= */

async function footprint(category, symbol) {

  try {

    const d =
      await bybit(
        "/v5/market/recent-trade",
        {
          category,
          symbol,
          limit: category === "spot" ? 60 : 1000
        }
      );

    const trades =
      d?.result?.list || [];

    let buyVolume = 0;
    let sellVolume = 0;

    let buyNotional = 0;
    let sellNotional = 0;

    let largestTrade = 0;

    const priceRows = new Map();

    for (const t of trades) {

      const price = n(t.price);
      const size = n(t.size);

      const value =
        price * size;

      largestTrade =
        Math.max(
          largestTrade,
          value
        );

      const side =
        String(t.side).toLowerCase();

      const key =
        price.toFixed(12);

      if (!priceRows.has(key)) {

        priceRows.set(
          key,
          {
            price,
            buy: 0,
            sell: 0
          }
        );
      }

      const row =
        priceRows.get(key);

      if (side === "buy") {

        buyVolume += size;
        buyNotional += value;
        row.buy += size;

      } else {

        sellVolume += size;
        sellNotional += value;
        row.sell += size;
      }
    }

    const totalVolume =
      buyVolume + sellVolume;

    const totalNotional =
      buyNotional + sellNotional;

    const delta =
      buyVolume - sellVolume;

    const deltaNotional =
      buyNotional - sellNotional;

    const deltaPercent =
      totalVolume
        ? delta / totalVolume * 100
        : 0;

    const rows =
      [...priceRows.values()]
        .map(x => ({
          ...x,
          delta:
            x.buy - x.sell,
          imbalance:
            x.sell
              ? x.buy / x.sell
              : x.buy
                ? Infinity
                : 0
        }))
        .sort(
          (a, b) =>
            b.price - a.price
        );

    return {

      valid: true,

      buyVolume,
      sellVolume,

      buyNotional,
      sellNotional,

      delta,
      deltaNotional,

      deltaPercent,

      buyShare:
        totalNotional
          ? buyNotional / totalNotional * 100
          : 0,

      sellShare:
        totalNotional
          ? sellNotional / totalNotional * 100
          : 0,

      trades:
        trades.length,

      largestTrade,

      pressure:
        deltaPercent >= 8
          ? "خریدار"
          : deltaPercent <= -8
            ? "فروشنده"
            : "متعادل",

      levels:
        rows.slice(0, 40)
    };

  } catch (e) {

    return {
      valid: false,
      error: e.message
    };
  }
}


/* =========================================================
   ORDER BOOK
========================================================= */

async function orderBook(
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
          limit: 200
        }
      );

    const bids =
      d?.result?.b || [];

    const asks =
      d?.result?.a || [];

    const buyLevels = [];

    const sellLevels = [];

    for (const row of bids) {

      const p = n(row[0]);
      const size = n(row[1]);

      if (!p || !size)
        continue;

      const value =
        p * size;

      const distance =
        absPct(p, price);

      if (distance <= 3) {

        buyLevels.push({
          price: p,
          size,
          notional: value,
          distancePct: distance
        });
      }
    }

    for (const row of asks) {

      const p = n(row[0]);
      const size = n(row[1]);

      if (!p || !size)
        continue;

      const value =
        p * size;

      const distance =
        absPct(p, price);

      if (distance <= 3) {

        sellLevels.push({
          price: p,
          size,
          notional: value,
          distancePct: distance
        });
      }
    }

    buyLevels.sort(
      (a, b) =>
        b.notional - a.notional
    );

    sellLevels.sort(
      (a, b) =>
        b.notional - a.notional
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

    const total =
      buyLiquidity +
      sellLiquidity;

    const buyWall =
      buyLevels[0] || null;

    const sellWall =
      sellLevels[0] || null;

    const avgBuy =
      avg(
        buyLevels
          .slice(0, 20)
          .map(x => x.notional)
      );

    const avgSell =
      avg(
        sellLevels
          .slice(0, 20)
          .map(x => x.notional)
      );

    const buyStrength =
      avgBuy
        ? clamp(
            buyWall.notional /
            avgBuy *
            20,
            0,
            100
          )
        : 0;

    const sellStrength =
      avgSell
        ? clamp(
            sellWall.notional /
            avgSell *
            20,
            0,
            100
          )
        : 0;

    return {

      valid: true,

      bestBid:
        bids.length
          ? {
              price: n(bids[0][0]),
              size: n(bids[0][1])
            }
          : null,

      bestAsk:
        asks.length
          ? {
              price: n(asks[0][0]),
              size: n(asks[0][1])
            }
          : null,

      buyLiquidity,
      sellLiquidity,

      buyShare:
        total
          ? buyLiquidity / total * 100
          : 0,

      sellShare:
        total
          ? sellLiquidity / total * 100
          : 0,

      buyWall,
      sellWall,

      buyStrength,
      sellStrength,

      buyNear:
        !!buyWall &&
        buyWall.distancePct <= 1,

      sellNear:
        !!sellWall &&
        sellWall.distancePct <= 1,

      buyLevels:
        buyLevels.slice(0, 30),

      sellLevels:
        sellLevels.slice(0, 30)
    };

  } catch (e) {

    return {
      valid: false,
      error: e.message
    };
  }
}


/* =========================================================
   SUPPORT / RESISTANCE
========================================================= */

function supportResistance(
  c,
  book,
  footprintData,
  price
) {

  const s =
    swingLevels(c, 3);

  const supports = [];
  const resistances = [];

  for (const x of s.lows) {

    if (x.price < price) {

      supports.push({
        price: x.price,
        source: "کف ساختاری",
        type: "حمایت",
        distancePct:
          absPct(x.price, price)
      });
    }
  }

  for (const x of s.highs) {

    if (x.price > price) {

      resistances.push({
        price: x.price,
        source: "سقف ساختاری",
        type: "مقاومت",
        distancePct:
          absPct(x.price, price)
      });
    }
  }

  for (
    const x of
    book?.buyLevels || []
  ) {

    if (x.price < price) {

      supports.push({
        price: x.price,
        source: "دیوار خرید",
        type: "حمایت",
        wallValue: x.notional,
        distancePct: x.distancePct
      });
    }
  }

  for (
    const x of
    book?.sellLevels || []
  ) {

    if (x.price > price) {

      resistances.push({
        price: x.price,
        source: "دیوار فروش",
        type: "مقاومت",
        wallValue: x.notional,
        distancePct: x.distancePct
      });
    }
  }

  supports.sort(
    (a, b) =>
      a.distancePct -
      b.distancePct
  );

  resistances.sort(
    (a, b) =>
      a.distancePct -
      b.distancePct
  );

  const pressure =
    footprintData?.pressure ||
    "متعادل";

  for (const x of supports) {

    x.pressure =
      pressure === "خریدار"
        ? "خریدار قوی‌تر"
        : pressure === "فروشنده"
          ? "فروشنده قوی‌تر"
          : "متعادل";
  }

  for (const x of resistances) {

    x.pressure =
      pressure === "فروشنده"
        ? "فروشنده قوی‌تر"
        : pressure === "خریدار"
          ? "خریدار قوی‌تر"
          : "متعادل";
  }

  return {

    supports:
      supports.slice(0, 12),

    resistances:
      resistances.slice(0, 12),

    nearestSupport:
      supports[0] || null,

    nearestResistance:
      resistances[0] || null
  };
}


/* =========================================================
   OI / FUNDING
========================================================= */

async function derivativesData(symbol) {

  try {

    const tickerData =
      await bybit(
        "/v5/market/tickers",
        {
          category: "linear",
          symbol
        }
      );

    const ticker =
      tickerData?.result?.list?.[0] || {};

    let oiHistory = [];

    let fundingHistory = [];

    try {

      const oi =
        await bybit(
          "/v5/market/open-interest",
          {
            category: "linear",
            symbol,
            intervalTime: "5min",
            limit: 20
          }
        );

      oiHistory =
        oi?.result?.list || [];

    } catch (_) {}

    try {

      const fr =
        await bybit(
          "/v5/market/funding/history",
          {
            category: "linear",
            symbol,
            limit: 20
          }
        );

      fundingHistory =
        fr?.result?.list || [];

    } catch (_) {}

    const currentOI =
      n(ticker.openInterest);

    const previousOI =
      oiHistory.length > 1
        ? n(
            oiHistory
              .at(-2)
              .openInterest
          )
        : null;

    const oldestOI =
      oiHistory.length
        ? n(
            oiHistory[0]
              .openInterest
          )
        : null;

    const currentFunding =
      n(ticker.fundingRate);

    const previousFunding =
      fundingHistory.length > 1
        ? n(
            fundingHistory
              .at(-2)
              .fundingRate
          )
        : null;

    const oi5m =
      previousOI !== null
        ? pct(
            currentOI,
            previousOI
          )
        : null;

    const oiHistoryChange =
      oldestOI
        ? pct(
            currentOI,
            oldestOI
          )
        : null;

    const fundingChange =
      previousFunding !== null
        ? currentFunding -
          previousFunding
        : null;

    let oiDirection = "رنج";

    if (
      oi5m !== null &&
      oi5m > .5
    )
      oiDirection = "افزایش";

    if (
      oi5m !== null &&
      oi5m < -.5
    )
      oiDirection = "کاهش";

    return {

      available: true,

      current:
        currentOI,

      previous:
        previousOI,

      change5mPct:
        oi5m,

      changeHistoryPct:
        oiHistoryChange,

      direction:
        oiDirection,

      funding: {

        current:
          currentFunding,

        previous:
          previousFunding,

        change:
          fundingChange,

        currentPercent:
          currentFunding * 100,

        state:
          currentFunding > .0005
            ? "مثبت"
            : currentFunding < -.0005
              ? "منفی"
              : "نزدیک به خنثی"
      },

      markPrice:
        n(ticker.markPrice),

      indexPrice:
        n(ticker.indexPrice),

      turnover24h:
        n(ticker.turnover24h),

      priceChange24h:
        n(ticker.price24hPcnt) * 100
    };

  } catch (e) {

    return {
      available: false,
      error: e.message
    };
  }
}


/* =========================================================
   STYLE CALCULATIONS
========================================================= */

function result(
  direction,
  score,
  reasons,
  data = {}
) {

  return {
    direction,
    score: Math.round(
      clamp(score, 0, 100)
    ),
    reasons,
    ...data
  };
}


/* ---------------- روندی ---------------- */

function styleTrend(one, fifteen) {

  let bull = 0;
  let bear = 0;

  const reasons = [];

  if (one.trend === "صعودی") {

    bull += 30;
    reasons.push(
      "قیمت، MA7 و MA20 در 1 دقیقه ساختار صعودی دارند."
    );
  }

  if (one.trend === "نزولی") {

    bear += 30;
    reasons.push(
      "قیمت، MA7 و MA20 در 1 دقیقه ساختار نزولی دارند."
    );
  }

  if (one.maSlopePct > .02) {

    bull += 20;

    reasons.push(
      "شیب MA20 یک‌دقیقه‌ای مثبت است."
    );
  }

  if (one.maSlopePct < -.02) {

    bear += 20;

    reasons.push(
      "شیب MA20 یک‌دقیقه‌ای منفی است."
    );
  }

  if (one.adx >= 20) {

    bull +=
      one.trend === "صعودی"
        ? 20
        : 0;

    bear +=
      one.trend === "نزولی"
        ? 20
        : 0;

    reasons.push(
      "ADX نشان‌دهنده قدرت بیشتر حرکت است."
    );
  }

  if (fifteen.direction === "صعودی")
    bull += 20;

  if (fifteen.direction === "نزولی")
    bear += 20;

  return result(
    bull > bear && bull >= 35
      ? "صعودی"
      : bear > bull && bear >= 35
        ? "نزولی"
        : "رنج",
    Math.max(bull, bear),
    reasons
  );
}


/* ---------------- شکست ---------------- */

function styleBreakout(one) {

  let bull = 0;
  let bear = 0;

  const reasons = [];

  if (one.bos === "صعودی") {

    bull += 35;

    reasons.push(
      "شکست ساختاری صعودی واقعی نسبت به سقف سوئینگ ثبت شده است."
    );
  }

  if (one.bos === "نزولی") {

    bear += 35;

    reasons.push(
      "شکست ساختاری نزولی واقعی نسبت به کف سوئینگ ثبت شده است."
    );
  }

  if (one.choch === "صعودی") {

    bull += 25;

    reasons.push(
      "CHoCH صعودی شناسایی شده است."
    );
  }

  if (one.choch === "نزولی") {

    bear += 25;

    reasons.push(
      "CHoCH نزولی شناسایی شده است."
    );
  }

  if (one.volumeSpike) {

    if (one.trend === "صعودی")
      bull += 20;

    if (one.trend === "نزولی")
      bear += 20;

    reasons.push(
      "حجم کندل جاری نسبت به میانگین افزایش غیرعادی دارد."
    );
  }

  if (
    one.crossedUp &&
    one.touched
  ) {

    bull += 15;

    reasons.push(
      "عبور واقعی قیمت از MA20 در 1 دقیقه ثبت شده است."
    );
  }

  if (
    one.crossedDown &&
    one.touched
  ) {

    bear += 15;

    reasons.push(
      "عبور واقعی قیمت از MA20 در 1 دقیقه ثبت شده است."
    );
  }

  return result(
    bull > bear && bull >= 35
      ? "صعودی"
      : bear > bull && bear >= 35
        ? "نزولی"
        : "رنج",
    Math.max(bull, bear),
    reasons
  );
}


/* ---------------- برگشتی ---------------- */

function styleReversal(
  one,
  fp
) {

  let bull = 0;
  let bear = 0;

  const reasons = [];

  if (
    one.divergence?.side ===
    "صعودی"
  ) {

    bull += 35;

    reasons.push(
      "واگرایی مثبت RSI نسبت به قیمت شناسایی شده است."
    );
  }

  if (
    one.divergence?.side ===
    "نزولی"
  ) {

    bear += 35;

    reasons.push(
      "واگرایی منفی RSI نسبت به قیمت شناسایی شده است."
    );
  }

  if (
    one.rsi < 30
  ) {

    bull += 20;

    reasons.push(
      "RSI در محدوده اشباع فروش قرار دارد."
    );
  }

  if (
    one.rsi > 70
  ) {

    bear += 20;

    reasons.push(
      "RSI در محدوده اشباع خرید قرار دارد."
    );
  }

  if (
    one.macd?.crossUp
  ) {

    bull += 20;

    reasons.push(
      "تقاطع واقعی MACD صعودی ثبت شده است."
    );
  }

  if (
    one.macd?.crossDown
  ) {

    bear += 20;

    reasons.push(
      "تقاطع واقعی MACD نزولی ثبت شده است."
    );
  }

  if (
    one.hunt?.side === "صعودی" &&
    one.hunt.confirmed
  ) {

    bull += 25;

    reasons.push(
      "شکار نقدینگی پایین با تأیید کندلی/حجم ثبت شده است."
    );
  }

  if (
    one.hunt?.side === "نزولی" &&
    one.hunt.confirmed
  ) {

    bear += 25;

    reasons.push(
      "شکار نقدینگی بالا با تأیید کندلی/حجم ثبت شده است."
    );
  }

  if (fp?.valid) {

    if (fp.deltaPercent > 8)
      bull += 10;

    if (fp.deltaPercent < -8)
      bear += 10;
  }

  return result(
    bull > bear && bull >= 35
      ? "صعودی"
      : bear > bull && bear >= 35
        ? "نزولی"
        : "رنج",
    Math.max(bull, bear),
    reasons
  );
}


/* ---------------- نقدینگی / اسمارت‌مانی ---------------- */

function styleLiquidity(
  one,
  book
) {

  let bull = 0;
  let bear = 0;

  const reasons = [];

  if (
    one.hunt?.confirmed &&
    one.hunt.side === "صعودی"
  ) {

    bull += 35;

    reasons.push(
      "Liquidity Sweep پایین با تأیید واقعی شناسایی شده است."
    );
  }

  if (
    one.hunt?.confirmed &&
    one.hunt.side === "نزولی"
  ) {

    bear += 35;

    reasons.push(
      "Liquidity Sweep بالا با تأیید واقعی شناسایی شده است."
    );
  }

  if (one.fvg?.type === "صعودی") {

    bull += 15;

    reasons.push(
      "FVG صعودی واقعی بین کندل‌ها تشکیل شده است."
    );
  }

  if (one.fvg?.type === "نزولی") {

    bear += 15;

    reasons.push(
      "FVG نزولی واقعی بین کندل‌ها تشکیل شده است."
    );
  }

  if (one.orderBlock?.type === "صعودی") {

    bull += 20;

    reasons.push(
      "Order Block صعودی واقعی شناسایی شده است."
    );
  }

  if (one.orderBlock?.type === "نزولی") {

    bear += 20;

    reasons.push(
      "Order Block نزولی واقعی شناسایی شده است."
    );
  }

  if (one.bos === "صعودی")
    bull += 15;

  if (one.bos === "نزولی")
    bear += 15;

  if (
    book?.buyNear &&
    book.buyStrength >= 60
  ) {

    bull += 15;

    reasons.push(
      "دیوار خرید نزدیک قیمت قدرت قابل‌توجهی دارد."
    );
  }

  if (
    book?.sellNear &&
    book.sellStrength >= 60
  ) {

    bear += 15;

    reasons.push(
      "دیوار فروش نزدیک قیمت قدرت قابل‌توجهی دارد."
    );
  }

  return result(
    bull > bear && bull >= 35
      ? "صعودی"
      : bear > bull && bear >= 35
        ? "نزولی"
        : "رنج",
    Math.max(bull, bear),
    reasons
  );
}


/* ---------------- جریان سفارش ---------------- */

function styleOrderFlow(
  fp,
  book
) {

  let bull = 0;
  let bear = 0;

  const reasons = [];

  if (fp?.valid) {

    if (fp.deltaPercent >= 8) {

      bull += 40;

      reasons.push(
        "Delta مثبت و فشار خرید واقعی در معاملات اخیر دیده می‌شود."
      );
    }

    if (fp.deltaPercent <= -8) {

      bear += 40;

      reasons.push(
        "Delta منفی و فشار فروش واقعی در معاملات اخیر دیده می‌شود."
      );
    }

    if (
      fp.buyNotionalShare >
      fp.sellNotionalShare
    )
      bull += 20;

    if (
      fp.sellNotionalShare >
      fp.buyNotionalShare
    )
      bear += 20;
  }

  if (
    book?.buyShare >
    book.sellShare
  ) {

    bull += 20;

    reasons.push(
      "نقدینگی دفتر سفارش به سمت خرید سنگین‌تر است."
    );
  }

  if (
    book?.sellShare >
    book.buyShare
  ) {

    bear += 20;

    reasons.push(
      "نقدینگی دفتر سفارش به سمت فروش سنگین‌تر است."
    );
  }

  if (
    book?.buyNear &&
    book.buyStrength >= 60
  )
    bull += 15;

  if (
    book?.sellNear &&
    book.sellStrength >= 60
  )
    bear += 15;

  return result(
    bull > bear && bull >= 35
      ? "صعودی"
      : bear > bull && bear >= 35
        ? "نزولی"
        : "رنج",
    Math.max(bull, bear),
    reasons
  );
}


/* ---------------- مومنتوم / پامپ دامپ ---------------- */

function styleMomentum(
  one,
  market,
  fp
) {

  let bull = 0;
  let bear = 0;

  const reasons = [];

  if (
    one.volumeRatio >= 2
  ) {

    if (one.trend === "صعودی")
      bull += 25;

    if (one.trend === "نزولی")
      bear += 25;

    reasons.push(
      "حجم جاری حداقل دو برابر میانگین 20 کندل است."
    );
  }

  if (
    one.price &&
    one.ma20
  ) {

    const move =
      Math.abs(
        pct(
          one.price,
          one.ma20
        )
      );

    if (
      move >= 1 &&
      one.price > one.ma20
    )
      bull += 20;

    if (
      move >= 1 &&
      one.price < one.ma20
    )
      bear += 20;
  }

  if (
    fp?.valid &&
    fp.deltaPercent > 8
  )
    bull += 20;

  if (
    fp?.valid &&
    fp.deltaPercent < -8
  )
    bear += 20;

  if (
    market?.available &&
    market.change24h > 5
  ) {

    bull += 20;

    reasons.push(
      "حرکت 24 ساعته قیمت مثبت و غیرعادی است."
    );
  }

  if (
    market?.available &&
    market.change24h < -5
  ) {

    bear += 20;

    reasons.push(
      "حرکت 24 ساعته قیمت منفی و غیرعادی است."
    );
  }

  if (
    market?.available &&
    market.change24h > 0 &&
    market.oi?.change5mPct > 1
  )
    bull += 15;

  if (
    market?.available &&
    market.change24h < 0 &&
    market.oi?.change5mPct > 1
  )
    bear += 15;

  return result(
    bull > bear && bull >= 35
      ? "صعودی"
      : bear > bull && bear >= 35
        ? "نزولی"
        : "رنج",
    Math.max(bull, bear),
    reasons
  );
}


/* =========================================================
   ALL SIX STYLES
========================================================= */

function calculateStyles(
  one,
  fifteen,
  fp,
  book,
  market
) {

  const styles = {

    TREND:
      styleTrend(
        one,
        fifteen
      ),

    BREAKOUT:
      styleBreakout(
        one
      ),

    REVERSAL:
      styleReversal(
        one,
        fp
      ),

    LIQUIDITY:
      styleLiquidity(
        one,
        book
      ),

    ORDERFLOW:
      styleOrderFlow(
        fp,
        book
      ),

    MOMENTUM:
      styleMomentum(
        one,
        market,
        fp
      )
  };

  const values =
    Object.values(styles);

  let bull =
    values.filter(
      x => x.direction === "صعودی"
    ).length;

  let bear =
    values.filter(
      x => x.direction === "نزولی"
    ).length;

  let overall =
    "رنج";

  if (bull >= 3)
    overall = "صعودی";

  if (bear >= 3)
    overall = "نزولی";

  return {
    styles,
    overall: {
      direction: overall,
      score:
        Math.round(
          values.reduce(
            (s, x) => s + x.score,
            0
          ) / values.length
        )
    }
  };
}


/* =========================================================
   SELECTABLE SIGNAL METHODS
========================================================= */

function signalMethodScore(
  method,
  one,
  styles
) {

  let bull = 0;
  let bear = 0;
  const reasons = [];

  if (
    method === "MA"
  ) {

    if (
      one.touched &&
      one.trend === "صعودی"
    ) {

      bull += 100;

      reasons.push(
        "قیمت واقعاً به MA20 یک‌دقیقه‌ای برخورد کرده و ساختار صعودی است."
      );
    }

    if (
      one.touched &&
      one.trend === "نزولی"
    ) {

      bear += 100;

      reasons.push(
        "قیمت واقعاً به MA20 یک‌دقیقه‌ای برخورد کرده و ساختار نزولی است."
      );
    }
  }


  if (
    method === "RSI"
  ) {

    if (one.rsi <= 30) {

      bull += 100;

      reasons.push(
        "RSI در اشباع فروش است."
      );
    }

    if (one.rsi >= 70) {

      bear += 100;

      reasons.push(
        "RSI در اشباع خرید است."
      );
    }

    if (
      one.rsi > 50 &&
      one.rsi < 70
    ) {

      bull += 45;

      reasons.push(
        "RSI بالاتر از 50 است."
      );
    }

    if (
      one.rsi < 50 &&
      one.rsi > 30
    ) {

      bear += 45;

      reasons.push(
        "RSI پایین‌تر از 50 است."
      );
    }
  }


  if (
    method === "MACD"
  ) {

    if (
      one.macd?.direction ===
      "صعودی"
    ) {

      bull += 100;

      reasons.push(
        "MACD بر اساس خط و سیگنال واقعی صعودی است."
      );
    }

    if (
      one.macd?.direction ===
      "نزولی"
    ) {

      bear += 100;

      reasons.push(
        "MACD بر اساس خط و سیگنال واقعی نزولی است."
      );
    }
  }


  if (
    method === "DIVERGENCE"
  ) {

    if (
      one.divergence?.side ===
      "صعودی"
    ) {

      bull += 100;

      reasons.push(
        "واگرایی مثبت واقعی قیمت و RSI شناسایی شده است."
      );
    }

    if (
      one.divergence?.side ===
      "نزولی"
    ) {

      bear += 100;

      reasons.push(
        "واگرایی منفی واقعی قیمت و RSI شناسایی شده است."
      );
    }
  }


  const styleMap = {

    TREND: styles.styles.TREND,

    BREAKOUT: styles.styles.BREAKOUT,

    REVERSAL: styles.styles.REVERSAL,

    LIQUIDITY: styles.styles.LIQUIDITY,

    ORDERFLOW: styles.styles.ORDERFLOW,

    MOMENTUM: styles.styles.MOMENTUM
  };

  if (styleMap[method]) {

    const x =
      styleMap[method];

    if (x.direction === "صعودی")
      bull = x.score;

    if (x.direction === "نزولی")
      bear = x.score;

    reasons.push(
      ...x.reasons
    );
  }

  return {
    bull,
    bear,
    reasons
  };
}


/* =========================================================
   FINAL SIGNAL
========================================================= */

function calculateSignal(
  one,
  fifteen,
  fp,
  book,
  market,
  styles,
  strictness,
  methods
) {

  const s =
    clamp(
      strictness,
      0,
      100
    );

  let selected =
    Array.isArray(methods)
      ? methods
      : ["ALL"];

  if (
    !selected.length ||
    selected.includes("ALL")
  ) {

    selected = [
      "MA",
      "RSI",
      "MACD",
      "DIVERGENCE",
      "TREND",
      "BREAKOUT",
      "REVERSAL",
      "LIQUIDITY",
      "ORDERFLOW",
      "MOMENTUM"
    ];
  }

  let bull = 0;
  let bear = 0;

  const evidence = [];

  for (const method of selected) {

    const x =
      signalMethodScore(
        method,
        one,
        styles
      );

    bull += x.bull;
    bear += x.bear;

    if (x.bull > 0) {

      evidence.push({
        method,
        direction: "صعودی",
        score: x.bull,
        reasons: x.reasons
      });
    }

    if (x.bear > 0) {

      evidence.push({
        method,
        direction: "نزولی",
        score: x.bear,
        reasons: x.reasons
      });
    }
  }

  const count =
    selected.length || 1;

  bull /= count;
  bear /= count;

  let direction =
    "رنج";

  const threshold =
    35 +
    s * .55;

  if (
    bull >= threshold &&
    bull > bear
  )
    direction = "صعودی";

  if (
    bear >= threshold &&
    bear > bull
  )
    direction = "نزولی";

  const rawScore =
    Math.max(
      bull,
      bear
    );

  let score =
    clamp(
      rawScore,
      0,
      100
    );

  /*
    تأیید 15 دقیقه فقط تأییدکننده است،
    نه جایگزین سیگنال 1 دقیقه.
  */

  if (
    direction === "صعودی" &&
    fifteen.direction === "صعودی"
  )
    score = clamp(
      score + 8,
      0,
      100
    );

  if (
    direction === "نزولی" &&
    fifteen.direction === "نزولی"
  )
    score = clamp(
      score + 8,
      0,
      100
    );

  if (
    direction === "صعودی" &&
    fifteen.direction === "نزولی"
  )
    score = clamp(
      score - 12,
      0,
      100
    );

  if (
    direction === "نزولی" &&
    fifteen.direction === "صعودی"
  )
    score = clamp(
      score - 12,
      0,
      100
    );

  return {

    direction,

    score:
      Math.round(score),

    longScore:
      Math.round(
        clamp(bull, 0, 100)
      ),

    shortScore:
      Math.round(
        clamp(bear, 0, 100)
      ),

    threshold:

      Math.round(
        threshold
      ),

    selectedMethods:

      selected,

    evidence,

    higherTimeframe:

      fifteen.direction,

    strictness: s
  };
}


/* =========================================================
   FULL ANALYSIS
========================================================= */

async function analyzeSymbol(
  category,
  symbol,
  settings
) {

  const oneCandles =
    await klines(
      category,
      symbol,
      "1",
      DEEP_1M_LIMIT
    );

  const fifteenCandles =
    await klines(
      category,
      symbol,
      "15",
      150
    );

  const one =
    analyze1m(
      oneCandles.slice(-250)
    );

  const fifteen =
    analyze15m(
      fifteenCandles
    );

  const price =
    one.price;

  const fp =
    await footprint(
      category,
      symbol
    );

  const book =
    await orderBook(
      category,
      symbol,
      price
    );

  let market = {

    available: false,

    current: null,

    previous: null,

    change5mPct: null,

    changeHistoryPct: null,

    direction: null,

    funding: null,

    markPrice: null,

    indexPrice: null,

    turnover24h: null,

    priceChange24h: null
  };

  if (
    category === "linear"
  ) {

    market =
      await derivativesData(
        symbol
      );
  }

  const sr =
    supportResistance(
      oneCandles,
      book,
      fp,
      price
    );

  const styles =
    calculateStyles(
      one,
      fifteen,
      fp,
      book,
      market
    );

  const signal =
    calculateSignal(
      one,
      fifteen,
      fp,
      book,
      market,
      styles,
      settings.strictness,
      settings.methods
    );

  const pumpScore =
    calculatePumpScore(
      one,
      market,
      fp
    );

  const dumpScore =
    calculateDumpScore(
      one,
      market,
      fp
    );

  return {

    ok: true,

    symbol,

    category,

    price,

    direction:
      signal.direction,

    score:
      signal.score,

    longScore:
      signal.longScore,

    shortScore:
      signal.shortScore,

    threshold:
      signal.threshold,

    signalLevel:
      signal.score >= 80
        ? "قوی"
        : signal.score >= 60
          ? "متوسط"
          : "ضعیف",

    signalEvidence:
      signal.evidence,

    signalSettings: {

      strictness:
        signal.strictness,

      selectedMethods:
        signal.selectedMethods,

      threshold:
        signal.threshold
    },

    oneMinute: {

      ...one,

      label:
        "1 دقیقه"
    },

    fifteenMinute: {

      ...fifteen,

      label:
        "15 دقیقه"
    },

    styles,

    footprint: fp,

    orderBook: book,

    supportResistance: sr,

    openInterest:
      market.available
        ? {
            current:
              market.current,

            previous:
              market.previous,

            change5mPct:
              market.change5mPct,

            changeHistoryPct:
              market.changeHistoryPct,

            direction:
              market.direction
          }
        : null,

    funding:
      market.available
        ? market.funding
        : null,

    derivatives:
      market.available
        ? market
        : null,

    pumpScore,

    dumpScore,

    pumpDumpStatus:
      pumpScore >= 70
        ? "پامپ"
        : dumpScore >= 70
          ? "دامپ"
          : "عادی",

    structure: {

      bos:
        one.bos,

      choch:
        one.choch,

      fvg:
        one.fvg,

      orderBlock:
        one.orderBlock
    },

    liquidation: {

      available: false,

      message:
        "داده مستقیم لیکوئیدیشن عمومی از REST این تحلیل در دسترس نیست."
    },

    reasons:
      signal.evidence
        .filter(
          x =>
            x.direction ===
            signal.direction
        )
        .flatMap(
          x => x.reasons
        ),

    generatedAt:
      Date.now()
  };
}


/* =========================================================
   PUMP / DUMP
========================================================= */

function calculatePumpScore(
  one,
  market,
  fp
) {

  let score = 0;

  if (one.trend === "صعودی")
    score += 20;

  if (one.volumeRatio >= 1.5)
    score += 20;

  if (one.volumeRatio >= 2)
    score += 15;

  if (one.maSlopePct > .05)
    score += 10;

  if (fp?.deltaPercent >= 8)
    score += 20;

  if (
    market?.available &&
    market.priceChange24h > 5
  )
    score += 15;

  return Math.round(
    clamp(score, 0, 100)
  );
}


function calculateDumpScore(
  one,
  market,
  fp
) {

  let score = 0;

  if (one.trend === "نزولی")
    score += 20;

  if (one.volumeRatio >= 1.5)
    score += 20;

  if (one.volumeRatio >= 2)
    score += 15;

  if (one.maSlopePct < -.05)
    score += 10;

  if (fp?.deltaPercent <= -8)
    score += 20;

  if (
    market?.available &&
    market.priceChange24h < -5
  )
    score += 15;

  return Math.round(
    clamp(score, 0, 100)
  );
}


/* =========================================================
   INSTRUMENTS
========================================================= */

async function instruments(category) {

  const all = [];

  let cursor = "";

  for (
    let page = 0;
    page < 5;
    page++
  ) {

    const params = {
      category,
      limit: 1000
    };

    if (cursor)
      params.cursor = cursor;

    const d =
      await bybit(
        "/v5/market/instruments-info",
        params
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


/* =========================================================
   SYMBOL SEARCH
========================================================= */

async function findSymbol(input) {

  const raw =
    String(input || "")
      .trim()
      .toUpperCase();

  const bare =
    raw
      .replace(/[-_/:\s]/g, "")
      .replace(/USDT$/, "");

  const [
    futures,
    spot
  ] = await Promise.all([
    instruments("linear"),
    instruments("spot")
  ]);

  const f =
    futures.find(
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
      f
        ? "Futures"
        : s
          ? "Spot"
          : null,

    futures:
      f
        ? {
            symbol: f.symbol,
            status: f.status,
            baseCoin: f.baseCoin,
            quoteCoin: f.quoteCoin
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


/* =========================================================
   SCAN
========================================================= */

async function scan(
  offset = 0,
  settings = {}
) {

  const [
    futures,
    spot
  ] = await Promise.all([
    instruments("linear"),
    instruments("spot")
  ]);

  const markets = [

    ...validFutures(futures)
      .map(x => ({
        symbol: x.symbol,
        category: "linear"
      })),

    ...spot
      .filter(
        x =>
          x.status === "Trading" &&
          x.quoteCoin === "USDT"
      )
      .map(x => ({
        symbol: x.symbol,
        category: "spot"
      }))
  ];

  markets.sort(
    (a, b) =>
      String(a.symbol)
        .localeCompare(
          String(b.symbol)
        )
  );

  if (!markets.length) {

    return {
      ok: false,
      error:
        "بازار قابل بررسی در Bybit پیدا نشد."
    };
  }

  const safeOffset =
    Math.max(
      0,
      Math.min(
        Number(offset) || 0,
        Math.max(
          0,
          markets.length - 1
        )
      )
    );

  const batch =
    markets.slice(
      safeOffset,
      safeOffset + SCAN_BATCH
    );

  const candidates = [];

  for (const m of batch) {

    try {

      const candles =
        await klines(
          m.category,
          m.symbol,
          "1",
          70
        );

      if (candles.length < 40)
        continue;

      const one =
        analyze1m(
          candles
        );

      let activity = 0;

      if (one.touched)
        activity += 20;

      if (one.volumeSpike)
        activity += 20;

      if (one.hunt.confirmed)
        activity += 20;

      if (one.bos !== "رنج")
        activity += 15;

      if (one.choch !== "رنج")
        activity += 15;

      if (one.trend !== "رنج")
        activity += 10;

      candidates.push({
        ...m,
        activity
      });

    } catch (_) {}
  }

  candidates.sort(
    (a, b) =>
      b.activity - a.activity
  );

  const selected =
    candidates.slice(
      0,
      DEEP_LIMIT
    );

  const results = [];

  for (const m of selected) {

    try {

      const data =
        await analyzeSymbol(
          m.category,
          m.symbol,
          settings
        );

      results.push(data);

    } catch (_) {}
  }

  results.sort(
    (a, b) =>
      b.score - a.score
  );

  return {

    ok: true,

    totalMarkets:
      markets.length,

    offset:
      safeOffset,

    checked:
      batch.length,

    batchSize:
      batch.length,

    nextOffset:
      (
        safeOffset +
        SCAN_BATCH
      ) % markets.length,

    results,

    settings,

    note:
      "اسکن اصلی بر پایه داده‌های واقعی 1 دقیقه انجام می‌شود و 15 دقیقه فقط تأیید تایم‌فریم بالاتر است."
  };
}


/* =========================================================
   SETTINGS
========================================================= */

function parseSettings(params) {

  const strictness =
    clamp(
      n(
        params.get(
          "strictness"
        ),
        DEFAULT_STRICTNESS
      ),
      0,
      100
    );

  let methods = ["ALL"];

  const raw =
    params.get("methods");

  if (raw) {

    try {

      methods =
        JSON.parse(raw);

    } catch {

      methods =
        raw
          .split(",")
          .map(
            x =>
              x.trim()
                .toUpperCase()
          );
    }
  }

  if (
    !Array.isArray(methods) ||
    !methods.length
  )
    methods = ["ALL"];

  return {
    strictness,
    methods
  };
}


/* =========================================================
   ROUTER
========================================================= */

export default {

  async fetch(
    request,
    env
  ) {

    const u =
      new URL(request.url);

    const p =
      u.pathname;

    try {

      const settings =
        parseSettings(
          u.searchParams
        );


      /* ---------- PERSONAL HEALTH ---------- */

      if (
        p ===
        "/api/personal/health"
      ) {

        return json({

          ok: true,

          service:
            "اسکنر شخصی Bybit",

          version:
            "Personal-V10",

          تایم‌فریم_اصلی:
            "1 دقیقه",

          تایم‌فریم_بالاتر:
            "15 دقیقه",

          styles:
            STYLE_NAMES,

          methods:
            METHOD_NAMES,

          defaultStrictness:
            DEFAULT_STRICTNESS,

          scanBatch:
            SCAN_BATCH
        });
      }


      /* ---------- PERSONAL SEARCH ---------- */

      if (
        p ===
        "/api/personal/search"
      ) {

        const symbol =
          u.searchParams.get(
            "symbol"
          );

        if (!symbol)
          return json(
            {
              ok: false,
              error:
                "نام ارز وارد نشده است."
            },
            400
          );

        return json({
          ok: true,
          ...await findSymbol(
            symbol
          )
        });
      }


      /* ---------- PERSONAL ANALYZE ---------- */

      if (
        p ===
        "/api/personal/analyze"
      ) {

        const symbol =
          u.searchParams.get(
            "symbol"
          );

        if (!symbol)
          return json(
            {
              ok: false,
              error:
                "نام ارز وارد نشده است."
            },
            400
          );

        const found =
          await findSymbol(
            symbol
          );

        const chosen =
          found.futures ||
          found.spot;

        if (!chosen) {

          return json(
            {
              ok: false,

              error:
                `${symbol} در Spot یا Futures Bybit پیدا نشد.`,

              search:
                found
            },
            404
          );
        }

        const category =
          found.futures
            ? "linear"
            : "spot";

        return json(
          await analyzeSymbol(
            category,
            chosen.symbol,
            settings
          )
        );
      }


      /* ---------- PERSONAL SCAN ---------- */

      if (
        p ===
        "/api/personal/scan"
      ) {

        return json(
          await scan(
            n(
              u.searchParams.get(
                "offset"
              ),
              0
            ),
            settings
          )
        );
      }


      /* ---------- OLD ROUTES ---------- */

      if (p === "/api/search") {

        const symbol =
          u.searchParams.get(
            "symbol"
          );

        if (!symbol)
          return json(
            {
              ok: false,
              error:
                "نام ارز وارد نشده است."
            },
            400
          );

        return json({
          ok: true,
          ...await findSymbol(
            symbol
          )
        });
      }


      if (p === "/api/analyze") {

        const symbol =
          u.searchParams.get(
            "symbol"
          );

        if (!symbol)
          return json(
            {
              ok: false,
              error:
                "نام ارز وارد نشده است."
            },
            400
          );

        const found =
          await findSymbol(
            symbol
          );

        const chosen =
          found.futures ||
          found.spot;

        if (!chosen)
          return json(
            {
              ok: false,
              error:
                "ارز در Bybit پیدا نشد."
            },
            404
          );

        return json(
          await analyzeSymbol(
            found.futures
              ? "linear"
              : "spot",
            chosen.symbol,
            settings
          )
        );
      }


      if (p === "/api/scan") {

        return json(
          await scan(
            n(
              u.searchParams.get(
                "offset"
              ),
              0
            ),
            settings
          )
        );
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
              1800
            )
        },
        500
      );
    }
  }
};
