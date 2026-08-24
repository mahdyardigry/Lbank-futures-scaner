const BYBIT = "https://api.bybit.com";

const PERSONAL_VERSION = "PERSONAL-MA20-V1";

const SCAN_BATCH = 20;
const KLINE_LIMIT_1M = 80;
const KLINE_LIMIT_15M = 80;

const DEFAULT_STRICTNESS = 50;

const sleep = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "content-type": "application/json; charset=UTF-8",
        "cache-control": "no-store"
      }
    }
  );
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function clamp(v, min = 0, max = 100) {
  return Math.max(min, Math.min(max, v));
}

function sma(values, period) {
  if (!values || values.length < period) return 0;

  const arr = values.slice(-period);

  return arr.reduce(
    (a, b) => a + num(b),
    0
  ) / period;
}

function ema(values, period) {
  if (!values || values.length < period)
    return 0;

  const k = 2 / (period + 1);

  let e = sma(
    values.slice(0, period),
    period
  );

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

function stddev(values) {
  if (!values.length) return 0;

  const avg =
    values.reduce(
      (a, b) => a + num(b),
      0
    ) / values.length;

  const variance =
    values.reduce(
      (a, b) =>
        a +
        Math.pow(
          num(b) - avg,
          2
        ),
      0
    ) / values.length;

  return Math.sqrt(variance);
}

function rsi(values, period = 14) {
  if (values.length < period + 1)
    return 50;

  let gains = 0;
  let losses = 0;

  for (
    let i = values.length - period;
    i < values.length;
    i++
  ) {
    const diff =
      num(values[i]) -
      num(values[i - 1]);

    if (diff >= 0)
      gains += diff;
    else
      losses -= diff;
  }

  if (losses === 0)
    return 100;

  const rs =
    (gains / period) /
    (losses / period);

  return 100 - 100 / (1 + rs);
}

function atr(candles, period = 14) {
  if (candles.length < period + 1)
    return 0;

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

  return (
    trs.reduce((a, b) => a + b, 0) /
    trs.length
  );
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
    .sort(
      (a, b) =>
        a.time - b.time
    );
}

async function bybit(path) {
  const r = await fetch(
    BYBIT + path,
    {
      headers: {
        "accept": "application/json"
      }
    }
  );

  if (!r.ok)
    throw new Error(
      `Bybit HTTP ${r.status}`
    );

  const d = await r.json();

  if (
    d.retCode !== 0
  ) {
    throw new Error(
      d.retMsg ||
      "Bybit API error"
    );
  }

  return d.result;
}

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

  if (!x)
    return false;

  if (
    x.status !== "Trading"
  )
    return false;

  if (
    x.quoteCoin !== "USDT"
  )
    return false;

  if (
    x.symbol.includes("USDC") ||
    x.symbol.includes("USDE") ||
    x.symbol.includes("USD")
  )
    return false;

  return true;
}

async function getSymbols() {

  const spot =
    await getInstruments(
      "spot"
    );

  const futures =
    await getInstruments(
      "linear"
    );

  const map =
    new Map();

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

async function getTicker(category, symbol) {

  const d =
    await bybit(
      `/v5/market/tickers?category=${category}&symbol=${encodeURIComponent(symbol)}`
    );

  return d.list?.[0] || null;
}

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
    d.list || []
  );
}

async function getOrderbook(
  category,
  symbol
) {

  const d =
    await bybit(
      `/v5/market/orderbook?category=${category}&symbol=${encodeURIComponent(symbol)}&limit=25`
    );

  return d;
}

function analyzeMA20(candles) {

  if (
    !candles ||
    candles.length < 30
  ) {
    return {
      ok: false,
      reason: "کندل کافی نیست"
    };
  }

  const closes =
    candles.map(
      x => x.close
    );

  const current =
    candles[candles.length - 1];

  const previous =
    candles[candles.length - 2];

  const ma20 =
    sma(
      closes,
      20
    );

  const previousCloses =
    closes.slice(
      0,
      -1
    );

  const previousMA20 =
    sma(
      previousCloses,
      20
    );

  const maSlope =
    ma20 - previousMA20;

  const slopePct =
    previousMA20
      ? (
          maSlope /
          previousMA20
        ) * 100
      : 0;

  const distancePct =
    ma20
      ? (
          (
            current.close -
            ma20
          ) /
          ma20
        ) * 100
      : 0;

  const previousDistancePct =
    previousMA20
      ? (
          (
            previous.close -
            previousMA20
          ) /
          previousMA20
        ) * 100
      : 0;

  const currentAbove =
    current.close >= ma20;

  const previousAbove =
    previous.close >=
    previousMA20;

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
    Math.abs(
      distancePct
    ) <= 0.35;

  const rejectionUp =
    current.low <= ma20 &&
    current.close > ma20;

  const rejectionDown =
    current.high >= ma20 &&
    current.close < ma20;

  let direction =
    "NONE";

  if (
    crossedUp ||
    rejectionUp
  )
    direction = "LONG";

  if (
    crossedDown ||
    rejectionDown
  )
    direction = "SHORT";

  const atrValue =
    atr(candles, 14);

  const atrPct =
    current.close
      ? (
          atrValue /
          current.close
        ) * 100
      : 0;

  const volumeValues =
    candles
      .slice(-21, -1)
      .map(x => x.volume);

  const averageVolume =
    sma(
      volumeValues,
      Math.min(
        20,
        volumeValues.length
      )
    );

  const volumeRatio =
    averageVolume
      ? current.volume /
        averageVolume
      : 0;

  const volumeSpike =
    volumeRatio >= 1.5;

  const rsiValue =
    rsi(
      closes,
      14
    );

  const recent =
    closes.slice(-20);

  const middle =
    sma(
      recent,
      20
    );

  const deviation =
    stddev(recent);

  const upper =
    middle +
    deviation * 2;

  const lower =
    middle -
    deviation * 2;

  const bbWidth =
    middle
      ? (
          (
            upper -
            lower
          ) /
          middle
        ) * 100
      : 0;

  return {
    ok: true,

    price:
      current.close,

    ma20,

    previousMA20,

    maSlope,

    maSlopePct:
      slopePct,

    distancePct,

    previousDistancePct,

    touched,

    near,

    crossedUp,

    crossedDown,

    rejectionUp,

    rejectionDown,

    direction,

    atr:
      atrValue,

    atrPct,

    volume:
      current.volume,

    averageVolume,

    volumeRatio,

    volumeSpike,

    rsi:
      rsiValue,

    bollingerWidth:
      bbWidth
  };
}

function analyze15m(candles) {

  if (
    !candles ||
    candles.length < 30
  ) {
    return {
      ok: false
    };
  }

  const closes =
    candles.map(
      x => x.close
    );

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

  const previous =
    sma(
      closes.slice(0, -1),
      20
    );

  const slope =
    ma20 - previous;

  const slopePct =
    previous
      ? (
          slope /
          previous
        ) * 100
      : 0;

  const current =
    closes[closes.length - 1];

  let direction =
    "RANGE";

  if (
    current > ma20 &&
    ma7 > ma20 &&
    slope > 0
  ) {
    direction =
      "LONG";
  }
  else if (
    current < ma20 &&
    ma7 < ma20 &&
    slope < 0
  ) {
    direction =
      "SHORT";
  }

  return {
    ok: true,

    price:
      current,

    ma7,

    ma20,

    slope,

    slopePct,

    direction,

    rsi:
      rsi(
        closes,
        14
      ),

    atr:
      atr(
        candles,
        14
      )
  };
}

function scoreSignal(
  one,
  fifteen,
  strictness
) {

  const reasons = [];

  let long = 0;
  let short = 0;

  if (!one.ok)
    return {
      score: 0,
      longScore: 0,
      shortScore: 0,
      direction: "NONE",
      reasons
    };

  /*
    هسته اصلی سیگنال:
    برخورد قیمت با MA20 در 1m
  */

  if (one.touched) {

    if (
      one.direction ===
      "LONG"
    ) {

      long += 30;

      reasons.push({
        side: "LONG",
        text:
          "برخورد قیمت با MA20 در 1m"
      });

    }

    if (
      one.direction ===
      "SHORT"
    ) {

      short += 30;

      reasons.push({
        side: "SHORT",
        text:
          "برخورد قیمت با MA20 در 1m"
      });
    }
  }

  if (one.near) {

    if (
      one.distancePct >= 0
    ) {

      long += 8;

      reasons.push({
        side: "LONG",
        text:
          "قیمت نزدیک و بالای MA20 در 1m"
      });

    }
    else {

      short += 8;

      reasons.push({
        side: "SHORT",
        text:
          "قیمت نزدیک و پایین MA20 در 1m"
      });
    }
  }

  /*
    شیب MA20
  */

  if (
    one.maSlopePct >
    0.015
  ) {

    long += 15;

    reasons.push({
      side: "LONG",
      text:
        "شیب MA20 صعودی در 1m"
    });

  }
  else if (
    one.maSlopePct <
    -0.015
  ) {

    short += 15;

    reasons.push({
      side: "SHORT",
      text:
        "شیب MA20 نزولی در 1m"
    });
  }

  /*
    رد شدن قیمت از MA20
  */

  if (
    one.rejectionUp
  ) {

    long += 10;

    reasons.push({
      side: "LONG",
      text:
        "بازگشت قیمت از MA20 به سمت بالا"
    });

  }

  if (
    one.rejectionDown
  ) {

    short += 10;

    reasons.push({
      side: "SHORT",
      text:
        "بازگشت قیمت از MA20 به سمت پایین"
    });
  }

  /*
    حجم
  */

  if (
    one.volumeRatio >= 1.5
  ) {

    if (
      one.direction ===
      "LONG"
    ) {

      long += 8;

      reasons.push({
        side: "LONG",
        text:
          "افزایش غیرعادی حجم در برخورد"
      });

    }

    if (
      one.direction ===
      "SHORT"
    ) {

      short += 8;

      reasons.push({
        side: "SHORT",
        text:
          "افزایش غیرعادی حجم در برخورد"
      });
    }

  }
  else if (
    one.volumeRatio >= 1.15
  ) {

    if (
      one.direction ===
      "LONG"
    )
      long += 4;

    if (
      one.direction ===
      "SHORT"
    )
      short += 4;
  }

  /*
    RSI
  */

  if (
    one.rsi >= 52
  ) {

    long += 5;

    reasons.push({
      side: "LONG",
      text:
        "RSI بالای 52 در 1m"
    });

  }
  else if (
    one.rsi <= 48
  ) {

    short += 5;

    reasons.push({
      side: "SHORT",
      text:
        "RSI زیر 48 در 1m"
    });
  }

  /*
    تأیید 15m
  */

  if (
    fifteen?.direction ===
    "LONG"
  ) {

    long += 15;

    reasons.push({
      side: "LONG",
      text:
        "تأیید روند صعودی در 15m"
    });

  }
  else if (
    fifteen?.direction ===
    "SHORT"
  ) {

    short += 15;

    reasons.push({
      side: "SHORT",
      text:
        "تأیید روند نزولی در 15m"
    });
  }

  /*
    اگر 15m خلاف جهت باشد
  */

  if (
    one.direction ===
    "LONG" &&
    fifteen?.direction ===
    "SHORT"
  ) {

    long -= 12;

    reasons.push({
      side: "LONG",
      text:
        "15m خلاف جهت سیگنال 1m است"
    });
  }

  if (
    one.direction ===
    "SHORT" &&
    fifteen?.direction ===
    "LONG"
  ) {

    short -= 12;

    reasons.push({
      side: "SHORT",
      text:
        "15m خلاف جهت سیگنال 1m است"
    });
  }

  long =
    clamp(long);

  short =
    clamp(short);

  const direction =
    long > short
      ? "LONG"
      : short > long
        ? "SHORT"
        : "WAIT";

  const raw =
    Math.max(
      long,
      short
    );

  /*
    سخت‌گیری:

    0  = حداقل شرط
    100 = سخت‌ترین شرط

    آستانه از 25 تا 90 تغییر می‌کند.
  */

  const threshold =
    25 +
    (
      clamp(strictness) *
      0.65
    );

  const qualifies =
    raw >= threshold;

  return {
    score:
      Math.round(
        raw
      ),

    longScore:
      Math.round(
        long
      ),

    shortScore:
      Math.round(
        short
      ),

    direction:
      qualifies
        ? direction
        : "WAIT",

    threshold:
      Math.round(
        threshold
      ),

    qualifies,

    reasons
  };
}

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
    analyzeMA20(k1);

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
      num(
        ticker?.lastPrice
      ) ||
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

    oneMinute: {

      price:
        one.price,

      ma20:
        one.ma20,

      previousMA20:
        one.previousMA20,

      maSlope:
        one.maSlope,

      maSlopePct:
        one.maSlopePct,

      distancePct:
        one.distancePct,

      previousDistancePct:
        one.previousDistancePct,

      touched:
        one.touched,

      near:
        one.near,

      crossedUp:
        one.crossedUp,

      crossedDown:
        one.crossedDown,

      rejectionUp:
        one.rejectionUp,

      rejectionDown:
        one.rejectionDown,

      direction:
        one.direction,

      volume:
        one.volume,

      averageVolume:
        one.averageVolume,

      volumeRatio:
        one.volumeRatio,

      volumeSpike:
        one.volumeSpike,

      rsi:
        one.rsi,

      atr:
        one.atr,

      atrPct:
        one.atrPct,

      bollingerWidth:
        one.bollingerWidth
    },

    fifteenMinute: {

      price:
        fifteen.price,

      ma7:
        fifteen.ma7,

      ma20:
        fifteen.ma20,

      slope:
        fifteen.slope,

      slopePct:
        fifteen.slopePct,

      direction:
        fifteen.direction,

      rsi:
        fifteen.rsi,

      atr:
        fifteen.atr
    },

    generatedAt:
      Date.now()
  };

  if (deep) {

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
            size: num(x[1])
          }));

      const asks =
        (book.a || [])
          .map(x => ({
            price: num(x[0]),
            size: num(x[1])
          }));

      const buyLiquidity =
        bids.reduce(
          (sum, x) =>
            sum +
            x.price *
            x.size,
          0
        );

      const sellLiquidity =
        asks.reduce(
          (sum, x) =>
            sum +
            x.price *
            x.size,
          0
        );

      result.orderBook = {

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

        buyLevels:
          bids.slice(0, 10),

        sellLevels:
          asks.slice(0, 10)
      };

    }
    catch {

      result.orderBook = {
        error:
          "Order Book در دسترس نیست."
      };
    }
  }

  return result;
}

async function resolveSymbol(input) {

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

  let exact =
    symbols.find(
      x =>
        x.symbol ===
        clean
    );

  if (exact)
    return exact;

  if (
    !clean.endsWith("USDT")
  ) {

    exact =
      symbols.find(
        x =>
          x.symbol ===
          clean + "USDT"
      );

    if (exact)
      return exact;
  }

  const base =
    clean.endsWith("USDT")
      ? clean.slice(
          0,
          -4
        )
      : clean;

  const matches =
    symbols.filter(
      x =>
        x.baseCoin ===
        base &&
        x.quoteCoin ===
        "USDT"
    );

  if (matches.length)
    return matches[0];

  return null;
}

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

  /*
    برای اسکن چرخشی،
    نمادها بر اساس ترتیب ثابت
    انتخاب می‌شوند.
  */

  const total =
    symbols.length;

  const selected = [];

  for (
    let i = 0;
    i < SCAN_BATCH;
    i++
  ) {

    const index =
      (
        offset +
        i
      ) % total;

    selected.push(
      symbols[index]
    );
  }

  const results = [];

  /*
    تحلیل همزمان محدود
    برای جلوگیری از فشار روی API
  */

  const concurrency = 4;

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

    await sleep(50);
  }

  /*
    فقط سیگنال‌های عبور کرده
    از درجه سخت‌گیری برگردانده می‌شوند.
  */

  const signals =
    results
      .filter(
        x =>
          x.qualifies &&
          (
            x.direction ===
              "LONG" ||
            x.direction ===
              "SHORT"
          )
      )
      .sort(
        (a, b) =>
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
      clamp(
        strictness
      ),

    batchSize:
      SCAN_BATCH,

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

    results:
      signals,

    generatedAt:
      Date.now()
  };
}

async function health() {

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
      "15m",

    scanBatch:
      SCAN_BATCH,

    strictness:
      "0-100",

    features: [

      "1m MA20 Touch",

      "MA20 Slope",

      "Price Distance",

      "MA20 Cross",

      "MA20 Rejection",

      "Volume",

      "Volume Spike",

      "RSI",

      "ATR",

      "Bollinger Width",

      "15m Confirmation",

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

  /*
    اسکن چرخشی شخصی
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
          num(
            url.searchParams.get(
              "offset"
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
    تحلیل دستی:
    فقط نام ارز.
    Worker خودش Spot/Futures
    را پیدا می‌کند.
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
              `${input.toUpperCase()} در Spot یا Futures Bybit پیدا نشد.`,
            search: {
              input:
                input.toUpperCase(),
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
            input.toUpperCase(),

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

  /*
    برای سازگاری با صفحه شخصی قبلی
  */

  if (
    path ===
    "/api/personal/health"
  ) {

    return json(
      await health()
    );
  }

  return json(
    {
      ok: false,
      error:
        "Personal API route not found.",
      routes: [
        "/api/health",
        "/api/personal/scan",
        "/api/personal/analyze"
      ]
    },
    404
  );
}

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
