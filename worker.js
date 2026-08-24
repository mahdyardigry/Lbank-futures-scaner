const BYBIT = "https://api.bybit.com";

const CONFIG = {
  scanBatch: 20,
  scanCandidates: 80,
  minCandles: 60,
  deepLimit: 3,
  defaultStrictness: 3,
  minimumSignalScore: 45
};

const TF = ["1", "15"];

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: corsHeaders()
      });
    }

    try {
      if (url.pathname === "/api/health") {
        return json({
          ok: true,
          service: "Bybit Personal Smart Money Scanner",
          version: "P1",
          timeframes: ["1", "15"],
          scanBatch: CONFIG.scanBatch,
          strictness: "1-6",
          signalBase: "MA20 1m + 15m confirmation"
        });
      }

      if (url.pathname === "/api/analyze") {
        const input = url.searchParams.get("symbol") || "";

        if (!input.trim()) {
          return json({
            ok: false,
            error: "نام ارز وارد نشده است."
          }, 400);
        }

        const found = await findSymbol(input);

        if (!found) {
          return json({
            ok: false,
            error: `${input} در Spot یا Futures Bybit پیدا نشد.`,
            search: {
              input,
              futures: null,
              spot: null
            }
          }, 404);
        }

        return json(
          await analyzeSymbol(
            found.symbol,
            found.category
          )
        );
      }

      if (url.pathname === "/api/scan") {
        const strictness = clamp(
          Number(
            url.searchParams.get("strictness") ||
            CONFIG.defaultStrictness
          ),
          1,
          6
        );

        const offset = Math.max(
          0,
          Number(
            url.searchParams.get("offset") || 0
          )
        );

        return json(
          await scanMarket(
            strictness,
            offset
          )
        );
      }

      return json({
        ok: false,
        error: "API route not found"
      }, 404);

    } catch (e) {
      return json({
        ok: false,
        error: e?.message || "Worker error"
      }, 500);
    }
  }
};


/* =========================================================
   BASIC
========================================================= */

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        ...corsHeaders()
      }
    }
  );
}

function clamp(v, min, max) {
  return Math.max(
    min,
    Math.min(max, Number(v) || min)
  );
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
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
   BYBIT REQUEST
========================================================= */

async function bybit(path, params = {}) {

  const qs = Object.entries(params)
    .filter(([, v]) =>
      v !== undefined &&
      v !== null &&
      v !== ""
    )
    .map(([k, v]) =>
      `${encodeURIComponent(k)}=${encodeURIComponent(v)}`
    )
    .join("&");

  const url =
    `${BYBIT}${path}${qs ? "?" + qs : ""}`;

  const r = await fetch(url, {
    headers: {
      "Accept": "application/json"
    },
    cf: {
      cacheTtl: 0,
      cacheEverything: false
    }
  });

  if (!r.ok) {
    throw new Error(
      `Bybit HTTP ${r.status}`
    );
  }

  const d = await r.json();

  if (d.retCode !== 0) {
    throw new Error(
      d.retMsg || "Bybit API error"
    );
  }

  return d.result;
}


/* =========================================================
   SYMBOL FINDER
========================================================= */

async function findSymbol(input) {

  let raw =
    String(input)
      .trim()
      .toUpperCase()
      .replace(/\s+/g, "");

  if (!raw) return null;

  if (!raw.includes("USDT")) {
    raw += "USDT";
  }

  const base =
    raw.endsWith("USDT")
      ? raw.slice(0, -4)
      : raw;

  let futures = null;
  let spot = null;

  try {
    const r =
      await bybit(
        "/v5/market/instruments-info",
        {
          category: "linear",
          symbol: raw
        }
      );

    if (
      r.list &&
      r.list.length &&
      r.list[0].status === "Trading"
    ) {
      futures = {
        symbol: r.list[0].symbol,
        status: r.list[0].status,
        baseCoin: r.list[0].baseCoin,
        quoteCoin: r.list[0].quoteCoin
      };
    }
  } catch (_) {}

  try {
    const r =
      await bybit(
        "/v5/market/instruments-info",
        {
          category: "spot",
          symbol: raw
        }
      );

    if (
      r.list &&
      r.list.length &&
      r.list[0].status === "Trading"
    ) {
      spot = {
        symbol: r.list[0].symbol,
        status: r.list[0].status,
        baseCoin: r.list[0].baseCoin,
        quoteCoin: r.list[0].quoteCoin
      };
    }
  } catch (_) {}

  /*
   اول Futures.
   اگر نبود Spot.
  */

  if (futures) {
    return {
      symbol: futures.symbol,
      category: "linear",
      futures,
      spot
    };
  }

  if (spot) {
    return {
      symbol: spot.symbol,
      category: "spot",
      futures,
      spot
    };
  }

  /*
   اگر کاربر فقط نام پایه داده باشد،
   یک جستجوی baseCoin هم انجام می‌دهیم.
  */

  if (base) {

    try {
      const r =
        await bybit(
          "/v5/market/instruments-info",
          {
            category: "linear",
            baseCoin: base,
            limit: 1000
          }
        );

      const x =
        (r.list || [])
          .find(
            a =>
              a.status === "Trading" &&
              a.quoteCoin === "USDT"
          );

      if (x) {
        return {
          symbol: x.symbol,
          category: "linear",
          futures: {
            symbol: x.symbol,
            status: x.status,
            baseCoin: x.baseCoin,
            quoteCoin: x.quoteCoin
          },
          spot
        };
      }
    } catch (_) {}

    try {
      const r =
        await bybit(
          "/v5/market/instruments-info",
          {
            category: "spot",
            limit: 1000
          }
        );

      const x =
        (r.list || [])
          .find(
            a =>
              a.status === "Trading" &&
              a.baseCoin === base &&
              a.quoteCoin === "USDT"
          );

      if (x) {
        return {
          symbol: x.symbol,
          category: "spot",
          futures,
          spot: {
            symbol: x.symbol,
            status: x.status,
            baseCoin: x.baseCoin,
            quoteCoin: x.quoteCoin
          }
        };
      }
    } catch (_) {}
  }

  return null;
}


/* =========================================================
   KLINES
========================================================= */

async function getKlines(
  category,
  symbol,
  interval,
  limit = 200
) {

  const r =
    await bybit(
      "/v5/market/kline",
      {
        category,
        symbol,
        interval,
        limit
      }
    );

  return (r.list || [])
    .reverse()
    .map(x => ({
      time: num(x[0]),
      open: num(x[1]),
      high: num(x[2]),
      low: num(x[3]),
      close: num(x[4]),
      volume: num(x[5]),
      turnover: num(x[6])
    }));
}


/* =========================================================
   MA
========================================================= */

function sma(values, period) {
  if (values.length < period) return 0;

  return avg(
    values.slice(
      values.length - period
    )
  );
}

function ema(values, period) {

  if (values.length < period)
    return 0;

  const k = 2 / (period + 1);

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

function maSlope(values, period) {

  if (values.length < period + 3)
    return 0;

  const now =
    sma(values, period);

  const prev =
    avg(
      values.slice(
        values.length - period - 3,
        values.length - 3
      )
    );

  return pct(now, prev);
}


/* =========================================================
   RSI
========================================================= */

function rsi(values, period = 14) {

  if (values.length <= period)
    return 50;

  let gains = 0;
  let losses = 0;

  for (
    let i = values.length - period;
    i < values.length;
    i++
  ) {

    const diff =
      values[i] -
      values[i - 1];

    if (diff >= 0)
      gains += diff;
    else
      losses += Math.abs(diff);
  }

  if (losses === 0)
    return 100;

  const rs =
    gains / losses;

  return 100 -
    (100 / (1 + rs));
}


/* =========================================================
   MACD
========================================================= */

function macd(values) {

  const fast = ema(values, 12);
  const slow = ema(values, 26);

  const line =
    fast - slow;

  const histValues = [];

  for (
    let i = 26;
    i <= values.length;
    i++
  ) {

    const part =
      values.slice(0, i);

    histValues.push(
      ema(part, 12) -
      ema(part, 26)
    );
  }

  const signal =
    ema(histValues, 9);

  const histogram =
    line - signal;

  return {
    macd: line,
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
   ATR
========================================================= */

function atr(candles, period = 14) {

  if (candles.length < period + 1)
    return 0;

  const trs = [];

  for (let i = 1; i < candles.length; i++) {

    const c = candles[i];
    const p = candles[i - 1];

    trs.push(
      Math.max(
        c.high - c.low,
        Math.abs(c.high - p.close),
        Math.abs(c.low - p.close)
      )
    );
  }

  return avg(
    trs.slice(-period)
  );
}


/* =========================================================
   ADX - SIMPLE TREND STRENGTH
========================================================= */

function adx(candles, period = 14) {

  if (candles.length < period + 2)
    return 0;

  let tr = 0;
  let plus = 0;
  let minus = 0;

  const start =
    Math.max(
      1,
      candles.length - period
    );

  for (
    let i = start;
    i < candles.length;
    i++
  ) {

    const c = candles[i];
    const p = candles[i - 1];

    const up =
      c.high - p.high;

    const down =
      p.low - c.low;

    tr +=
      Math.max(
        c.high - c.low,
        Math.abs(c.high - p.close),
        Math.abs(c.low - p.close)
      );

    if (up > down && up > 0)
      plus += up;

    if (down > up && down > 0)
      minus += down;
  }

  if (!tr)
    return 0;

  const pdi =
    (plus / tr) * 100;

  const mdi =
    (minus / tr) * 100;

  if (pdi + mdi === 0)
    return 0;

  return (
    Math.abs(pdi - mdi) /
    (pdi + mdi)
  ) * 100;
}


/* =========================================================
   ICHIMOKU
========================================================= */

function midHighLow(candles, period) {

  const a =
    candles.slice(-period);

  if (!a.length)
    return 0;

  const high =
    Math.max(
      ...a.map(x => x.high)
    );

  const low =
    Math.min(
      ...a.map(x => x.low)
    );

  return (high + low) / 2;
}

function ichimoku(candles) {

  const tenkan =
    midHighLow(candles, 9);

  const kijun =
    midHighLow(candles, 26);

  const spanA =
    (tenkan + kijun) / 2;

  const spanB =
    midHighLow(candles, 52);

  const price =
    candles.at(-1)?.close || 0;

  let direction = "NONE";

  if (
    price > spanA &&
    price > spanB &&
    tenkan > kijun
  )
    direction = "LONG";

  if (
    price < spanA &&
    price < spanB &&
    tenkan < kijun
  )
    direction = "SHORT";

  return {
    tenkan,
    kijun,
    spanA,
    spanB,
    direction
  };
}


/* =========================================================
   BOLLINGER
========================================================= */

function bollinger(candles, period = 20) {

  const values =
    candles.map(x => x.close);

  if (values.length < period)
    return {
      width: 0
    };

  const a =
    values.slice(-period);

  const m =
    avg(a);

  const variance =
    avg(
      a.map(
        x =>
          Math.pow(
            x - m,
            2
          )
      )
    );

  const sd =
    Math.sqrt(variance);

  return {
    middle: m,
    upper: m + sd * 2,
    lower: m - sd * 2,
    width:
      m
        ? ((sd * 4) / m) * 100
        : 0
  };
}


/* =========================================================
   VOLUME
========================================================= */

function volumeAnalysis(candles) {

  if (candles.length < 21) {
    return {
      current: 0,
      average: 0,
      ratio: 0,
      spike: false,
      state: "NORMAL"
    };
  }

  const current =
    candles.at(-1).volume;

  const average =
    avg(
      candles
        .slice(-21, -1)
        .map(x => x.volume)
    );

  const ratio =
    average
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


/* =========================================================
   BOS / CHOCH
========================================================= */

function structure(candles) {

  if (candles.length < 10) {
    return {
      bos: "NONE",
      choch: "NONE"
    };
  }

  const last =
    candles.at(-1);

  const prev =
    candles.slice(-8, -1);

  const high =
    Math.max(
      ...prev.map(x => x.high)
    );

  const low =
    Math.min(
      ...prev.map(x => x.low)
    );

  let bos = "NONE";
  let choch = "NONE";

  if (last.close > high)
    bos = "LONG";

  if (last.close < low)
    bos = "SHORT";

  const older =
    candles.slice(-14, -8);

  if (older.length) {

    const oh =
      Math.max(
        ...older.map(x => x.high)
      );

    const ol =
      Math.min(
        ...older.map(x => x.low)
      );

    if (
      last.close > high &&
      high < oh
    )
      choch = "LONG";

    if (
      last.close < low &&
      low > ol
    )
      choch = "SHORT";
  }

  return {
    bos,
    choch
  };
}


/* =========================================================
   FVG
========================================================= */

function fvg(candles) {

  if (candles.length < 3)
    return {
      type: "NONE",
      top: 0,
      bottom: 0,
      sizePct: 0
    };

  const a =
    candles.at(-3);

  const b =
    candles.at(-2);

  const c =
    candles.at(-1);

  if (c.low > a.high) {

    const bottom = a.high;
    const top = c.low;

    return {
      type: "BULLISH",
      top,
      bottom,
      sizePct:
        pct(top, bottom)
    };
  }

  if (c.high < a.low) {

    const bottom = c.high;
    const top = a.low;

    return {
      type: "BEARISH",
      top,
      bottom,
      sizePct:
        pct(top, bottom)
    };
  }

  return {
    type: "NONE",
    top: 0,
    bottom: 0,
    sizePct: 0
  };
}


/* =========================================================
   ORDER BLOCK
========================================================= */

function orderBlock(candles) {

  if (candles.length < 6)
    return {
      type: "NONE",
      price: 0,
      strength: 0
    };

  const last =
    candles.at(-1);

  const prev =
    candles.at(-2);

  const body =
    Math.abs(
      prev.close - prev.open
    );

  const range =
    prev.high - prev.low;

  if (
    last.close > prev.high &&
    prev.close < prev.open &&
    range > 0
  ) {

    return {
      type: "BULLISH",
      price: prev.open,
      strength:
        Math.min(
          100,
          (body / range) * 100
        )
    };
  }

  if (
    last.close < prev.low &&
    prev.close > prev.open &&
    range > 0
  ) {

    return {
      type: "BEARISH",
      price: prev.open,
      strength:
        Math.min(
          100,
          (body / range) * 100
        )
    };
  }

  return {
    type: "NONE",
    price: 0,
    strength: 0
  };
}


/* =========================================================
   LIQUIDITY HUNT
========================================================= */

function hunt(candles) {

  if (candles.length < 8)
    return {
      side: "NONE",
      confirmed: false,
      sweepPrice: 0,
      strength: 0
    };

  const last =
    candles.at(-1);

  const before =
    candles.slice(-7, -1);

  const high =
    Math.max(
      ...before.map(x => x.high)
    );

  const low =
    Math.min(
      ...before.map(x => x.low)
    );

  if (
    last.high > high &&
    last.close < high
  ) {

    return {
      side: "SHORT",
      confirmed: true,
      sweepPrice: last.high,
      strength:
        Math.min(
          100,
          pct(last.high, high) * 10
        )
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
      strength:
        Math.min(
          100,
          pct(low, last.low) * -10
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


/* =========================================================
   DIVERGENCE
========================================================= */

function divergence(candles) {

  if (candles.length < 30)
    return {
      type: "NONE",
      side: "NONE"
    };

  const p =
    candles.map(x => x.close);

  const rsiValues = [];

  for (
    let i = 20;
    i <= p.length;
    i++
  ) {
    rsiValues.push(
      rsi(
        p.slice(0, i),
        14
      )
    );
  }

  if (rsiValues.length < 10)
    return {
      type: "NONE",
      side: "NONE"
    };

  const oldPrice =
    p.at(-10);

  const newPrice =
    p.at(-1);

  const oldRsi =
    rsiValues.at(-10);

  const newRsi =
    rsiValues.at(-1);

  if (
    newPrice < oldPrice &&
    newRsi > oldRsi
  ) {

    return {
      type: "BULLISH_DIVERGENCE",
      side: "LONG"
    };
  }

  if (
    newPrice > oldPrice &&
    newRsi < oldRsi
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


/* =========================================================
   FOOTPRINT
========================================================= */

async function footprint(
  category,
  symbol
) {

  try {

    const r =
      await bybit(
        "/v5/market/recent-trade",
        {
          category,
          symbol,
          limit:
            category === "spot"
              ? 60
              : 500
        }
      );

    const trades =
      r.list || [];

    let buy = 0;
    let sell = 0;
    let buyNotional = 0;
    let sellNotional = 0;

    for (const t of trades) {

      const price =
        num(t.price);

      const size =
        num(t.size);

      const value =
        price * size;

      if (
        String(t.side)
          .toLowerCase() === "buy"
      ) {
        buy += size;
        buyNotional += value;
      } else {
        sell += size;
        sellNotional += value;
      }
    }

    const total =
      buyNotional +
      sellNotional;

    const delta =
      buyNotional -
      sellNotional;

    return {
      buyVolume: buy,
      sellVolume: sell,
      delta,
      deltaPercent:
        total
          ? (delta / total) * 100
          : 0,
      buyNotional,
      sellNotional,
      buyNotionalShare:
        total
          ? (buyNotional / total) * 100
          : 0,
      sellNotionalShare:
        total
          ? (sellNotional / total) * 100
          : 0,
      trades: trades.length,
      largeTradeNotional:
        trades.length
          ? Math.max(
              ...trades.map(
                t =>
                  num(t.price) *
                  num(t.size)
              )
            )
          : 0,
      pressure:
        delta > 0
          ? "BUY"
          : delta < 0
            ? "SELL"
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

async function orderBook(
  category,
  symbol
) {

  try {

    const r =
      await bybit(
        "/v5/market/orderbook",
        {
          category,
          symbol,
          limit: 50
        }
      );

    const bids =
      (r.b || [])
        .map(x => ({
          price: num(x[0]),
          size: num(x[1])
        }));

    const asks =
      (r.a || [])
        .map(x => ({
          price: num(x[0]),
          size: num(x[1])
        }));

    const buyLevels =
      bids
        .map(x => ({
          ...x,
          notional:
            x.price * x.size
        }))
        .sort(
          (a, b) =>
            b.notional -
            a.notional
        )
        .slice(0, 10);

    const sellLevels =
      asks
        .map(x => ({
          ...x,
          notional:
            x.price * x.size
        }))
        .sort(
          (a, b) =>
            b.notional -
            a.notional
        )
        .slice(0, 10);

    const price =
      num(r.ts)
      ? 0
      : (
        bids[0]?.price ||
        asks[0]?.price ||
        0
      );

    const bestBid =
      bids[0]?.price || 0;

    const bestAsk =
      asks[0]?.price || 0;

    const mid =
      bestBid && bestAsk
        ? (bestBid + bestAsk) / 2
        : price;

    for (const x of buyLevels) {
      x.distancePct =
        mid
          ? Math.abs(
              pct(x.price, mid)
            )
          : 0;
    }

    for (const x of sellLevels) {
      x.distancePct =
        mid
          ? Math.abs(
              pct(x.price, mid)
            )
          : 0;
    }

    const buyLiquidity =
      buyLevels.reduce(
        (a, b) =>
          a + b.notional,
        0
      );

    const sellLiquidity =
      sellLevels.reduce(
        (a, b) =>
          a + b.notional,
        0
      );

    const total =
      buyLiquidity +
      sellLiquidity;

    const buy =
      buyLevels[0] || {
        price: 0,
        size: 0,
        notional: 0,
        distancePct: 0
      };

    const sell =
      sellLevels[0] || {
        price: 0,
        size: 0,
        notional: 0,
        distancePct: 0
      };

    return {
      buy,
      sell,
      buyLevels,
      sellLevels,
      buyLiquidity,
      sellLiquidity,
      totalLiquidity: total,
      buyShare:
        total
          ? buyLiquidity / total * 100
          : 0,
      sellShare:
        total
          ? sellLiquidity / total * 100
          : 0,
      buyStrength:
        total
          ? buyLiquidity / total * 100
          : 0,
      sellStrength:
        total
          ? sellLiquidity / total * 100
          : 0,
      buyNear:
        buy.distancePct < 1,
      sellNear:
        sell.distancePct < 1
    };

  } catch (e) {

    return {
      error: e.message
    };
  }
}


/* =========================================================
   SUPPORT / RESISTANCE
========================================================= */

function supportResistance(candles) {

  const lows =
    candles
      .slice(-80)
      .map(x => x.low)
      .sort((a, b) => a - b);

  const highs =
    candles
      .slice(-80)
      .map(x => x.high)
      .sort((a, b) => a - b);

  const price =
    candles.at(-1)?.close || 0;

  const supports =
    lows
      .filter(x => x < price)
      .sort(
        (a, b) =>
          Math.abs(a - price) -
          Math.abs(b - price)
      );

  const resistances =
    highs
      .filter(x => x > price)
      .sort(
        (a, b) =>
          Math.abs(a - price) -
          Math.abs(b - price)
      );

  return {
    nearestSupport:
      supports.length
        ? {
            price: supports[0]
          }
        : null,

    nearestResistance:
      resistances.length
        ? {
            price: resistances[0]
          }
        : null,

    strongestSupport:
      supports.length
        ? {
            price:
              supports[
                Math.floor(
                  supports.length / 2
                )
              ]
          }
        : null,

    strongestResistance:
      resistances.length
        ? {
            price:
              resistances[
                Math.floor(
                  resistances.length / 2
                )
              ]
          }
        : null
  };
}


/* =========================================================
   15m CONFIRMATION
========================================================= */

function confirm15(tf) {

  let score = 0;
  const reasons = [];

  if (tf.trend === "BULLISH") {
    score += 15;
    reasons.push(
      "روند 15m صعودی"
    );
  }

  if (tf.trend === "BEARISH") {
    score -= 15;
    reasons.push(
      "روند 15m نزولی"
    );
  }

  if (tf.maSlope > 0) {
    score += 8;
    reasons.push(
      "شیب MA20 در 15m صعودی"
    );
  }

  if (tf.maSlope < 0) {
    score -= 8;
    reasons.push(
      "شیب MA20 در 15m نزولی"
    );
  }

  if (tf.macd.direction === "LONG") {
    score += 7;
    reasons.push(
      "MACD در 15m صعودی"
    );
  }

  if (tf.macd.direction === "SHORT") {
    score -= 7;
    reasons.push(
      "MACD در 15m نزولی"
    );
  }

  if (tf.ichimoku.direction === "LONG")
    score += 5;

  if (tf.ichimoku.direction === "SHORT")
    score -= 5;

  return {
    score,
    reasons
  };
}


/* =========================================================
   MA20 SIGNAL ENGINE
========================================================= */

function signal1m(tf1, tf15, strictness) {

  const price =
    tf1.price;

  const ma20 =
    tf1.ma20;

  if (!price || !ma20) {
    return {
      direction: "WAIT",
      score: 0,
      longScore: 0,
      shortScore: 0,
      reasons: [
        {
          side: "WAIT",
          text: "MA20 کافی نیست."
        }
      ]
    };
  }

  const distance =
    Math.abs(
      pct(price, ma20)
    );

  /*
    هرچه سخت‌گیری بیشتر شود،
    فاصله مجاز از MA20 کمتر می‌شود.
  */

  const maxDistance =
    {
      1: 1.20,
      2: 0.90,
      3: 0.65,
      4: 0.45,
      5: 0.30,
      6: 0.20
    }[strictness];

  let long = 0;
  let short = 0;

  const reasons = [];

  /*
    برخورد قیمت با MA20
  */

  if (tf1.touchMA20) {

    long += 25;
    short += 25;

    reasons.push({
      side: "BOTH",
      text:
        "برخورد قیمت با MA20 در 1m"
    });
  } else {

    if (distance <= maxDistance) {

      long += 10;
      short += 10;

      reasons.push({
        side: "BOTH",
        text:
          `فاصله قیمت تا MA20 برابر ${distance.toFixed(3)}٪ است`
      });

    } else {

      reasons.push({
        side: "WAIT",
        text:
          `فاصله قیمت تا MA20 زیاد است: ${distance.toFixed(3)}٪`
      });
    }
  }

  /*
    شیب MA20
  */

  if (tf1.maSlope > 0) {

    long += 20;

    reasons.push({
      side: "LONG",
      text:
        "شیب MA20 در 1m صعودی است"
    });

  } else if (tf1.maSlope < 0) {

    short += 20;

    reasons.push({
      side: "SHORT",
      text:
        "شیب MA20 در 1m نزولی است"
    });
  }

  /*
    جایگاه قیمت نسبت MA20
  */

  if (price > ma20) {

    long += 12;

    reasons.push({
      side: "LONG",
      text:
        "قیمت بالای MA20 قرار دارد"
    });

  } else if (price < ma20) {

    short += 12;

    reasons.push({
      side: "SHORT",
      text:
        "قیمت زیر MA20 قرار دارد"
    });
  }

  /*
    حجم
  */

  if (tf1.volume.spike) {

    if (tf1.candle.direction === "LONG")
      long += 10;

    if (tf1.candle.direction === "SHORT")
      short += 10;

    reasons.push({
      side:
        tf1.candle.direction,
      text:
        "افزایش غیرعادی حجم 1m"
    });
  }

  /*
    MACD
  */

  if (
    tf1.macd.direction === "LONG"
  ) {

    long += 8;

    reasons.push({
      side: "LONG",
      text:
        "MACD در 1m صعودی است"
    });
  }

  if (
    tf1.macd.direction === "SHORT"
  ) {

    short += 8;

    reasons.push({
      side: "SHORT",
      text:
        "MACD در 1m نزولی است"
    });
  }

  /*
    RSI
  */

  if (tf1.rsi >= 52) {
    long += 5;
  }

  if (tf1.rsi <= 48) {
    short += 5;
  }

  /*
    Hunt
  */

  if (
    tf1.hunt.confirmed &&
    tf1.hunt.side === "LONG"
  ) {

    long += 8;

    reasons.push({
      side: "LONG",
      text:
        "Liquidity Hunt صعودی تأیید شده"
    });
  }

  if (
    tf1.hunt.confirmed &&
    tf1.hunt.side === "SHORT"
  ) {

    short += 8;

    reasons.push({
      side: "SHORT",
      text:
        "Liquidity Hunt نزولی تأیید شده"
    });
  }

  /*
    FVG
  */

  if (tf1.fvg.type === "BULLISH")
    long += 4;

  if (tf1.fvg.type === "BEARISH")
    short += 4;

  /*
    BOS
  */

  if (tf1.bos === "LONG")
    long += 6;

  if (tf1.bos === "SHORT")
    short += 6;

  /*
    CHOCH
  */

  if (tf1.choch === "LONG")
    long += 6;

  if (tf1.choch === "SHORT")
    short += 6;

  /*
    15m confirmation
  */

  const c =
    confirm15(tf15);

  if (c.score > 0)
    long += c.score;

  if (c.score < 0)
    short += Math.abs(c.score);

  c.reasons.forEach(x => {

    reasons.push({
      side:
        x.includes("نزولی")
          ? "SHORT"
          : "LONG",
      text:
        `${x} — تأیید 15m`
    });

  });

  const max =
    Math.max(
      long,
      short
    );

  const direction =
    long > short
      ? "LONG"
      : short > long
        ? "SHORT"
        : "WAIT";

  /*
    سخت‌گیری واقعی:
    سطح بالاتر آستانه بیشتری می‌خواهد.
  */

  const threshold =
    {
      1: 40,
      2: 48,
      3: 56,
      4: 64,
      5: 72,
      6: 80
    }[strictness];

  const finalDirection =
    max >= threshold
      ? direction
      : "WAIT";

  return {
    direction:
      finalDirection,
    rawDirection:
      direction,
    score:
      Math.min(100, max),
    longScore:
      Math.min(100, long),
    shortScore:
      Math.min(100, short),
    threshold,
    distanceToMA20:
      distance,
    reasons
  };
}


/* =========================================================
   TIMEFRAME ANALYSIS
========================================================= */

function analyzeTF(candles) {

  const prices =
    candles.map(x => x.close);

  const price =
    prices.at(-1);

  const ma7 =
    sma(prices, 7);

  const ma20 =
    sma(prices, 20);

  const slope =
    maSlope(prices, 20);

  const last =
    candles.at(-1);

  const previous =
    candles.at(-2);

  const touchMA20 =
    last &&
    (
      (
        last.low <= ma20 &&
        last.high >= ma20
      ) ||
      Math.abs(
        pct(price, ma20)
      ) <= 0.15
    );

  let trend =
    "RANGE";

  if (
    price > ma20 &&
    slope > 0
  )
    trend = "BULLISH";

  if (
    price < ma20 &&
    slope < 0
  )
    trend = "BEARISH";

  const candleDirection =
    last.close > last.open
      ? "LONG"
      : last.close < last.open
        ? "SHORT"
        : "NONE";

  const candleRange =
    last.high - last.low;

  const candleBody =
    Math.abs(
      last.close -
      last.open
    );

  const candleStrength =
    candleRange
      ? candleBody /
        candleRange *
        100
      : 0;

  const m =
    macd(prices);

  const i =
    ichimoku(candles);

  const v =
    volumeAnalysis(candles);

  const s =
    structure(candles);

  const h =
    hunt(candles);

  const fv =
    fvg(candles);

  const ob =
    orderBlock(candles);

  const dv =
    divergence(candles);

  const at =
    atr(candles);

  const ad =
    adx(candles);

  const bb =
    bollinger(candles);

  return {
    price,
    ma7,
    ma20,
    trend,
    maSlope: slope,
    touchMA20,
    distanceMA20:
      Math.abs(
        pct(price, ma20)
      ),
    volume: v,
    hunt: h,
    bos: s.bos,
    choch: s.choch,
    candle: {
      type:
        candleStrength > 65
          ? "STRONG"
          : "NORMAL",
      direction:
        candleDirection,
      strength:
        candleStrength
    },
    fvg: fv,
    orderBlock: ob,
    support: 0,
    resistance: 0,
    rsi:
      rsi(prices),
    macd: m,
    ichimoku: i,
    divergence: dv,
    atr: at,
    atrPct:
      price
        ? (at / price) * 100
        : 0,
    adx: ad,
    bollingerWidth:
      bb.width
  };
}


/* =========================================================
   CONVERTED MA
========================================================= */

function convertedMA(
  price1m,
  tf3,
  tf5,
  tf15
) {

  const events = [];

  const sources = [
    {
      source: "3m",
      data: tf3
    },
    {
      source: "5m",
      data: tf5
    },
    {
      source: "15m",
      data: tf15
    }
  ];

  for (const s of sources) {

    for (const period of [7, 20]) {

      const value =
        period === 7
          ? s.data.ma7
          : s.data.ma20;

      if (!value)
        continue;

      const distance =
        Math.abs(
          pct(
            price1m,
            value
          )
        );

      if (distance <= 1.5) {

        let confirmation =
          "NONE";

        if (
          price1m > value &&
          s.data.maSlope > 0
        )
          confirmation =
            "CONFIRMED_LONG";

        if (
          price1m < value &&
          s.data.maSlope < 0
        )
          confirmation =
            "CONFIRMED_SHORT";

        events.push({
          type: "TOUCH",
          source: s.source,
          period1m: period,
          ma:
            `MA${period}`,
          value,
          distancePct:
            distance,
          slope:
            s.data.maSlope > 0
              ? "UP"
              : s.data.maSlope < 0
                ? "DOWN"
                : "FLAT",
          confirmation
        });
      }
    }
  }

  return {
    events
  };
}


/* =========================================================
   DEEP ANALYSIS
========================================================= */

async function analyzeSymbol(
  symbol,
  category,
  strictness = 3
) {

  const [
    c1,
    c3,
    c5,
    c15,
    c60
  ] = await Promise.all([
    getKlines(
      category,
      symbol,
      "1",
      200
    ),
    getKlines(
      category,
      symbol,
      "3",
      200
    ),
    getKlines(
      category,
      symbol,
      "5",
      200
    ),
    getKlines(
      category,
      symbol,
      "15",
      200
    ),
    getKlines(
      category,
      symbol,
      "60",
      200
    )
  ]);

  if (
    c1.length < CONFIG.minCandles ||
    c15.length < CONFIG.minCandles
  ) {
    throw new Error(
      "داده کافی برای تحلیل وجود ندارد."
    );
  }

  const t1 =
    analyzeTF(c1);

  const t3 =
    analyzeTF(c3);

  const t5 =
    analyzeTF(c5);

  const t15 =
    analyzeTF(c15);

  const t60 =
    analyzeTF(c60);

  const signal =
    signal1m(
      t1,
      t15,
      strictness
    );

  const fp =
    await footprint(
      category,
      symbol
    );

  const walls =
    await orderBook(
      category,
      symbol
    );

  const sr =
    supportResistance(c1);

  t1.support =
    sr.nearestSupport?.price || 0;

  t1.resistance =
    sr.nearestResistance?.price || 0;

  t15.support =
    supportResistance(c15)
      .nearestSupport?.price || 0;

  t15.resistance =
    supportResistance(c15)
      .nearestResistance?.price || 0;

  /*
    Footprint تأیید نهایی
  */

  if (
    fp &&
    !fp.error
  ) {

    if (
      fp.delta > 0 &&
      signal.direction === "LONG"
    ) {
      signal.score =
        Math.min(
          100,
          signal.score + 5
        );

      signal.reasons.push({
        side: "LONG",
        text:
          "Delta فوت‌پرینت مثبت است"
      });
    }

    if (
      fp.delta < 0 &&
      signal.direction === "SHORT"
    ) {
      signal.score =
        Math.min(
          100,
          signal.score + 5
        );

      signal.reasons.push({
        side: "SHORT",
        text:
          "Delta فوت‌پرینت منفی است"
      });
    }
  }

  /*
    Walls
  */

  if (
    walls &&
    !walls.error
  ) {

    if (
      walls.buyShare >
      walls.sellShare + 10
    ) {

      signal.reasons.push({
        side: "LONG",
        text:
          "نقدینگی سمت خرید بیشتر است"
      });
    }

    if (
      walls.sellShare >
      walls.buyShare + 10
    ) {

      signal.reasons.push({
        side: "SHORT",
        text:
          "نقدینگی سمت فروش بیشتر است"
      });
    }
  }

  const converted =
    convertedMA(
      t1.price,
      t3,
      t5,
      t15
    );

  /*
    اطلاعات قیمت
  */

  const price =
    t1.price;

  /*
    pump / dump فقط به‌عنوان
    اطلاعات جانبی، نه مبنای اصلی
  */

  const pumpScore =
    Math.round(
      Math.max(
        0,
        Math.min(
          100,
          (
            t1.volume.ratio * 25 +
            Math.max(
              0,
              pct(
                price,
                t15.ma20
              )
            ) * 10
          )
        )
      )
    );

  const dumpScore =
    Math.round(
      Math.max(
        0,
        Math.min(
          100,
          (
            t1.volume.ratio * 20 +
            Math.max(
              0,
              pct(
                t15.ma20,
                price
              )
            ) * 10
          )
        )
      )
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

    signal: {
      direction:
        signal.direction,

      rawDirection:
        signal.rawDirection,

      score:
        signal.score,

      threshold:
        signal.threshold,

      strictness,

      basedOn:
        "MA20 1m",

      distanceToMA20:
        signal.distanceToMA20
    },

    pumpScore,

    dumpScore,

    timeframes: {

      "1": t1,
      "3": t3,
      "5": t5,
      "15": t15,
      "60": t60

    },

    deepByTimeframe: {

      "1": {
        label: "1 دقیقه",
        analysis: t1,
        indicators: {
          MACD: t1.macd,
          RSI: {
            value: t1.rsi,
            direction:
              t1.rsi >= 52
                ? "LONG"
                : t1.rsi <= 48
                  ? "SHORT"
                  : "NONE"
          },
          ICHIMOKU:
            t1.ichimoku,
          DIVERGENCE:
            t1.divergence
        },
        footprint: fp,
        orderBook: walls,
        supportResistance:
          sr
      },

      "15": {
        label: "15 دقیقه",
        analysis: t15,
        indicators: {
          MACD: t15.macd,
          RSI: {
            value: t15.rsi,
            direction:
              t15.rsi >= 52
                ? "LONG"
                : t15.rsi <= 48
                  ? "SHORT"
                  : "NONE"
          },
          ICHIMOKU:
            t15.ichimoku,
          DIVERGENCE:
            t15.divergence
        },
        footprint: fp,
        orderBook: walls,
        supportResistance:
          supportResistance(c15)
      }
    },

    convertedMA1m:
      converted,

    footprint: fp,

    walls,

    market: {
      category,
      available:
        category === "linear"
    },

    supportResistance:
      sr,

    reasons:
      signal.reasons,

    liquidation: {
      available: false,
      message:
        "داده تجمیعی لیکوئیدیشن از REST عمومی این اسکنر دریافت نمی‌شود."
    },

    generatedAt:
      Date.now(),

    search: {
      input: symbol,
      selected:
        category === "linear"
          ? "FUTURES"
          : "SPOT"
    }
  };
}


/* =========================================================
   SCAN MARKET
========================================================= */

async function getLinearSymbols() {

  const all = [];

  let cursor = "";

  for (let page = 0; page < 3; page++) {

    const r =
      await bybit(
        "/v5/market/instruments-info",
        {
          category: "linear",
          status: "Trading",
          limit: 1000,
          cursor
        }
      );

    all.push(
      ...(r.list || [])
    );

    cursor =
      r.nextPageCursor || "";

    if (!cursor)
      break;
  }

  return all.filter(
    x =>
      x.status === "Trading" &&
      x.quoteCoin === "USDT" &&
      x.contractType ===
        "LinearPerpetual"
  );
}


async function getTickers() {

  try {

    const r =
      await bybit(
        "/v5/market/tickers",
        {
          category: "linear"
        }
      );

    return r.list || [];

  } catch (_) {

    return [];
  }
}


async function scanMarket(
  strictness,
  offset
) {

  /*
    اسکن شخصی روی Futures انجام می‌شود،
    چون MA20 و سیگنال‌گیری سریع برای
    بازار دائمی مناسب‌تر است.
  */

  const [
    symbols,
    tickers
  ] =
    await Promise.all([
      getLinearSymbols(),
      getTickers()
    ]);

  const tickerMap =
    new Map(
      tickers.map(
        x => [
          x.symbol,
          x
        ]
      )
    );

  /*
    حجم 24h فقط برای مرتب‌سازی
    اولیه است؛ معیار اصلی سیگنال نیست.
  */

  const candidates =
    symbols
      .map(x => {

        const t =
          tickerMap.get(
            x.symbol
          );

        return {
          ...x,
          turnover24h:
            num(
              t?.turnover24h
            )
        };
      })
      .sort(
        (a, b) =>
          b.turnover24h -
          a.turnover24h
      );

  const totalMarkets =
    candidates.length;

  const start =
    offset %
    Math.max(
      1,
      candidates.length
    );

  const selected = [];

  for (
    let i = 0;
    i < CONFIG.scanCandidates;
    i++
  ) {

    const idx =
      (start + i) %
      candidates.length;

    selected.push(
      candidates[idx]
    );
  }

  const results = [];

  /*
    برای جلوگیری از فشار زیاد،
    تحلیل‌ها به صورت گروهی انجام می‌شوند.
  */

  for (
    let i = 0;
    i < selected.length;
    i += 5
  ) {

    const batch =
      selected.slice(
        i,
        i + 5
      );

    const analyzed =
      await Promise.all(
        batch.map(
          async x => {

            try {

              const d =
                await analyzeSymbol(
                  x.symbol,
                  "linear",
                  strictness
                );

              if (
                d.direction ===
                  "LONG" ||
                d.direction ===
                  "SHORT"
              ) {

                return {
                  symbol:
                    d.symbol,

                  category:
                    d.category,

                  direction:
                    d.direction,

                  score:
                    d.score,

                  longScore:
                    d.longScore,

                  shortScore:
                    d.shortScore,

                  strictness,

                  price:
                    d.price,

                  signal:
                    d.signal,

                  reasons:
                    d.reasons,

                  deepByTimeframe:
                    d.deepByTimeframe,

                  convertedMA1m:
                    d.convertedMA1m,

                  footprint:
                    d.footprint,

                  walls:
                    d.walls,

                  supportResistance:
                    d.supportResistance,

                  generatedAt:
                    d.generatedAt
                };
              }

              return null;

            } catch (_) {

              return null;
            }
          }
        )
      );

    for (const x of analyzed) {
      if (x)
        results.push(x);
    }
  }

  results.sort(
    (a, b) =>
      b.score -
      a.score
  );

  return {
    ok: true,

    mode: "personal",

    strictness,

    batchSize:
      results.length,

    scannedCandidates:
      selected.length,

    totalMarkets,

    nextOffset:
      (
        start +
        CONFIG.scanCandidates
      ) %
      Math.max(
        1,
        candidates.length
      ),

    minimumSignalScore:
      {
        1: 40,
        2: 48,
        3: 56,
        4: 64,
        5: 72,
        6: 80
      }[strictness],

    signalBase:
      "MA20 1m",

    confirmation:
      "15m",

    results
  };
}
