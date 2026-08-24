const BYBIT = "https://api.bybit.com";

const PERSONAL_VERSION = "PERSONAL-MA20-LIVE-V2";

const SCAN_BATCH = 20;

const KLINE_LIMIT_1M = 150;
const KLINE_LIMIT_15M = 150;

const TRADE_LIMIT = 1000;
const ORDERBOOK_LIMIT = 50;

const DEFAULT_STRICTNESS = 50;

const sleep = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*"
    }
  });
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function clamp(v, min = 0, max = 100) {
  return Math.max(min, Math.min(max, num(v)));
}

function pct(a, b) {
  return b ? ((a - b) / b) * 100 : 0;
}

function average(values) {
  const a = values.filter(Number.isFinite);
  if (!a.length) return 0;
  return a.reduce((x, y) => x + y, 0) / a.length;
}

function sma(values, period) {
  if (!values || values.length < period) return 0;
  return average(values.slice(-period));
}

function ema(values, period) {
  if (!values || values.length < period) return 0;

  let e = average(values.slice(0, period));
  const k = 2 / (period + 1);

  for (let i = period; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
  }

  return e;
}

function stddev(values) {
  if (!values.length) return 0;

  const m = average(values);

  return Math.sqrt(
    average(
      values.map(x =>
        Math.pow(num(x) - m, 2)
      )
    )
  );
}

/* =========================
   RSI — Wilder
========================= */

function rsi(values, period = 14) {
  if (!values || values.length < period + 1)
    return null;

  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];

    if (d >= 0) gain += d;
    else loss -= d;
  }

  let avgGain = gain / period;
  let avgLoss = loss / period;

  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];

    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;

    avgGain =
      (avgGain * (period - 1) + g) / period;

    avgLoss =
      (avgLoss * (period - 1) + l) / period;
  }

  if (avgLoss === 0)
    return 100;

  const rs = avgGain / avgLoss;

  return 100 - 100 / (1 + rs);
}

/* =========================
   MACD
========================= */

function macd(values, fast = 12, slow = 26, signalPeriod = 9) {
  if (!values || values.length < slow + signalPeriod)
    return {
      available: false,
      reason: "کندل کافی برای MACD وجود ندارد."
    };

  const fastSeries = [];
  const slowSeries = [];

  for (let i = slow - 1; i < values.length; i++) {
    fastSeries.push(
      ema(values.slice(0, i + 1), fast)
    );

    slowSeries.push(
      ema(values.slice(0, i + 1), slow)
    );
  }

  const macdSeries =
    fastSeries.map(
      (x, i) =>
        x - slowSeries[i]
    );

  const signal =
    ema(
      macdSeries,
      signalPeriod
    );

  const previousMacd =
    macdSeries[macdSeries.length - 2];

  const currentMacd =
    macdSeries[macdSeries.length - 1];

  const histogram =
    currentMacd - signal;

  const previousHistogram =
    previousMacd -
    ema(
      macdSeries.slice(0, -1),
      signalPeriod
    );

  return {
    available: true,
    macd: currentMacd,
    signal,
    histogram,
    previousMacd,
    previousHistogram,
    direction:
      histogram > 0
        ? "LONG"
        : histogram < 0
          ? "SHORT"
          : "NONE",
    crossover:
      previousMacd <=
        (signal - histogram + previousHistogram) &&
      currentMacd > signal
        ? "BULLISH_CROSS"
        : previousMacd >=
            (signal - histogram + previousHistogram) &&
          currentMacd < signal
          ? "BEARISH_CROSS"
          : "NONE"
  };
}

/* =========================
   ATR
========================= */

function atr(candles, period = 14) {
  if (!candles || candles.length < period + 1)
    return null;

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

  return average(
    trs.slice(-period)
  );
}

/* =========================
   KLINE
========================= */

function parseKlines(list) {
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
    .filter(x => x.close > 0)
    .sort(
      (a, b) =>
        a.time - b.time
    );
}

/* =========================
   BYBIT REQUEST
========================= */

async function bybit(path) {
  const r = await fetch(
    BYBIT + path,
    {
      headers: {
        accept: "application/json"
      }
    }
  );

  if (!r.ok)
    throw new Error(
      `Bybit HTTP ${r.status}`
    );

  const d = await r.json();

  if (d.retCode !== 0)
    throw new Error(
      d.retMsg ||
      "Bybit API error"
    );

  return d.result || {};
}

/* =========================
   INSTRUMENTS
========================= */

async function getInstruments(category) {

  const all = [];
  let cursor = "";

  for (let page = 0; page < 5; page++) {

    let url =
      `/v5/market/instruments-info?category=${category}&limit=1000`;

    if (cursor)
      url +=
        `&cursor=${encodeURIComponent(cursor)}`;

    const d =
      await bybit(url);

    all.push(
      ...(d.list || [])
    );

    cursor =
      d.nextPageCursor || "";

    if (!cursor)
      break;
  }

  return all;
}

function validSymbol(x) {

  if (!x) return false;

  if (x.status !== "Trading")
    return false;

  if (x.quoteCoin !== "USDT")
    return false;

  if (
    x.symbol.includes("USDC") ||
    x.symbol.includes("USDE")
  )
    return false;

  return true;
}

async function getSymbols() {

  const [
    spot,
    futures
  ] = await Promise.all([
    getInstruments("spot"),
    getInstruments("linear")
  ]);

  const map = new Map();

  for (const x of futures) {

    if (!validSymbol(x))
      continue;

    map.set(
      x.symbol,
      {
        symbol: x.symbol,
        category: "linear",
        baseCoin: x.baseCoin,
        quoteCoin: x.quoteCoin
      }
    );
  }

  for (const x of spot) {

    if (!validSymbol(x))
      continue;

    if (!map.has(x.symbol)) {

      map.set(
        x.symbol,
        {
          symbol: x.symbol,
          category: "spot",
          baseCoin: x.baseCoin,
          quoteCoin: x.quoteCoin
        }
      );
    }
  }

  return [...map.values()];
}

/* =========================
   TICKER
========================= */

async function getTicker(category, symbol) {

  const d =
    await bybit(
      `/v5/market/tickers?category=${category}&symbol=${encodeURIComponent(symbol)}`
    );

  return d.list?.[0] || null;
}

/* =========================
   KLINES
========================= */

async function getKlines(
  category,
  symbol,
  interval,
  limit
) {

  const d =
    await bybit(
      `/v5/market/kline?category=${category}&symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`
    );

  return parseKlines(
    d.list
  );
}

/* =========================
   RECENT TRADES
   REAL FOOTPRINT SOURCE
========================= */

async function getRecentTrades(
  category,
  symbol
) {

  const d =
    await bybit(
      `/v5/market/recent-trade?category=${category}&symbol=${encodeURIComponent(symbol)}&limit=${TRADE_LIMIT}`
    );

  return (d.list || []).map(t => ({
    execId: t.execId || "",
    price: num(t.price),
    size: num(t.size),
    side: String(t.side || "").toUpperCase(),
    time: num(t.time),
    isBlockTrade:
      Boolean(t.isBlockTrade)
  }));
}

/* =========================
   ORDER BOOK
========================= */

async function getOrderbook(
  category,
  symbol
) {

  return bybit(
    `/v5/market/orderbook?category=${category}&symbol=${encodeURIComponent(symbol)}&limit=${ORDERBOOK_LIMIT}`
  );
}

/* =========================
   OI
========================= */

async function getOIHistory(
  symbol
) {

  return bybit(
    `/v5/market/open-interest?category=linear&symbol=${encodeURIComponent(symbol)}&intervalTime=5min&limit=50`
  );
}

/* =========================
   FUNDING HISTORY
========================= */

async function getFundingHistory(
  symbol
) {

  return bybit(
    `/v5/market/funding/history?category=linear&symbol=${encodeURIComponent(symbol)}&limit=50`
  );
}

/* =========================
   LONG SHORT RATIO
========================= */

async function getLongShort(
  symbol
) {

  return bybit(
    `/v5/market/account-ratio?category=linear&symbol=${encodeURIComponent(symbol)}&period=5min&limit=50`
  );
}

/* =========================
   FOOTPRINT
========================= */

function analyzeFootprint(trades) {

  if (!trades || !trades.length) {

    return {
      available: false,
      reason:
        "معاملات اخیر Bybit دریافت نشد."
    };
  }

  let buyVolume = 0;
  let sellVolume = 0;

  let buyNotional = 0;
  let sellNotional = 0;

  let buyTrades = 0;
  let sellTrades = 0;

  let largeBuyVolume = 0;
  let largeSellVolume = 0;

  const notionals =
    trades.map(
      t =>
        t.price *
        t.size
    );

  const largeThreshold =
    notionals.length
      ? Math.max(
          average(notionals) * 5,
          notionals.sort((a,b) => a-b)[
            Math.floor(
              notionals.length * 0.95
            )
          ] || 0
        )
      : 0;

  for (const t of trades) {

    const n =
      t.price *
      t.size;

    if (t.side === "BUY") {

      buyVolume += t.size;
      buyNotional += n;
      buyTrades++;

      if (n >= largeThreshold)
        largeBuyVolume += t.size;

    }
    else if (
      t.side === "SELL"
    ) {

      sellVolume += t.size;
      sellNotional += n;
      sellTrades++;

      if (n >= largeThreshold)
        largeSellVolume += t.size;
    }
  }

  const total =
    buyVolume +
    sellVolume;

  const delta =
    buyVolume -
    sellVolume;

  const deltaPct =
    total
      ? (delta / total) * 100
      : 0;

  let pressure = "NEUTRAL";

  if (deltaPct >= 10)
    pressure = "BUY_PRESSURE";

  else if (deltaPct <= -10)
    pressure = "SELL_PRESSURE";

  return {

    available: true,

    trades:
      trades.length,

    buyVolume,

    sellVolume,

    totalVolume:
      total,

    delta,

    deltaPercent:
      deltaPct,

    buyNotional,

    sellNotional,

    buyNotionalShare:
      (
        buyNotional /
        Math.max(
          1,
          buyNotional +
          sellNotional
        )
      ) * 100,

    sellNotionalShare:
      (
        sellNotional /
        Math.max(
          1,
          buyNotional +
          sellNotional
        )
      ) * 100,

    buyTrades,

    sellTrades,

    largeTradeThreshold:
      largeThreshold,

    largeBuyVolume,

    largeSellVolume,

    pressure
  };
}

/* =========================
   ORDER BOOK / WALLS
========================= */

function analyzeOrderbook(
  book,
  currentPrice
) {

  if (
    !book ||
    (!book.b?.length &&
      !book.a?.length)
  ) {

    return {
      available: false,
      reason:
        "Order Book دریافت نشد."
    };
  }

  const bids =
    (book.b || [])
      .map(x => ({
        price: num(x[0]),
        size: num(x[1]),
        notional:
          num(x[0]) *
          num(x[1]),
        distancePct:
          currentPrice
            ? Math.abs(
                (
                  num(x[0]) -
                  currentPrice
                ) /
                currentPrice
              ) * 100
            : 0
      }));

  const asks =
    (book.a || [])
      .map(x => ({
        price: num(x[0]),
        size: num(x[1]),
        notional:
          num(x[0]) *
          num(x[1]),
        distancePct:
          currentPrice
            ? Math.abs(
                (
                  num(x[0]) -
                  currentPrice
                ) /
                currentPrice
              ) * 100
            : 0
      }));

  const buyLiquidity =
    bids.reduce(
      (s, x) =>
        s + x.notional,
      0
    );

  const sellLiquidity =
    asks.reduce(
      (s, x) =>
        s + x.notional,
      0
    );

  const allNotional = [
    ...bids,
    ...asks
  ]
    .map(x => x.notional)
    .sort((a,b) => a-b);

  const median =
    allNotional.length
      ? allNotional[
          Math.floor(
            allNotional.length / 2
          )
        ]
      : 0;

  const wallThreshold =
    median * 5;

  const buyWalls =
    bids
      .filter(
        x =>
          wallThreshold > 0 &&
          x.notional >=
            wallThreshold
      )
      .sort(
        (a,b) =>
          b.notional -
          a.notional
      );

  const sellWalls =
    asks
      .filter(
        x =>
          wallThreshold > 0 &&
          x.notional >=
            wallThreshold
      )
      .sort(
        (a,b) =>
          b.notional -
          a.notional
      );

  return {

    available: true,

    buyLiquidity,

    sellLiquidity,

    totalLiquidity:
      buyLiquidity +
      sellLiquidity,

    buyShare:
      (
        buyLiquidity /
        Math.max(
          1,
          buyLiquidity +
          sellLiquidity
        )
      ) * 100,

    sellShare:
      (
        sellLiquidity /
        Math.max(
          1,
          buyLiquidity +
          sellLiquidity
        )
      ) * 100,

    bestBid:
      bids[0] || null,

    bestAsk:
      asks[0] || null,

    wallThreshold,

    buyWalls:
      buyWalls.slice(0, 15),

    sellWalls:
      sellWalls.slice(0, 15),

    buyLevels:
      bids.slice(0, 25),

    sellLevels:
      asks.slice(0, 25)
  };
}

/* =========================
   PIVOTS
========================= */

function pivotHigh(candles, i, left = 2, right = 2) {

  const h =
    candles[i].high;

  for (
    let j = 1;
    j <= left;
    j++
  ) {
    if (
      i - j < 0 ||
      candles[i-j].high >= h
    )
      return false;
  }

  for (
    let j = 1;
    j <= right;
    j++
  ) {
    if (
      i + j >= candles.length ||
      candles[i+j].high > h
    )
      return false;
  }

  return true;
}

function pivotLow(candles, i, left = 2, right = 2) {

  const l =
    candles[i].low;

  for (
    let j = 1;
    j <= left;
    j++
  ) {
    if (
      i - j < 0 ||
      candles[i-j].low <= l
    )
      return false;
  }

  for (
    let j = 1;
    j <= right;
    j++
  ) {
    if (
      i + j >= candles.length ||
      candles[i+j].low < l
    )
      return false;
  }

  return true;
}

/* =========================
   SUPPORT / RESISTANCE
========================= */

function supportResistance(candles, price) {

  if (!candles || candles.length < 10)
    return {
      available: false
    };

  const highs = [];
  const lows = [];

  for (
    let i = 2;
    i < candles.length - 2;
    i++
  ) {

    if (
      pivotHigh(
        candles,
        i
      )
    ) {

      highs.push({
        price:
          candles[i].high,
        time:
          candles[i].time
      });
    }

    if (
      pivotLow(
        candles,
        i
      )
    ) {

      lows.push({
        price:
          candles[i].low,
        time:
          candles[i].time
      });
    }
  }

  const resistance =
    highs
      .filter(
        x =>
          x.price >
          price
      )
      .sort(
        (a,b) =>
          a.price -
          b.price
      )
      .slice(0, 10);

  const support =
    lows
      .filter(
        x =>
          x.price <
          price
      )
      .sort(
        (a,b) =>
          b.price -
          a.price
      )
      .slice(0, 10);

  return {

    available: true,

    support,

    resistance
  };
}

/* =========================
   LIQUIDITY HUNT / SWEEP
========================= */

function detectLiquiditySweep(
  candles
) {

  if (!candles || candles.length < 8)
    return {
      available: false
    };

  const current =
    candles[candles.length - 1];

  const previous =
    candles.slice(
      -7,
      -1
    );

  const priorHigh =
    Math.max(
      ...previous.map(
        x => x.high
      )
    );

  const priorLow =
    Math.min(
      ...previous.map(
        x => x.low
      )
    );

  const sweptHigh =
    current.high >
      priorHigh &&
    current.close <
      priorHigh;

  const sweptLow =
    current.low <
      priorLow &&
    current.close >
      priorLow;

  if (sweptHigh) {

    return {

      available: true,

      confirmed: true,

      side: "SHORT",

      type: "HIGH_SWEEP",

      sweepPrice:
        current.high,

      reference:
        priorHigh,

      strength:
        pct(
          current.high,
          priorHigh
        )
    };
  }

  if (sweptLow) {

    return {

      available: true,

      confirmed: true,

      side: "LONG",

      type: "LOW_SWEEP",

      sweepPrice:
        current.low,

      reference:
        priorLow,

      strength:
        Math.abs(
          pct(
            current.low,
            priorLow
          )
        )
    };
  }

  return {

    available: true,

    confirmed: false,

    side: "NONE",

    type: "NONE",

    sweepPrice: 0,

    reference: 0,

    strength: 0
  };
}

/* =========================
   DIVERGENCE
========================= */

function findPivotIndexes(
  candles,
  type
) {

  const indexes = [];

  for (
    let i = 3;
    i < candles.length - 3;
    i++
  ) {

    if (
      type === "HIGH" &&
      pivotHigh(
        candles,
        i,
        3,
        3
      )
    )
      indexes.push(i);

    if (
      type === "LOW" &&
      pivotLow(
        candles,
        i,
        3,
        3
      )
    )
      indexes.push(i);
  }

  return indexes;
}

function divergence(
  candles
) {

  if (!candles || candles.length < 40)
    return {
      available: false,
      type: "NONE",
      side: "NONE"
    };

  const closes =
    candles.map(
      x => x.close
    );

  const rsiValues = [];

  for (
    let i = 15;
    i < closes.length;
    i++
  ) {

    const value =
      rsi(
        closes.slice(
          0,
          i + 1
        ),
        14
      );

    rsiValues.push({
      index: i,
      value
    });
  }

  const highs =
    findPivotIndexes(
      candles,
      "HIGH"
    );

  const lows =
    findPivotIndexes(
      candles,
      "LOW"
    );

  const validRsi =
    new Map(
      rsiValues.map(
        x => [
          x.index,
          x.value
        ]
      )
    );

  if (highs.length >= 2) {

    const i1 =
      highs[highs.length - 2];

    const i2 =
      highs[highs.length - 1];

    const r1 =
      validRsi.get(i1);

    const r2 =
      validRsi.get(i2);

    if (
      r1 != null &&
      r2 != null &&
      candles[i2].high >
        candles[i1].high &&
      r2 < r1
    ) {

      return {

        available: true,

        type:
          "BEARISH_DIVERGENCE",

        side: "SHORT",

        priceFirst:
          candles[i1].high,

        priceSecond:
          candles[i2].high,

        rsiFirst:
          r1,

        rsiSecond:
          r2
      };
    }
  }

  if (lows.length >= 2) {

    const i1 =
      lows[lows.length - 2];

    const i2 =
      lows[lows.length - 1];

    const r1 =
      validRsi.get(i1);

    const r2 =
      validRsi.get(i2);

    if (
      r1 != null &&
      r2 != null &&
      candles[i2].low <
        candles[i1].low &&
      r2 > r1
    ) {

      return {

        available: true,

        type:
          "BULLISH_DIVERGENCE",

        side: "LONG",

        priceFirst:
          candles[i1].low,

        priceSecond:
          candles[i2].low,

        rsiFirst:
          r1,

        rsiSecond:
          r2
      };
    }
  }

  return {

    available: true,

    type: "NONE",

    side: "NONE"
  };
}

/* =========================
   ICHIMOKU
========================= */

function ichimoku(candles) {

  if (candles.length < 52)
    return {
      available: false
    };

  const highest = arr =>
    Math.max(
      ...arr.map(
        x => x.high
      )
    );

  const lowest = arr =>
    Math.min(
      ...arr.map(
        x => x.low
      )
    );

  const last =
    candles.length - 1;

  const tenkan =
    (
      highest(
        candles.slice(
          last - 8,
          last + 1
        )
      ) +
      lowest(
        candles.slice(
          last - 8,
          last + 1
        )
      )
    ) / 2;

  const kijun =
    (
      highest(
        candles.slice(
          last - 25,
          last + 1
        )
      ) +
      lowest(
        candles.slice(
          last - 25,
          last + 1
        )
      )
    ) / 2;

  const spanA =
    (tenkan + kijun) / 2;

  const spanB =
    (
      highest(
        candles.slice(
          last - 51,
          last + 1
        )
      ) +
      lowest(
        candles.slice(
          last - 51,
          last + 1
        )
      )
    ) / 2;

  const price =
    candles[last].close;

  let direction = "NONE";

  if (
    price > spanA &&
    price > spanB &&
    tenkan > kijun
  )
    direction = "LONG";

  else if (
    price < spanA &&
    price < spanB &&
    tenkan < kijun
  )
    direction = "SHORT";

  return {

    available: true,

    tenkan,

    kijun,

    spanA,

    spanB,

    price,

    direction
  };
}

/* =========================
   BOLLINGER
========================= */

function bollinger(
  closes,
  period = 20,
  mult = 2
) {

  if (closes.length < period)
    return {
      available: false
    };

  const values =
    closes.slice(-period);

  const middle =
    average(values);

  const sd =
    stddev(values);

  const upper =
    middle +
    mult * sd;

  const lower =
    middle -
    mult * sd;

  const width =
    middle
      ? ((upper - lower) / middle) * 100
      : 0;

  const price =
    closes[closes.length - 1];

  let position = "MIDDLE";

  if (price >= upper)
    position = "UPPER";

  else if (price <= lower)
    position = "LOWER";

  return {

    available: true,

    middle,

    upper,

    lower,

    width,

    position
  };
}

/* =========================
   1 MINUTE ANALYSIS
========================= */

function analyze1m(candles) {

  if (!candles || candles.length < 60)
    return {
      available: false,
      reason:
        "کندل کافی برای تحلیل 1m وجود ندارد."
    };

  const closes =
    candles.map(
      x => x.close
    );

  const current =
    candles[candles.length - 1];

  const previous =
    candles[candles.length - 2];

  const ma7 =
    sma(closes, 7);

  const ma20 =
    sma(closes, 20);

  const prevMa20 =
    sma(
      closes.slice(0, -1),
      20
    );

  const slope =
    ma20 - prevMa20;

  const slopePct =
    pct(
      ma20,
      prevMa20
    );

  const distancePct =
    pct(
      current.close,
      ma20
    );

  const previousDistance =
    pct(
      previous.close,
      prevMa20
    );

  const touched =
    current.low <= ma20 &&
    current.high >= ma20;

  const near =
    Math.abs(
      distancePct
    ) <= 0.30;

  const crossUp =
    previous.close <
      prevMa20 &&
    current.close >=
      ma20;

  const crossDown =
    previous.close >
      prevMa20 &&
    current.close <=
      ma20;

  const rejectionUp =
    current.low <= ma20 &&
    current.close > ma20;

  const rejectionDown =
    current.high >= ma20 &&
    current.close < ma20;

  let direction = "NONE";

  if (
    rejectionUp ||
    crossUp
  )
    direction = "LONG";

  else if (
    rejectionDown ||
    crossDown
  )
    direction = "SHORT";

  const volumeAverage =
    average(
      candles
        .slice(-21, -1)
        .map(
          x => x.volume
        )
    );

  const volumeRatio =
    volumeAverage
      ? current.volume /
        volumeAverage
      : 0;

  const rsiValue =
    rsi(
      closes,
      14
    );

  const macdValue =
    macd(closes);

  const atrValue =
    atr(
      candles,
      14
    );

  const bb =
    bollinger(
      closes
    );

  const div =
    divergence(
      candles
    );

  const ichi =
    ichimoku(
      candles
    );

  const sweep =
    detectLiquiditySweep(
      candles
    );

  const supportResistanceData =
    supportResistance(
      candles,
      current.close
    );

  let marketStyle =
    "RANGE";

  if (
    ma20 > prevMa20 &&
    ma7 > ma20 &&
    current.close > ma20
  )
    marketStyle = "BULLISH";

  else if (
    ma20 < prevMa20 &&
    ma7 < ma20 &&
    current.close < ma20
  )
    marketStyle = "BEARISH";

  return {

    available: true,

    price:
      current.close,

    ma7,

    ma20,

    previousMA20:
      prevMa20,

    slope,

    slopePct,

    distancePct,

    previousDistancePct:
      previousDistance,

    touched,

    near,

    crossUp,

    crossDown,

    rejectionUp,

    rejectionDown,

    direction,

    volume:
      current.volume,

    averageVolume:
      volumeAverage,

    volumeRatio,

    volumeSpike:
      volumeRatio >= 1.5,

    rsi:
      rsiValue,

    macd:
      macdValue,

    atr:
      atrValue,

    atrPct:
      current.close &&
      atrValue
        ? (
            atrValue /
            current.close
          ) * 100
        : 0,

    bollinger:
      bb,

    ichimoku:
      ichi,

    divergence:
      div,

    liquiditySweep:
      sweep,

    supportResistance:
      supportResistanceData,

    marketStyle
  };
}

/* =========================
   15 MINUTE ANALYSIS
========================= */

function analyze15m(candles) {

  if (!candles || candles.length < 60)
    return {
      available: false,
      reason:
        "کندل کافی برای تحلیل 15m وجود ندارد."
    };

  const closes =
    candles.map(
      x => x.close
    );

  const current =
    closes[closes.length - 1];

  const ma7 =
    sma(
      closes,
      7
    );

  const ma20 =
    sma(
      closes,
      20
    );

  const prevMa20 =
    sma(
      closes.slice(0, -1),
      20
    );

  const slope =
    ma20 - prevMa20;

  const slopePct =
    pct(
      ma20,
      prevMa20
    );

  let direction =
    "RANGE";

  if (
    current > ma20 &&
    ma7 > ma20 &&
    slope > 0
  )
    direction =
      "LONG";

  else if (
    current < ma20 &&
    ma7 < ma20 &&
    slope < 0
  )
    direction =
      "SHORT";

  return {

    available: true,

    price:
      current,

    ma7,

    ma20,

    previousMA20:
      prevMa20,

    slope,

    slopePct,

    direction,

    rsi:
      rsi(
        closes,
        14
      ),

    macd:
      macd(
        closes
      ),

    atr:
      atr(
        candles,
        14
      ),

    bollinger:
      bollinger(
        closes
      ),

    ichimoku:
      ichimoku(
        candles
      ),

    divergence:
      divergence(
        candles
      ),

    marketStyle:
      direction === "LONG"
        ? "BULLISH"
        : direction === "SHORT"
          ? "BEARISH"
          : "RANGE"
  };
}

/* =========================
   OI ANALYSIS
========================= */

function analyzeOI(
  history,
  currentTicker
) {

  const list =
    history?.list || [];

  if (!list.length) {

    return {
      available: false,
      reason:
        "OI فقط برای Futures قابل دریافت است."
    };
  }

  const sorted =
    list
      .map(x => ({
        timestamp:
          num(x.timestamp),
        openInterest:
          num(
            x.openInterest
          )
      }))
      .sort(
        (a,b) =>
          a.timestamp -
          b.timestamp
      );

  const latest =
    sorted[
      sorted.length - 1
    ];

  const previous =
    sorted[
      Math.max(
        0,
        sorted.length - 2
      )
    ];

  const change =
    latest.openInterest -
    previous.openInterest;

  const changePct =
    pct(
      latest.openInterest,
      previous.openInterest
    );

  return {

    available: true,

    current:
      latest.openInterest,

    previous:
      previous.openInterest,

    change,

    changePct,

    history:
      sorted.slice(-20)
  };
}

/* =========================
   FUNDING ANALYSIS
========================= */

function analyzeFunding(
  history,
  ticker
) {

  const list =
    history?.list || [];

  const current =
    num(
      ticker?.fundingRate
    );

  if (
    !list.length &&
    !Number.isFinite(
      current
    )
  ) {

    return {
      available: false,
      reason:
        "Funding برای این بازار در دسترس نیست."
    };
  }

  const rates =
    list
      .map(x => ({
        timestamp:
          num(x.fundingRateTimestamp),
        rate:
          num(x.fundingRate)
      }))
      .sort(
        (a,b) =>
          a.timestamp -
          b.timestamp
      );

  const previous =
    rates.length >= 2
      ? rates[
          rates.length - 2
        ].rate
      : null;

  return {

    available: true,

    current,

    previous,

    change:
      previous == null
        ? null
        : current - previous,

    changePct:
      previous == null ||
      previous === 0
        ? null
        : (
            (
              current -
              previous
            ) /
            Math.abs(previous)
          ) * 100,

    history:
      rates.slice(-20),

    pressure:
      current > 0
        ? "LONG_PAYS_SHORT"
        : current < 0
          ? "SHORT_PAYS_LONG"
          : "NEUTRAL"
  };
}

/* =========================
   LONG / SHORT RATIO
========================= */

function analyzeLongShort(data) {

  const list =
    data?.list || [];

  if (!list.length)
    return {
      available: false
    };

  const sorted =
    list
      .map(x => ({
        timestamp:
          num(x.timestamp),
        buyRatio:
          num(x.buyRatio),
        sellRatio:
          num(x.sellRatio)
      }))
      .sort(
        (a,b) =>
          a.timestamp -
          b.timestamp
      );

  const latest =
    sorted[
      sorted.length - 1
    ];

  return {

    available: true,

    buyRatio:
      latest.buyRatio,

    sellRatio:
      latest.sellRatio,

    ratio:
      latest.sellRatio
        ? latest.buyRatio /
          latest.sellRatio
        : null,

    history:
      sorted.slice(-20)
  };
}

/* =========================
   SIGNAL SCORE
========================= */

function scoreSignal(
  one,
  fifteen,
  footprint,
  orderbook,
  oi,
  funding,
  strictness
) {

  const reasons = [];

  let long = 0;
  let short = 0;

  if (!one?.available)
    return {
      score: 0,
      longScore: 0,
      shortScore: 0,
      direction: "WAIT",
      qualifies: false,
      threshold: 100,
      reasons
    };

  /*
    MA20 برخورد:
    هسته اصلی
  */

  if (!one.touched)
    return {
      score: 0,
      longScore: 0,
      shortScore: 0,
      direction: "WAIT",
      qualifies: false,
      threshold:
        25 +
        clamp(strictness) *
        0.65,
      reasons: [
        {
          side: "NONE",
          text:
            "قیمت در این لحظه با MA20 تایم 1m برخورد نکرده است."
        }
      ]
    };

  if (
    one.direction === "LONG"
  ) {

    long += 35;

    reasons.push({
      side: "LONG",
      text:
        "برخورد واقعی قیمت با MA20 در 1m"
    });
  }

  else if (
    one.direction === "SHORT"
  ) {

    short += 35;

    reasons.push({
      side: "SHORT",
      text:
        "برخورد واقعی قیمت با MA20 در 1m"
    });
  }

  /*
    شیب MA20
  */

  if (
    one.slopePct > 0
  ) {

    long += 15;

    reasons.push({
      side: "LONG",
      text:
        "شیب واقعی MA20 در 1m صعودی است."
    });

  }
  else if (
    one.slopePct < 0
  ) {

    short += 15;

    reasons.push({
      side: "SHORT",
      text:
        "شیب واقعی MA20 در 1m نزولی است."
    });
  }

  /*
    نوع برخورد
  */

  if (one.rejectionUp) {

    long += 10;

    reasons.push({
      side: "LONG",
      text:
        "قیمت MA20 را لمس کرده و بالای آن بسته شده است."
    });
  }

  if (one.rejectionDown) {

    short += 10;

    reasons.push({
      side: "SHORT",
      text:
        "قیمت MA20 را لمس کرده و زیر آن بسته شده است."
    });
  }

  /*
    حجم
  */

  if (
    one.volumeRatio >= 1.5
  ) {

    if (
      one.direction === "LONG"
    ) {

      long += 8;

      reasons.push({
        side: "LONG",
        text:
          `حجم 1m حدود ${one.volumeRatio.toFixed(2)} برابر میانگین است.`
      });
    }

    else if (
      one.direction === "SHORT"
    ) {

      short += 8;

      reasons.push({
        side: "SHORT",
        text:
          `حجم 1m حدود ${one.volumeRatio.toFixed(2)} برابر میانگین است.`
      });
    }
  }

  /*
    MACD
  */

  if (
    one.macd?.available &&
    one.macd.direction ===
      "LONG"
  ) {

    long += 7;

    reasons.push({
      side: "LONG",
      text:
        "MACD واقعی 1m بالای صفر است."
    });
  }

  if (
    one.macd?.available &&
    one.macd.direction ===
      "SHORT"
  ) {

    short += 7;

    reasons.push({
      side: "SHORT",
      text:
        "MACD واقعی 1m زیر صفر است."
    });
  }

  /*
    RSI
  */

  if (
    one.rsi != null &&
    one.rsi > 52
  ) {

    long += 5;

    reasons.push({
      side: "LONG",
      text:
        `RSI واقعی 1m = ${one.rsi.toFixed(2)}`
    });
  }

  else if (
    one.rsi != null &&
    one.rsi < 48
  ) {

    short += 5;

    reasons.push({
      side: "SHORT",
      text:
        `RSI واقعی 1m = ${one.rsi.toFixed(2)}`
    });
  }

  /*
    Footprint
  */

  if (
    footprint?.available
  ) {

    if (
      footprint.deltaPercent >
      10
    ) {

      long += 8;

      reasons.push({
        side: "LONG",
        text:
          "Footprint واقعی: فشار خرید بالاتر است."
      });
    }

    else if (
      footprint.deltaPercent <
      -10
    ) {

      short += 8;

      reasons.push({
        side: "SHORT",
        text:
          "Footprint واقعی: فشار فروش بالاتر است."
      });
    }
  }

  /*
    15m
  */

  if (
    fifteen?.direction ===
    "LONG"
  ) {

    long += 12;

    reasons.push({
      side: "LONG",
      text:
        "روند 15m صعودی است."
    });

  }
  else if (
    fifteen?.direction ===
    "SHORT"
  ) {

    short += 12;

    reasons.push({
      side: "SHORT",
      text:
        "روند 15m نزولی است."
    });
  }

  /*
    تضاد 1m و 15m
  */

  if (
    one.direction === "LONG" &&
    fifteen?.direction === "SHORT"
  ) {

    long -= 20;

    reasons.push({
      side: "LONG",
      text:
        "15m خلاف جهت سیگنال 1m است."
    });
  }

  if (
    one.direction === "SHORT" &&
    fifteen?.direction === "LONG"
  ) {

    short -= 20;

    reasons.push({
      side: "SHORT",
      text:
        "15m خلاف جهت سیگنال 1m است."
    });
  }

  /*
    Divergence
  */

  if (
    one.divergence?.side ===
    "LONG"
  ) {

    long += 8;

    reasons.push({
      side: "LONG",
      text:
        "واگرایی صعودی واقعی در RSI تشخیص داده شد."
    });
  }

  if (
    one.divergence?.side ===
    "SHORT"
  ) {

    short += 8;

    reasons.push({
      side: "SHORT",
      text:
        "واگرایی نزولی واقعی در RSI تشخیص داده شد."
    });
  }

  /*
    Liquidity Sweep
  */

  if (
    one.liquiditySweep?.confirmed
  ) {

    if (
      one.liquiditySweep.side ===
      "LONG"
    ) {

      long += 8;

      reasons.push({
        side: "LONG",
        text:
          "Liquidity Sweep پایین با برگشت قیمت تأیید شده است."
      });
    }

    else if (
      one.liquiditySweep.side ===
      "SHORT"
    ) {

      short += 8;

      reasons.push({
        side: "SHORT",
        text:
          "Liquidity Sweep بالا با برگشت قیمت تأیید شده است."
      });
    }
  }

  /*
    Order Book
  */

  if (
    orderbook?.available
  ) {

    if (
      orderbook.buyShare >
      orderbook.sellShare + 10
    ) {

      long += 5;

      reasons.push({
        side: "LONG",
        text:
          "نقدینگی خرید در Order Book بیشتر است."
      });
    }

    else if (
      orderbook.sellShare >
      orderbook.buyShare + 10
    ) {

      short += 5;

      reasons.push({
        side: "SHORT",
        text:
          "نقدینگی فروش در Order Book بیشتر است."
      });
    }
  }

  /*
    Funding
  */

  if (
    funding?.available
  ) {

    if (
      funding.current < 0
    ) {

      long += 3;

      reasons.push({
        side: "LONG",
        text:
          "Funding فعلی منفی است."
      });

    }
    else if (
      funding.current > 0
    ) {

      short += 3;

      reasons.push({
        side: "SHORT",
        text:
          "Funding فعلی مثبت است."
      });
    }
  }

  long =
    clamp(long);

  short =
    clamp(short);

  const raw =
    Math.max(
      long,
      short
    );

  const threshold =
    25 +
    (
      clamp(strictness) *
      0.65
    );

  let direction =
    long > short
      ? "LONG"
      : short > long
        ? "SHORT"
        : "WAIT";

  /*
    اگر MA20 جهت مشخصی دارد،
    اجازه نمی‌دهیم امتیاز مخالف
    صرفاً با عوامل فرعی برنده شود.
  */

  if (
    one.direction === "LONG" &&
    direction === "SHORT"
  ) {

    direction = "WAIT";

    reasons.push({
      side: "NONE",
      text:
        "عوامل فرعی با جهت برخورد MA20 در تضاد هستند؛ سیگنال تأیید نشد."
    });
  }

  if (
    one.direction === "SHORT" &&
    direction === "LONG"
  ) {

    direction = "WAIT";

    reasons.push({
      side: "NONE",
      text:
        "عوامل فرعی با جهت برخورد MA20 در تضاد هستند؛ سیگنال تأیید نشد."
    });
  }

  const qualifies =
    raw >= threshold &&
    direction !== "WAIT";

  return {

    score:
      Math.round(raw),

    longScore:
      Math.round(long),

    shortScore:
      Math.round(short),

    threshold:
      Math.round(threshold),

    direction:
      qualifies
        ? direction
        : "WAIT",

    qualifies,

    reasons
  };
}

/* =========================
   FULL ANALYSIS
========================= */

async function analyzeSymbol(
  symbol,
  category,
  strictness,
  deep = true
) {

  const k1Promise =
    getKlines(
      category,
      symbol,
      "1",
      KLINE_LIMIT_1M
    );

  const k15Promise =
    getKlines(
      category,
      symbol,
      "15",
      KLINE_LIMIT_15M
    );

  const tickerPromise =
    getTicker(
      category,
      symbol
    );

  const tradesPromise =
    getRecentTrades(
      category,
      symbol
    );

  const bookPromise =
    getOrderbook(
      category,
      symbol
    );

  const [
    k1,
    k15,
    ticker,
    trades,
    book
  ] = await Promise.all([
    k1Promise,
    k15Promise,
    tickerPromise,
    tradesPromise,
    bookPromise
  ]);

  const one =
    analyze1m(k1);

  const fifteen =
    analyze15m(k15);

  const footprint =
    analyzeFootprint(
      trades
    );

  const orderbook =
    analyzeOrderbook(
      book,
      num(ticker?.lastPrice) ||
      one.price
    );

  let oi = {
    available: false,
    reason:
      "OI فقط برای Futures است."
  };

  let funding = {
    available: false,
    reason:
      "Funding فقط برای Futures است."
  };

  let longShort = {
    available: false
  };

  if (
    category === "linear"
  ) {

    const [
      oiHistory,
      fundingHistory,
      longShortData
    ] = await Promise.all([
      getOIHistory(symbol).catch(
        () => null
      ),
      getFundingHistory(symbol).catch(
        () => null
      ),
      getLongShort(symbol).catch(
        () => null
      )
    ]);

    oi =
      analyzeOI(
        oiHistory,
        ticker
      );

    funding =
      analyzeFunding(
        fundingHistory,
        ticker
      );

    longShort =
      analyzeLongShort(
        longShortData
      );
  }

  const signal =
    scoreSignal(
      one,
      fifteen,
      footprint,
      orderbook,
      oi,
      funding,
      strictness
    );

  const result = {

    ok: true,

    mode:
      "personal",

    version:
      PERSONAL_VERSION,

    symbol,

    category,

    price:
      num(ticker?.lastPrice) ||
      one.price,

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

    qualifies:
      signal.qualifies,

    reasons:
      signal.reasons,

    marketStyle:
      one.marketStyle,

    oneMinute: one,

    fifteenMinute:
      fifteen,

    footprint,

    orderBook:
      orderbook,

    supportResistance:
      one.supportResistance,

    liquiditySweep:
      one.liquiditySweep,

    oi,

    funding,

    longShort,

    generatedAt:
      Date.now()
  };

  return result;
}

/* =========================
   SYMBOL RESOLVER
========================= */

async function resolveSymbol(
  input
) {

  const clean =
    String(input || "")
      .trim()
      .toUpperCase()
      .replace(
        /[^A-Z0-9]/g,
        ""
      );

  if (!clean)
    return null;

  const symbols =
    await getSymbols();

  let found =
    symbols.find(
      x =>
        x.symbol ===
        clean
    );

  if (found)
    return found;

  if (
    !clean.endsWith("USDT")
  ) {

    found =
      symbols.find(
        x =>
          x.symbol ===
          clean + "USDT"
      );

    if (found)
      return found;
  }

  const base =
    clean.endsWith("USDT")
      ? clean.slice(0, -4)
      : clean;

  const matches =
    symbols.filter(
      x =>
        x.baseCoin === base &&
        x.quoteCoin === "USDT"
    );

  if (!matches.length)
    return null;

  /*
    Futures اولویت دارد
    اگر همان ارز در هر دو باشد.
  */

  return (
    matches.find(
      x =>
        x.category ===
        "linear"
    ) ||
    matches[0]
  );
}

/* =========================
   ROTATING SCAN
========================= */

async function scanMarket(
  offset,
  strictness
) {

  const symbols =
    await getSymbols();

  if (!symbols.length)
    throw new Error(
      "بازارهای Bybit دریافت نشد."
    );

  const total =
    symbols.length;

  const selected = [];

  for (
    let i = 0;
    i < SCAN_BATCH;
    i++
  ) {

    selected.push(
      symbols[
        (
          offset + i
        ) % total
      ]
    );
  }

  const results = [];

  const concurrency = 3;

  for (
    let i = 0;
    i < selected.length;
    i += concurrency
  ) {

    const chunk =
      selected.slice(
        i,
        i + concurrency
      );

    const data =
      await Promise.all(
        chunk.map(
          async x => {

            try {

              return await analyzeSymbol(
                x.symbol,
                x.category,
                strictness,
                false
              );

            }
            catch {

              return null;
            }
          }
        )
      );

    results.push(
      ...data.filter(Boolean)
    );

    await sleep(80);
  }

  const signals =
    results
      .filter(
        x =>
          x.qualifies &&
          (
            x.direction === "LONG" ||
            x.direction === "SHORT"
          )
      )
      .sort(
        (a,b) =>
          b.score -
          a.score
      );

  return {

    ok: true,

    mode:
      "personal",

    version:
      PERSONAL_VERSION,

    strictness:
      clamp(strictness),

    checked:
      results.length,

    totalMarkets:
      total,

    offset,

    nextOffset:
      (
        offset +
        SCAN_BATCH
      ) % total,

    results: signals,

    generatedAt:
      Date.now()
  };
}

/* =========================
   HEALTH
========================= */

async function health() {

  return {

    ok: true,

    service:
      "Bybit Personal Live Smart Money Scanner",

    version:
      PERSONAL_VERSION,

    mode:
      "personal",

    signalCore:
      "REAL 1m PRICE TOUCH MA20",

    confirmation:
      "REAL 15m",

    strictness:
      "0-100",

    features: [

      "REAL 1m MA20",

      "REAL MA20 Slope",

      "REAL MA20 Touch",

      "REAL MA20 Cross",

      "REAL Rejection",

      "REAL Volume",

      "REAL RSI",

      "REAL MACD",

      "REAL ATR",

      "REAL Bollinger",

      "REAL Ichimoku",

      "REAL RSI Divergence",

      "REAL Liquidity Sweep",

      "REAL Support Resistance",

      "REAL Recent Trades Footprint",

      "REAL Order Book",

      "REAL Buy Walls",

      "REAL Sell Walls",

      "REAL Open Interest",

      "REAL Funding",

      "REAL Long Short Ratio",

      "15m Confirmation",

      "Rotating Scan",

      "Deep Analysis"

    ],

    timeframes: [
      "1",
      "15"
    ],

    dataPolicy:
      "No synthetic indicator values",

    time:
      Date.now()
  };
}

/* =========================
   ROUTER
========================= */

async function handle(request) {

  const url =
    new URL(request.url);

  const path =
    url.pathname;

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
            "GET,OPTIONS",
          "access-control-allow-headers":
            "*"
        }
      }
    );
  }

  if (
    path ===
    "/api/health"
  ) {

    return json(
      await health()
    );
  }

  if (
    path ===
      "/api/personal/health"
  ) {

    return json(
      await health()
    );
  }

  /*
    ROTATING PERSONAL SCAN
  */

  if (
    path ===
      "/api/personal/scan" ||
    path ===
      "/api/scan"
  ) {

    try {

      const offset =
        Math.max(
          0,
          Math.floor(
            num(
              url.searchParams.get(
                "offset"
              )
            )
          )
        );

      const strictness =
        clamp(
          num(
            url.searchParams.get(
              "strictness"
            ) ??
            DEFAULT_STRICTNESS
          )
        );

      return json(
        await scanMarket(
          offset,
          strictness
        )
      );

    }
    catch (e) {

      return json(
        {
          ok: false,
          error:
            e.message ||
            "خطا در اسکن بازار"
        },
        500
      );
    }
  }

  /*
    DEEP MANUAL ANALYSIS
  */

  if (
    path ===
      "/api/personal/analyze" ||
    path ===
      "/api/analyze"
  ) {

    try {

      const input =
        url.searchParams.get(
          "symbol"
        );

      const strictness =
        clamp(
          num(
            url.searchParams.get(
              "strictness"
            ) ??
            DEFAULT_STRICTNESS
          )
        );

      if (!input) {

        return json(
          {
            ok: false,
            error:
              "نام ارز وارد نشده است."
          },
          400
        );
      }

      const found =
        await resolveSymbol(
          input
        );

      if (!found) {

        return json(
          {
            ok: false,

            error:
              `${String(input).toUpperCase()} در Spot یا Futures Bybit پیدا نشد.`,

            search: {
              input:
                String(input)
                  .toUpperCase(),
              selected:
                null
            }
          },
          404
        );
      }

      const data =
        await analyzeSymbol(
          found.symbol,
          found.category,
          strictness,
          true
        );

      return json({

        ...data,

        baseCoin:
          found.baseCoin,

        quoteCoin:
          found.quoteCoin,

        strictness,

        search: {

          input:
            String(input)
              .toUpperCase(),

          selected:
            found.category ===
            "linear"
              ? "FUTURES"
              : "SPOT"
        }

      });

    }
    catch (e) {

      return json(
        {
          ok: false,
          error:
            e.message ||
            "تحلیل انجام نشد."
        },
        500
      );
    }
  }

  return json(
    {
      ok: false,

      error:
        "Personal API route not found.",

      routes: [
        "/api/health",
        "/api/personal/health",
        "/api/personal/scan",
        "/api/personal/analyze"
      ]
    },
    404
  );
}

/* =========================
   CLOUDFLARE WORKER
========================= */

export default {

  async fetch(
    request,
    env,
    ctx
  ) {

    return handle(
      request
    );

  }

};
