const BYBIT_BASE = "https://api.bybit.com";

const TIMEFRAMES = [
  { key: "1", label: "1m", weight: 2 },
  { key: "3", label: "3m", weight: 3 },
  { key: "5", label: "5m", weight: 4 }
];

const INITIAL_SCAN = 200;
const DEEP_SCAN = 20;

// قبلاً 70 بود؛ برای اینکه اسکنر بیش از حد بی‌سیگنال نباشد
const MIN_SIGNAL_SCORE = 60;

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

        const limit = clamp(
          Number(url.searchParams.get("limit") || 100),
          30,
          200
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

        const footprint =
          await getFootprint(symbol);

        return json({
          ok: true,
          symbol,
          footprint
        });
      }

      // =========================
      // MARKET
      // =========================

      if (url.pathname === "/api/market") {

        const symbol = normalizeSymbol(
          url.searchParams.get("symbol")
        );

        if (!symbol) {
          return json({
            ok: false,
            error: "symbol required"
          }, 400);
        }

        const market =
          await getMarketData(symbol);

        return json({
          ok: true,
          symbol,
          market
        });
      }

      // =========================
      // ANALYZE
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
      // SCAN
      // =========================

      if (url.pathname === "/api/scan") {

        const result =
          await scanMarket();

        return json({
          ok: true,
          ...result
        });
      }

      // =========================
      // ALERTS
      // =========================

      if (url.pathname === "/api/alerts") {

        const result =
          await scanMarket();

        const alerts =
          result.results.filter(x =>
            x.signal === "CONFIRMED LONG" ||
            x.signal === "CONFIRMED SHORT"
          );

        return json({
          ok: true,
          alerts,
          timestamp: Date.now()
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


// =================================================
// MARKET SCAN
// =================================================

async function scanMarket() {

  // مرحله اول:
  // تمام بازار را می‌گیریم و 200 ارز فعال‌تر را انتخاب می‌کنیم

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
      .sort((a, b) =>
        Number(b.turnover24h || 0) -
        Number(a.turnover24h || 0)
      )
      .slice(0, INITIAL_SCAN);


  // =================================================
  // مرحله دوم:
  // از 200 ارز، 20 ارز را بر اساس حرکت قیمت + حجم + گردش
  // برای تحلیل عمیق انتخاب می‌کنیم
  // =================================================

  const prioritized =
    candidates
      .map(x => {

        const change =
          Math.abs(Number(x.price24hPcnt || 0) * 100);

        const turnover =
          Number(x.turnover24h || 0);

        const volumeScore =
          Math.log10(turnover + 1);

        const priority =
          change * 2 +
          volumeScore;

        return {
          ticker: x,
          priority
        };
      })
      .sort((a, b) =>
        b.priority - a.priority
      )
      .slice(0, DEEP_SCAN);


  // =================================================
  // تحلیل عمیق 20 ارز
  // =================================================

  const batchResults =
    await Promise.all(
      prioritized.map(async item => {

        try {

          return await analyzeSymbol(
            item.ticker.symbol,
            false
          );

        } catch (e) {

          return {
            symbol: item.ticker.symbol,
            direction: "WAIT",
            signal: "WAIT",
            score: 0,
            error: e.message
          };
        }
      })
    );


  // =================================================
  // دیگر فقط سیگنال 70+ را نشان نمی‌دهیم
  // همه موقعیت‌های 60+ را نشان می‌دهیم
  // =================================================

  const results =
    batchResults
      .filter(r =>
        r &&
        r.direction !== "WAIT" &&
        r.score >= MIN_SIGNAL_SCORE
      )
      .sort((a, b) =>
        b.score - a.score
      );


  return {

    scanned: candidates.length,

    deepScanned:
      prioritized.length,

    found:
      results.length,

    results:
      results.slice(0, 10),

    timestamp:
      Date.now()
  };
}


// =================================================
// ANALYZE
// =================================================

async function analyzeSymbol(
  symbol,
  withFootprint = false
) {

  const tfResults =
    await Promise.all(
      TIMEFRAMES.map(async tf => {

        try {

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

        } catch (e) {

          return {
            key: tf.key,
            data: {
              error: e.message
            }
          };
        }
      })
    );


  const timeframes = {};

  tfResults.forEach(x => {
    timeframes[x.key] = x.data;
  });


  const valid =
    tfResults
      .map(x => x.data)
      .filter(x => !x.error);


  if (!valid.length) {
    throw new Error("No market data");
  }


  let bullish = 0;
  let bearish = 0;

  for (const x of valid) {

    if (x.trend === "BULLISH")
      bullish++;

    if (x.trend === "BEARISH")
      bearish++;
  }


  let longScore = 0;
  let shortScore = 0;


  // =================================================
  // TIMEFRAME SCORE
  // =================================================

  for (const tf of TIMEFRAMES) {

    const x =
      timeframes[tf.key];

    if (!x || x.error)
      continue;

    const w = tf.weight;


    // Trend

    if (x.trend === "BULLISH")
      longScore += 5 * w;

    if (x.trend === "BEARISH")
      shortScore += 5 * w;


    // MA slope

    if (x.maSlope === "UP")
      longScore += 3 * w;

    if (x.maSlope === "DOWN")
      shortScore += 3 * w;


    // Structure

    if (x.structure === "BULLISH")
      longScore += 4 * w;

    if (x.structure === "BEARISH")
      shortScore += 4 * w;


    // FVG

    if (x.fvg.type === "BULLISH")
      longScore += 3 * w;

    if (x.fvg.type === "BEARISH")
      shortScore += 3 * w;


    // Volume reaction

    if (x.volume.spike) {

      if (x.reaction === "BULLISH")
        longScore += 3 * w;

      if (x.reaction === "BEARISH")
        shortScore += 3 * w;
    }


    // MA20 touch

    if (x.touchMA20) {

      if (x.trend === "BULLISH")
        longScore += 2 * w;

      if (x.trend === "BEARISH")
        shortScore += 2 * w;
    }
  }


  // =================================================
  // MARKET
  // =================================================

  const market =
    await getMarketData(symbol);


  // =================================================
  // FOOTPRINT
  // =================================================

  let footprint = null;

  if (withFootprint) {

    footprint =
      await getFootprint(symbol);

    if (footprint.deltaPercent > 12)
      longScore += 10;

    if (footprint.deltaPercent < -12)
      shortScore += 10;
  }


  // =================================================
  // OI
  // =================================================

  if (market.oi.changePercent > 2) {

    if (longScore > shortScore)
      longScore += 4;

    else if (shortScore > longScore)
      shortScore += 4;
  }


  if (market.oi.changePercent < -2) {

    if (longScore > shortScore)
      longScore += 2;

    else if (shortScore > longScore)
      shortScore += 2;
  }


  // =================================================
  // FUNDING
  // =================================================

  if (market.funding.rate > 0.05) {

    longScore -= 4;
    shortScore += 3;
  }


  if (market.funding.rate < -0.05) {

    shortScore -= 4;
    longScore += 3;
  }


  // =================================================
  // ORDER BOOK
  // =================================================

  const book =
    market.orderBook;


  if (book.bidRatio > 58)
    longScore += 5;

  if (book.askRatio > 58)
    shortScore += 5;


  // =================================================
  // OPPOSITE WALL
  // =================================================

  // دیگر حذف کامل سیگنال نیست
  // فقط امتیاز کم می‌کند

  if (book.oppositeWallForLong)
    longScore -= 7;

  if (book.oppositeWallForShort)
    shortScore -= 7;


  // =================================================
  // LIQUIDITY HUNT
  // =================================================

  const hunt =
    detectLiquidityHunt(valid);


  if (hunt === "BULLISH_HUNT")
    longScore += 6;

  if (hunt === "BEARISH_HUNT")
    shortScore += 6;


  // =================================================
  // LIQUIDATION
  // =================================================

  const liquidationPressure =
    detectLiquidationPressure(
      valid,
      market,
      footprint
    );


  if (
    liquidationPressure ===
    "LONG_LIQUIDATION"
  )
    shortScore += 7;


  if (
    liquidationPressure ===
    "SHORT_LIQUIDATION"
  )
    longScore += 7;


  // =================================================
  // RAW DIRECTION
  // =================================================

  let direction = "WAIT";


  if (
    longScore > shortScore &&
    longScore >= 30
  )
    direction = "LONG";


  if (
    shortScore > longScore &&
    shortScore >= 30
  )
    direction = "SHORT";


  // =================================================
  // 3 TF CONFIRMATION
  // =================================================

  if (bullish === 3)
    longScore += 12;

  if (bearish === 3)
    shortScore += 12;


  // 2 از 3 هم امتیاز می‌گیرد

  if (bullish === 2)
    longScore += 5;

  if (bearish === 2)
    shortScore += 5;


  // =================================================
  // FINAL DIRECTION
  // =================================================

  if (
    longScore > shortScore &&
    longScore >= 30
  ) {

    direction = "LONG";

  } else if (
    shortScore > longScore &&
    shortScore >= 30
  ) {

    direction = "SHORT";

  } else {

    direction = "WAIT";
  }


  // =================================================
  // FINAL SCORE
  // =================================================

  const main =
    timeframes["5"] ||
    timeframes["3"] ||
    timeframes["1"];


  const score =
    calculateFinalScoreV10(
      main,
      direction,
      bullish,
      bearish,
      market,
      book,
      footprint,
      hunt,
      liquidationPressure
    );


  // =================================================
  // SAFETY
  // =================================================

  let confirmed = true;

  const reasons = [];


  // فقط اگر اختلاف خیلی شدید باشد سیگنال را حذف می‌کنیم

  if (
    direction === "LONG" &&
    bearish === 3
  ) {

    // اگر هر سه تایم‌فریم نزولی باشند
    // LONG خطرناک است

    confirmed = false;

    reasons.push(
      "هر ۳ تایم‌فریم نزولی هستند"
    );
  }


  if (
    direction === "SHORT" &&
    bullish === 3
  ) {

    confirmed = false;

    reasons.push(
      "هر ۳ تایم‌فریم صعودی هستند"
    );
  }


  // Footprint مخالف دیگر حذف قطعی نیست

  if (
    direction === "LONG" &&
    footprint &&
    footprint.deltaPercent < -20
  ) {

    reasons.push(
      "Footprint فشار فروش دارد"
    );
  }


  if (
    direction === "SHORT" &&
    footprint &&
    footprint.deltaPercent > 20
  ) {

    reasons.push(
      "Footprint فشار خرید دارد"
    );
  }


  if (
    direction === "LONG" &&
    book.oppositeWallForLong
  ) {

    reasons.push(
      "دیوار فروش نزدیک ورود وجود دارد"
    );
  }


  if (
    direction === "SHORT" &&
    book.oppositeWallForShort
  ) {

    reasons.push(
      "دیوار خرید نزدیک ورود وجود دارد"
    );
  }


  if (score < MIN_SIGNAL_SCORE) {

    confirmed = false;

    reasons.push(
      "امتیاز کمتر از حد سیگنال است"
    );
  }


  if (!confirmed)
    direction = "WAIT";


  // =================================================
  // TARGETS
  // =================================================

  let targets = null;


  if (
    direction === "LONG" ||
    direction === "SHORT"
  ) {

    targets =
      calculateTargetsV10(
        main,
        direction,
        market
      );
  }


  return {

    symbol,

    signal:
      direction === "LONG"
        ? "CONFIRMED LONG"
        : direction === "SHORT"
        ? "CONFIRMED SHORT"
        : "WAIT",

    direction,

    score,

    price:
      main.price,

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

    confirmations:
      countConfirmationsV10(
        main,
        direction,
        bullish,
        bearish,
        market,
        book,
        footprint
      ),

    bullishTimeframes:
      bullish,

    bearishTimeframes:
      bearish,

    market,

    orderBook:
      book,

    liquidityHunt:
      hunt,

    liquidationPressure,

    reasons,

    timeframes,

    footprint
  };
}


// =================================================
// TIMEFRAME
// =================================================

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
// MARKET DATA
// =================================================

async function getMarketData(symbol) {

  const tickerPromise =
    bybit(
      "/v5/market/tickers" +
      "?category=linear" +
      "&symbol=" +
      encodeURIComponent(symbol)
    );


  const oiPromise =
    bybit(
      "/v5/market/open-interest" +
      "?category=linear" +
      "&symbol=" +
      encodeURIComponent(symbol) +
      "&intervalTime=5min&limit=2"
    );


  const bookPromise =
    bybit(
      "/v5/market/orderbook" +
      "?category=linear" +
      "&symbol=" +
      encodeURIComponent(symbol) +
      "&limit=25"
    );


  const [
    tickerData,
    oiData,
    bookData
  ] = await Promise.all([
    tickerPromise,
    oiPromise,
    bookPromise
  ]);


  const ticker =
    tickerData.result?.list?.[0] || {};


  const oiList =
    oiData.result?.list || [];


  let oiCurrent = 0;
  let oiPrevious = 0;


  if (oiList.length > 0) {

    oiCurrent =
      Number(
        oiList[0].openInterest || 0
      );
  }


  if (oiList.length > 1) {

    oiPrevious =
      Number(
        oiList[1].openInterest || 0
      );
  }


  const oiChangePercent =
    oiPrevious > 0
      ? (
          (oiCurrent - oiPrevious) /
          oiPrevious
        ) * 100
      : 0;


  const bids =
    bookData.result?.b || [];


  const asks =
    bookData.result?.a || [];


  const orderBook =
    analyzeOrderBook(
      bids,
      asks,
      Number(ticker.lastPrice || 0)
    );


  return {

    price:
      Number(ticker.lastPrice || 0),


    funding: {

      rate:
        Number(
          ticker.fundingRate || 0
        ) * 100,

      nextFunding:
        ticker.nextFundingTime || null
    },


    oi: {

      current:
        oiCurrent,

      previous:
        oiPrevious,

      changePercent:
        oiChangePercent
    },


    orderBook
  };
}


// =================================================
// ORDER BOOK
// =================================================

function analyzeOrderBook(
  bids,
  asks,
  price
) {

  let bidValue = 0;
  let askValue = 0;

  let biggestBid = 0;
  let biggestAsk = 0;


  for (const b of bids) {

    const p =
      Number(b[0] || 0);

    const q =
      Number(b[1] || 0);

    const value =
      p * q;

    bidValue += value;

    if (value > biggestBid)
      biggestBid = value;
  }


  for (const a of asks) {

    const p =
      Number(a[0] || 0);

    const q =
      Number(a[1] || 0);

    const value =
      p * q;

    askValue += value;

    if (value > biggestAsk)
      biggestAsk = value;
  }


  const total =
    bidValue + askValue;


  const bidRatio =
    total > 0
      ? (bidValue / total) * 100
      : 50;


  const askRatio =
    total > 0
      ? (askValue / total) * 100
      : 50;


  const averageBid =
    bids.length > 0
      ? bidValue / bids.length
      : 0;


  const averageAsk =
    asks.length > 0
      ? askValue / asks.length
      : 0;


  const oppositeWallForLong =
    biggestAsk >
    averageAsk * 5;


  const oppositeWallForShort =
    biggestBid >
    averageBid * 5;


  return {

    bidValue,

    askValue,

    bidRatio,

    askRatio,

    biggestBid,

    biggestAsk,

    oppositeWallForLong,

    oppositeWallForShort
  };
}


// =================================================
// FOOTPRINT
// =================================================

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

  const notionals = [];


  for (const t of trades) {

    const price =
      Number(t.price || 0);

    const size =
      Number(t.size || 0);

    const notional =
      price * size;


    notionals.push(notional);


    if (
      String(t.side).toLowerCase() === "buy"
    ) {

      buyVolume += size;

    } else {

      sellVolume += size;
    }
  }


  const total =
    buyVolume + sellVolume;


  const delta =
    buyVolume - sellVolume;


  const deltaPercent =
    total > 0
      ? (delta / total) * 100
      : 0;


  const buyRatio =
    total > 0
      ? (buyVolume / total) * 100
      : 0;


  const sellRatio =
    total > 0
      ? (sellVolume / total) * 100
      : 0;


  const average =
    notionals.reduce(
      (a, b) => a + b,
      0
    ) / notionals.length;


  let largest = 0;


  for (const n of notionals) {

    if (n > largest)
      largest = n;
  }


  return {

    trades:
      trades.length,

    buyVolume,

    sellVolume,

    delta,

    deltaPercent,

    buyRatio,

    sellRatio,

    largeTrade:
      largest >= average * 5,

    largeTradeNotional:
      largest,

    averageTradeNotional:
      average
  };
}


// =================================================
// LIQUIDITY HUNT
// =================================================

function detectLiquidityHunt(analyses) {

  let bullish = false;
  let bearish = false;


  for (const x of analyses) {

    if (
      x.structure === "BULLISH" &&
      x.reaction === "BULLISH"
    )
      bullish = true;


    if (
      x.structure === "BEARISH" &&
      x.reaction === "BEARISH"
    )
      bearish = true;
  }


  if (bullish && !bearish)
    return "BULLISH_HUNT";


  if (bearish && !bullish)
    return "BEARISH_HUNT";


  return "NONE";
}


// =================================================
// LIQUIDATION
// =================================================

function detectLiquidationPressure(
  analyses,
  market,
  footprint
) {

  const oi =
    market.oi.changePercent;


  const delta =
    footprint?.deltaPercent || 0;


  if (
    oi < -2 &&
    delta < -12
  )
    return "LONG_LIQUIDATION";


  if (
    oi < -2 &&
    delta > 12
  )
    return "SHORT_LIQUIDATION";


  return "NONE";
}


// =================================================
// SCORE V10
// =================================================

function calculateFinalScoreV10(
  x,
  direction,
  bullish,
  bearish,
  market,
  book,
  footprint,
  hunt,
  liquidation
) {

  if (
    !x ||
    direction === "WAIT"
  )
    return 0;


  let score = 0;


  // MA

  if (
    direction === "LONG" &&
    x.maSlope === "UP"
  )
    score += 10;


  if (
    direction === "SHORT" &&
    x.maSlope === "DOWN"
  )
    score += 10;


  // Structure

  if (
    direction === "LONG" &&
    x.structure === "BULLISH"
  )
    score += 12;


  if (
    direction === "SHORT" &&
    x.structure === "BEARISH"
  )
    score += 12;


  // FVG

  if (
    direction === "LONG" &&
    x.fvg.type === "BULLISH"
  )
    score += 8;


  if (
    direction === "SHORT" &&
    x.fvg.type === "BEARISH"
  )
    score += 8;


  // MA20

  if (x.touchMA20)
    score += 6;


  // Volume

  if (x.volume.spike)
    score += 6;


  // Multi TF

  if (
    direction === "LONG" &&
    bullish === 3
  )
    score += 18;


  if (
    direction === "SHORT" &&
    bearish === 3
  )
    score += 18;


  if (
    direction === "LONG" &&
    bullish === 2
  )
    score += 9;


  if (
    direction === "SHORT" &&
    bearish === 2
  )
    score += 9;


  // Footprint

  if (footprint) {

    if (
      direction === "LONG" &&
      footprint.deltaPercent > 10
    )
      score += 10;


    if (
      direction === "SHORT" &&
      footprint.deltaPercent < -10
    )
      score += 10;
  }


  // Order Book

  if (
    direction === "LONG" &&
    book.bidRatio > 55
  )
    score += 5;


  if (
    direction === "SHORT" &&
    book.askRatio > 55
  )
    score += 5;


  // Hunt

  if (
    direction === "LONG" &&
    hunt === "BULLISH_HUNT"
  )
    score += 5;


  if (
    direction === "SHORT" &&
    hunt === "BEARISH_HUNT"
  )
    score += 5;


  // Liquidation

  if (
    direction === "LONG" &&
    liquidation === "SHORT_LIQUIDATION"
  )
    score += 5;


  if (
    direction === "SHORT" &&
    liquidation === "LONG_LIQUIDATION"
  )
    score += 5;


  // Opposite wall

  if (
    direction === "LONG" &&
    book.oppositeWallForLong
  )
    score -= 8;


  if (
    direction === "SHORT" &&
    book.oppositeWallForShort
  )
    score -= 8;


  return Math.max(
    0,
    Math.min(
      100,
      Math.round(score)
    )
  );
}


// =================================================
// CONFIRMATIONS
// =================================================

function countConfirmationsV10(
  x,
  direction,
  bullish,
  bearish,
  market,
  book,
  footprint
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


  if (x.touchMA20)
    c++;


  if (x.volume.spike)
    c++;


  if (
    (direction === "LONG" && bullish >= 2) ||
    (direction === "SHORT" && bearish >= 2)
  )
    c++;


  if (footprint) {

    if (
      direction === "LONG" &&
      footprint.deltaPercent > 10
    )
      c++;


    if (
      direction === "SHORT" &&
      footprint.deltaPercent < -10
    )
      c++;
  }


  if (
    direction === "LONG" &&
    book.bidRatio > 55
  )
    c++;


  if (
    direction === "SHORT" &&
    book.askRatio > 55
  )
    c++;


  return c;
}


// =================================================
// TARGETS
// =================================================

function calculateTargetsV10(
  x,
  direction,
  market
) {

  const price =
    Number(x.price);


  // فعلاً همان 1.2 درصد
  // بعداً ATR را اضافه می‌کنیم

  const risk =
    price * 0.012;


  if (direction === "LONG") {

    const sl =
      price - risk;


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
    price + risk;


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


function clamp(
  value,
  min,
  max
) {

  return Math.max(
    min,
    Math.min(max, value)
  );
}


function sma(
  data,
  period
) {

  if (
    !data ||
    data.length < period
  )
    return null;


  const part =
    data.slice(
      data.length - period
    );


  return (
    part.reduce(
      (a, b) =>
        a + Number(b),
      0
    ) / period
  );
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
