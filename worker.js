const BYBIT_BASE = "https://api.bybit.com";

const TIMEFRAMES = [
  { key: "1", label: "1m", weight: 2 },
  { key: "3", label: "3m", weight: 3 },
  { key: "5", label: "5m", weight: 4 }
];

// =================================================
// SCANNER SETTINGS
// =================================================

const INITIAL_SCAN = 200;
const DEEP_SCAN = 20;
const MAX_RESULTS = 10;

// قبلاً 70 بود.
// برای اینکه اسکنر بیش از حد بی‌سیگنال نباشد:
const MIN_SIGNAL_SCORE = 60;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};


// =================================================
// MAIN WORKER
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

      // =================================================
      // FUTURES LIST
      // =================================================

      if (url.pathname === "/api/futures") {

        const data =
          await bybit(
            "/v5/market/instruments-info?category=linear&limit=1000"
          );

        const list =
          data.result?.list || [];

        const futures =
          list
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


      // =================================================
      // KLINE
      // =================================================

      if (url.pathname === "/api/kline") {

        const symbol =
          normalizeSymbol(
            url.searchParams.get("symbol")
          );

        const interval =
          url.searchParams.get("interval") || "15";

        const limit =
          clamp(
            Number(
              url.searchParams.get("limit") || 100
            ),
            30,
            200
          );

        if (!symbol) {

          return json({
            ok: false,
            error: "symbol required"
          }, 400);

        }

        const rows =
          await getKlines(
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


      // =================================================
      // FOOTPRINT
      // =================================================

      if (url.pathname === "/api/footprint") {

        const symbol =
          normalizeSymbol(
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


      // =================================================
      // MARKET
      // =================================================

      if (url.pathname === "/api/market") {

        const symbol =
          normalizeSymbol(
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


      // =================================================
      // MANUAL ANALYZE
      // =================================================

      if (url.pathname === "/api/analyze") {

        const symbol =
          normalizeSymbol(
            url.searchParams.get("symbol")
          );

        if (!symbol) {

          return json({
            ok: false,
            error: "symbol required"
          }, 400);

        }

        const result =
          await analyzeSymbol(
            symbol,
            true
          );

        return json({
          ok: true,
          ...result
        });

      }


      // =================================================
      // MARKET SCAN
      // =================================================

      if (url.pathname === "/api/scan") {

        const result =
          await scanMarket();

        return json({
          ok: true,
          ...result
        });

      }


      // =================================================
      // ALERTS
      // =================================================

      if (url.pathname === "/api/alerts") {

        const result =
          await scanMarket();

        const alerts =
          result.results.filter(
            x =>
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
        detail:
          error?.message ||
          String(error)
      }, 500);

    }

  }

};


// =================================================
// MARKET SCAN
// =================================================

async function scanMarket() {

  // اول همه تیکرها
  const tickerData =
    await bybit(
      "/v5/market/tickers?category=linear"
    );

  const tickers =
    tickerData.result?.list || [];


  // =================================================
  // 200 CANDIDATES
  // =================================================

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
      .slice(0, INITIAL_SCAN);


  // =================================================
  // انتخاب 20 ارز برای تحلیل عمیق‌تر
  //
  // فقط حجم را ملاک قرار نمی‌دهیم.
  // تغییر قیمت + حجم معاملات + turnover
  // برای اولویت‌بندی استفاده می‌شود.
  // =================================================

  const ranked =
    candidates
      .map(x => {

        const change =
          Math.abs(
            Number(x.price24hPcnt || 0)
          );

        const turnover =
          Number(x.turnover24h || 0);

        const volume =
          Number(x.volume24h || 0);

        return {

          ...x,

          priority:
            change * 100 +
            Math.log10(
              Math.max(turnover, 1)
            ) * 2 +
            Math.log10(
              Math.max(volume, 1)
            )

        };

      })
      .sort(
        (a, b) =>
          b.priority - a.priority
      )
      .slice(0, DEEP_SCAN);


  // =================================================
  // تحلیل 20 ارز
  // =================================================

  const batchResults =
    await Promise.all(

      ranked.map(
        async ticker => {

          try {

            return await analyzeSymbol(
              ticker.symbol,
              false
            );

          } catch (e) {

            return {

              symbol:
                ticker.symbol,

              direction:
                "WAIT",

              signal:
                "WAIT",

              score: 0,

              error:
                e.message

            };

          }

        }
      )

    );


  // =================================================
  // نتایج
  //
  // اینجا دیگر فقط score>=60
  // و سیگنال LONG/SHORT
  // =================================================

  const results =
    batchResults
      .filter(r =>
        r &&
        (
          r.direction === "LONG" ||
          r.direction === "SHORT"
        ) &&
        r.score >= MIN_SIGNAL_SCORE
      )
      .sort(
        (a, b) =>
          b.score - a.score
      )
      .slice(0, MAX_RESULTS);


  return {

    scanned:
      candidates.length,

    deepScanned:
      ranked.length,

    found:
      results.length,

    results,

    timestamp:
      Date.now()

  };

}


// =================================================
// ANALYZE SYMBOL
// =================================================

async function analyzeSymbol(
  symbol,
  withFootprint = false
) {

  // =================================================
  // TIMEFRAMES
  // =================================================

  const tfResults =
    await Promise.all(

      TIMEFRAMES.map(
        async tf => {

          try {

            const rows =
              await getKlines(
                symbol,
                tf.key,
                100
              );

            return {

              key:
                tf.key,

              data:
                analyzeTimeframe(rows)

            };

          } catch (e) {

            return {

              key:
                tf.key,

              data: {

                error:
                  e.message

              }

            };

          }

        }
      )

    );


  const timeframes = {};


  tfResults.forEach(x => {

    timeframes[x.key] =
      x.data;

  });


  const valid =
    tfResults
      .map(x => x.data)
      .filter(
        x => !x.error
      );


  if (!valid.length) {

    throw new Error(
      "No market data"
    );

  }


  // =================================================
  // TF COUNT
  // =================================================

  let bullish = 0;
  let bearish = 0;


  for (const x of valid) {

    if (
      x.trend === "BULLISH"
    )
      bullish++;

    if (
      x.trend === "BEARISH"
    )
      bearish++;

  }


  // =================================================
  // RAW DIRECTION SCORE
  // =================================================

  let longScore = 0;
  let shortScore = 0;


  for (const tf of TIMEFRAMES) {

    const x =
      timeframes[tf.key];

    if (!x || x.error)
      continue;


    const w =
      tf.weight;


    // TREND

    if (
      x.trend === "BULLISH"
    )
      longScore += 5 * w;


    if (
      x.trend === "BEARISH"
    )
      shortScore += 5 * w;


    // MA SLOPE

    if (
      x.maSlope === "UP"
    )
      longScore += 3 * w;


    if (
      x.maSlope === "DOWN"
    )
      shortScore += 3 * w;


    // STRUCTURE

    if (
      x.structure === "BULLISH"
    )
      longScore += 4 * w;


    if (
      x.structure === "BEARISH"
    )
      shortScore += 4 * w;


    // FVG

    if (
      x.fvg.type === "BULLISH"
    )
      longScore += 3 * w;


    if (
      x.fvg.type === "BEARISH"
    )
      shortScore += 3 * w;


    // VOLUME

    if (
      x.volume.spike
    ) {

      if (
        x.reaction === "BULLISH"
      )
        longScore += 3 * w;


      if (
        x.reaction === "BEARISH"
      )
        shortScore += 3 * w;

    }


    // MA20 TOUCH

    if (
      x.touchMA20
    ) {

      if (
        x.trend === "BULLISH"
      )
        longScore += 2 * w;


      if (
        x.trend === "BEARISH"
      )
        shortScore += 2 * w;

    }

  }


  // =================================================
  // MARKET DATA
  // =================================================

  const market =
    await getMarketData(
      symbol
    );


  const book =
    market.orderBook;


  // =================================================
  // FOOTPRINT
  // =================================================

  let footprint = null;


  if (withFootprint) {

    footprint =
      await getFootprint(
        symbol
      );


    if (
      footprint.deltaPercent > 12
    ) {

      longScore += 10;

    }


    if (
      footprint.deltaPercent < -12
    ) {

      shortScore += 10;

    }

  }


  // =================================================
  // OPEN INTEREST
  // =================================================

  if (
    market.oi.changePercent > 2
  ) {

    if (
      longScore >= shortScore
    ) {

      longScore += 5;

    } else {

      shortScore += 5;

    }

  }


  if (
    market.oi.changePercent < -2
  ) {

    if (
      longScore >= shortScore
    ) {

      longScore += 3;

    } else {

      shortScore += 3;

    }

  }


  // =================================================
  // FUNDING
  // =================================================

  if (
    market.funding.rate > 0.05
  ) {

    longScore -= 5;
    shortScore += 3;

  }


  if (
    market.funding.rate < -0.05
  ) {

    shortScore -= 5;
    longScore += 3;

  }


  // =================================================
  // ORDER BOOK
  // =================================================

  if (
    book.bidRatio > 60
  ) {

    longScore += 6;

  }


  if (
    book.askRatio > 60
  ) {

    shortScore += 6;

  }


  if (
    book.bidRatio > 55 &&
    book.bidRatio <= 60
  ) {

    longScore += 3;

  }


  if (
    book.askRatio > 55 &&
    book.askRatio <= 60
  ) {

    shortScore += 3;

  }


  // =================================================
  // OPPOSITE WALL
  // =================================================

  if (
    book.oppositeWallForLong
  ) {

    longScore -= 8;

  }


  if (
    book.oppositeWallForShort
  ) {

    shortScore -= 8;

  }


  // =================================================
  // LIQUIDITY HUNT
  // =================================================

  const hunt =
    detectLiquidityHunt(
      valid
    );


  if (
    hunt === "BULLISH_HUNT"
  ) {

    longScore += 6;

  }


  if (
    hunt === "BEARISH_HUNT"
  ) {

    shortScore += 6;

  }


  // =================================================
  // LIQUIDATION PRESSURE
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
  ) {

    shortScore += 7;

  }


  if (
    liquidationPressure ===
    "SHORT_LIQUIDATION"
  ) {

    longScore += 7;

  }


  // =================================================
  // DIRECTION
  // =================================================

  let direction =
    "WAIT";


  /*
   * تغییر مهم:
   *
   * قبلاً فقط score خام >=35 بود.
   *
   * حالا اگر حداقل 2 تایم‌فریم
   * هم‌جهت باشند، اجازه بررسی
   * سیگنال داده می‌شود.
   */

  if (
    bullish >= 2 &&
    longScore > shortScore
  ) {

    direction =
      "LONG";

  }


  if (
    bearish >= 2 &&
    shortScore > longScore
  ) {

    direction =
      "SHORT";

  }


  // =================================================
  // اگر 3 تایم‌فریم کامل هم‌جهت باشند
  // =================================================

  if (
    bullish === 3 &&
    longScore >= shortScore
  ) {

    longScore += 10;

    direction =
      "LONG";

  }


  if (
    bearish === 3 &&
    shortScore >= longScore
  ) {

    shortScore += 10;

    direction =
      "SHORT";

  }


  // =================================================
  // اگر فقط یک TF باشد
  // =================================================

  if (
    bullish < 2 &&
    bearish < 2
  ) {

    direction =
      "WAIT";

  }


  // =================================================
  // MAIN TF
  // =================================================

  const main =
    timeframes["5"] ||
    timeframes["3"] ||
    timeframes["1"];


  // =================================================
  // FINAL SCORE
  // =================================================

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
  // SAFETY FILTER
  // =================================================

  let confirmed = true;

  const reasons = [];


  // حداقل دو تایم‌فریم
  if (
    direction === "LONG" &&
    bullish < 2
  ) {

    confirmed = false;

    reasons.push(
      "تأیید حداقل دو تایم‌فریم وجود ندارد"
    );

  }


  if (
    direction === "SHORT" &&
    bearish < 2
  ) {

    confirmed = false;

    reasons.push(
      "تأیید حداقل دو تایم‌فریم وجود ندارد"
    );

  }


  // Footprint مخالف
  if (
    direction === "LONG" &&
    footprint &&
    footprint.deltaPercent < -20
  ) {

    reasons.push(
      "Footprint مخالف LONG است"
    );

    // دیگر سیگنال را مستقیم حذف نمی‌کنیم
    confirmed = true;

  }


  if (
    direction === "SHORT" &&
    footprint &&
    footprint.deltaPercent > 20
  ) {

    reasons.push(
      "Footprint مخالف SHORT است"
    );

    confirmed = true;

  }


  // دیوار مخالف
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


  // امتیاز
  if (
    score < MIN_SIGNAL_SCORE
  ) {

    confirmed = false;

    reasons.push(
      "امتیاز کمتر از حد تأیید است"
    );

  }


  // =================================================
  // FINAL WAIT
  // =================================================

  if (!confirmed) {

    direction =
      "WAIT";

  }


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


  // =================================================
  // RETURN
  // =================================================

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
        footprint,
        hunt
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
// TIMEFRAME ANALYSIS
// =================================================

function analyzeTimeframe(rows) {

  if (
    !rows ||
    rows.length < 30
  ) {

    throw new Error(
      "Not enough candles"
    );

  }


  const closes =
    rows.map(
      x => x.close
    );


  const volumes =
    rows.map(
      x => x.volume
    );


  const price =
    closes[
      closes.length - 1
    ];


  const ma7 =
    sma(closes, 7);


  const ma20 =
    sma(closes, 20);


  const previousMA20 =
    sma(
      closes.slice(0, -1),
      20
    );


  let maSlope =
    "FLAT";


  if (
    ma20 > previousMA20
  )
    maSlope = "UP";


  if (
    ma20 < previousMA20
  )
    maSlope = "DOWN";


  let trend =
    "RANGE";


  if (
    ma7 > ma20
  )
    trend = "BULLISH";


  if (
    ma7 < ma20
  )
    trend = "BEARISH";


  const current =
    rows[
      rows.length - 1
    ];


  const touchMA20 =
    current.low <= ma20 &&
    current.high >= ma20;


  const reaction =
    current.close >
    current.open

      ? "BULLISH"

      : current.close <
        current.open

      ? "BEARISH"

      : "NEUTRAL";


  const structure =
    detectStructure(rows);


  const fvg =
    detectFVG(rows);


  const volumeMA7 =
    sma(
      volumes,
      7
    );


  const volumeMA20 =
    sma(
      volumes,
      20
    );


  const volumeSpike =
    volumeMA20 > 0 &&
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

  if (
    rows.length < 12
  )
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
  ) {

    return "BULLISH";

  }


  if (
    h3 < h2 &&
    h2 < h1 &&
    l3 < l2
  ) {

    return "BEARISH";

  }


  return "NONE";

}


// =================================================
// FVG
// =================================================

function detectFVG(rows) {

  if (
    rows.length < 3
  ) {

    return {

      type: "NONE",
      bottom: null,
      top: null,
      status: "NONE"

    };

  }


  const a =
    rows[
      rows.length - 3
    ];


  const c =
    rows[
      rows.length - 1
    ];


  // Bullish FVG
  if (
    c.low > a.high
  ) {

    return {

      type: "BULLISH",

      bottom:
        a.high,

      top:
        c.low,

      status:
        "ACTIVE"

    };

  }


  // Bearish FVG
  if (
    c.high < a.low
  ) {

    return {

      type: "BEARISH",

      bottom:
        c.high,

      top:
        a.low,

      status:
        "ACTIVE"

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

async function getMarketData(
  symbol
) {

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
  ] =
    await Promise.all([
      tickerPromise,
      oiPromise,
      bookPromise
    ]);


  const ticker =
    tickerData.result?.list?.[0]
    || {};


  const oiList =
    oiData.result?.list
    || [];


  let oiCurrent = 0;
  let oiPrevious = 0;


  if (
    oiList.length > 0
  ) {

    oiCurrent =
      Number(
        oiList[0].openInterest || 0
      );

  }


  if (
    oiList.length > 1
  ) {

    oiPrevious =
      Number(
        oiList[1].openInterest || 0
      );

  }


  const oiChangePercent =
    oiPrevious > 0

      ? (
          (
            oiCurrent -
            oiPrevious
          ) /
          oiPrevious
        ) * 100

      : 0;


  const bids =
    bookData.result?.b
    || [];


  const asks =
    bookData.result?.a
    || [];


  const orderBook =
    analyzeOrderBook(
      bids,
      asks,
      Number(
        ticker.lastPrice || 0
      )
    );


  return {

    price:
      Number(
        ticker.lastPrice || 0
      ),

    funding: {

      rate:
        Number(
          ticker.fundingRate || 0
        ) * 100,

      nextFunding:
        ticker.nextFundingTime
        || null

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


  for (
    const b of bids
  ) {

    const p =
      Number(
        b[0] || 0
      );

    const q =
      Number(
        b[1] || 0
      );


    const value =
      p * q;


    bidValue +=
      value;


    if (
      value > biggestBid
    )
      biggestBid =
        value;

  }


  for (
    const a of asks
  ) {

    const p =
      Number(
        a[0] || 0
      );

    const q =
      Number(
        a[1] || 0
      );


    const value =
      p * q;


    askValue +=
      value;


    if (
      value > biggestAsk
    )
      biggestAsk =
        value;

  }


  const total =
    bidValue +
    askValue;


  const bidRatio =
    total > 0

      ? (
          bidValue /
          total
        ) * 100

      : 50;


  const askRatio =
    total > 0

      ? (
          askValue /
          total
        ) * 100

      : 50;


  const averageBid =
    bids.length > 0

      ? bidValue /
        bids.length

      : 0;


  const averageAsk =
    asks.length > 0

      ? askValue /
        asks.length

      : 0;


  const oppositeWallForLong =
    averageAsk > 0 &&
    biggestAsk >
    averageAsk * 5;


  const oppositeWallForShort =
    averageBid > 0 &&
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

async function getFootprint(
  symbol
) {

  const data =
    await bybit(
      "/v5/market/recent-trade" +
      "?category=linear" +
      "&symbol=" +
      encodeURIComponent(symbol) +
      "&limit=500"
    );


  const trades =
    data.result?.list
    || [];


  if (
    !trades.length
  ) {

    return {

      trades: 0,

      buyVolume: 0,

      sellVolume: 0,

      delta: 0,

      deltaPercent: 0,

      buyRatio: 0,

      sellRatio: 0,

      largeTrade: false,

      largeTradeNotional: 0,

      averageTradeNotional: 0

    };

  }


  let buyVolume = 0;
  let sellVolume = 0;


  const notionals = [];


  for (
    const t of trades
  ) {

    const price =
      Number(
        t.price || 0
      );


    const size =
      Number(
        t.size || 0
      );


    const notional =
      price * size;


    notionals.push(
      notional
    );


    if (
      String(t.side)
        .toLowerCase() ===
      "buy"
    ) {

      buyVolume +=
        size;

    } else {

      sellVolume +=
        size;

    }

  }


  const total =
    buyVolume +
    sellVolume;


  const delta =
    buyVolume -
    sellVolume;


  const deltaPercent =
    total > 0

      ? (
          delta /
          total
        ) * 100

      : 0;


  const buyRatio =
    total > 0

      ? (
          buyVolume /
          total
        ) * 100

      : 0;


  const sellRatio =
    total > 0

      ? (
          sellVolume /
          total
        ) * 100

      : 0;


  const average =
    notionals.reduce(
      (a, b) =>
        a + b,
      0
    ) /
    notionals.length;


  let largest = 0;


  for (
    const n of notionals
  ) {

    if (
      n > largest
    )
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
      largest >=
      average * 5,

    largeTradeNotional:
      largest,

    averageTradeNotional:
      average

  };

}


// =================================================
// LIQUIDITY HUNT
// =================================================

function detectLiquidityHunt(
  analyses
) {

  let bullish = false;
  let bearish = false;


  for (
    const x of analyses
  ) {

    if (
      x.structure ===
        "BULLISH" &&
      x.reaction ===
        "BULLISH"
    ) {

      bullish = true;

    }


    if (
      x.structure ===
        "BEARISH" &&
      x.reaction ===
        "BEARISH"
    ) {

      bearish = true;

    }

  }


  if (
    bullish &&
    !bearish
  )
    return "BULLISH_HUNT";


  if (
    bearish &&
    !bullish
  )
    return "BEARISH_HUNT";


  return "NONE";

}


// =================================================
// LIQUIDATION PRESSURE
// =================================================

function detectLiquidationPressure(
  analyses,
  market,
  footprint
) {

  const oi =
    market.oi.changePercent;


  const delta =
    footprint?.deltaPercent
    || 0;


  if (
    oi < -2 &&
    delta < -12
  ) {

    return "LONG_LIQUIDATION";

  }


  if (
    oi < -2 &&
    delta > 12
  ) {

    return "SHORT_LIQUIDATION";

  }


  return "NONE";

}


// =================================================
// FINAL SCORE V10
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
  ) {

    return 0;

  }


  let score = 0;


  // =================================================
  // MA SLOPE
  // =================================================

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


  // =================================================
  // STRUCTURE
  // =================================================

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


  // =================================================
  // FVG
  // =================================================

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


  // =================================================
  // MA20 TOUCH
  // =================================================

  if (
    x.touchMA20
  )
    score += 6;


  // =================================================
  // VOLUME
  // =================================================

  if (
    x.volume.spike
  )
    score += 6;


  // =================================================
  // MULTI TF
  // =================================================

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
    score += 10;


  if (
    direction === "SHORT" &&
    bearish === 2
  )
    score += 10;


  // =================================================
  // FOOTPRINT
  // =================================================

  if (
    footprint
  ) {

    if (
      direction === "LONG" &&
      footprint.deltaPercent > 10
    )
      score += 12;


    if (
      direction === "SHORT" &&
      footprint.deltaPercent < -10
    )
      score += 12;


    // Footprint مخالف:
    // جریمه، نه حذف کامل

    if (
      direction === "LONG" &&
      footprint.deltaPercent < -20
    )
      score -= 8;


    if (
      direction === "SHORT" &&
      footprint.deltaPercent > 20
    )
      score -= 8;

  }


  // =================================================
  // ORDER BOOK
  // =================================================

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


  // =================================================
  // LIQUIDITY HUNT
  // =================================================

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


  // =================================================
  // LIQUIDATION
  // =================================================

  if (
    direction === "LONG" &&
    liquidation ===
      "SHORT_LIQUIDATION"
  )
    score += 5;


  if (
    direction === "SHORT" &&
    liquidation ===
      "LONG_LIQUIDATION"
  )
    score += 5;


  // =================================================
  // OPPOSITE WALL
  // =================================================

  if (
    direction === "LONG" &&
    book.oppositeWallForLong
  )
    score -= 10;


  if (
    direction === "SHORT" &&
    book.oppositeWallForShort
  )
    score -= 10;


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
  footprint,
  hunt
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


  if (
    x.touchMA20
  )
    c++;


  if (
    x.volume.spike
  )
    c++;


  if (
    bullish >= 2 &&
    direction === "LONG"
  )
    c++;


  if (
    bearish >= 2 &&
    direction === "SHORT"
  )
    c++;


  if (
    bullish === 3 &&
    direction === "LONG"
  )
    c++;


  if (
    bearish === 3 &&
    direction === "SHORT"
  )
    c++;


  if (
    footprint
  ) {

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


  if (
    direction === "LONG" &&
    hunt === "BULLISH_HUNT"
  )
    c++;


  if (
    direction === "SHORT" &&
    hunt === "BEARISH_HUNT"
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
    Number(
      x.price
    );


  /*
   * فعلاً همان 1.2%
   * برای تست نگه داشته شده.
   *
   * بعداً ATR را اضافه می‌کنیم.
   */

  const risk =
    price * 0.012;


  if (
    direction === "LONG"
  ) {

    const sl =
      price - risk;


    return {

      entry:
        price,

      sl,

      tp1:
        price + risk,

      tp2:
        price +
        risk * 2,

      tp3:
        price +
        risk * 3,

      rr:
        "1:3"

    };

  }


  const sl =
    price + risk;


  return {

    entry:
      price,

    sl,

    tp1:
      price - risk,

    tp2:
      price -
      risk * 2,

    tp3:
      price -
      risk * 3,

    rr:
      "1:3"

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
    data.result?.list
    || []
  )

    .reverse()

    .map(
      x => ({

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

      })
    );

}


// =================================================
// BYBIT REQUEST
// =================================================

async function bybit(
  path
) {

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


  if (
    !response.ok
  ) {

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
// NORMALIZE SYMBOL
// =================================================

function normalizeSymbol(
  symbol
) {

  if (!symbol)
    return "";


  return String(
    symbol
  )
    .trim()
    .toUpperCase()
    .replace(
      "/",
      ""
    )
    .replace(
      "-",
      ""
    );

}


// =================================================
// CLAMP
// =================================================

function clamp(
  value,
  min,
  max
) {

  return Math.max(
    min,
    Math.min(
      max,
      value
    )
  );

}


// =================================================
// SMA
// =================================================

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
        a +
        Number(b),
      0
    ) /
    period
  );

}


// =================================================
// JSON RESPONSE
// =================================================

function json(
  data,
  status = 200
) {

  return new Response(

    JSON.stringify(
      data
    ),

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
