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

        const footprint =
          await getFootprint(symbol);

        return json({
          ok: true,
          symbol,
          footprint
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

        const results =
          await scanMarket();

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


// =================================================
// MARKET SCAN
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

  const results = [];

  const batchSize = 10;

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

    batchResults.forEach(r => {

      if (
        r &&
        r.direction !== "WAIT" &&
        r.score >= 45
      ) {
        results.push(r);
      }

    });
  }

  results.sort(
    (a, b) => b.score - a.score
  );

  /*
   * اطلاعات سنگین فقط برای 5 کاندید برتر.
   * این کار جلوی خطای Too Many Subrequests را می‌گیرد.
   */

  const topCandidates =
    results.slice(0, 5);

  const enriched =
    await Promise.all(
      topCandidates.map(async r => {

        try {
          r.footprint =
            await getFootprint(r.symbol);
        } catch (e) {
          r.footprint = {
            error: e?.message || String(e)
          };
        }

        return r;
      })
    );

  enriched.sort(
    (a, b) => b.score - a.score
  );

  return {
    scanned: candidates.length,
    results: enriched.slice(0, 10)
  };
}


// =================================================
// ANALYZE SYMBOL
// =================================================

async function analyzeSymbol(
  symbol,
  withFootprint = false
) {

  symbol = normalizeSymbol(symbol);

  if (!symbol) {
    throw new Error("Invalid symbol");
  }

  /*
   * 3 تایم‌فریم
   */
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
          data: analyzeTimeframe(rows)
        };

      })
    );


  const timeframes = {};

  data.forEach(x => {
    timeframes[x.key] = x.data;
  });


  const analyses =
    TIMEFRAMES
      .map(tf => timeframes[tf.key])
      .filter(Boolean);


  if (!analyses.length) {
    throw new Error("No market data");
  }


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

    const x = timeframes[tf.key];

    if (!x) continue;

    const weight = tf.weight;


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


  /*
   * سه تایم‌فریم
   */
  if (bullish === 3)
    longScore += 10;

  if (bearish === 3)
    shortScore += 10;


  /*
   * جهت اولیه
   */
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


  /*
   * اطلاعات بازار:
   * OI
   * Funding
   * Long/Short
   * Order Book
   */
  let market = null;

  try {

    market =
      await getMarketContext(
        symbol
      );

  } catch (e) {

    market = {
      error: e?.message || String(e)
    };

  }


  /*
   * تحلیل نقدینگی و نهنگ
   */
  let liquidity = null;

  try {

    liquidity =
      analyzeLiquidity(
        market?.orderBook,
        direction,
        timeframes["5"]?.price
      );

  } catch (e) {

    liquidity = {
      error: e?.message || String(e)
    };

  }


  /*
   * شکار نقدینگی / Hunt
   */
  const hunt =
    detectLiquidityHunt(
      timeframes["5"]?.rows || null
    );


  /*
   * Order Block
   */
  const orderBlock =
    detectOrderBlock(
      timeframes["5"]?.rows || null
    );


  /*
   * Footprint
   */
  let footprint = null;

  if (withFootprint) {

    try {

      footprint =
        await getFootprint(symbol);

    } catch (e) {

      footprint = {
        error: e?.message || String(e)
      };

    }
  }


  /*
   * امتیاز بازار
   */
  const marketScore =
    scoreMarketContext(
      market,
      liquidity,
      direction
    );


  if (direction === "LONG")
    longScore += marketScore;

  if (direction === "SHORT")
    shortScore += marketScore;


  /*
   * بررسی تضاد Footprint
   */
  const footprintConflict =
    isFootprintConflict(
      footprint,
      direction
    );


  /*
   * اگر فشار سفارشات شدیداً مخالف باشد:
   * ورود ممنوع
   */
  if (
    liquidity?.danger === true
  ) {
    direction = "WAIT";
  }


  if (
    footprintConflict === true
  ) {
    direction = "WAIT";
  }


  /*
   * امتیاز نهایی
   */
  const main =
    timeframes["5"] ||
    timeframes["3"] ||
    timeframes["1"];


  const score =
    calculateFinalScore(
      main,
      direction,
      bullish,
      bearish,
      market,
      liquidity,
      hunt,
      orderBlock,
      footprint
    );


  /*
   * Entry / SL / TP
   */
  let targets = null;

  if (
    direction !== "WAIT" &&
    score >= 55
  ) {

    targets =
      calculateSmartTargets(
        main,
        direction,
        orderBlock,
        hunt
      );
  }


  /*
   * تعداد تأییدها
   */
  const confirmations =
    countConfirmations(
      main,
      direction,
      bullish,
      bearish,
      market,
      liquidity,
      hunt,
      orderBlock,
      footprint
    );


  /*
   * نتیجه ورود
   */
  const entryStatus =
    direction === "WAIT"
      ? "WAIT"
      : score >= 75
      ? "STRONG_ENTRY"
      : score >= 60
      ? "ENTRY"
      : "WEAK";


  return {

    symbol,

    direction,

    entryStatus,

    score,

    mainTimeframe: "5",

    price: main.price,

    entry: targets?.entry || null,

    sl: targets?.sl || null,

    tp1: targets?.tp1 || null,

    tp2: targets?.tp2 || null,

    tp3: targets?.tp3 || null,

    rr: targets?.rr || null,

    bullishTimeframes: bullish,

    bearishTimeframes: bearish,

    confirmations,

    market,

    liquidity,

    hunt,

    orderBlock,

    footprint,

    timeframes

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

    rows,

    ma7,

    ma20,

    maSlope,

    trend,

    touchMA20,

    reaction,

    structure,

    fvg,

    volume: {

      current: current.volume,

      ma7: volumeMA7,

      ma20: volumeMA20,

      spike: volumeSpike

    },

    previousClose:
      previous.close

  };
}


// =================================================
// STRUCTURE
// =================================================

function detectStructure(rows) {

  if (!rows || rows.length < 12)
    return "NONE";


  const n = rows.length;


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

  if (!rows || rows.length < 3) {

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
// MARKET CONTEXT
// =================================================

async function getMarketContext(symbol) {

  /*
   * این درخواست‌ها فقط در تحلیل دستی
   * یا کاندید نهایی انجام می‌شوند.
   */

  const [
    ticker,
    oi,
    funding,
    longShort,
    orderBook
  ] = await Promise.all([

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
      "&intervalTime=5min&limit=2"
    ),

    bybit(
      "/v5/market/funding/history" +
      "?category=linear" +
      "&symbol=" +
      encodeURIComponent(symbol) +
      "&limit=1"
    ),

    bybit(
      "/v5/market/account-ratio" +
      "?category=linear" +
      "&symbol=" +
      encodeURIComponent(symbol) +
      "&period=5min&limit=1"
    ),

    bybit(
      "/v5/market/orderbook" +
      "?category=linear" +
      "&symbol=" +
      encodeURIComponent(symbol) +
      "&limit=50"
    )

  ]);


  const tickerRow =
    ticker.result?.list?.[0] || {};


  const oiRows =
    oi.result?.list || [];


  const currentOI =
    Number(
      oiRows[0]?.openInterest ||
      oiRows[0]?.singleOpenInterest ||
      0
    );


  const previousOI =
    Number(
      oiRows[1]?.openInterest ||
      oiRows[1]?.singleOpenInterest ||
      0
    );


  const oiChange =
    previousOI > 0
      ? ((currentOI - previousOI) /
          previousOI) * 100
      : 0;


  const fundingRow =
    funding.result?.list?.[0] || {};


  const fundingRate =
    Number(
      fundingRow.fundingRate || 0
    );


  const ratioRow =
    longShort.result?.list?.[0] || {};


  const buyRatio =
    Number(
      ratioRow.buyRatio || 0
    );


  const sellRatio =
    Number(
      ratioRow.sellRatio || 0
    );


  const bids =
    orderBook.result?.b || [];


  const asks =
    orderBook.result?.a || [];


  return {

    ticker: {

      price:
        Number(tickerRow.lastPrice || 0),

      turnover24h:
        Number(tickerRow.turnover24h || 0),

      volume24h:
        Number(tickerRow.volume24h || 0)

    },

    oi: {

      current: currentOI,

      previous: previousOI,

      changePercent: oiChange

    },

    funding: {

      rate: fundingRate,

      percent: fundingRate * 100

    },

    longShort: {

      buyRatio,

      sellRatio

    },

    orderBook: {

      bids,

      asks

    }

  };
}


// =================================================
// ORDER BOOK / WALL
// =================================================

function analyzeLiquidity(
  orderBook,
  direction,
  price
) {

  if (
    !orderBook ||
    !price
  ) {

    return {

      available: false,

      danger: false

    };
  }


  const bids =
    orderBook.bids || [];

  const asks =
    orderBook.asks || [];


  let bidNotional = 0;
  let askNotional = 0;


  let largestBid = 0;
  let largestAsk = 0;


  let largestBidPrice = null;
  let largestAskPrice = null;


  for (const b of bids) {

    const p = Number(b[0]);
    const q = Number(b[1]);

    const n = p * q;

    bidNotional += n;

    if (n > largestBid) {

      largestBid = n;
      largestBidPrice = p;

    }
  }


  for (const a of asks) {

    const p = Number(a[0]);
    const q = Number(a[1]);

    const n = p * q;

    askNotional += n;

    if (n > largestAsk) {

      largestAsk = n;
      largestAskPrice = p;

    }
  }


  const averageBid =
    bids.length > 0
      ? bidNotional / bids.length
      : 0;


  const averageAsk =
    asks.length > 0
      ? askNotional / asks.length
      : 0;


  const bidWall =
    largestBid >
    averageBid * 5;


  const askWall =
    largestAsk >
    averageAsk * 5;


  /*
   * اگر LONG است و دیوار فروش بسیار بزرگ
   * نزدیک قیمت قرار دارد، ورود خطرناک است.
   *
   * اگر SHORT است و دیوار خرید بسیار بزرگ
   * نزدیک قیمت قرار دارد، ورود خطرناک است.
   */

  let danger = false;


  if (
    direction === "LONG" &&
    askWall &&
    largestAskPrice > price
  ) {

    danger = true;

  }


  if (
    direction === "SHORT" &&
    bidWall &&
    largestBidPrice < price
  ) {

    danger = true;

  }


  return {

    available: true,

    bidNotional,

    askNotional,

    largestBid,

    largestAsk,

    largestBidPrice,

    largestAskPrice,

    bidWall,

    askWall,

    danger

  };
}


// =================================================
// OI / FUNDING / MARKET SCORE
// =================================================

function scoreMarketContext(
  market,
  liquidity,
  direction
) {

  if (!market)
    return 0;


  let score = 0;


  const oiChange =
    Number(
      market.oi?.changePercent || 0
    );


  const funding =
    Number(
      market.funding?.rate || 0
    );


  const buyRatio =
    Number(
      market.longShort?.buyRatio || 0
    );


  const sellRatio =
    Number(
      market.longShort?.sellRatio || 0
    );


  if (direction === "LONG") {

    /*
     * LONG بهتر است:
     * OI در حال افزایش
     * Funding بیش از حد مثبت نباشد
     * نسبت خریداران مناسب باشد
     */

    if (oiChange > 0.5)
      score += 3;

    if (funding <= 0.0005)
      score += 2;

    if (buyRatio > sellRatio)
      score += 3;

  }


  if (direction === "SHORT") {

    /*
     * SHORT بهتر است:
     * OI در حال افزایش
     * Funding خیلی منفی نباشد
     * فروشندگان غالب باشند
     */

    if (oiChange > 0.5)
      score += 3;

    if (funding >= -0.0005)
      score += 2;

    if (sellRatio > buyRatio)
      score += 3;

  }


  if (
    liquidity &&
    liquidity.danger === false
  ) {
    score += 3;
  }


  return Math.min(
    10,
    score
  );
}


// =================================================
// LIQUIDITY HUNT
// =================================================

function detectLiquidityHunt(rows) {

  if (!rows || rows.length < 10) {

    return {
      type: "NONE",
      detected: false
    };
  }


  const n = rows.length;


  const recent =
    rows[n - 1];


  const previous =
    rows.slice(
      Math.max(0, n - 8),
      n - 1
    );


  const previousHigh =
    Math.max(
      ...previous.map(x => x.high)
    );


  const previousLow =
    Math.min(
      ...previous.map(x => x.low)
    );


  /*
   * Sweep بالای سقف و برگشت
   */
  if (
    recent.high > previousHigh &&
    recent.close < previousHigh
  ) {

    return {

      type: "SELL_SIDE_LIQUIDITY_HUNT",

      detected: true,

      level: previousHigh

    };
  }


  /*
   * Sweep پایین کف و برگشت
   */
  if (
    recent.low < previousLow &&
    recent.close > previousLow
  ) {

    return {

      type: "BUY_SIDE_LIQUIDITY_HUNT",

      detected: true,

      level: previousLow

    };
  }


  return {

    type: "NONE",

    detected: false,

    level: null

  };
}


// =================================================
// ORDER BLOCK
// =================================================

function detectOrderBlock(rows) {

  if (!rows || rows.length < 6) {

    return {
      type: "NONE",
      detected: false
    };
  }


  const n = rows.length;


  const c1 =
    rows[n - 2];

  const c2 =
    rows[n - 1];


  /*
   * Bullish Order Block:
   * کندل قبلی نزولی
   * کندل بعدی حرکت صعودی قوی
   */

  if (
    c1.close < c1.open &&
    c2.close > c2.open &&
    c2.close > c1.high
  ) {

    return {

      type: "BULLISH",

      detected: true,

      low: c1.low,

      high: c1.high

    };
  }


  /*
   * Bearish Order Block
   */

  if (
    c1.close > c1.open &&
    c2.close < c2.open &&
    c2.close < c1.low
  ) {

    return {

      type: "BEARISH",

      detected: true,

      low: c1.low,

      high: c1.high

    };
  }


  return {

    type: "NONE",

    detected: false,

    low: null,

    high: null

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


    const side =
      String(
        t.side || ""
      ).toLowerCase();


    if (side === "buy") {

      buyVolume += size;

    } else if (side === "sell") {

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


// =================================================
// FOOTPRINT CONFLICT
// =================================================

function isFootprintConflict(
  footprint,
  direction
) {

  if (!footprint)
    return false;


  const delta =
    Number(
      footprint.deltaPercent || 0
    );


  if (
    direction === "LONG" &&
    delta < -20
  ) {

    return true;
  }


  if (
    direction === "SHORT" &&
    delta > 20
  ) {

    return true;
  }


  return false;
}


// =================================================
// FINAL SCORE
// =================================================

function calculateFinalScore(
  x,
  direction,
  bullish,
  bearish,
  market,
  liquidity,
  hunt,
  orderBlock,
  footprint
) {

  if (!x || direction === "WAIT")
    return 0;


  let score = 0;


  /*
   * روند MA
   */
  if (
    direction === "LONG" &&
    x.maSlope === "UP"
  )
    score += 15;


  if (
    direction === "SHORT" &&
    x.maSlope === "DOWN"
  )
    score += 15;


  /*
   * Structure
   */
  if (
    direction === "LONG" &&
    x.structure === "BULLISH"
  )
    score += 15;


  if (
    direction === "SHORT" &&
    x.structure === "BEARISH"
  )
    score += 15;


  /*
   * FVG
   */
  if (
    direction === "LONG" &&
    x.fvg.type === "BULLISH"
  )
    score += 10;


  if (
    direction === "SHORT" &&
    x.fvg.type === "BEARISH"
  )
    score += 10;


  /*
   * Volume
   */
  if (x.volume.spike)
    score += 8;


  /*
   * سه تایم‌فریم
   */
  if (
    direction === "LONG" &&
    bullish === 3
  )
    score += 15;


  if (
    direction === "SHORT" &&
    bearish === 3
  )
    score += 15;


  /*
   * OI / Funding / L/S
   */
  if (market) {

    const oiChange =
      Number(
        market.oi?.changePercent || 0
      );

    const funding =
      Number(
        market.funding?.rate || 0
      );

    const buyRatio =
      Number(
        market.longShort?.buyRatio || 0
      );

    const sellRatio =
      Number(
        market.longShort?.sellRatio || 0
      );


    if (direction === "LONG") {

      if (oiChange > 0.5)
        score += 4;

      if (funding <= 0.0005)
        score += 3;

      if (buyRatio > sellRatio)
        score += 3;

    }


    if (direction === "SHORT") {

      if (oiChange > 0.5)
        score += 4;

      if (funding >= -0.0005)
        score += 3;

      if (sellRatio > buyRatio)
        score += 3;

    }

  }


  /*
   * Order Book
   */
  if (
    liquidity &&
    !liquidity.danger
  ) {

    score += 5;

  }


  /*
   * Hunt
   */
  if (
    hunt?.detected
  ) {

    if (
      direction === "SHORT" &&
      hunt.type ===
      "SELL_SIDE_LIQUIDITY_HUNT"
    )
      score += 5;


    if (
      direction === "LONG" &&
      hunt.type ===
      "BUY_SIDE_LIQUIDITY_HUNT"
    )
      score += 5;

  }


  /*
   * Order Block
   */
  if (
    orderBlock?.detected
  ) {

    if (
      direction === "LONG" &&
      orderBlock.type === "BULLISH"
    )
      score += 5;


    if (
      direction === "SHORT" &&
      orderBlock.type === "BEARISH"
    )
      score += 5;

  }


  /*
   * Footprint
   */
  if (footprint) {

    const delta =
      Number(
        footprint.deltaPercent || 0
      );


    if (
      direction === "LONG" &&
      delta > 15
    )
      score += 5;


    if (
      direction === "SHORT" &&
      delta < -15
    )
      score += 5;

  }


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
  bearish,
  market,
  liquidity,
  hunt,
  orderBlock,
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


  if (x.volume.spike)
    c++;


  if (
    bullish === 3 ||
    bearish === 3
  )
    c++;


  if (
    market?.oi?.changePercent > 0.5
  )
    c++;


  if (
    liquidity &&
    liquidity.danger === false
  )
    c++;


  if (hunt?.detected)
    c++;


  if (orderBlock?.detected)
    c++;


  if (footprint) {

    const d =
      Number(
        footprint.deltaPercent || 0
      );


    if (
      (direction === "LONG" && d > 15) ||
      (direction === "SHORT" && d < -15)
    )
      c++;

  }


  return c;
}


// =================================================
// SMART TARGETS
// =================================================

function calculateSmartTargets(
  x,
  direction,
  orderBlock,
  hunt
) {

  const price =
    Number(x.price);


  if (!price)
    return null;


  /*
   * ریسک پایه 1.5 درصد
   */
  let risk =
    price * 0.015;


  /*
   * Order Block می‌تواند SL را بهتر کند.
   */

  if (
    orderBlock?.detected
  ) {

    if (
      direction === "LONG" &&
      orderBlock.low < price
    ) {

      const r =
        price - orderBlock.low;

      if (
        r > 0 &&
        r < risk * 1.5
      ) {
        risk = r;
      }

    }


    if (
      direction === "SHORT" &&
      orderBlock.high > price
    ) {

      const r =
        orderBlock.high - price;

      if (
        r > 0 &&
        r < risk * 1.5
      ) {
        risk = r;
      }

    }

  }


  if (direction === "LONG") {

    const sl =
      price - risk;

    return {

      entry: price,

      sl,

      tp1: price + risk,

      tp2: price + risk * 2,

      tp3: price + risk * 3,

      rr: "1:3"

    };
  }


  const sl =
    price + risk;


  return {

    entry: price,

    sl,

    tp1: price - risk,

    tp2: price - risk * 2,

    tp3: price - risk * 3,

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


  const list =
    data.result?.list || [];


  if (!list.length)
    throw new Error(
      "No kline data for " + symbol
    );


  return list
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
          "Accept": "application/json"
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
      "Bybit API error " +
      data.retCode
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
    (a, b) => a + Number(b),
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
