const BYBIT_BASE = "https://api.bybit.com";

const TIMEFRAMES = [
  { key: "1", label: "1 دقیقه (1m)", weight: 2 },
  { key: "3", label: "3 دقیقه (3m)", weight: 3 },
  { key: "5", label: "5 دقیقه (5m)", weight: 4 }
];

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

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
          url.searchParams.get("interval") || "15";

        let limit = Number(
          url.searchParams.get("limit") || 100
        );

        limit = Math.max(30, Math.min(limit, 200));

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
          footprint: await getFootprint(symbol)
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
      // MARKET SCAN
      // =========================
      if (url.pathname === "/api/scan") {

        const results = await scanMarket();

        return json({
          ok: true,
          source: "Bybit Futures",
          scanned: results.scanned,
          found: results.results.length,
          results: results.results
        });
      }

      return json({
        ok: false,
        error: "API endpoint not found"
      }, 404);

    } catch (error) {

      return json({
        ok: false,
        error: "Worker error",
        detail: error?.message || String(error)
      }, 500);
    }
  }
};


// =====================================================
// MARKET SCAN
// =====================================================

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

  const results = [];

  /*
    مهم:
    به‌جای اینکه برای 80 ارز همزمان
    ده‌ها درخواست بزنیم، دسته‌های کوچک
    استفاده می‌کنیم تا دوباره به خطای
    Too many subrequests نخوریم.
  */

  const batchSize = 4;

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
        r.score >= 70 &&
        r.entryReady === true
      ) {
        results.push(r);
      }

    }
  }

  results.sort(
    (a, b) => b.score - a.score
  );

  /*
    فقط 5 کاندید برتر را دوباره
    با Footprint بررسی می‌کنیم.
    این کار سرعت را بالا نگه می‌دارد.
  */

  const top =
    results.slice(0, 5);

  const enriched = [];

  for (const r of top) {

    try {

      r.footprint =
        await getFootprint(r.symbol);

      /*
        بعد از Footprint دوباره
        فیلتر نهایی انجام می‌شود.
      */

      const finalCheck =
        finalFootprintCheck(
          r.direction,
          r.footprint
        );

      r.footprintConfirmation =
        finalCheck;

      if (finalCheck.ok) {

        r.score =
          Math.min(
            100,
            r.score + 5
          );

        enriched.push(r);

      }

    } catch (e) {

      /*
        اگر Footprint نتوانست دریافت شود،
        سیگنال را حذف می‌کنیم.
      */

    }
  }

  enriched.sort(
    (a, b) => b.score - a.score
  );

  return {
    scanned: candidates.length,
    results: enriched.slice(0, 10)
  };
}


// =====================================================
// ANALYZE SYMBOL
// =====================================================

async function analyzeSymbol(
  symbol,
  withFootprint = false
) {

  /*
    داده‌های اصلی را با حداقل درخواست
    دریافت می‌کنیم.
  */

  const [
    tf1,
    tf3,
    tf5,
    derivatives,
    orderbook
  ] = await Promise.all([

    getKlines(symbol, "1", 80),

    getKlines(symbol, "3", 80),

    getKlines(symbol, "5", 80),

    getDerivatives(symbol),

    getOrderBook(symbol)

  ]);

  const timeframes = {

    "1": analyzeTimeframe(tf1),

    "3": analyzeTimeframe(tf3),

    "5": analyzeTimeframe(tf5)

  };

  let bullish = 0;
  let bearish = 0;

  for (const key of ["1", "3", "5"]) {

    const x = timeframes[key];

    if (x.trend === "BULLISH")
      bullish++;

    if (x.trend === "BEARISH")
      bearish++;

  }

  let longScore = 0;
  let shortScore = 0;

  // ==========================================
  // TIMEFRAME ANALYSIS
  // ==========================================

  for (const tf of TIMEFRAMES) {

    const x =
      timeframes[tf.key];

    const w = tf.weight;

    if (x.trend === "BULLISH")
      longScore += 5 * w;

    if (x.trend === "BEARISH")
      shortScore += 5 * w;

    if (x.maSlope === "UP")
      longScore += 3 * w;

    if (x.maSlope === "DOWN")
      shortScore += 3 * w;

    if (x.structure === "BULLISH")
      longScore += 5 * w;

    if (x.structure === "BEARISH")
      shortScore += 5 * w;

    if (x.fvg.type === "BULLISH")
      longScore += 3 * w;

    if (x.fvg.type === "BEARISH")
      shortScore += 3 * w;

    if (x.touchMA20) {

      if (x.trend === "BULLISH")
        longScore += 2 * w;

      if (x.trend === "BEARISH")
        shortScore += 2 * w;
    }

    if (x.volume.spike) {

      if (x.trend === "BULLISH")
        longScore += 3 * w;

      if (x.trend === "BEARISH")
        shortScore += 3 * w;
    }
  }

  // ==========================================
  // MULTI TIMEFRAME
  // ==========================================

  if (bullish === 3)
    longScore += 15;

  if (bearish === 3)
    shortScore += 15;

  /*
    اگر 5m مخالف 1m باشد،
    امتیاز ورود را کم می‌کنیم.
  */

  if (
    timeframes["1"].trend === "BULLISH" &&
    timeframes["5"].trend === "BEARISH"
  ) {
    longScore -= 12;
  }

  if (
    timeframes["1"].trend === "BEARISH" &&
    timeframes["5"].trend === "BULLISH"
  ) {
    shortScore -= 12;
  }

  // ==========================================
  // DIRECTION
  // ==========================================

  let direction = "WAIT";

  if (
    longScore > shortScore &&
    longScore >= 35
  ) {
    direction = "LONG";
  }

  if (
    shortScore > longScore &&
    shortScore >= 35
  ) {
    direction = "SHORT";
  }

  // ==========================================
  // DERIVATIVES
  // ==========================================

  const derivativeScore =
    evaluateDerivatives(
      direction,
      derivatives
    );

  if (direction === "LONG")
    longScore += derivativeScore.score;

  if (direction === "SHORT")
    shortScore += derivativeScore.score;

  // ==========================================
  // ORDER BOOK
  // ==========================================

  const bookScore =
    evaluateOrderBook(
      direction,
      orderbook
    );

  if (direction === "LONG")
    longScore += bookScore.score;

  if (direction === "SHORT")
    shortScore += bookScore.score;

  /*
    دیوار خیلی سنگین مخالف:
    سیگنال را می‌توانیم کاملاً متوقف کنیم.
  */

  const blockedByWall =
    bookScore.oppositeWall === true;

  // ==========================================
  // FINAL DIRECTION
  // ==========================================

  if (direction === "LONG") {

    if (longScore < shortScore + 8)
      direction = "WAIT";

  }

  if (direction === "SHORT") {

    if (shortScore < longScore + 8)
      direction = "WAIT";

  }

  // ==========================================
  // MAIN TIMEFRAME
  // ==========================================

  const main =
    timeframes["5"];

  /*
    امتیاز نهایی
  */

  let score =
    calculateFinalScoreV9(
      direction,
      main,
      bullish,
      bearish,
      longScore,
      shortScore,
      derivatives,
      orderbook
    );

  /*
    اگر دیوار مخالف سنگین باشد،
    ورود ممنوع.
  */

  if (blockedByWall) {

    direction = "WAIT";
    score = Math.min(score, 59);

  }

  // ==========================================
  // ENTRY FILTER
  // ==========================================

  const confirmations =
    getConfirmationsV9(
      direction,
      timeframes,
      derivatives,
      orderbook
    );

  const required =
    7;

  let entryReady =
    direction !== "WAIT" &&
    score >= 70 &&
    confirmations >= required &&
    !blockedByWall;

  /*
    برای LONG حداقل Footprint مناسب
    و برای SHORT حداقل Footprint مناسب
    لازم است.
  */

  let footprint = null;

  if (withFootprint) {

    try {
      footprint =
        await getFootprint(symbol);
    } catch (e) {
      footprint = {
        error: e.message
      };
    }

    if (
      footprint &&
      !footprint.error
    ) {

      const fp =
        finalFootprintCheck(
          direction,
          footprint
        );

      if (!fp.ok)
        entryReady = false;

    } else {

      entryReady = false;

    }
  }

  // ==========================================
  // TARGETS
  // ==========================================

  let targets = null;

  if (entryReady) {

    targets =
      calculateTargetsV9(
        main,
        direction,
        orderbook
      );

  }

  return {

    symbol,

    direction,

    score,

    entryReady,

    signal:
      entryReady
        ? direction === "LONG"
          ? "CONFIRMED LONG"
          : "CONFIRMED SHORT"
        : "WAIT",

    mainTimeframe: "5",

    price: main.price,

    entry: targets?.entry || null,
    sl: targets?.sl || null,
    tp1: targets?.tp1 || null,
    tp2: targets?.tp2 || null,
    tp3: targets?.tp3 || null,

    rr: targets?.rr || null,

    confirmations,

    bullishTimeframes: bullish,
    bearishTimeframes: bearish,

    timeframes,

    derivatives,

    orderbook,

    footprint

  };
}


// =====================================================
// TIMEFRAME
// =====================================================

function analyzeTimeframe(rows) {

  if (!rows || rows.length < 30)
    throw new Error("Not enough candles");

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

  const previous =
    rows[rows.length - 2];

  const touchMA20 =
    current.low <= ma20 &&
    current.high >= ma20;

  const reaction =
    current.close > current.open
      ? "BULLISH"
      : current.close < current.open
        ? "BEARISH"
        : "NEUTRAL";

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

    reaction,

    structure,

    fvg,

    volume: {

      current:
        current.volume,

      ma7:
        volumeMA7,

      ma20:
        volumeMA20,

      spike:
        volumeSpike

    },

    previousClose:
      previous.close

  };
}


// =====================================================
// STRUCTURE
// =====================================================

function detectStructure(rows) {

  if (rows.length < 15)
    return "NONE";

  const n = rows.length;

  const highs =
    rows.slice(n - 12)
      .map(x => x.high);

  const lows =
    rows.slice(n - 12)
      .map(x => x.low);

  const h1 =
    Math.max(...highs.slice(0, 4));

  const h2 =
    Math.max(...highs.slice(4, 8));

  const h3 =
    Math.max(...highs.slice(8, 12));

  const l1 =
    Math.min(...lows.slice(0, 4));

  const l2 =
    Math.min(...lows.slice(4, 8));

  const l3 =
    Math.min(...lows.slice(8, 12));

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


// =====================================================
// FVG
// =====================================================

function detectFVG(rows) {

  if (rows.length < 3) {

    return {
      type: "NONE",
      bottom: null,
      top: null,
      status: "NONE"
    };

  }

  const a =
    rows[rows.length - 3];

  const b =
    rows[rows.length - 2];

  const c =
    rows[rows.length - 1];

  if (c.low > a.high) {

    return {

      type: "BULLISH",

      bottom: a.high,

      top: c.low,

      status: "ACTIVE",

      midpoint:
        (a.high + c.low) / 2

    };
  }

  if (c.high < a.low) {

    return {

      type: "BEARISH",

      bottom: c.high,

      top: a.low,

      status: "ACTIVE",

      midpoint:
        (c.high + a.low) / 2

    };
  }

  return {

    type: "NONE",

    bottom: null,

    top: null,

    status: "NONE"

  };
}


// =====================================================
// DERIVATIVES
// =====================================================

async function getDerivatives(symbol) {

  const results =
    await Promise.all([

      bybit(
        "/v5/market/tickers" +
        "?category=linear" +
        "&symbol=" +
        encodeURIComponent(symbol)
      ),

      bybit(
        "/v5/market/open-interest" +
        "?category=linear" +
        "&symbol=" +
        encodeURIComponent(symbol) +
        "&intervalTime=5min" +
        "&limit=5"
      ),

      bybit(
        "/v5/market/funding/history" +
        "?category=linear" +
        "&symbol=" +
        encodeURIComponent(symbol) +
        "&limit=1"
      )

    ]);

  const ticker =
    results[0].result?.list?.[0] || {};

  const oiList =
    results[1].result?.list || [];

  const funding =
    results[2].result?.list?.[0] || {};

  const oiCurrent =
    Number(
      oiList[0]?.openInterest || 0
    );

  const oiPrevious =
    Number(
      oiList[oiList.length - 1]?.openInterest || 0
    );

  const oiChange =
    oiPrevious > 0
      ? ((oiCurrent - oiPrevious) /
        oiPrevious) * 100
      : 0;

  return {

    price:
      Number(ticker.lastPrice || 0),

    fundingRate:
      Number(
        funding.fundingRate || 0
      ),

    nextFundingTime:
      funding.nextFundingTime || null,

    openInterest:
      oiCurrent,

    previousOpenInterest:
      oiPrevious,

    oiChangePercent:
      oiChange,

    turnover24h:
      Number(
        ticker.turnover24h || 0
      )

  };
}


// =====================================================
// DERIVATIVE SCORE
// =====================================================

function evaluateDerivatives(
  direction,
  d
) {

  if (
    !d ||
    direction === "WAIT"
  ) {
    return {
      score: 0,
      notes: []
    };
  }

  let score = 0;

  const notes = [];

  const funding =
    Number(d.fundingRate || 0);

  const oi =
    Number(d.oiChangePercent || 0);

  /*
    LONG:
    OI افزایشی + Funding خیلی مثبت نباشد
  */

  if (direction === "LONG") {

    if (oi > 1) {
      score += 5;
      notes.push("OI rising");
    }

    if (funding < 0.0005) {
      score += 4;
      notes.push("Funding acceptable");
    }

    /*
      اگر Funding خیلی مثبت باشد
      Long crowded محسوب می‌شود.
    */

    if (funding > 0.001) {
      score -= 8;
      notes.push("Long crowded");
    }

  }

  /*
    SHORT
  */

  if (direction === "SHORT") {

    if (oi > 1) {
      score += 5;
      notes.push("OI rising");
    }

    if (funding > -0.0005) {
      score += 4;
      notes.push("Funding acceptable");
    }

    /*
      Funding خیلی منفی:
      Short crowded
    */

    if (funding < -0.001) {
      score -= 8;
      notes.push("Short crowded");
    }

  }

  /*
    OI شدیداً در حال سقوط:
    احتمال squeeze / liquidation.
  */

  if (oi < -3) {

    score -= 5;

    notes.push(
      "OI falling / possible squeeze"
    );
  }

  return {
    score,
    notes
  };
}


// =====================================================
// ORDER BOOK
// =====================================================

async function getOrderBook(symbol) {

  const data =
    await bybit(
      "/v5/market/orderbook" +
      "?category=linear" +
      "&symbol=" +
      encodeURIComponent(symbol) +
      "&limit=50"
    );

  const result =
    data.result || {};

  const bids =
    result.b || [];

  const asks =
    result.a || [];

  let bidVolume = 0;
  let askVolume = 0;

  const bidLevels = [];
  const askLevels = [];

  for (const x of bids) {

    const price = Number(x[0]);
    const size = Number(x[1]);

    bidVolume += size;

    bidLevels.push({
      price,
      size,
      notional: price * size
    });
  }

  for (const x of asks) {

    const price = Number(x[0]);
    const size = Number(x[1]);

    askVolume += size;

    askLevels.push({
      price,
      size,
      notional: price * size
    });
  }

  const total =
    bidVolume + askVolume;

  const imbalance =
    total > 0
      ? ((bidVolume - askVolume) /
        total) * 100
      : 0;

  const largestBid =
    bidLevels.length
      ? Math.max(
          ...bidLevels.map(x => x.notional)
        )
      : 0;

  const largestAsk =
    askLevels.length
      ? Math.max(
          ...askLevels.map(x => x.notional)
        )
      : 0;

  const avgBid =
    bidLevels.length
      ? bidLevels.reduce(
          (a, x) => a + x.notional,
          0
        ) / bidLevels.length
      : 0;

  const avgAsk =
    askLevels.length
      ? askLevels.reduce(
          (a, x) => a + x.notional,
          0
        ) / askLevels.length
      : 0;

  /*
    Wall = حداقل 5 برابر متوسط سطح‌ها
  */

  const bidWall =
    largestBid >
    avgBid * 5;

  const askWall =
    largestAsk >
    avgAsk * 5;

  return {

    bidVolume,

    askVolume,

    imbalance,

    bidWall,

    askWall,

    largestBid,

    largestAsk,

    bidLevels:
      bidLevels.slice(0, 20),

    askLevels:
      askLevels.slice(0, 20)

  };
}


// =====================================================
// ORDER BOOK SCORE
// =====================================================

function evaluateOrderBook(
  direction,
  book
) {

  if (
    !book ||
    direction === "WAIT"
  ) {
    return {
      score: 0,
      oppositeWall: false
    };
  }

  let score = 0;

  let oppositeWall = false;

  if (direction === "LONG") {

    if (book.imbalance > 10)
      score += 7;

    if (book.imbalance < -10)
      score -= 7;

    /*
      Ask wall جلوی LONG
    */

    if (book.askWall) {

      score -= 12;

      oppositeWall = true;

    }

    if (book.bidWall)
      score += 5;

  }

  if (direction === "SHORT") {

    if (book.imbalance < -10)
      score += 7;

    if (book.imbalance > 10)
      score -= 7;

    /*
      Bid wall جلوی SHORT
    */

    if (book.bidWall) {

      score -= 12;

      oppositeWall = true;

    }

    if (book.askWall)
      score += 5;

  }

  return {
    score,
    oppositeWall
  };
}


// =====================================================
// FOOTPRINT
// =====================================================

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

  let totalNotional = 0;

  const notionals = [];

  for (const t of trades) {

    const price =
      Number(t.price || 0);

    const size =
      Number(t.size || 0);

    const notional =
      price * size;

    notionals.push(notional);

    totalNotional += notional;

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
      ? (delta / totalVolume) * 100
      : 0;

  const buyRatio =
    totalVolume > 0
      ? (buyVolume / totalVolume) * 100
      : 0;

  const sellRatio =
    totalVolume > 0
      ? (sellVolume / totalVolume) * 100
      : 0;

  const averageNotional =
    totalNotional / trades.length;

  const largeThreshold =
    averageNotional * 5;

  let largestTrade = 0;

  for (const n of notionals) {

    if (n > largestTrade)
      largestTrade = n;

  }

  return {

    trades: trades.length,

    buyVolume,

    sellVolume,

    delta,

    deltaPercent,

    buyRatio,

    sellRatio,

    largeTrade:
      largestTrade >= largeThreshold,

    largeTradeNotional:
      largestTrade,

    averageTradeNotional:
      averageNotional

  };
}


// =====================================================
// FINAL FOOTPRINT CHECK
// =====================================================

function finalFootprintCheck(
  direction,
  fp
) {

  if (
    !fp ||
    fp.error ||
    fp.trades < 50
  ) {
    return {
      ok: false,
      reason: "Footprint unavailable"
    };
  }

  const delta =
    Number(fp.deltaPercent || 0);

  /*
    برای ورود باید فشار واقعی
    حداقل قابل قبول باشد.
  */

  if (direction === "LONG") {

    if (delta < 8) {

      return {
        ok: false,
        reason:
          "Buy delta too weak"
      };

    }

    return {
      ok: true,
      reason:
        "Positive delta confirmed"
    };
  }

  if (direction === "SHORT") {

    if (delta > -8) {

      return {
        ok: false,
        reason:
          "Sell delta too weak"
      };

    }

    return {
      ok: true,
      reason:
        "Negative delta confirmed"
    };
  }

  return {
    ok: false,
    reason: "WAIT"
  };
}


// =====================================================
// FINAL SCORE
// =====================================================

function calculateFinalScoreV9(
  direction,
  x,
  bullish,
  bearish,
  longScore,
  shortScore,
  derivatives,
  orderbook
) {

  if (
    !x ||
    direction === "WAIT"
  )
    return 0;

  let raw =
    direction === "LONG"
      ? longScore
      : shortScore;

  /*
    امتیاز پایه را به بازه 0-100
    تبدیل می‌کنیم.
  */

  let score =
    Math.min(
      100,
      Math.max(
        0,
        Math.round(
          raw * 0.95
        )
      )
    );

  /*
    سه تایم‌فریم هم‌جهت
  */

  if (
    direction === "LONG" &&
    bullish === 3
  )
    score += 8;

  if (
    direction === "SHORT" &&
    bearish === 3
  )
    score += 8;

  /*
    OI
  */

  if (
    derivatives &&
    Number(
      derivatives.oiChangePercent
    ) > 1
  )
    score += 4;

  /*
    Order book
  */

  if (
    orderbook &&
    Math.abs(
      Number(orderbook.imbalance || 0)
    ) > 10
  )
    score += 3;

  return Math.min(
    100,
    Math.max(0, Math.round(score))
  );
}


// =====================================================
// CONFIRMATIONS
// =====================================================

function getConfirmationsV9(
  direction,
  tf,
  derivatives,
  book
) {

  if (direction === "WAIT")
    return 0;

  let c = 0;

  const main = tf["5"];

  if (
    direction === "LONG" &&
    main.trend === "BULLISH"
  )
    c++;

  if (
    direction === "SHORT" &&
    main.trend === "BEARISH"
  )
    c++;

  if (
    direction === "LONG" &&
    main.maSlope === "UP"
  )
    c++;

  if (
    direction === "SHORT" &&
    main.maSlope === "DOWN"
  )
    c++;

  if (
    direction === "LONG" &&
    main.structure === "BULLISH"
  )
    c++;

  if (
    direction === "SHORT" &&
    main.structure === "BEARISH"
  )
    c++;

  if (
    direction === "LONG" &&
    main.fvg.type === "BULLISH"
  )
    c++;

  if (
    direction === "SHORT" &&
    main.fvg.type === "BEARISH"
  )
    c++;

  if (main.volume.spike)
    c++;

  if (
    derivatives &&
    Number(
      derivatives.oiChangePercent
    ) > 1
  )
    c++;

  if (
    book &&
    (
      direction === "LONG"
        ? book.imbalance > 10
        : book.imbalance < -10
    )
  )
    c++;

  if (
    direction === "LONG" &&
    derivatives &&
    Number(derivatives.fundingRate) < 0.001
  )
    c++;

  if (
    direction === "SHORT" &&
    derivatives &&
    Number(derivatives.fundingRate) > -0.001
  )
    c++;

  return c;
}


// =====================================================
// TARGETS
// =====================================================

function calculateTargetsV9(
  x,
  direction,
  book
) {

  const price =
    Number(x.price);

  /*
    ATR تقریبی از کندل‌های موجود
    نداریم، بنابراین برای جلوگیری از
    SL غیرمنطقی از فاصله محافظه‌کارانه
    استفاده می‌کنیم.
  */

  const riskPercent = 0.0125;

  if (direction === "LONG") {

    const sl =
      price * (1 - riskPercent);

    const risk =
      price - sl;

    return {

      entry: price,

      sl:
        roundPrice(sl),

      tp1:
        roundPrice(price + risk),

      tp2:
        roundPrice(price + risk * 2),

      tp3:
        roundPrice(price + risk * 3),

      rr: "1:3"

    };
  }

  const sl =
    price * (1 + riskPercent);

  const risk =
    sl - price;

  return {

    entry: price,

    sl:
      roundPrice(sl),

    tp1:
      roundPrice(price - risk),

    tp2:
      roundPrice(price - risk * 2),

    tp3:
      roundPrice(price - risk * 3),

    rr: "1:3"

  };
}


// =====================================================
// KLINES
// =====================================================

async function getKlines(
  symbol,
  interval,
  limit = 80
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

      time:
        Number(x[0]),

      open:
        Number(x[1]),

      high:
        Number(x[2]),

      low:
        Number(x[3]),

      close:
        Number(x[4]),

      volume:
        Number(x[5])

    }));
}


// =====================================================
// BYBIT
// =====================================================

async function bybit(path) {

  const response =
    await fetch(
      BYBIT_BASE + path,
      {
        headers: {
          "Accept":
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


// =====================================================
// HELPERS
// =====================================================

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


function roundPrice(x) {

  if (!Number.isFinite(x))
    return null;

  /*
    نمایش مناسب برای قیمت‌های
    مختلف بدون تغییر مقدار اصلی.
  */

  if (x >= 1000)
    return Number(x.toFixed(2));

  if (x >= 1)
    return Number(x.toFixed(4));

  if (x >= 0.01)
    return Number(x.toFixed(6));

  return Number(x.toFixed(8));
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
