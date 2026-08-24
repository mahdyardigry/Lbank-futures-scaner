const BYBIT = "https://api.bybit.com";

const PERSONAL_VERSION = "PERSONAL-MA20-V2";

const SCAN_BATCH = 20;

const KLINE_LIMIT_1M = 100;
const KLINE_LIMIT_15M = 100;

const DEFAULT_STRICTNESS = 50;

const sleep = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,OPTIONS",
      "access-control-allow-headers": "*"
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

function sma(values, period) {
  if (!values || values.length < period) return 0;

  const arr = values.slice(-period);

  return arr.reduce((a, b) => a + num(b), 0) / period;
}

function rsi(values, period = 14) {
  if (!values || values.length < period + 1) return 50;

  let gains = 0;
  let losses = 0;

  const start = values.length - period;

  for (let i = start; i < values.length; i++) {
    const diff =
      num(values[i]) -
      num(values[i - 1]);

    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }

  if (losses === 0) return 100;

  const rs =
    (gains / period) /
    (losses / period);

  return 100 - 100 / (1 + rs);
}

function atr(candles, period = 14) {
  if (!candles || candles.length < period + 1) return 0;

  const trs = [];

  for (
    let i = candles.length - period;
    i < candles.length;
    i++
  ) {
    const c = candles[i];
    const p = candles[i - 1];

    const high = num(c.high);
    const low = num(c.low);
    const prevClose = num(p.close);

    trs.push(
      Math.max(
        high - low,
        Math.abs(high - prevClose),
        Math.abs(low - prevClose)
      )
    );
  }

  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

function stddev(values) {
  if (!values || !values.length) return 0;

  const avg =
    values.reduce((a, b) => a + num(b), 0) /
    values.length;

  const variance =
    values.reduce(
      (a, b) =>
        a + Math.pow(num(b) - avg, 2),
      0
    ) / values.length;

  return Math.sqrt(variance);
}

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
    .sort((a, b) => a.time - b.time);
}

async function bybit(path) {
  const response = await fetch(
    BYBIT + path,
    {
      method: "GET",
      headers: {
        accept: "application/json"
      }
    }
  );

  if (!response.ok) {
    throw new Error(
      `Bybit HTTP ${response.status}`
    );
  }

  const data = await response.json();

  if (num(data.retCode) !== 0) {
    throw new Error(
      data.retMsg ||
      "Bybit API error"
    );
  }

  return data.result || {};
}

/* =========================================================
   INSTRUMENTS
   ========================================================= */

async function getInstruments(category) {
  const all = [];
  let cursor = "";

  for (let page = 0; page < 10; page++) {
    let path =
      `/v5/market/instruments-info?category=${encodeURIComponent(category)}&limit=1000`;

    if (cursor) {
      path +=
        `&cursor=${encodeURIComponent(cursor)}`;
    }

    const result = await bybit(path);

    const list =
      Array.isArray(result.list)
        ? result.list
        : [];

    all.push(...list);

    const next =
      result.nextPageCursor || "";

    if (!next || next === cursor) {
      break;
    }

    cursor = next;

    await sleep(30);
  }

  return all;
}

function validSpot(x) {
  if (!x) return false;

  if (x.status !== "Trading") return false;

  if (
    String(x.quoteCoin || "")
      .toUpperCase() !== "USDT"
  ) {
    return false;
  }

  if (
    x.symbol === "USDTUSDT"
  ) {
    return false;
  }

  return true;
}

function validLinear(x) {
  if (!x) return false;

  if (x.status !== "Trading") return false;

  if (
    String(x.quoteCoin || "")
      .toUpperCase() !== "USDT"
  ) {
    return false;
  }

  if (
    String(x.settleCoin || "")
      .toUpperCase() !== "USDT"
  ) {
    return false;
  }

  return true;
}

async function getSymbols() {
  /*
    مهم:
    اگر یکی از بازارها خطا داد،
    بازار دیگر همچنان قابل استفاده باشد.
  */

  let spot = [];
  let linear = [];

  try {
    spot = await getInstruments("spot");
  } catch (e) {
    spot = [];
  }

  try {
    linear = await getInstruments("linear");
  } catch (e) {
    linear = [];
  }

  const map = new Map();

  /*
    Futures اولویت دارد.
  */

  for (const x of linear) {
    if (!validLinear(x)) continue;

    map.set(x.symbol, {
      symbol: x.symbol,
      category: "linear",
      baseCoin: x.baseCoin || "",
      quoteCoin: x.quoteCoin || "USDT"
    });
  }

  /*
    Spot فقط اگر Futures همان نماد وجود نداشته باشد.
  */

  for (const x of spot) {
    if (!validSpot(x)) continue;

    if (!map.has(x.symbol)) {
      map.set(x.symbol, {
        symbol: x.symbol,
        category: "spot",
        baseCoin: x.baseCoin || "",
        quoteCoin: x.quoteCoin || "USDT"
      });
    }
  }

  return [...map.values()];
}

/* =========================================================
   MARKET DATA
   ========================================================= */

async function getTicker(category, symbol) {
  const result =
    await bybit(
      `/v5/market/tickers?category=${encodeURIComponent(category)}&symbol=${encodeURIComponent(symbol)}`
    );

  return result.list?.[0] || null;
}

async function getKlines(
  category,
  symbol,
  interval,
  limit
) {
  const result =
    await bybit(
      `/v5/market/kline?category=${encodeURIComponent(category)}&symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${limit}`
    );

  return parseKlines(result.list);
}

async function getOrderbook(category, symbol) {
  return await bybit(
    `/v5/market/orderbook?category=${encodeURIComponent(category)}&symbol=${encodeURIComponent(symbol)}&limit=50`
  );
}

/* =========================================================
   1 MINUTE MA20
   ========================================================= */

function analyze1m(candles) {
  if (!candles || candles.length < 30) {
    return {
      ok: false,
      reason: "کندل کافی نیست"
    };
  }

  const closes =
    candles.map(x => x.close);

  const current =
    candles[candles.length - 1];

  const previous =
    candles[candles.length - 2];

  const ma20 =
    sma(closes, 20);

  const previousMA20 =
    sma(closes.slice(0, -1), 20);

  if (!ma20 || !previousMA20) {
    return {
      ok: false,
      reason: "MA20 محاسبه نشد"
    };
  }

  const maSlope =
    ma20 - previousMA20;

  const maSlopePct =
    previousMA20
      ? (maSlope / previousMA20) * 100
      : 0;

  const distancePct =
    ((current.close - ma20) / ma20) * 100;

  const previousDistancePct =
    ((previous.close - previousMA20) /
      previousMA20) *
    100;

  const previousAbove =
    previous.close >= previousMA20;

  const currentAbove =
    current.close >= ma20;

  const crossedUp =
    !previousAbove &&
    currentAbove;

  const crossedDown =
    previousAbove &&
    !currentAbove;

  const touched =
    current.low <= ma20 &&
    current.high >= ma20;

  const near =
    Math.abs(distancePct) <= 0.40;

  const rejectionUp =
    current.low <= ma20 &&
    current.close > ma20;

  const rejectionDown =
    current.high >= ma20 &&
    current.close < ma20;

  let direction = "NONE";

  if (crossedUp || rejectionUp) {
    direction = "LONG";
  }

  if (crossedDown || rejectionDown) {
    direction = "SHORT";
  }

  /*
    اگر فقط برخورد داشته باشیم،
    جهت کندل هم بررسی می‌شود.
  */

  if (
    direction === "NONE" &&
    touched
  ) {
    if (current.close > current.open) {
      direction = "LONG";
    } else if (
      current.close < current.open
    ) {
      direction = "SHORT";
    }
  }

  const atrValue =
    atr(candles, 14);

  const atrPct =
    current.close
      ? (atrValue / current.close) * 100
      : 0;

  const volumeHistory =
    candles
      .slice(-21, -1)
      .map(x => x.volume);

  const averageVolume =
    volumeHistory.length
      ? sma(
          volumeHistory,
          Math.min(
            20,
            volumeHistory.length
          )
        )
      : 0;

  const volumeRatio =
    averageVolume
      ? current.volume / averageVolume
      : 0;

  const volumeSpike =
    volumeRatio >= 1.5;

  const rsiValue =
    rsi(closes, 14);

  const recent =
    closes.slice(-20);

  const middle =
    sma(recent, 20);

  const deviation =
    stddev(recent);

  const upper =
    middle + deviation * 2;

  const lower =
    middle - deviation * 2;

  const bollingerWidth =
    middle
      ? ((upper - lower) / middle) * 100
      : 0;

  /*
    قدرت برخورد
  */

  let touchStrength = 0;

  if (touched) {
    touchStrength += 35;
  }

  if (crossedUp || crossedDown) {
    touchStrength += 20;
  }

  if (rejectionUp || rejectionDown) {
    touchStrength += 20;
  }

  if (near) {
    touchStrength += 10;
  }

  if (volumeRatio >= 1.5) {
    touchStrength += 15;
  }

  return {
    ok: true,

    price: current.close,

    open: current.open,
    high: current.high,
    low: current.low,

    ma20,
    previousMA20,

    maSlope,
    maSlopePct,

    distancePct,
    previousDistancePct,

    touched,
    near,

    crossedUp,
    crossedDown,

    rejectionUp,
    rejectionDown,

    direction,

    touchStrength:
      clamp(touchStrength),

    volume:
      current.volume,

    averageVolume,

    volumeRatio,

    volumeSpike,

    rsi:
      rsiValue,

    atr:
      atrValue,

    atrPct,

    bollingerWidth
  };
}

/* =========================================================
   15 MINUTE CONFIRMATION
   ========================================================= */

function analyze15m(candles) {
  if (!candles || candles.length < 30) {
    return {
      ok: false,
      direction: "RANGE"
    };
  }

  const closes =
    candles.map(x => x.close);

  const current =
    closes[closes.length - 1];

  const previous =
    closes[closes.length - 2];

  const ma7 =
    sma(closes, 7);

  const ma20 =
    sma(closes, 20);

  const previousMA20 =
    sma(
      closes.slice(0, -1),
      20
    );

  const slope =
    ma20 - previousMA20;

  const slopePct =
    previousMA20
      ? (slope / previousMA20) * 100
      : 0;

  const above =
    current > ma20;

  const below =
    current < ma20;

  let direction = "RANGE";

  if (
    above &&
    ma7 > ma20 &&
    slope > 0
  ) {
    direction = "LONG";
  }

  if (
    below &&
    ma7 < ma20 &&
    slope < 0
  ) {
    direction = "SHORT";
  }

  const distancePct =
    ma20
      ? ((current - ma20) / ma20) * 100
      : 0;

  return {
    ok: true,

    price:
      current,

    previous,

    ma7,
    ma20,
    previousMA20,

    slope,
    slopePct,

    distancePct,

    aboveMA20:
      above,

    belowMA20:
      below,

    direction,

    rsi:
      rsi(closes, 14),

    atr:
      atr(candles, 14)
  };
}

/* =========================================================
   SIGNAL SCORING
   ========================================================= */

function scoreSignal(
  one,
  fifteen,
  strictness
) {
  const reasons = [];

  let long = 0;
  let short = 0;

  if (!one.ok) {
    return {
      score: 0,
      longScore: 0,
      shortScore: 0,
      direction: "WAIT",
      qualifies: false,
      threshold: 0,
      reasons
    };
  }

  /*
    MA20 برخورد = هسته اصلی
    بدون برخورد، سیگنال اصلی ساخته نمی‌شود.
  */

  if (!one.touched) {
    return {
      score: 0,
      longScore: 0,
      shortScore: 0,
      direction: "WAIT",
      qualifies: false,
      threshold:
        20 +
        clamp(strictness) * 0.70,
      reasons: [
        {
          side: "NONE",
          text:
            "قیمت در این کندل با MA20 تایم 1m برخورد نکرده است."
        }
      ]
    };
  }

  /*
    برخورد اصلی
  */

  if (one.direction === "LONG") {
    long += 35;

    reasons.push({
      side: "LONG",
      text:
        "برخورد قیمت با MA20 در 1m"
    });
  }

  if (one.direction === "SHORT") {
    short += 35;

    reasons.push({
      side: "SHORT",
      text:
        "برخورد قیمت با MA20 در 1m"
    });
  }

  /*
    عبور MA20
  */

  if (one.crossedUp) {
    long += 15;

    reasons.push({
      side: "LONG",
      text:
        "عبور قیمت از MA20 به سمت بالا در 1m"
    });
  }

  if (one.crossedDown) {
    short += 15;

    reasons.push({
      side: "SHORT",
      text:
        "عبور قیمت از MA20 به سمت پایین در 1m"
    });
  }

  /*
    برگشت از MA20
  */

  if (one.rejectionUp) {
    long += 12;

    reasons.push({
      side: "LONG",
      text:
        "رد قیمت از MA20 به سمت بالا"
    });
  }

  if (one.rejectionDown) {
    short += 12;

    reasons.push({
      side: "SHORT",
      text:
        "رد قیمت از MA20 به سمت پایین"
    });
  }

  /*
    شیب MA20
  */

  if (one.maSlopePct > 0.015) {
    long += 15;

    reasons.push({
      side: "LONG",
      text:
        "شیب MA20 صعودی در 1m"
    });
  }

  if (one.maSlopePct < -0.015) {
    short += 15;

    reasons.push({
      side: "SHORT",
      text:
        "شیب MA20 نزولی در 1m"
    });
  }

  /*
    فاصله از MA20
  */

  if (
    Math.abs(one.distancePct) <= 0.20
  ) {
    if (one.direction === "LONG") {
      long += 8;

      reasons.push({
        side: "LONG",
        text:
          "قیمت بسیار نزدیک MA20 است"
      });
    }

    if (one.direction === "SHORT") {
      short += 8;

      reasons.push({
        side: "SHORT",
        text:
          "قیمت بسیار نزدیک MA20 است"
      });
    }
  }

  /*
    حجم
  */

  if (one.volumeRatio >= 1.50) {
    if (one.direction === "LONG") {
      long += 8;

      reasons.push({
        side: "LONG",
        text:
          "حجم برخورد بالاتر از میانگین است"
      });
    }

    if (one.direction === "SHORT") {
      short += 8;

      reasons.push({
        side: "SHORT",
        text:
          "حجم برخورد بالاتر از میانگین است"
      });
    }
  }

  /*
    RSI
  */

  if (one.rsi >= 52) {
    long += 4;

    reasons.push({
      side: "LONG",
      text:
        "RSI در محدوده صعودی 1m"
    });
  }

  if (one.rsi <= 48) {
    short += 4;

    reasons.push({
      side: "SHORT",
      text:
        "RSI در محدوده نزولی 1m"
    });
  }

  /*
    تایید 15 دقیقه
  */

  if (
    fifteen &&
    fifteen.direction === "LONG"
  ) {
    long += 15;

    reasons.push({
      side: "LONG",
      text:
        "تایید روند MA20 در 15m"
    });
  }

  if (
    fifteen &&
    fifteen.direction === "SHORT"
  ) {
    short += 15;

    reasons.push({
      side: "SHORT",
      text:
        "تایید روند MA20 در 15m"
    });
  }

  /*
    خلاف جهت 15m
  */

  if (
    one.direction === "LONG" &&
    fifteen?.direction === "SHORT"
  ) {
    long -= 15;

    reasons.push({
      side: "LONG",
      text:
        "روند 15m خلاف سیگنال 1m است"
    });
  }

  if (
    one.direction === "SHORT" &&
    fifteen?.direction === "LONG"
  ) {
    short -= 15;

    reasons.push({
      side: "SHORT",
      text:
        "روند 15m خلاف سیگنال 1m است"
    });
  }

  long = clamp(long);
  short = clamp(short);

  const direction =
    long > short
      ? "LONG"
      : short > long
        ? "SHORT"
        : "WAIT";

  const score =
    Math.round(
      Math.max(long, short)
    );

  /*
    0 = سیگنال زیاد
    100 = فقط سیگنال‌های بسیار قوی
  */

  const threshold =
    20 +
    clamp(strictness) * 0.70;

  const qualifies =
    score >= threshold &&
    direction !== "WAIT";

  return {
    score,

    longScore:
      Math.round(long),

    shortScore:
      Math.round(short),

    direction:
      qualifies
        ? direction
        : "WAIT",

    qualifies,

    threshold:
      Math.round(threshold),

    reasons
  };
}

/* =========================================================
   DEEP ORDER BOOK
   ========================================================= */

async function deepOrderBook(
  category,
  symbol
) {
  try {
    const book =
      await getOrderbook(
        category,
        symbol
      );

    const bids =
      (book.b || [])
        .map(x => ({
          price: num(x[0]),
          size: num(x[1]),
          notional:
            num(x[0]) * num(x[1])
        }))
        .filter(x => x.price > 0);

    const asks =
      (book.a || [])
        .map(x => ({
          price: num(x[0]),
          size: num(x[1]),
          notional:
            num(x[0]) * num(x[1])
        }))
        .filter(x => x.price > 0);

    const buyLiquidity =
      bids.reduce(
        (sum, x) =>
          sum + x.notional,
        0
      );

    const sellLiquidity =
      asks.reduce(
        (sum, x) =>
          sum + x.notional,
        0
      );

    const total =
      buyLiquidity +
      sellLiquidity;

    const bestBid =
      bids[0] || null;

    const bestAsk =
      asks[0] || null;

    let spreadPct = 0;

    if (
      bestBid &&
      bestAsk &&
      bestBid.price
    ) {
      spreadPct =
        (
          (bestAsk.price -
            bestBid.price) /
          bestBid.price
        ) * 100;
    }

    return {
      available: true,

      buyLiquidity,
      sellLiquidity,

      totalLiquidity:
        total,

      buyShare:
        total
          ? (buyLiquidity / total) * 100
          : 0,

      sellShare:
        total
          ? (sellLiquidity / total) * 100
          : 0,

      spreadPct,

      bestBid,
      bestAsk,

      buyLevels:
        bids.slice(0, 10),

      sellLevels:
        asks.slice(0, 10)
    };
  } catch (e) {
    return {
      available: false,
      error:
        e.message ||
        "Order Book در دسترس نیست."
    };
  }
}

/* =========================================================
   COMPLETE SYMBOL ANALYSIS
   ========================================================= */

async function analyzeSymbol(
  symbol,
  category,
  strictness,
  deep = true
) {
  const [
    k1,
    k15,
    ticker
  ] = await Promise.all([
    getKlines(
      category,
      symbol,
      "1",
      KLINE_LIMIT_1M
    ),
    getKlines(
      category,
      symbol,
      "15",
      KLINE_LIMIT_15M
    ),
    getTicker(
      category,
      symbol
    )
  ]);

  const one =
    analyze1m(k1);

  const fifteen =
    analyze15m(k15);

  const signal =
    scoreSignal(
      one,
      fifteen,
      strictness
    );

  const result = {
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

    oneMinute: one,

    fifteenMinute: fifteen,

    generatedAt:
      Date.now()
  };

  if (deep) {
    result.orderBook =
      await deepOrderBook(
        category,
        symbol
      );
  }

  return result;
}

/* =========================================================
   FIND SYMBOL
   ========================================================= */

async function resolveSymbol(input) {
  const clean =
    String(input || "")
      .trim()
      .toUpperCase()
      .replace(
        /[^A-Z0-9]/g,
        ""
      );

  if (!clean) return null;

  const symbols =
    await getSymbols();

  /*
    اول نماد دقیق
  */

  let found =
    symbols.find(
      x =>
        x.symbol === clean
    );

  if (found) return found;

  /*
    اگر فقط PEPE وارد شد
  */

  const withUSDT =
    clean.endsWith("USDT")
      ? clean
      : `${clean}USDT`;

  /*
    Futures اولویت دارد
  */

  found =
    symbols.find(
      x =>
        x.symbol === withUSDT &&
        x.category === "linear"
    );

  if (found) return found;

  /*
    سپس Spot
  */

  found =
    symbols.find(
      x =>
        x.symbol === withUSDT &&
        x.category === "spot"
    );

  if (found) return found;

  /*
    بر اساس baseCoin
  */

  const base =
    clean.endsWith("USDT")
      ? clean.slice(0, -4)
      : clean;

  found =
    symbols.find(
      x =>
        String(x.baseCoin)
          .toUpperCase() === base &&
        x.quoteCoin === "USDT"
    );

  return found || null;
}

/* =========================================================
   ROTATING SCANNER
   ========================================================= */

async function scanMarket(
  offset,
  strictness
) {
  const symbols =
    await getSymbols();

  if (!symbols.length) {
    throw new Error(
      "بازارهای Bybit دریافت نشد. API instruments-info پاسخ معتبر نداد."
    );
  }

  const total =
    symbols.length;

  const safeOffset =
    Math.floor(
      Math.max(
        0,
        num(offset)
      )
    ) % total;

  const selected = [];

  for (
    let i = 0;
    i < SCAN_BATCH;
    i++
  ) {
    const index =
      (
        safeOffset +
        i
      ) % total;

    selected.push(
      symbols[index]
    );
  }

  const results = [];

  /*
    تعداد همزمان محدود
    برای جلوگیری از فشار API
  */

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

    const batch =
      await Promise.all(
        chunk.map(
          async item => {
            try {
              return await analyzeSymbol(
                item.symbol,
                item.category,
                strictness,
                false
              );
            } catch {
              return null;
            }
          }
        )
      );

    for (const item of batch) {
      if (item) {
        results.push(item);
      }
    }

    await sleep(100);
  }

  /*
    فقط سیگنال‌هایی که:
    1. برخورد MA20 دارند
    2. امتیازشان از سخت‌گیری عبور کرده
    3. LONG/SHORT هستند
  */

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
        (a, b) =>
          b.score -
          a.score
      );

  /*
    برای ارزهای پیدا شده،
    تحلیل عمیق را جداگانه انجام می‌دهیم.
  */

  const deepSignals = [];

  for (const signal of signals) {
    try {
      const deep =
        await analyzeSymbol(
          signal.symbol,
          signal.category,
          strictness,
          true
        );

      deepSignals.push(deep);
    } catch {
      deepSignals.push(signal);
    }

    await sleep(80);
  }

  return {
    ok: true,

    mode:
      "personal",

    version:
      PERSONAL_VERSION,

    strictness:
      clamp(strictness),

    batchSize:
      SCAN_BATCH,

    checked:
      results.length,

    totalMarkets:
      total,

    offset:
      safeOffset,

    nextOffset:
      (
        safeOffset +
        SCAN_BATCH
      ) % total,

    results:
      deepSignals,

    generatedAt:
      Date.now()
  };
}

/* =========================================================
   HEALTH
   ========================================================= */

async function health() {
  let spotCount = 0;
  let futuresCount = 0;

  try {
    const spot =
      await getInstruments("spot");

    spotCount =
      spot.filter(
        validSpot
      ).length;
  } catch {}

  try {
    const linear =
      await getInstruments("linear");

    futuresCount =
      linear.filter(
        validLinear
      ).length;
  } catch {}

  return {
    ok: true,

    service:
      "Bybit Personal Smart Money Scanner",

    version:
      PERSONAL_VERSION,

    mode:
      "personal",

    signalCore:
      "1m PRICE TOUCH MA20",

    confirmation:
      "15m MA20",

    scanBatch:
      SCAN_BATCH,

    strictness:
      "0-100",

    markets: {
      spot:
        spotCount,

      futures:
        futuresCount
    },

    features: [
      "1m MA20 Touch",
      "1m MA20 Cross",
      "1m MA20 Rejection",
      "1m MA20 Slope",
      "1m Price Distance",
      "1m Volume",
      "1m Volume Spike",
      "1m RSI",
      "1m ATR",
      "1m Bollinger Width",
      "15m MA7",
      "15m MA20",
      "15m MA20 Slope",
      "15m Trend Confirmation",
      "Order Book",
      "Rotating Scan",
      "Deep Analysis"
    ],

    timeframes: [
      "1",
      "15"
    ],

    time:
      Date.now()
  };
}

/* =========================================================
   REQUEST HANDLER
   ========================================================= */

async function handle(request) {
  const url =
    new URL(request.url);

  const path =
    url.pathname;

  if (
    request.method === "OPTIONS"
  ) {
    return new Response(
      null,
      {
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,OPTIONS",
          "access-control-allow-headers": "*"
        }
      }
    );
  }

  /* HEALTH */

  if (
    path === "/api/health" ||
    path === "/api/personal/health"
  ) {
    try {
      return json(
        await health()
      );
    } catch (e) {
      return json(
        {
          ok: false,
          error:
            e.message
        },
        500
      );
    }
  }

  /* ROTATING SCAN */

  if (
    path === "/api/personal/scan" ||
    path === "/api/scan"
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
          url.searchParams.get(
            "strictness"
          ) === null
            ? DEFAULT_STRICTNESS
            : url.searchParams.get(
                "strictness"
              )
        );

      return json(
        await scanMarket(
          offset,
          strictness
        )
      );
    } catch (e) {
      return json(
        {
          ok: false,

          error:
            e.message ||
            "خطا در اسکن بازار",

          version:
            PERSONAL_VERSION,

          hint:
            "اتصال Worker به API عمومی Bybit یا دریافت instruments-info بررسی شود."
        },
        500
      );
    }
  }

  /* MANUAL ANALYSIS */

  if (
    path === "/api/personal/analyze" ||
    path === "/api/analyze"
  ) {
    try {
      const input =
        url.searchParams.get(
          "symbol"
        );

      const strictness =
        clamp(
          url.searchParams.get(
            "strictness"
          ) === null
            ? DEFAULT_STRICTNESS
            : url.searchParams.get(
                "strictness"
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
        ok: true,

        mode:
          "personal",

        version:
          PERSONAL_VERSION,

        symbol:
          found.symbol,

        category:
          found.category,

        baseCoin:
          found.baseCoin,

        quoteCoin:
          found.quoteCoin,

        strictness,

        ...data,

        search: {
          input:
            String(input)
              .toUpperCase(),

          selected:
            found.category === "linear"
              ? "FUTURES"
              : "SPOT"
        }
      });
    } catch (e) {
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

/* =========================================================
   CLOUDFLARE WORKER
   ========================================================= */

export default {
  async fetch(
    request,
    env,
    ctx
  ) {
    return handle(request);
  }
};
