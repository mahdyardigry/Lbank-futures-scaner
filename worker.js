const BYBIT_BASE = "https://api.bybit.com";

/*
 * =========================================================
 * SCANNER CONFIG
 * =========================================================
 *
 * PRIORITY_SCAN:
 * تعداد ارزهایی که در مرحله اول غربال می‌شوند.
 *
 * DEEP_SCAN:
 * تعداد ارزهایی که بعد از غربال وارد تحلیل سنگین می‌شوند.
 *
 * دلیل جدا بودن این دو:
 * بررسی عمیق 200 ارز با چندین API برای هر ارز
 * روی Cloudflare Free مناسب نیست.
 *
 * بنابراین:
 *
 * Bybit Futures
 *      ↓
 * 200 ارز اولویت‌دار
 *      ↓
 * 8 ارز برتر
 *      ↓
 * تحلیل کامل
 */

const PRIORITY_SCAN = 200;
const DEEP_SCAN = 8;

const MIN_SIGNAL_SCORE = 70;

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


/*
 * =========================================================
 * WORKER
 * =========================================================
 */

export default {

  async fetch(request) {

    const url = new URL(request.url);

    /*
     * CORS preflight
     */

    if (request.method === "OPTIONS") {

      return new Response(null, {
        status: 204,
        headers: cors
      });

    }


    try {

      /*
       * =====================================================
       * FUTURES LIST
       * =====================================================
       */

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


      /*
       * =====================================================
       * KLINE
       * =====================================================
       */

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


      /*
       * =====================================================
       * FOOTPRINT
       * =====================================================
       */

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


      /*
       * =====================================================
       * MARKET
       * =====================================================
       */

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


      /*
       * =====================================================
       * MANUAL ANALYZE
       * =====================================================
       */

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


      /*
       * =====================================================
       * MARKET SCAN
       * =====================================================
       */

      if (url.pathname === "/api/scan") {

        const result =
          await scanMarket();

        return json({
          ok: true,
          ...result
        });

      }


      /*
       * =====================================================
       * ALERTS
       * =====================================================
       *
       * هشدارها فعال هستند.
       *
       * این endpoint فقط سیگنال‌های تاییدشده
       * LONG / SHORT را برمی‌گرداند.
       *
       * Mute کردن صدا در Frontend نباید
       * این endpoint را خاموش کند.
       */

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


      /*
       * =====================================================
       * UNKNOWN API
       * =====================================================
       */

      return json({
        ok: false,
        error: "API endpoint not found"
      }, 404);

    }

    catch (error) {

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


/*
 * =========================================================
 * MARKET SCAN
 * =========================================================
 *
 * مرحله اول:
 * یک بار کل Ticker های Linear Futures را می‌گیریم.
 *
 * سپس 200 ارز اولویت‌دار را انتخاب می‌کنیم.
 *
 * سپس فقط 8 ارز برتر وارد تحلیل عمیق می‌شوند.
 */

async function scanMarket() {

  /*
   * =======================================================
   * STEP 1
   * دریافت Ticker کل Futures
   * =======================================================
   */

  const tickerData =
    await bybit(
      "/v5/market/tickers?category=linear"
    );

  const tickers =
    tickerData.result?.list || [];

  if (!tickers.length) {

    throw new Error(
      "Bybit ticker data unavailable"
    );

  }


  /*
   * =======================================================
   * STEP 2
   * فیلتر ارزهای مناسب
   * =======================================================
   */

  const eligible =
    tickers.filter(x => {

      const symbol =
        String(x.symbol || "");

      const turnover =
        Number(
          x.turnover24h || 0
        );

      const price =
        Number(
          x.lastPrice || 0
        );

      return (
        symbol.endsWith("USDT") &&
        !symbol.includes("-") &&
        turnover > 0 &&
        price > 0
      );

    });


  /*
   * =======================================================
   * STEP 3
   * رتبه‌بندی 200 ارز
   * =======================================================
   */

  const ranked =
    eligible
      .map(x => {

        const change =
          Number(
            x.price24hPcnt || 0
          ) * 100;

        const turnover =
          Number(
            x.turnover24h || 0
          );

        const volume =
          Number(
            x.volume24h || 0
          );

        /*
         * بعضی نسخه‌های API ممکن است
         * openInterestValue را ندهند.
         *
         * در آن حالت صفر می‌گیریم.
         */

        const oi =
          Number(
            x.openInterestValue || 0
          );

        const funding =
          Number(
            x.fundingRate || 0
          ) * 100;


        /*
         * -----------------------------------------------
         * Liquidity Score
         * -----------------------------------------------
         */

        let liquidityScore = 0;

        if (turnover >= 100000000) {

          liquidityScore = 30;

        }
        else if (turnover >= 50000000) {

          liquidityScore = 25;

        }
        else if (turnover >= 20000000) {

          liquidityScore = 20;

        }
        else if (turnover >= 10000000) {

          liquidityScore = 15;

        }
        else if (turnover >= 5000000) {

          liquidityScore = 10;

        }
        else {

          liquidityScore = 5;

        }


        /*
         * -----------------------------------------------
         * Price Movement Score
         * -----------------------------------------------
         */

        const absChange =
          Math.abs(change);

        let movementScore = 0;

        if (absChange >= 8) {

          movementScore = 25;

        }
        else if (absChange >= 5) {

          movementScore = 20;

        }
        else if (absChange >= 3) {

          movementScore = 15;

        }
        else if (absChange >= 1.5) {

          movementScore = 10;

        }
        else {

          movementScore = 3;

        }


        /*
         * -----------------------------------------------
         * OI Score
         * -----------------------------------------------
         */

        let oiScore = 0;

        if (oi >= 50000000) {

          oiScore = 20;

        }
        else if (oi >= 20000000) {

          oiScore = 15;

        }
        else if (oi >= 5000000) {

          oiScore = 10;

        }
        else if (oi > 0) {

          oiScore = 5;

        }
        else {

          oiScore = 2;

        }


        /*
         * -----------------------------------------------
         * Volume Score
         * -----------------------------------------------
         */

        let volumeScore = 0;

        if (volume >= 100000000) {

          volumeScore = 15;

        }
        else if (volume >= 50000000) {

          volumeScore = 12;

        }
        else if (volume >= 10000000) {

          volumeScore = 8;

        }
        else if (volume >= 1000000) {

          volumeScore = 5;

        }
        else {

          volumeScore = 2;

        }


        /*
         * -----------------------------------------------
         * Funding Risk
         * -----------------------------------------------
         */

        let fundingRisk = 0;

        if (Math.abs(funding) >= 0.10) {

          fundingRisk = 8;

        }
        else if (Math.abs(funding) >= 0.05) {

          fundingRisk = 4;

        }


        /*
         * -----------------------------------------------
         * Final Priority Score
         * -----------------------------------------------
         */

        const priorityScore =
          liquidityScore +
          movementScore +
          oiScore +
          volumeScore -
          fundingRisk;


        return {

          symbol:
            x.symbol,

          price:
            Number(
              x.lastPrice || 0
            ),

          change24h:
            change,

          turnover24h:
            turnover,

          volume24h:
            volume,

          openInterestValue:
            oi,

          fundingRate:
            funding,

          priorityScore

        };

      })
      .sort(
        (a, b) =>
          b.priorityScore -
          a.priorityScore
      )
      .slice(
        0,
        PRIORITY_SCAN
      );


  /*
   * =======================================================
   * STEP 4
   * فقط 8 ارز برتر برای تحلیل سنگین
   * =======================================================
   */

  const deepCandidates =
    ranked.slice(
      0,
      DEEP_SCAN
    );


  /*
   * =======================================================
   * STEP 5
   * تحلیل کامل
   * =======================================================
   */

  const batchResults =
    await Promise.all(
      deepCandidates.map(
        async candidate => {

          try {

            return await analyzeSymbol(
              candidate.symbol,
              false
            );

          }

          catch (e) {

            return {

              symbol:
                candidate.symbol,

              direction:
                "WAIT",

              signal:
                "WAIT",

              score:
                0,

              error:
                e?.message ||
                String(e)

            };

          }

        }
      )
    );


  /*
   * =======================================================
   * STEP 6
   * فقط سیگنال‌های تاییدشده
   * =======================================================
   */

  const results =
    batchResults
      .filter(r => {

        return (
          r &&
          r.signal !== "WAIT" &&
          r.score >= MIN_SIGNAL_SCORE
        );

      })
      .sort(
        (a, b) =>
          b.score - a.score
      );


  /*
   * =======================================================
   * RESULT
   * =======================================================
   */

  return {

    /*
     * تعداد واقعی ارزهای غربال‌شده
     */

    scanned:
      ranked.length,

    /*
     * هدف مرحله اول
     */

    priorityUniverse:
      PRIORITY_SCAN,

    /*
     * تعداد تحلیل عمیق
     */

    deepScanned:
      deepCandidates.length,

    /*
     * تعداد سیگنال‌ها
     */

    found:
      results.length,

    /*
     * بهترین موقعیت‌ها
     */

    results:
      results.slice(
        0,
        10
      ),

    /*
     * لیست 200 ارز اولویت‌دار
     */

    priorityCoins:
      ranked.map(x => ({

        symbol:
          x.symbol,

        price:
          x.price,

        change24h:
          x.change24h,

        turnover24h:
          x.turnover24h,

        volume24h:
          x.volume24h,

        openInterestValue:
          x.openInterestValue,

        fundingRate:
          x.fundingRate,

        priorityScore:
          x.priorityScore

      })),

    timestamp:
      Date.now()

  };

}


/*
 * =========================================================
 * ANALYZE SYMBOL
 * =========================================================
 */

async function analyzeSymbol(
  symbol,
  withFootprint = false
) {

  /*
   * =======================================================
   * TIMEFRAMES
   * =======================================================
   */

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

          }

          catch (e) {

            return {

              key:
                tf.key,

              data: {

                error:
                  e?.message ||
                  String(e)

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
      .filter(x => !x.error);


  if (!valid.length) {

    throw new Error(
      "No market data"
    );

  }


  /*
   * =======================================================
   * BULL / BEAR COUNT
   * =======================================================
   */

  let bullish = 0;
  let bearish = 0;


  for (const x of valid) {

    if (x.trend === "BULLISH")
      bullish++;

    if (x.trend === "BEARISH")
      bearish++;

  }


  /*
   * =======================================================
   * INITIAL SCORE
   * =======================================================
   */

  let longScore = 0;
  let shortScore = 0;


  for (const tf of TIMEFRAMES) {

    const x =
      timeframes[tf.key];


    if (!x || x.error)
      continue;


    const w =
      tf.weight;


    /*
     * Trend
     */

    if (x.trend === "BULLISH")
      longScore += 5 * w;

    if (x.trend === "BEARISH")
      shortScore += 5 * w;


    /*
     * MA slope
     */

    if (x.maSlope === "UP")
      longScore += 3 * w;

    if (x.maSlope === "DOWN")
      shortScore += 3 * w;


    /*
     * Structure
     */

    if (x.structure === "BULLISH")
      longScore += 4 * w;

    if (x.structure === "BEARISH")
      shortScore += 4 * w;


    /*
     * FVG
     */

    if (x.fvg.type === "BULLISH")
      longScore += 3 * w;

    if (x.fvg.type === "BEARISH")
      shortScore += 3 * w;


    /*
     * Volume reaction
     */

    if (x.volume.spike) {

      if (x.reaction === "BULLISH")
        longScore += 3 * w;

      if (x.reaction === "BEARISH")
        shortScore += 3 * w;

    }


    /*
     * MA20 touch
     */

    if (x.touchMA20) {

      if (x.trend === "BULLISH")
        longScore += 2 * w;

      if (x.trend === "BEARISH")
        shortScore += 2 * w;

    }

  }


  /*
   * =======================================================
   * MARKET DATA
   * =======================================================
   */

  const market =
    await getMarketData(symbol);


  /*
   * =======================================================
   * FOOTPRINT
   * =======================================================
   *
   * در اسکن بازار گرفته نمی‌شود.
   *
   * در تحلیل دستی گرفته می‌شود.
   */

  let footprint = null;


  if (withFootprint) {

    footprint =
      await getFootprint(symbol);


    if (
      footprint.deltaPercent > 12
    ) {

      longScore += 12;

    }


    if (
      footprint.deltaPercent < -12
    ) {

      shortScore += 12;

    }

  }


  /*
   * =======================================================
   * OPEN INTEREST
   * =======================================================
   */

  if (
    market.oi.changePercent > 2
  ) {

    if (longScore > shortScore)
      longScore += 5;

    if (shortScore > longScore)
      shortScore += 5;

  }


  if (
    market.oi.changePercent < -2
  ) {

    if (longScore > shortScore)
      longScore += 3;

    if (shortScore > longScore)
      shortScore += 3;

  }


  /*
   * =======================================================
   * FUNDING
   * =======================================================
   */

  if (
    market.funding.rate > 0.05
  ) {

    longScore -= 6;
    shortScore += 4;

  }


  if (
    market.funding.rate < -0.05
  ) {

    shortScore -= 6;
    longScore += 4;

  }


  /*
   * =======================================================
   * ORDER BOOK
   * =======================================================
   */

  const book =
    market.orderBook;


  if (
    book.bidRatio > 60 &&
    book.askRatio < 40
  ) {

    longScore += 7;

  }


  if (
    book.askRatio > 60 &&
    book.bidRatio < 40
  ) {

    shortScore += 7;

  }


  /*
   * =======================================================
   * OPPOSITE WALL
   * =======================================================
   */

  if (
    book.oppositeWallForLong
  ) {

    longScore -= 12;

  }


  if (
    book.oppositeWallForShort
  ) {

    shortScore -= 12;

  }


  /*
   * =======================================================
   * LIQUIDITY HUNT
   * =======================================================
   */

  const hunt =
    detectLiquidityHunt(
      valid
    );


  if (
    hunt === "BULLISH_HUNT"
  ) {

    longScore += 7;

  }


  if (
    hunt === "BEARISH_HUNT"
  ) {

    shortScore += 7;

  }


  /*
   * =======================================================
   * LIQUIDATION PRESSURE
   * =======================================================
   */

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

    shortScore += 8;

  }


  if (
    liquidationPressure ===
    "SHORT_LIQUIDATION"
  ) {

    longScore += 8;

  }


  /*
   * =======================================================
   * INITIAL DIRECTION
   * =======================================================
   */

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


  /*
   * =======================================================
   * MULTI TIMEFRAME CONFIRMATION
   * =======================================================
   */

  const allBullish =
    bullish === 3;

  const allBearish =
    bearish === 3;


  if (allBullish)
    longScore += 15;


  if (allBearish)
    shortScore += 15;


  /*
   * جهت نهایی بعد از تایید سه تایم‌فریم
   */

  if (
    longScore > shortScore &&
    longScore >= 35
  ) {

    direction = "LONG";

  }

  else if (
    shortScore > longScore &&
    shortScore >= 35
  ) {

    direction = "SHORT";

  }

  else {

    direction = "WAIT";

  }


  /*
   * =======================================================
   * FINAL SCORE
   * =======================================================
   */

  const main =
    timeframes["5"] ||
    timeframes["3"] ||
    timeframes["1"];


  const score =
    calculateFinalScoreV9(
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


  /*
   * =======================================================
   * SAFETY FILTER
   * =======================================================
   */

  let confirmed = true;

  const reasons = [];


  /*
   * LONG باید حداقل 2 تایم‌فریم صعودی داشته باشد
   */

  if (
    bullish < 2 &&
    direction === "LONG"
  ) {

    confirmed = false;

    reasons.push(
      "تأیید کافی تایم‌فریم‌ها وجود ندارد"
    );

  }


  /*
   * SHORT باید حداقل 2 تایم‌فریم نزولی داشته باشد
   */

  if (
    bearish < 2 &&
    direction === "SHORT"
  ) {

    confirmed = false;

    reasons.push(
      "تأیید کافی تایم‌فریم‌ها وجود ندارد"
    );

  }


  /*
   * Footprint مخالف LONG
   */

  if (
    direction === "LONG" &&
    footprint &&
    footprint.deltaPercent < -15
  ) {

    confirmed = false;

    reasons.push(
      "Footprint مخالف LONG است"
    );

  }


  /*
   * Footprint مخالف SHORT
   */

  if (
    direction === "SHORT" &&
    footprint &&
    footprint.deltaPercent > 15
  ) {

    confirmed = false;

    reasons.push(
      "Footprint مخالف SHORT است"
    );

  }


  /*
   * فروشنده نزدیک LONG
   */

  if (
    direction === "LONG" &&
    book.oppositeWallForLong
  ) {

    confirmed = false;

    reasons.push(
      "دیوار فروش نزدیک ورود وجود دارد"
    );

  }


  /*
   * خریدار نزدیک SHORT
   */

  if (
    direction === "SHORT" &&
    book.oppositeWallForShort
  ) {

    confirmed = false;

    reasons.push(
      "دیوار خرید نزدیک ورود وجود دارد"
    );

  }


  /*
   * Score filter
   */

  if (
    score < MIN_SIGNAL_SCORE
  ) {

    confirmed = false;

    reasons.push(
      "امتیاز کمتر از حد تأیید است"
    );

  }


  /*
   * اگر تایید نشد:
   * سیگنال WAIT
   */

  if (!confirmed) {

    direction = "WAIT";

  }


  /*
   * =======================================================
   * TARGETS
   * =======================================================
   */

  let targets = null;


  if (
    direction === "LONG" ||
    direction === "SHORT"
  ) {

    targets =
      calculateTargetsV9(
        main,
        direction,
        market
      );

  }


  /*
   * =======================================================
   * RESULT
   * =======================================================
   */

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
      targets?.entry ||
      null,

    sl:
      targets?.sl ||
      null,

    tp1:
      targets?.tp1 ||
      null,

    tp2:
      targets?.tp2 ||
      null,

    tp3:
      targets?.tp3 ||
      null,

    rr:
      targets?.rr ||
      null,

    confirmations:
      countConfirmationsV9(
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


/*
 * =========================================================
 * TIMEFRAME ANALYSIS
 * =========================================================
 */

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
    sma(
      closes,
      7
    );


  const ma20 =
    sma(
      closes,
      20
    );


  const previousMA20 =
    sma(
      closes.slice(0, -1),
      20
    );


  let maSlope =
    "FLAT";


  if (
    ma20 !== null &&
    previousMA20 !== null
  ) {

    if (
      ma20 > previousMA20
    ) {

      maSlope = "UP";

    }

    if (
      ma20 < previousMA20
    ) {

      maSlope = "DOWN";

    }

  }


  /*
   * Trend
   */

  let trend =
    "RANGE";


  if (
    ma7 > ma20
  ) {

    trend =
      "BULLISH";

  }


  if (
    ma7 < ma20
  ) {

    trend =
      "BEARISH";

  }


  const current =
    rows[
      rows.length - 1
    ];


  /*
   * Touch MA20
   */

  const touchMA20 =
    current.low <= ma20 &&
    current.high >= ma20;


  /*
   * Candle reaction
   */

  const reaction =
    current.close >
    current.open

      ? "BULLISH"

      : current.close <
        current.open

      ? "BEARISH"

      : "NEUTRAL";


  /*
   * Structure
   */

  const structure =
    detectStructure(
      rows
    );


  /*
   * FVG
   */

  const fvg =
    detectFVG(
      rows
    );


  /*
   * Volume MA
   */

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


  /*
   * Volume spike
   */

  const volumeSpike =
    volumeMA20 &&
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
        Boolean(
          volumeSpike
        )

    }

  };

}


/*
 * =========================================================
 * MARKET STRUCTURE
 * =========================================================
 */

function detectStructure(rows) {

  if (
    rows.length < 12
  ) {

    return "NONE";

  }


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


  /*
   * Bullish structure
   */

  if (
    h3 > h2 &&
    h2 > h1 &&
    l3 > l2
  ) {

    return "BULLISH";

  }


  /*
   * Bearish structure
   */

  if (
    h3 < h2 &&
    h2 < h1 &&
    l3 < l2
  ) {

    return "BEARISH";

  }


  return "NONE";

}


/*
 * =========================================================
 * FVG
 * =========================================================
 */

function detectFVG(rows) {

  if (
    rows.length < 3
  ) {

    return {

      type:
        "NONE",

      bottom:
        null,

      top:
        null,

      status:
        "NONE"

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


  /*
   * Bullish FVG
   */

  if (
    c.low > a.high
  ) {

    return {

      type:
        "BULLISH",

      bottom:
        a.high,

      top:
        c.low,

      status:
        "ACTIVE"

    };

  }


  /*
   * Bearish FVG
   */

  if (
    c.high < a.low
  ) {

    return {

      type:
        "BEARISH",

      bottom:
        c.high,

      top:
        a.low,

      status:
        "ACTIVE"

    };

  }


  return {

    type:
      "NONE",

    bottom:
      null,

    top:
      null,

    status:
      "NONE"

  };

}


/*
 * =========================================================
 * MARKET DATA
 * =========================================================
 */

async function getMarketData(symbol) {

  /*
   * 3 درخواست موازی:
   *
   * Ticker
   * OI
   * Order Book
   */

  const tickerPromise =
    bybit(
      "/v5/market/tickers" +
      "?category=linear" +
      "&symbol=" +
      encodeURIComponent(
        symbol
      )
    );


  const oiPromise =
    bybit(
      "/v5/market/open-interest" +
      "?category=linear" +
      "&symbol=" +
      encodeURIComponent(
        symbol
      ) +
      "&intervalTime=5min&limit=2"
    );


  const bookPromise =
    bybit(
      "/v5/market/orderbook" +
      "?category=linear" +
      "&symbol=" +
      encodeURIComponent(
        symbol
      ) +
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
    tickerData
      .result
      ?.list
      ?.[0] ||
    {};


  const oiList =
    oiData
      .result
      ?.list ||
    [];


  let oiCurrent =
    0;


  let oiPrevious =
    0;


  if (
    oiList.length > 0
  ) {

    oiCurrent =
      Number(
        oiList[0]
          .openInterest ||
        0
      );

  }


  if (
    oiList.length > 1
  ) {

    oiPrevious =
      Number(
        oiList[1]
          .openInterest ||
        0
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


  /*
   * Order Book
   */

  const bids =
    bookData
      .result
      ?.b ||
    [];


  const asks =
    bookData
      .result
      ?.a ||
    [];


  const orderBook =
    analyzeOrderBook(
      bids,
      asks,
      Number(
        ticker.lastPrice ||
        0
      )
    );


  return {

    price:
      Number(
        ticker.lastPrice ||
        0
      ),

    funding: {

      rate:
        Number(
          ticker.fundingRate ||
          0
        ) * 100,

      nextFunding:
        ticker.nextFundingTime ||
        null

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


/*
 * =========================================================
 * ORDER BOOK
 * =========================================================
 */

function analyzeOrderBook(
  bids,
  asks,
  price
) {

  let bidValue =
    0;

  let askValue =
    0;

  let biggestBid =
    0;

  let biggestAsk =
    0;


  /*
   * Bids
   */

  for (
    const b of bids
  ) {

    const p =
      Number(
        b[0] ||
        0
      );

    const q =
      Number(
        b[1] ||
        0
      );

    const value =
      p * q;


    bidValue +=
      value;


    if (
      value >
      biggestBid
    ) {

      biggestBid =
        value;

    }

  }


  /*
   * Asks
   */

  for (
    const a of asks
  ) {

    const p =
      Number(
        a[0] ||
        0
      );

    const q =
      Number(
        a[1] ||
        0
      );

    const value =
      p * q;


    askValue +=
      value;


    if (
      value >
      biggestAsk
    ) {

      biggestAsk =
        value;

    }

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


  /*
   * Average order value
   */

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


  /*
   * Wall detection
   */

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


/*
 * =========================================================
 * FOOTPRINT
 * =========================================================
 *
 * این Footprint واقعی exchange-level نیست.
 *
 * Bybit recent trades را می‌گیریم و:
 *
 * Buy Volume
 * Sell Volume
 * Delta
 * Delta %
 * Buy/Sell Ratio
 * Large Trade
 *
 * را محاسبه می‌کنیم.
 */

async function getFootprint(symbol) {

  const data =
    await bybit(
      "/v5/market/recent-trade" +
      "?category=linear" +
      "&symbol=" +
      encodeURIComponent(
        symbol
      ) +
      "&limit=500"
    );


  const trades =
    data.result
      ?.list ||
    [];


  if (
    !trades.length
  ) {

    return {

      trades:
        0,

      buyVolume:
        0,

      sellVolume:
        0,

      delta:
        0,

      deltaPercent:
        0,

      buyRatio:
        0,

      sellRatio:
        0,

      largeTrade:
        false,

      largeTradeNotional:
        0,

      averageTradeNotional:
        0

    };

  }


  let buyVolume =
    0;

  let sellVolume =
    0;


  const notionals =
    [];


  for (
    const t of trades
  ) {

    const price =
      Number(
        t.price ||
        0
      );


    const size =
      Number(
        t.size ||
        0
      );


    const notional =
      price *
      size;


    notionals.push(
      notional
    );


    if (
      String(
        t.side
      )
        .toLowerCase() ===
      "buy"
    ) {

      buyVolume +=
        size;

    }

    else {

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
      (
        a,
        b
      ) =>
        a + b,
      0
    ) /
    notionals.length;


  let largest =
    0;


  for (
    const n of notionals
  ) {

    if (
      n > largest
    ) {

      largest =
        n;

    }

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


/*
 * =========================================================
 * LIQUIDITY HUNT
 * =========================================================
 */

function detectLiquidityHunt(
  analyses
) {

  let bullish =
    false;

  let bearish =
    false;


  for (
    const x of analyses
  ) {

    if (
      x.structure ===
        "BULLISH" &&
      x.reaction ===
        "BULLISH"
    ) {

      bullish =
        true;

    }


    if (
      x.structure ===
        "BEARISH" &&
      x.reaction ===
        "BEARISH"
    ) {

      bearish =
        true;

    }

  }


  if (
    bullish &&
    !bearish
  ) {

    return "BULLISH_HUNT";

  }


  if (
    bearish &&
    !bullish
  ) {

    return "BEARISH_HUNT";

  }


  return "NONE";

}


/*
 * =========================================================
 * LIQUIDATION PRESSURE
 * =========================================================
 */

function detectLiquidationPressure(
  analyses,
  market,
  footprint
) {

  const oi =
    market
      .oi
      .changePercent;


  const delta =
    footprint
      ?.deltaPercent ||
    0;


  /*
   * افت OI + فشار فروش
   * احتمال خروج Long
   */

  if (
    oi < -2 &&
    delta < -12
  ) {

    return "LONG_LIQUIDATION";

  }


  /*
   * افت OI + فشار خرید
   * احتمال خروج Short
   */

  if (
    oi < -2 &&
    delta > 12
  ) {

    return "SHORT_LIQUIDATION";

  }


  return "NONE";

}


/*
 * =========================================================
 * FINAL SCORE
 * =========================================================
 */

function calculateFinalScoreV9(
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
    direction ===
      "WAIT"
  ) {

    return 0;

  }


  let score =
    0;


  /*
   * MA
   */

  if (
    direction ===
      "LONG" &&
    x.maSlope ===
      "UP"
  ) {

    score +=
      10;

  }


  if (
    direction ===
      "SHORT" &&
    x.maSlope ===
      "DOWN"
  ) {

    score +=
      10;

  }


  /*
   * Structure
   */

  if (
    direction ===
      "LONG" &&
    x.structure ===
      "BULLISH"
  ) {

    score +=
      12;

  }


  if (
    direction ===
      "SHORT" &&
    x.structure ===
      "BEARISH"
  ) {

    score +=
      12;

  }


  /*
   * FVG
   */

  if (
    direction ===
      "LONG" &&
    x.fvg.type ===
      "BULLISH"
  ) {

    score +=
      8;

  }


  if (
    direction ===
      "SHORT" &&
    x.fvg.type ===
      "BEARISH"
  ) {

    score +=
      8;

  }


  /*
   * MA20
   */

  if (
    x.touchMA20
  ) {

    score +=
      6;

  }


  /*
   * Volume
   */

  if (
    x.volume.spike
  ) {

    score +=
      6;

  }


  /*
   * Multi timeframe
   */

  if (
    direction ===
      "LONG" &&
    bullish === 3
  ) {

    score +=
      18;

  }


  if (
    direction ===
      "SHORT" &&
    bearish === 3
  ) {

    score +=
      18;

  }


  if (
    direction ===
      "LONG" &&
    bullish === 2
  ) {

    score +=
      8;

  }


  if (
    direction ===
      "SHORT" &&
    bearish === 2
  ) {

    score +=
      8;

  }


  /*
   * Footprint
   */

  if (
    footprint
  ) {

    if (
      direction ===
        "LONG" &&
      footprint.deltaPercent >
        10
    ) {

      score +=
        12;

    }


    if (
      direction ===
        "SHORT" &&
      footprint.deltaPercent <
        -10
    ) {

      score +=
        12;

    }

  }


  /*
   * Order Book
   */

  if (
    direction ===
      "LONG" &&
    book.bidRatio >
      55
  ) {

    score +=
      5;

  }


  if (
    direction ===
      "SHORT" &&
    book.askRatio >
      55
  ) {

    score +=
      5;

  }


  /*
   * Liquidity Hunt
   */

  if (
    direction ===
      "LONG" &&
    hunt ===
      "BULLISH_HUNT"
  ) {

    score +=
      5;

  }


  if (
    direction ===
      "SHORT" &&
    hunt ===
      "BEARISH_HUNT"
  ) {

    score +=
      5;

  }


  /*
   * Liquidation
   */

  if (
    direction ===
      "LONG" &&
    liquidation ===
      "SHORT_LIQUIDATION"
  ) {

    score +=
      5;

  }


  if (
    direction ===
      "SHORT" &&
    liquidation ===
      "LONG_LIQUIDATION"
  ) {

    score +=
      5;

  }


  /*
   * Opposite wall
   */

  if (
    direction ===
      "LONG" &&
    book.oppositeWallForLong
  ) {

    score -=
      15;

  }


  if (
    direction ===
      "SHORT" &&
    book.oppositeWallForShort
  ) {

    score -=
      15;

  }


  return Math.max(
    0,
    Math.min(
      100,
      Math.round(
        score
      )
    )
  );

}


/*
 * =========================================================
 * CONFIRMATIONS
 * =========================================================
 */

function countConfirmationsV9(
  x,
  direction,
  bullish,
  bearish,
  market,
  book,
  footprint
) {

  let c =
    0;


  /*
   * MA slope
   */

  if (
    direction ===
      "LONG" &&
    x.maSlope ===
      "UP"
  ) {

    c++;

  }


  if (
    direction ===
      "SHORT" &&
    x.maSlope ===
      "DOWN"
  ) {

    c++;

  }


  /*
   * Structure
   */

  if (
    direction ===
      "LONG" &&
    x.structure ===
      "BULLISH"
  ) {

    c++;

  }


  if (
    direction ===
      "SHORT" &&
    x.structure ===
      "BEARISH"
  ) {

    c++;

  }


  /*
   * FVG
   */

  if (
    x.fvg.type !==
      "NONE"
  ) {

    c++;

  }


  /*
   * MA20
   */

  if (
    x.touchMA20
  ) {

    c++;

  }


  /*
   * Volume
   */

  if (
    x.volume.spike
  ) {

    c++;

  }


  /*
   * 3 TF
   */

  if (
    bullish === 3 ||
    bearish === 3
  ) {

    c++;

  }


  /*
   * Footprint
   */

  if (
    footprint
  ) {

    if (
      direction ===
        "LONG" &&
      footprint.deltaPercent >
        10
    ) {

      c++;

    }


    if (
      direction ===
        "SHORT" &&
      footprint.deltaPercent <
        -10
    ) {

      c++;

    }

  }


  /*
   * Order Book
   */

  if (
    direction ===
      "LONG" &&
    book.bidRatio >
      55
  ) {

    c++;

  }


  if (
    direction ===
      "SHORT" &&
    book.askRatio >
      55
  ) {

    c++;

  }


  return c;

}


/*
 * =========================================================
 * TARGETS
 * =========================================================
 */

function calculateTargetsV9(
  x,
  direction,
  market
) {

  const price =
    Number(
      x.price
    );


  /*
   * فعلاً ریسک 1.2%
   *
   * بعداً می‌توانیم ATR
   * و ساختار بازار را وارد کنیم.
   */

  const risk =
    price * 0.012;


  /*
   * LONG
   */

  if (
    direction ===
      "LONG"
  ) {

    const sl =
      price -
      risk;


    return {

      entry:
        price,

      sl,

      tp1:
        price +
        risk,

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


  /*
   * SHORT
   */

  const sl =
    price +
    risk;


  return {

    entry:
      price,

    sl,

    tp1:
      price -
      risk,

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


/*
 * =========================================================
 * KLINES
 * =========================================================
 */

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
      encodeURIComponent(
        symbol
      ) +
      "&interval=" +
      encodeURIComponent(
        interval
      ) +
      "&limit=" +
      limit
    );


  return (
    data.result
      ?.list ||
    []
  )
    .reverse()
    .map(x => ({

      time:
        Number(
          x[0]
        ),

      open:
        Number(
          x[1]
        ),

      high:
        Number(
          x[2]
        ),

      low:
        Number(
          x[3]
        ),

      close:
        Number(
          x[4]
        ),

      volume:
        Number(
          x[5]
        )

    }));

}


/*
 * =========================================================
 * BYBIT REQUEST
 * =========================================================
 */

async function bybit(
  path
) {

  const response =
    await fetch(
      BYBIT_BASE +
      path,
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
    data.retCode !==
      undefined &&
    data.retCode !==
      0
  ) {

    throw new Error(
      data.retMsg ||
      "Bybit API error"
    );

  }


  return data;

}


/*
 * =========================================================
 * SYMBOL NORMALIZER
 * =========================================================
 */

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


/*
 * =========================================================
 * CLAMP
 * =========================================================
 */

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


/*
 * =========================================================
 * SMA
 * =========================================================
 */

function sma(
  data,
  period
) {

  if (
    !data ||
    data.length <
      period
  ) {

    return null;

  }


  const part =
    data.slice(
      data.length -
      period
    );


  return (
    part.reduce(
      (
        a,
        b
      ) =>
        a +
        Number(b),
      0
    ) /
    period
  );

}


/*
 * =========================================================
 * JSON RESPONSE
 * =========================================================
 */

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
