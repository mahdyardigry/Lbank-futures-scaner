const BYBIT_BASE = "https://api.bybit.com";

const TIMEFRAMES = [
  { key: "1", label: "1m", weight: 2 },
  { key: "3", label: "3m", weight: 3 },
  { key: "5", label: "5m", weight: 4 }
];

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

// =================================================
// CACHE
// =================================================

const CACHE = new Map();

function cacheGet(key, ttl = 15000) {
  const x = CACHE.get(key);
  if (!x) return null;

  if (Date.now() - x.time > ttl) {
    CACHE.delete(key);
    return null;
  }

  return x.data;
}

function cacheSet(key, data) {
  CACHE.set(key, {
    time: Date.now(),
    data
  });
}

// =================================================
// WORKER
// =================================================

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: cors
      });
    }

    try {

      // =========================
      // FUTURES
      // =========================

      if (url.pathname === "/api/futures") {

        const data = await bybit(
          "/v5/market/instruments-info?category=linear&limit=1000"
        );

        const list = data.result?.list || [];

        const futures = list
          .filter(x =>
            x.status === "Trading" &&
            x.quoteCoin === "USDT" &&
            !x.symbol.includes("-")
          )
          .map(x => x.symbol)
          .sort();

        return json({
          ok: true,
          source: "Bybit Futures",
          count: futures.length,
          futures
        });
      }

      // =========================
      // KLINE
      // =========================

      if (url.pathname === "/api/kline") {

        const symbol = normalizeSymbol(
          url.searchParams.get("symbol")
        );

        const interval =
          url.searchParams.get("interval") || "5";

        const limit = Math.min(
          200,
          Math.max(
            30,
            Number(url.searchParams.get("limit") || 100)
          )
        );

        if (!symbol) {
          return json({
            ok: false,
            error: "symbol required"
          }, 400);
        }

        const rows = await getKlines(
          symbol,
          interval,
          limit
        );

        return json({
          ok: true,
          symbol,
          interval,
          rows
        });
      }

      // =========================
      // MANUAL ANALYZE
      // =========================

      if (url.pathname === "/api/analyze") {

        const symbol = normalizeSymbol(
          url.searchParams.get("symbol")
        );

        if (!symbol) {
          return json({
            ok: false,
            error: "symbol required"
          }, 400);
        }

        const result =
          await analyzeSymbol(symbol, true);

        return json({
          ok: true,
          ...result
        });
      }

      // =========================
      // FOOTPRINT
      // =========================

      if (url.pathname === "/api/footprint") {

        const symbol = normalizeSymbol(
          url.searchParams.get("symbol")
        );

        if (!symbol) {
          return json({
            ok: false,
            error: "symbol required"
          }, 400);
        }

        return json({
          ok: true,
          symbol,
          footprint:
            await getFootprint(symbol)
        });
      }

      // =========================
      // SCAN
      // =========================

      if (url.pathname === "/api/scan") {

        const result =
          await scanMarket();

        return json({
          ok: true,
          source: "Bybit Futures",
          scanned: result.scanned,
          found: result.results.length,
          results: result.results
        });
      }

      return json({
        ok: false,
        error: "API endpoint not found"
      }, 404);

    } catch (e) {

      return json({
        ok: false,
        error: "Worker error",
        detail: e?.message || String(e)
      }, 500);
    }
  }
};


// =================================================
// FAST MARKET SCAN
// =================================================

async function scanMarket() {

  const tickerData = await bybit(
    "/v5/market/tickers?category=linear"
  );

  const tickers =
    tickerData.result?.list || [];

  const candidates =
    tickers
      .filter(x =>
        x.symbol &&
        x.symbol.endsWith("USDT") &&
        !x.symbol.includes("-") &&
        Number(x.turnover24h || 0) > 0
      )
      .sort(
        (a, b) =>
          Number(b.turnover24h || 0) -
          Number(a.turnover24h || 0)
      )
      .slice(0, 80);

  const lightResults = [];

  /*
   * مهم:
   * فقط تحلیل تکنیکال سبک برای 80 ارز.
   * Footprint در این مرحله گرفته نمی‌شود.
   */

  const batchSize = 8;

  for (
    let i = 0;
    i < candidates.length;
    i += batchSize
  ) {

    const batch =
      candidates.slice(i, i + batchSize);

    const batchResults =
      await Promise.all(
        batch.map(async ticker => {

          try {

            return await analyzeSymbol(
              ticker.symbol,
              false
            );

          } catch (e) {

            return null;

          }

        })
      );

    for (const r of batchResults) {

      if (
        r &&
        r.direction !== "WAIT" &&
        r.score >= 45
      ) {
        lightResults.push(r);
      }
    }
  }

  lightResults.sort(
    (a, b) => b.score - a.score
  );

  /*
   * فقط 5 کاندیدای اول وارد
   * بررسی سنگین می‌شوند.
   */

  const finalists =
    lightResults.slice(0, 5);

  const results = [];

  /*
   * بررسی سنگین به صورت ترتیبی
   * تا Worker به سقف subrequest نخورد.
   */

  for (const r of finalists) {

    try {

      const heavy =
        await deepConfirm(r);

      if (
        heavy &&
        heavy.direction !== "WAIT" &&
        heavy.score >= 60
      ) {
        results.push(heavy);
      }

    } catch (e) {

      r.deepError =
        e?.message || String(e);

      /*
       * خطای یک ارز باعث توقف کل اسکن نمی‌شود.
       */

      results.push(r);
    }
  }

  results.sort(
    (a, b) => b.score - a.score
  );

  return {
    scanned: candidates.length,
    results: results.slice(0, 10)
  };
}


// =================================================
// DEEP CONFIRMATION
// =================================================

async function deepConfirm(result) {

  const symbol =
    result.symbol;

  /*
   * فقط برای 5 کاندیدای اول:
   *
   * OI
   * Funding
   * Order Book
   * Liquidation proxy
   * Footprint
   */

  const [
    footprint,
    oi,
    funding,
    orderbook
  ] = await Promise.all([
    safeFootprint(symbol),
    safeOpenInterest(symbol),
    safeFunding(symbol),
    safeOrderBook(symbol)
  ]);

  result.footprint = footprint;
  result.oi = oi;
  result.funding = funding;
  result.orderbook = orderbook;

  const confirmation =
    evaluateDeepConfirmation(
      result
    );

  result.deepConfirmation =
    confirmation;

  /*
   * امتیاز نهایی
   */

  result.score =
    Math.min(
      100,
      Math.round(
        result.score +
        confirmation.bonus
      )
    );

  /*
   * اگر عوامل مهم خلاف جهت باشند:
   * ورود ممنوع
   */

  if (confirmation.blockEntry) {

    result.direction = "WAIT";

    result.entry = null;
    result.sl = null;
    result.tp1 = null;
    result.tp2 = null;
    result.tp3 = null;
    result.rr = null;
  }

  /*
   * فقط اگر تأیید کافی باشد
   * Entry/SL/TP ساخته می‌شود.
   */

  if (
    result.direction !== "WAIT" &&
    result.score >= 60
  ) {

    const main =
      result.timeframes["5"];

    const targets =
      calculateTargets(
        main,
        result.direction
      );

    result.entry = targets.entry;
    result.sl = targets.sl;
    result.tp1 = targets.tp1;
    result.tp2 = targets.tp2;
    result.tp3 = targets.tp3;
    result.rr = targets.rr;
  }

  return result;
}


// =================================================
// DEEP CONFIRMATION LOGIC
// =================================================

function evaluateDeepConfirmation(r) {

  let bonus = 0;

  let blockEntry = false;

  const direction =
    r.direction;

  const fp =
    r.footprint || {};

  const oi =
    r.oi || {};

  const funding =
    r.funding || {};

  const book =
    r.orderbook || {};

  /*
   * ==========================
   * FOOTPRINT
   * ==========================
   */

  if (direction === "SHORT") {

    if (Number(fp.deltaPercent) <= -20)
      bonus += 8;

    if (Number(fp.deltaPercent) >= 20)
      blockEntry = true;

  }

  if (direction === "LONG") {

    if (Number(fp.deltaPercent) >= 20)
      bonus += 8;

    if (Number(fp.deltaPercent) <= -20)
      blockEntry = true;

  }

  /*
   * ==========================
   * OI
   * ==========================
   *
   * برای حرکت نزولی:
   * OI صعودی + قیمت نزولی
   * می‌تواند نشانه ورود شورت باشد.
   */

  if (
    direction === "SHORT" &&
    Number(oi.changePercent) > 1
  ) {
    bonus += 5;
  }

  if (
    direction === "LONG" &&
    Number(oi.changePercent) > 1
  ) {
    bonus += 5;
  }

  /*
   * ==========================
   * FUNDING
   * ==========================
   */

  if (
    direction === "SHORT" &&
    Number(funding.rate) > 0
  ) {
    bonus += 3;
  }

  if (
    direction === "LONG" &&
    Number(funding.rate) < 0
  ) {
    bonus += 3;
  }

  /*
   * ==========================
   * ORDER BOOK WALL
   * ==========================
   */

  if (direction === "SHORT") {

    if (
      Number(book.askWallRatio) >
      Number(book.bidWallRatio) * 1.3
    ) {
      bonus += 6;
    }

    /*
     * دیوار خرید بسیار بزرگ:
     * ممکن است قیمت را برخلاف SHORT حرکت دهد.
     */

    if (
      Number(book.bidWallRatio) >
      Number(book.askWallRatio) * 2
    ) {
      blockEntry = true;
    }
  }

  if (direction === "LONG") {

    if (
      Number(book.bidWallRatio) >
      Number(book.askWallRatio) * 1.3
    ) {
      bonus += 6;
    }

    if (
      Number(book.askWallRatio) >
      Number(book.bidWallRatio) * 2
    ) {
      blockEntry = true;
    }
  }

  /*
   * ==========================
   * LARGE TRADE
   * ==========================
   */

  if (fp.largeTrade)
    bonus += 2;

  /*
   * ==========================
   * حداقل تأیید
   * ==========================
   */

  const deepConfirmations =
    countDeepConfirmations(r);

  /*
   * اگر فقط روند داریم ولی
   * تأیید Order Flow نداریم،
   * ورود ممنوع.
   */

  if (deepConfirmations < 2)
    blockEntry = true;

  return {
    bonus,
    blockEntry,
    confirmations: deepConfirmations
  };
}


function countDeepConfirmations(r) {

  let c = 0;

  const d =
    r.direction;

  const fp =
    r.footprint || {};

  const oi =
    r.oi || {};

  const funding =
    r.funding || {};

  const book =
    r.orderbook || {};

  if (d === "SHORT") {

    if (Number(fp.deltaPercent) < -15)
      c++;

    if (Number(oi.changePercent) > 0)
      c++;

    if (Number(funding.rate) > 0)
      c++;

    if (
      Number(book.askWallRatio) >
      Number(book.bidWallRatio)
    )
      c++;
  }

  if (d === "LONG") {

    if (Number(fp.deltaPercent) > 15)
      c++;

    if (Number(oi.changePercent) > 0)
      c++;

    if (Number(funding.rate) < 0)
      c++;

    if (
      Number(book.bidWallRatio) >
      Number(book.askWallRatio)
    )
      c++;
  }

  return c;
}


// =================================================
// OPEN INTEREST
// =================================================

async function safeOpenInterest(symbol) {

  try {

    const data =
      await bybit(
        "/v5/market/open-interest" +
        "?category=linear" +
        "&symbol=" +
        encodeURIComponent(symbol) +
        "&intervalTime=5min" +
        "&limit=2"
      );

    const list =
      data.result?.list || [];

    if (list.length < 2) {

      return {
        available: false,
        changePercent: 0
      };
    }

    const newest =
      Number(list[0].openInterest || 0);

    const old =
      Number(list[1].openInterest || 0);

    const changePercent =
      old > 0
        ? ((newest - old) / old) * 100
        : 0;

    return {
      available: true,
      current: newest,
      previous: old,
      changePercent
    };

  } catch (e) {

    return {
      available: false,
      error: e.message,
      changePercent: 0
    };
  }
}


// =================================================
// FUNDING
// =================================================

async function safeFunding(symbol) {

  try {

    const data =
      await bybit(
        "/v5/market/tickers" +
        "?category=linear" +
        "&symbol=" +
        encodeURIComponent(symbol)
      );

    const x =
      data.result?.list?.[0];

    return {
      available: !!x,
      rate:
        Number(
          x?.fundingRate || 0
        )
    };

  } catch (e) {

    return {
      available: false,
      rate: 0,
      error: e.message
    };
  }
}


// =================================================
// ORDER BOOK
// =================================================

async function safeOrderBook(symbol) {

  try {

    const data =
      await bybit(
        "/v5/market/orderbook" +
        "?category=linear" +
        "&symbol=" +
        encodeURIComponent(symbol) +
        "&limit=25"
      );

    const bids =
      data.result?.b || [];

    const asks =
      data.result?.a || [];

    let bidNotional = 0;
    let askNotional = 0;

    for (const b of bids) {

      const price = Number(b[0]);
      const size = Number(b[1]);

      bidNotional +=
        price * size;
    }

    for (const a of asks) {

      const price = Number(a[0]);
      const size = Number(a[1]);

      askNotional +=
        price * size;
    }

    /*
     * نسبت فشار دفتر سفارش
     */

    const total =
      bidNotional + askNotional;

    return {

      available: true,

      bidNotional,
      askNotional,

      bidWallRatio:
        total > 0
          ? bidNotional / total
          : 0,

      askWallRatio:
        total > 0
          ? askNotional / total
          : 0
    };

  } catch (e) {

    return {
      available: false,
      bidWallRatio: 0,
      askWallRatio: 0,
      error: e.message
    };
  }
}


// =================================================
// FOOTPRINT
// =================================================

async function safeFootprint(symbol) {

  try {

    return await getFootprint(symbol);

  } catch (e) {

    return {
      available: false,
      error: e.message,
      delta: 0,
      deltaPercent: 0,
      buyRatio: 0,
      sellRatio: 0,
      largeTrade: false
    };
  }
}


async function getFootprint(symbol) {

  const data =
    await bybit(
      "/v5/market/recent-trade" +
      "?category=linear" +
      "&symbol=" +
      encodeURIComponent(symbol) +
      "&limit=500"
    );

  const trades =
    data.result?.list || [];

  if (!trades.length) {

    return {
      available: false,
      trades: 0,
      buyVolume: 0,
      sellVolume: 0,
      delta: 0,
      deltaPercent: 0,
      buyRatio: 0,
      sellRatio: 0,
      largeTrade: false,
      largeTradeNotional: 0
    };
  }

  let buyVolume = 0;
  let sellVolume = 0;

  const notionals = [];

  let totalNotional = 0;

  for (const t of trades) {

    const price =
      Number(t.price || 0);

    const size =
      Number(t.size || 0);

    const notional =
      price * size;

    notionals.push(notional);

    totalNotional +=
      notional;

    if (
      String(t.side)
        .toLowerCase() === "buy"
    ) {

      buyVolume += size;

    } else {

      sellVolume += size;
    }
  }

  const totalVolume =
    buyVolume + sellVolume;

  const delta =
    buyVolume - sellVolume;

  const deltaPercent =
    totalVolume > 0
      ? delta / totalVolume * 100
      : 0;

  const buyRatio =
    totalVolume > 0
      ? buyVolume / totalVolume * 100
      : 0;

  const sellRatio =
    totalVolume > 0
      ? sellVolume / totalVolume * 100
      : 0;

  const averageNotional =
    trades.length > 0
      ? totalNotional / trades.length
      : 0;

  const threshold =
    averageNotional * 5;

  const largestTrade =
    Math.max(...notionals);

  return {

    available: true,

    trades: trades.length,

    buyVolume,

    sellVolume,

    delta,

    deltaPercent,

    buyRatio,

    sellRatio,

    largeTrade:
      largestTrade >= threshold,

    largeTradeNotional:
      largestTrade,

    averageTradeNotional:
      averageNotional
  };
}


// =================================================
// ANALYZE SYMBOL
// =================================================

async function analyzeSymbol(
  symbol,
  withDeep = false
) {

  const timeframes = {};

  const data =
    await Promise.all(
      TIMEFRAMES.map(async tf => {

        const rows =
          await getKlines(
            symbol,
            tf.key,
            100
          );

        return {
          key: tf.key,
          data:
            analyzeTimeframe(rows)
        };
      })
    );

  for (const x of data) {
    timeframes[x.key] = x.data;
  }

  const analyses =
    TIMEFRAMES
      .map(tf =>
        timeframes[tf.key]
      );

  let bullish = 0;
  let bearish = 0;

  for (const x of analyses) {

    if (x.trend === "BULLISH")
      bullish++;

    if (x.trend === "BEARISH")
      bearish++;
  }

  let longScore = 0;
  let shortScore = 0;

  for (const tf of TIMEFRAMES) {

    const x =
      timeframes[tf.key];

    const weight =
      tf.weight;

    if (x.trend === "BULLISH")
      longScore += weight;

    if (x.trend === "BEARISH")
      shortScore += weight;

    if (x.maSlope === "UP")
      longScore += 2;

    if (x.maSlope === "DOWN")
      shortScore += 2;

    if (x.structure === "BULLISH")
      longScore += 3;

    if (x.structure === "BEARISH")
      shortScore += 3;

    if (x.fvg.type === "BULLISH")
      longScore += 2;

    if (x.fvg.type === "BEARISH")
      shortScore += 2;

    if (x.volume.spike) {

      if (x.trend === "BULLISH")
        longScore += 2;

      if (x.trend === "BEARISH")
        shortScore += 2;
    }

    if (x.touchMA20) {

      if (x.trend === "BULLISH")
        longScore += 2;

      if (x.trend === "BEARISH")
        shortScore += 2;
    }
  }

  if (bullish === 3)
    longScore += 10;

  if (bearish === 3)
    shortScore += 10;

  let direction = "WAIT";

  if (
    longScore > shortScore &&
    longScore >= 12
  ) {
    direction = "LONG";
  }

  if (
    shortScore > longScore &&
    shortScore >= 12
  ) {
    direction = "SHORT";
  }

  const main =
    timeframes["5"];

  let score =
    calculateFinalScore(
      main,
      direction,
      bullish,
      bearish
    );

  let targets = null;

  /*
   * در تحلیل دستی می‌توانیم
   * اطلاعات عمیق را هم بگیریم.
   */

  let deep = null;

  if (withDeep && direction !== "WAIT") {

    deep =
      await deepConfirm({
        symbol,
        direction,
        score,
        timeframes
      });

    score =
      deep.score;

    targets = {
      entry: deep.entry,
      sl: deep.sl,
      tp1: deep.tp1,
      tp2: deep.tp2,
      tp3: deep.tp3,
      rr: deep.rr
    };
  }

  return {

    symbol,

    direction,

    score,

    mainTimeframe: "5",

    price: main.price,

    entry:
      targets?.entry || null,

    sl:
      targets?.sl || null,

    tp1:
      targets?.tp1 || null,

    tp2:
      targets?.tp2 || null,

    tp3:
      targets?.tp3 || null,

    rr:
      targets?.rr || null,

    bullishTimeframes:
      bullish,

    bearishTimeframes:
      bearish,

    confirmations:
      countConfirmations(
        main,
        direction,
        bullish,
        bearish
      ),

    timeframes,

    footprint:
      deep?.footprint || null,

    oi:
      deep?.oi || null,

    funding:
      deep?.funding || null,

    orderbook:
      deep?.orderbook || null,

    deepConfirmation:
      deep?.deepConfirmation || null
  };
}


// =================================================
// TIMEFRAME
// =================================================

function analyzeTimeframe(rows) {

  if (!rows || rows.length < 30)
    throw new Error(
      "Not enough candles"
    );

  const closes =
    rows.map(x => x.close);

  const volumes =
    rows.map(x => x.volume);

  const price =
    closes[closes.length - 1];

  const ma7 =
    sma(closes, 7);

  const ma20 =
    sma(closes, 20);

  const previousMA20 =
    sma(
      closes.slice(0, -1),
      20
    );

  let maSlope = "FLAT";

  if (ma20 > previousMA20)
    maSlope = "UP";

  if (ma20 < previousMA20)
    maSlope = "DOWN";

  let trend = "RANGE";

  if (ma7 > ma20)
    trend = "BULLISH";

  if (ma7 < ma20)
    trend = "BEARISH";

  const current =
    rows[rows.length - 1];

  const touchMA20 =
    current.low <= ma20 &&
    current.high >= ma20;

  const structure =
    detectStructure(rows);

  const fvg =
    detectFVG(rows);

  const volumeMA7 =
    sma(volumes, 7);

  const volumeMA20 =
    sma(volumes, 20);

  const volumeSpike =
    current.volume >
    volumeMA20 * 1.5;

  return {

    price,

    ma7,

    ma20,

    maSlope,

    trend,

    touchMA20,

    reaction:
      current.close > current.open
        ? "BULLISH"
        : current.close < current.open
          ? "BEARISH"
          : "NEUTRAL",

    structure,

    fvg,

    volume: {
      current: current.volume,
      ma7: volumeMA7,
      ma20: volumeMA20,
      spike: volumeSpike
    }
  };
}


// =================================================
// STRUCTURE
// =================================================

function detectStructure(rows) {

  if (rows.length < 12)
    return "NONE";

  const n =
    rows.length;

  const h1 =
    rows[n - 7].high;

  const h2 =
    rows[n - 4].high;

  const h3 =
    rows[n - 1].high;

  const l1 =
    rows[n - 7].low;

  const l2 =
    rows[n - 4].low;

  const l3 =
    rows[n - 1].low;

  if (
    h3 > h2 &&
    h2 > h1 &&
    l3 > l2
  )
    return "BULLISH";

  if (
    h3 < h2 &&
    h2 < h1 &&
    l3 < l2
  )
    return "BEARISH";

  return "NONE";
}


// =================================================
// FVG
// =================================================

function detectFVG(rows) {

  if (rows.length < 3)
    return {
      type: "NONE",
      bottom: null,
      top: null,
      status: "NONE"
    };

  const a =
    rows[rows.length - 3];

  const c =
    rows[rows.length - 1];

  if (c.low > a.high) {

    return {
      type: "BULLISH",
      bottom: a.high,
      top: c.low,
      status: "ACTIVE"
    };
  }

  if (c.high < a.low) {

    return {
      type: "BEARISH",
      bottom: c.high,
      top: a.low,
      status: "ACTIVE"
    };
  }

  return {
    type: "NONE",
    bottom: null,
    top: null,
    status: "NONE"
  };
}


// =================================================
// SCORE
// =================================================

function calculateFinalScore(
  x,
  direction,
  bullish,
  bearish
) {

  if (!x || direction === "WAIT")
    return 0;

  let score = 0;

  if (
    direction === "LONG" &&
    x.maSlope === "UP"
  )
    score += 20;

  if (
    direction === "SHORT" &&
    x.maSlope === "DOWN"
  )
    score += 20;

  if (x.touchMA20)
    score += 10;

  if (
    direction === "LONG" &&
    x.structure === "BULLISH"
  )
    score += 20;

  if (
    direction === "SHORT" &&
    x.structure === "BEARISH"
  )
    score += 20;

  if (
    direction === "LONG" &&
    x.fvg.type === "BULLISH"
  )
    score += 15;

  if (
    direction === "SHORT" &&
    x.fvg.type === "BEARISH"
  )
    score += 15;

  if (x.volume.spike)
    score += 10;

  if (
    direction === "LONG" &&
    bullish === 3
  )
    score += 25;

  if (
    direction === "SHORT" &&
    bearish === 3
  )
    score += 25;

  return Math.min(
    100,
    Math.round(score)
  );
}


// =================================================
// CONFIRMATIONS
// =================================================

function countConfirmations(
  x,
  direction,
  bullish,
  bearish
) {

  let c = 0;

  if (
    direction === "LONG" &&
    x.maSlope === "UP"
  )
    c++;

  if (
    direction === "SHORT" &&
    x.maSlope === "DOWN"
  )
    c++;

  if (x.touchMA20)
    c++;

  if (
    direction === "LONG" &&
    x.structure === "BULLISH"
  )
    c++;

  if (
    direction === "SHORT" &&
    x.structure === "BEARISH"
  )
    c++;

  if (
    direction === "LONG" &&
    x.fvg.type === "BULLISH"
  )
    c++;

  if (
    direction === "SHORT" &&
    x.fvg.type === "BEARISH"
  )
    c++;

  if (x.volume.spike)
    c++;

  if (
    bullish === 3 ||
    bearish === 3
  )
    c++;

  return c;
}


// =================================================
// TARGETS
// =================================================

function calculateTargets(
  x,
  direction
) {

  const price =
    x.price;

  if (direction === "LONG") {

    const sl =
      price * 0.985;

    const risk =
      price - sl;

    return {

      entry: price,

      sl,

      tp1:
        price + risk,

      tp2:
        price + risk * 2,

      tp3:
        price + risk * 3,

      rr: "1:3"
    };
  }

  const sl =
    price * 1.015;

  const risk =
    sl - price;

  return {

    entry: price,

    sl,

    tp1:
      price - risk,

    tp2:
      price - risk * 2,

    tp3:
      price - risk * 3,

    rr: "1:3"
  };
}


// =================================================
// KLINES
// =================================================

async function getKlines(
  symbol,
  interval,
  limit = 100
) {

  const data =
    await bybit(
      "/v5/market/kline" +
      "?category=linear" +
      "&symbol=" +
      encodeURIComponent(symbol) +
      "&interval=" +
      encodeURIComponent(interval) +
      "&limit=" +
      limit
    );

  return (
    data.result?.list || []
  )
    .reverse()
    .map(x => ({
      time: Number(x[0]),
      open: Number(x[1]),
      high: Number(x[2]),
      low: Number(x[3]),
      close: Number(x[4]),
      volume: Number(x[5])
    }));
}


// =================================================
// BYBIT
// =================================================

async function bybit(path) {

  const response =
    await fetch(
      BYBIT_BASE + path,
      {
        headers: {
          Accept:
            "application/json"
        }
      }
    );

  if (!response.ok) {

    throw new Error(
      "Bybit HTTP " +
      response.status
    );
  }

  const data =
    await response.json();

  if (
    data.retCode !== undefined &&
    data.retCode !== 0
  ) {

    throw new Error(
      data.retMsg ||
      "Bybit API error"
    );
  }

  return data;
}


// =================================================
// HELPERS
// =================================================

function normalizeSymbol(symbol) {

  if (!symbol)
    return "";

  return String(symbol)
    .trim()
    .toUpperCase()
    .replace("/", "")
    .replace("-", "");
}


function sma(data, period) {

  if (
    !data ||
    data.length < period
  )
    return null;

  const part =
    data.slice(
      data.length - period
    );

  return part.reduce(
    (a, b) =>
      a + Number(b),
    0
  ) / period;
}


function json(
  data,
  status = 200
) {

  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        ...cors,
        "Content-Type":
          "application/json; charset=utf-8"
      }
    }
  );
}
