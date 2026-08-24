const BYBIT = "https://api.bybit.com";

const SCAN_BATCH = 20;
const DEEP_LIMIT = 3;
const MIN_SIGNAL_SCORE = 45;
const WATCH_SCORE = 35;
const DEFAULT_STRICTNESS = 3;

const TIMEFRAMES = ["1", "3", "5", "15", "60"];

const SIGNAL_METHODS = [
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

const CONVERTED_MA = {
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

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "cache-control": "no-store"
    }
  });
}

function n(v, d = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
}

function avg(a) {
  if (!a.length) return 0;
  return a.reduce((s, x) => s + x, 0) / a.length;
}

function ema(data, period) {
  if (!data.length) return 0;

  const k = 2 / (period + 1);
  let value = data[0];

  for (let i = 1; i < data.length; i++) {
    value = data[i] * k + value * (1 - k);
  }

  return value;
}

function sma(data, period) {
  if (!data.length) return 0;
  return avg(data.slice(-period));
}

function rsi(data, period = 14) {
  if (data.length < period + 1) return 50;

  let gain = 0;
  let loss = 0;

  for (let i = data.length - period; i < data.length; i++) {
    const diff = data[i] - data[i - 1];

    if (diff > 0) gain += diff;
    else loss -= diff;
  }

  if (loss === 0) return 100;

  const rs = gain / loss;
  return 100 - 100 / (1 + rs);
}

function atr(candles, period = 14) {
  if (candles.length < 2) return 0;

  const tr = [];

  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high;
    const l = candles[i].low;
    const pc = candles[i - 1].close;

    tr.push(
      Math.max(
        h - l,
        Math.abs(h - pc),
        Math.abs(l - pc)
      )
    );
  }

  return avg(tr.slice(-period));
}

function adx(candles, period = 14) {
  if (candles.length < period + 2) return 0;

  let up = 0;
  let down = 0;

  for (
    let i = candles.length - period;
    i < candles.length;
    i++
  ) {
    const a = candles[i];
    const b = candles[i - 1];

    const u = a.high - b.high;
    const d = b.low - a.low;

    if (u > d && u > 0) up += u;
    if (d > u && d > 0) down += d;
  }

  const total = up + down;

  if (!total) return 0;

  return Math.min(
    100,
    Math.abs(up - down) / total * 100
  );
}

function bollingerWidth(closes, period = 20) {
  if (closes.length < period) return 0;

  const a = closes.slice(-period);
  const m = avg(a);

  const variance =
    avg(
      a.map(x => Math.pow(x - m, 2))
    );

  const sd = Math.sqrt(variance);

  return m
    ? ((sd * 4) / m) * 100
    : 0;
}

function macd(closes) {
  if (closes.length < 26) {
    return {
      macd: 0,
      signal: 0,
      histogram: 0,
      direction: "NONE"
    };
  }

  const fast = ema(closes, 12);
  const slow = ema(closes, 26);
  const line = fast - slow;

  const values = [];

  for (
    let i = 26;
    i <= closes.length;
    i++
  ) {
    const part = closes.slice(0, i);
    values.push(
      ema(part, 12) -
      ema(part, 26)
    );
  }

  const signal = ema(values, 9);
  const hist = line - signal;

  return {
    macd: line,
    signal,
    histogram: hist,
    direction:
      hist > 0
        ? "LONG"
        : hist < 0
          ? "SHORT"
          : "NONE"
  };
}

function ichimoku(candles) {
  if (candles.length < 30) {
    return {
      tenkan: 0,
      kijun: 0,
      spanA: 0,
      spanB: 0,
      direction: "NONE"
    };
  }

  const mid = arr =>
    (Math.max(...arr.map(x => x.high)) +
      Math.min(...arr.map(x => x.low))) / 2;

  const tenkan = mid(candles.slice(-9));
  const kijun = mid(candles.slice(-26));
  const spanB = mid(candles.slice(-52));
  const spanA = (tenkan + kijun) / 2;

  const price =
    candles[candles.length - 1].close;

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

function divergence(candles) {
  if (candles.length < 30) {
    return {
      type: "NONE",
      side: "NONE"
    };
  }

  const prices = candles.map(x => x.close);
  const rsis = [];

  for (let i = 15; i < prices.length; i++) {
    rsis.push(
      rsi(prices.slice(0, i + 1))
    );
  }

  const p = prices.slice(-10);
  const r = rsis.slice(-10);

  const oldPrice = p[0];
  const newPrice = p[p.length - 1];
  const oldRsi = r[0];
  const newRsi = r[r.length - 1];

  if (
    newPrice > oldPrice &&
    newRsi < oldRsi
  ) {
    return {
      type: "BEARISH_DIVERGENCE",
      side: "SHORT"
    };
  }

  if (
    newPrice < oldPrice &&
    newRsi > oldRsi
  ) {
    return {
      type: "BULLISH_DIVERGENCE",
      side: "LONG"
    };
  }

  return {
    type: "NONE",
    side: "NONE"
  };
}

function volumeAnalysis(candles) {
  if (!candles.length) {
    return {
      current: 0,
      average: 0,
      ratio: 0,
      spike: false,
      state: "NORMAL"
    };
  }

  const current =
    candles[candles.length - 1].volume;

  const previous =
    candles
      .slice(-21, -1)
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
    spike: ratio >= 1.5,
    state:
      ratio >= 1.5
        ? "SPIKE"
        : "NORMAL"
  };
}

function structure(candles) {
  if (candles.length < 10) {
    return {
      bos: "NONE",
      choch: "NONE"
    };
  }

  const recent =
    candles[candles.length - 1];

  const prev =
    candles.slice(-6, -1);

  const high =
    Math.max(...prev.map(x => x.high));

  const low =
    Math.min(...prev.map(x => x.low));

  return {
    bos:
      recent.close > high
        ? "LONG"
        : recent.close < low
          ? "SHORT"
          : "NONE",

    choch: "NONE"
  };
}

function hunt(candles) {
  if (candles.length < 8) {
    return {
      side: "NONE",
      confirmed: false,
      sweepPrice: 0,
      strength: 0
    };
  }

  const last =
    candles[candles.length - 1];

  const prev =
    candles.slice(-7, -1);

  const high =
    Math.max(...prev.map(x => x.high));

  const low =
    Math.min(...prev.map(x => x.low));

  if (
    last.high > high &&
    last.close < high
  ) {
    return {
      side: "SHORT",
      confirmed: true,
      sweepPrice: last.high,
      strength: 80
    };
  }

  if (
    last.low < low &&
    last.close > low
  ) {
    return {
      side: "LONG",
      confirmed: true,
      sweepPrice: last.low,
      strength: 80
    };
  }

  return {
    side: "NONE",
    confirmed: false,
    sweepPrice: 0,
    strength: 0
  };
}

function fvg(candles) {
  if (candles.length < 3) {
    return {
      type: "NONE",
      top: 0,
      bottom: 0,
      sizePct: 0
    };
  }

  const a = candles[candles.length - 3];
  const c = candles[candles.length - 1];

  if (c.low > a.high) {
    return {
      type: "LONG",
      top: c.low,
      bottom: a.high,
      sizePct:
        a.high
          ? ((c.low - a.high) / a.high) * 100
          : 0
    };
  }

  if (c.high < a.low) {
    return {
      type: "SHORT",
      top: a.low,
      bottom: c.high,
      sizePct:
        a.low
          ? ((a.low - c.high) / a.low) * 100
          : 0
    };
  }

  return {
    type: "NONE",
    top: 0,
    bottom: 0,
    sizePct: 0
  };
}

function orderBlock(candles) {
  if (candles.length < 5) {
    return {
      type: "NONE",
      price: 0,
      strength: 0
    };
  }

  const a =
    candles[candles.length - 2];

  const b =
    candles[candles.length - 1];

  if (
    a.close < a.open &&
    b.close > a.high
  ) {
    return {
      type: "LONG",
      price: a.low,
      strength: 70
    };
  }

  if (
    a.close > a.open &&
    b.close < a.low
  ) {
    return {
      type: "SHORT",
      price: a.high,
      strength: 70
    };
  }

  return {
    type: "NONE",
    price: 0,
    strength: 0
  };
}

function candleAnalysis(candles) {
  const x =
    candles[candles.length - 1];

  if (!x) {
    return {
      type: "NONE",
      direction: "NONE",
      strength: 0
    };
  }

  const body =
    Math.abs(x.close - x.open);

  const range =
    x.high - x.low;

  return {
    type:
      range && body / range > 0.65
        ? "STRONG"
        : "NORMAL",

    direction:
      x.close >= x.open
        ? "LONG"
        : "SHORT",

    strength:
      range
        ? Math.min(
            100,
            body / range * 100
          )
        : 0
  };
}

function calculateTF(candles) {
  const closes =
    candles.map(x => x.close);

  const price =
    closes[closes.length - 1];

  const ma7 = sma(closes, 7);
  const ma20 = sma(closes, 20);

  const maSlope =
    closes.length >= 10 &&
    sma(closes.slice(0, -5), 7) < ma7
      ? "UP"
      : "DOWN";

  const mac = macd(closes);
  const ich = ichimoku(candles);
  const div = divergence(candles);
  const vol = volumeAnalysis(candles);
  const st = structure(candles);
  const hn = hunt(candles);
  const fg = fvg(candles);
  const ob = orderBlock(candles);
  const candle = candleAnalysis(candles);

  let trend = "RANGE";

  if (
    price > ma20 &&
    ma7 >= ma20
  ) {
    trend = "BULLISH";
  }

  if (
    price < ma20 &&
    ma7 <= ma20
  ) {
    trend = "BEARISH";
  }

  const atrValue =
    atr(candles);

  return {
    price,
    ma7,
    ma20,
    trend,
    maSlope,
    touchMA20:
      Math.abs(price - ma20) /
        price < 0.005,

    touchMA7:
      Math.abs(price - ma7) /
        price < 0.005,

    volume: vol,
    hunt: hn,
    bos: st.bos,
    choch: st.choch,
    candle,
    fvg: fg,
    orderBlock: ob,

    support:
      Math.min(
        ...candles.slice(-20).map(x => x.low)
      ),

    resistance:
      Math.max(
        ...candles.slice(-20).map(x => x.high)
      ),

    rsi: rsi(closes),

    macd: mac,

    ichimoku: ich,

    divergence: div,

    atr: atrValue,

    adx: adx(candles),

    bollingerWidth:
      bollingerWidth(closes),

    market: {
      state:
        vol.spike
          ? "ACTIVE"
          : "NORMAL"
    },

    extra: {
      MACD: mac,
      RSI: {
        value: rsi(closes),
        direction:
          rsi(closes) >= 55
            ? "LONG"
            : rsi(closes) <= 45
              ? "SHORT"
              : "NONE"
      },
      ICHIMOKU: ich,
      DIVERGENCE: div
    }
  };
}

function scoreAnalysis(timeframes) {
  let long = 0;
  let short = 0;
  const reasons = [];

  for (const [tf, x] of Object.entries(timeframes)) {
    if (!x) continue;

    if (x.trend === "BULLISH") {
      long += 8;
      reasons.push({
        side: "LONG",
        text: `روند صعودی ${tf}m`
      });
    }

    if (x.trend === "BEARISH") {
      short += 8;
      reasons.push({
        side: "SHORT",
        text: `روند نزولی ${tf}m`
      });
    }

    if (x.maSlope === "UP") {
      long += 5;
      reasons.push({
        side: "LONG",
        text: `شیب MA صعودی ${tf}m`
      });
    }

    if (x.maSlope === "DOWN") {
      short += 5;
      reasons.push({
        side: "SHORT",
        text: `شیب MA نزولی ${tf}m`
      });
    }

    if (x.macd.direction === "LONG") {
      long += 6;
      reasons.push({
        side: "LONG",
        text: `MACD صعودی ${tf}m`
      });
    }

    if (x.macd.direction === "SHORT") {
      short += 6;
      reasons.push({
        side: "SHORT",
        text: `MACD نزولی ${tf}m`
      });
    }

    if (x.divergence.side === "LONG") {
      long += 7;
      reasons.push({
        side: "LONG",
        text: `واگرایی صعودی ${tf}m`
      });
    }

    if (x.divergence.side === "SHORT") {
      short += 7;
      reasons.push({
        side: "SHORT",
        text: `واگرایی نزولی ${tf}m`
      });
    }

    if (x.ichimoku.direction === "LONG") {
      long += 5;
      reasons.push({
        side: "LONG",
        text: `Ichimoku صعودی ${tf}m`
      });
    }

    if (x.ichimoku.direction === "SHORT") {
      short += 5;
      reasons.push({
        side: "SHORT",
        text: `Ichimoku نزولی ${tf}m`
      });

    }

    if (x.hunt.confirmed) {
      if (x.hunt.side === "LONG") {
        long += 8;
      }

      if (x.hunt.side === "SHORT") {
        short += 8;
      }

      reasons.push({
        side: x.hunt.side,
        text: `Liquidity Hunt ${tf}m`
      });
    }

    if (x.bos === "LONG") {
      long += 6;
      reasons.push({
        side: "LONG",
        text: `BOS صعودی ${tf}m`
      });
    }

    if (x.bos === "SHORT") {
      short += 6;
      reasons.push({
        side: "SHORT",
        text: `BOS نزولی ${tf}m`
      });
    }

    if (x.fvg.type === "LONG") {
      long += 4;
    }

    if (x.fvg.type === "SHORT") {
      short += 4;
    }

    if (x.orderBlock.type === "LONG") {
      long += 4;
    }

    if (x.orderBlock.type === "SHORT") {
      short += 4;
    }

    if (x.volume.spike) {
      reasons.push({
        side:
          x.candle.direction,
        text:
          `افزایش غیرعادی حجم ${tf}m`
      });
    }
  }

  long = Math.min(100, long);
  short = Math.min(100, short);

  const direction =
    long > short
      ? "LONG"
      : short > long
        ? "SHORT"
        : "WAIT";

  return {
    direction,
    score:
      Math.max(long, short),
    longScore: long,
    shortScore: short,
    reasons
  };
}

async function bybit(path) {
  const r =
    await fetch(
      BYBIT + path,
      {
        headers: {
          "User-Agent":
            "Bybit-Smart-Money-Scanner"
        }
      }
    );

  const d =
    await r.json();

  if (
    !r.ok ||
    d.retCode !== 0
  ) {
    throw Error(
      d.retMsg ||
      `Bybit HTTP ${r.status}`
    );
  }

  return d.result;
}

async function instruments(category) {
  return bybit(
    `/v5/market/instruments-info?category=${category}&limit=1000`
  );
}

async function resolveSymbol(input) {
  const symbol =
    String(input)
      .trim()
      .toUpperCase();

  const [linear, spot] =
    await Promise.all([
      instruments("linear"),
      instruments("spot")
    ]);

  const futures =
    (linear.list || [])
      .find(x =>
        x.symbol === symbol &&
        x.status === "Trading"
      );

  const sp =
    (spot.list || [])
      .find(x =>
        x.symbol === symbol &&
        x.status === "Trading"
      );

  return {
    input: symbol,

    selected:
      futures
        ? "LINEAR"
        : sp
          ? "SPOT"
          : null,

    futures: futures
      ? {
          symbol: futures.symbol,
          status: futures.status,
          baseCoin: futures.baseCoin,
          quoteCoin: futures.quoteCoin
        }
      : null,

    spot: sp
      ? {
          symbol: sp.symbol,
          status: sp.status,
          baseCoin: sp.baseCoin,
          quoteCoin: sp.quoteCoin
        }
      : null
  };
}

async function klines(
  category,
  symbol,
  interval,
  limit = 200
) {
  const result =
    await bybit(
      `/v5/market/kline?category=${category}` +
      `&symbol=${encodeURIComponent(symbol)}` +
      `&interval=${interval}` +
      `&limit=${limit}`
    );

  const list =
    result.list || [];

  return list
    .reverse()
    .map(x => ({
      time: n(x[0]),
      open: n(x[1]),
      high: n(x[2]),
      low: n(x[3]),
      close: n(x[4]),
      volume: n(x[5]),
      turnover: n(x[6])
    }));
}

async function ticker(
  category,
  symbol
) {
  const result =
    await bybit(
      `/v5/market/tickers?category=${category}` +
      `&symbol=${encodeURIComponent(symbol)}`
    );

  return result.list?.[0] || {};
}

async function orderBook(
  category,
  symbol
) {
  const result =
    await bybit(
      `/v5/market/orderbook?category=${category}` +
      `&symbol=${encodeURIComponent(symbol)}` +
      `&limit=50`
    );

  const bids =
    (result.b || [])
      .map(x => ({
        price: n(x[0]),
        size: n(x[1])
      }));

  const asks =
    (result.a || [])
      .map(x => ({
        price: n(x[0]),
        size: n(x[1])
      }));

  const buyLevels =
    bids
      .sort(
        (a, b) =>
          b.price * b.size -
          a.price * a.size
      )
      .slice(0, 10);

  const sellLevels =
    asks
      .sort(
        (a, b) =>
          b.price * b.size -
          a.price * a.size
      )
      .slice(0, 10);

  const price =
    n(
      result.ts
        ? result.b?.[0]?.[0]
        : 0
    );

  const bidPrice =
    bids[0]?.price || 0;

  const askPrice =
    asks[0]?.price || 0;

  const current =
    price ||
    (bidPrice + askPrice) / 2;

  const makeLevel =
    x => ({
      price: x.price,
      size: x.size,
      notional:
        x.price * x.size,
      distancePct:
        current
          ? Math.abs(
              x.price - current
            ) /
            current *
            100
          : 0
    });

  const buys =
    buyLevels.map(makeLevel);

  const sells =
    sellLevels.map(makeLevel);

  const buyLiquidity =
    buys.reduce(
      (s, x) =>
        s + x.notional,
      0
    );

  const sellLiquidity =
    sells.reduce(
      (s, x) =>
        s + x.notional,
      0
    );

  const buy =
    buys[0] || {
      price: 0,
      size: 0,
      notional: 0,
      distancePct: 0
    };

  const sell =
    sells[0] || {
      price: 0,
      size: 0,
      notional: 0,
      distancePct: 0
    };

  return {
    buy,
    sell,
    buyLevels: buys,
    sellLevels: sells,

    buyLiquidity,
    sellLiquidity,

    totalLiquidity:
      buyLiquidity +
      sellLiquidity,

    buyShare:
      buyLiquidity +
      sellLiquidity
        ? buyLiquidity /
          (buyLiquidity +
            sellLiquidity) *
          100
        : 0,

    sellShare:
      buyLiquidity +
      sellLiquidity
        ? sellLiquidity /
          (buyLiquidity +
            sellLiquidity) *
          100
        : 0,

    buyStrength: 100,
    sellStrength: 100,

    buyNear:
      buy.distancePct < 1,

    sellNear:
      sell.distancePct < 1
  };
}

async function footprint(
  category,
  symbol
) {
  const candles =
    await klines(
      category,
      symbol,
      "1",
      60
    );

  const buyVolume =
    candles.reduce(
      (s, x) =>
        s +
        (
          x.close >= x.open
            ? x.volume
            : x.volume * 0.45
        ),
      0
    );

  const sellVolume =
    candles.reduce(
      (s, x) =>
        s +
        (
          x.close < x.open
            ? x.volume
            : x.volume * 0.55
        ),
      0
    );

  const delta =
    buyVolume - sellVolume;

  const total =
    buyVolume + sellVolume;

  return {
    buyVolume,
    sellVolume,
    delta,

    deltaPercent:
      total
        ? delta / total * 100
        : 0,

    buyNotional:
      buyVolume *
      candles.at(-1).close,

    sellNotional:
      sellVolume *
      candles.at(-1).close,

    buyNotionalShare:
      total
        ? buyVolume / total * 100
        : 0,

    sellNotionalShare:
      total
        ? sellVolume / total * 100
        : 0,

    trades: 0,

    largeTradeNotional:
      0,

    pressure:
      delta > 0
        ? "BUY"
        : delta < 0
          ? "SELL"
          : "NEUTRAL"
  };
}

async function convertedMA(
  category,
  symbol,
  candles1m
) {
  const events = [];

  for (
    const item of CONVERTED_MA["1m"]
  ) {
    const source =
      item.source
        .replace("m", "");

    const candles =
      await klines(
        category,
        symbol,
        source,
        100
      );

    const closes =
      candles.map(x => x.close);

    const value =
      sma(
        closes,
        item.period
      );

    const price =
      candles1m.at(-1)?.close || 0;

    const distancePct =
      price
        ? Math.abs(
            price - value
          ) /
          price *
          100
        : 0;

    const slope =
      closes.at(-1) >=
      avg(
        closes.slice(
          -Math.min(
            10,
            closes.length
          )
        )
      )
        ? "UP"
        : "DOWN";

    events.push({
      type: "TOUCH",
      source: item.source,
      period1m: item.period,
      ma:
        `MA${item.period}`,
      value,
      distancePct,
      slope,
      confirmation:
        slope === "UP" &&
        distancePct < 0.5
          ? "CONFIRMED_LONG"
          : slope === "DOWN" &&
            distancePct < 0.5
              ? "CONFIRMED_SHORT"
              : "NONE"
    });
  }

  return { events };
}

async function analyzeSymbol(
  category,
  symbol
) {
  const tfData = {};

  for (
    const tf of TIMEFRAMES
  ) {
    const candles =
      await klines(
        category,
        symbol,
        tf,
        200
      );

    tfData[tf] =
      calculateTF(candles);
  }

  const one =
    await klines(
      category,
      symbol,
      "1",
      200
    );

  const converted =
    await convertedMA(
      category,
      symbol,
      one
    );

  const fp =
    await footprint(
      category,
      symbol
    );

  let walls;

  try {
    walls =
      await orderBook(
        category,
        symbol
      );
  } catch {
    walls = {
      error:
        "Order Book unavailable"
    };
  }

  const scored =
    scoreAnalysis(tfData);

  const price =
    tfData["1"]?.price || 0;

  const reasons =
    scored.reasons;

  for (
    const e of converted.events
  ) {
    if (
      e.confirmation ===
      "CONFIRMED_LONG"
    ) {
      scored.longScore =
        Math.min(
          100,
          scored.longScore + 5
        );

      reasons.push({
        side: "LONG",
        text:
          `${e.ma} ${e.source} → MA روی 1m: برخورد و تأیید صعودی`
      });
    }

    if (
      e.confirmation ===
      "CONFIRMED_SHORT"
    ) {
      scored.shortScore =
        Math.min(
          100,
          scored.shortScore + 5
        );

      reasons.push({
        side: "SHORT",
        text:
          `${e.ma} ${e.source} → MA روی 1m: برخورد و تأیید نزولی`
      });
    }
  }

  const direction =
    scored.longScore >
    scored.shortScore
      ? "LONG"
      : scored.shortScore >
        scored.longScore
        ? "SHORT"
        : "WAIT";

  return {
    ok: true,
    symbol,
    category,
    price,

    direction,

    score:
      Math.max(
        scored.longScore,
        scored.shortScore
      ),

    longScore:
      scored.longScore,

    shortScore:
      scored.shortScore,

    pumpScore:
      Math.min(
        100,
        scored.longScore
      ),

    dumpScore:
      Math.min(
        100,
        scored.shortScore
      ),

    timeframes: tfData,

    convertedMA1m:
      converted,

    footprint: fp,

    walls,

    market: {
      error:
        category === "spot"
          ? "Open Interest/Funding فقط برای Futures در دسترس است."
          : "داده بازار در دسترس نیست."
    },

    reasons,

    generatedAt:
      Date.now(),

    liquidation: {
      available: false,
      message:
        "داده لیکوئیدیشن تجمیعی از REST عمومی Bybit برای این اسکنر در دسترس نیست."
    },

    search: {
      input: symbol,
      selected:
        category === "linear"
          ? "FUTURES"
          : "SPOT"
    }
  };
}

async function scan(
  offset = 0
) {
  const result =
    await instruments(
      "linear"
    );

  const markets =
    (result.list || [])
      .filter(
        x =>
          x.status ===
            "Trading" &&
          x.quoteCoin ===
            "USDT"
      );

  const totalMarkets =
    markets.length;

  const start =
    offset %
    Math.max(
      1,
      totalMarkets
    );

  const selected =
    markets.slice(
      start,
      start + SCAN_BATCH
    );

  const wrapped =
    selected.length <
    SCAN_BATCH
      ? [
          ...selected,
          ...markets.slice(
            0,
            SCAN_BATCH -
              selected.length
          )
        ]
      : selected;

  const results = [];

  for (
    const m of wrapped
  ) {
    try {
      const d =
        await analyzeSymbol(
          "linear",
          m.symbol
        );

      results.push({
        symbol: m.symbol,
        direction: d.direction,
        score: d.score,
        longScore:
          d.longScore,
        shortScore:
          d.shortScore
      });
    } catch {
      // skip broken symbol
    }
  }

  results.sort(
    (a, b) =>
      b.score - a.score
  );

  return {
    ok: true,
    batchSize:
      results.length,
    totalMarkets,
    offset: start,

    nextOffset:
      (
        start +
        SCAN_BATCH
      ) % Math.max(
        1,
        totalMarkets
      ),

    results
  };
}

export default {
  async fetch(request) {
    const url =
      new URL(request.url);

    try {

      if (
        url.pathname ===
        "/api/health"
      ) {
        return json({
          ok: true,
          service:
            "Bybit Smart Money Scanner",
          version: "V10",
          timeframes:
            TIMEFRAMES,
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
            SIGNAL_METHODS,
          convertedMA:
            CONVERTED_MA,
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

      if (
        url.pathname ===
        "/api/analyze"
      ) {
        const symbol =
          url.searchParams
            .get("symbol");

        const requested =
          (
            url.searchParams
              .get("category") ||
            "auto"
          ).toLowerCase();

        if (!symbol) {
          return json({
            ok: false,
            error:
              "نام ارز وارد نشده است."
          }, 400);
        }

        const resolved =
          await resolveSymbol(
            symbol
          );

        let category;

        if (
          requested ===
          "linear"
        ) {
          if (
            !resolved.futures
          ) {
            return json({
              ok: false,
              error:
                `${symbol.toUpperCase()} در Futures Bybit پیدا نشد.`,
              search: resolved
            }, 404);
          }

          category =
            "linear";
        } else if (
          requested ===
          "spot"
        ) {
          if (
            !resolved.spot
          ) {
            return json({
              ok: false,
              error:
                `${symbol.toUpperCase()} در Spot Bybit پیدا نشد.`,
              search: resolved
            }, 404);
          }

          category =
            "spot";
        } else {

          category =
            resolved.futures
              ? "linear"
              : resolved.spot
                ? "spot"
                : null;

          if (!category) {
            return json({
              ok: false,
              error:
                `${symbol.toUpperCase()} در Spot یا Futures Bybit پیدا نشد.`,
              search: resolved
            }, 404);
          }
        }

        return json(
          await analyzeSymbol(
            category,
            symbol.toUpperCase()
          )
        );
      }

      if (
        url.pathname ===
        "/api/scan"
      ) {
        const offset =
          n(
            url.searchParams
              .get("offset"),
            0
          );

        return json(
          await scan(offset)
        );
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
        error:
          e?.message ||
          "Worker error"
      }, 500);
    }
  }
};
