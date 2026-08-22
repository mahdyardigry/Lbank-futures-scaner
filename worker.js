const BYBIT_BASE = "https://api.bybit.com";

const TIMEFRAMES = [
  { key: "1", label: "۱ دقیقه (1m)", weight: 2 },
  { key: "3", label: "۳ دقیقه (3m)", weight: 3 },
  { key: "5", label: "۵ دقیقه (5m)", weight: 4 }
];

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

const SCAN_CANDIDATES = 15;
const DEEP_CANDIDATES = 5;
const ENRICH_CANDIDATES = 5;


// =====================================================
// WORKER
// =====================================================

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
      // FUTURES
      // =================================================

      if (url.pathname === "/api/futures") {

        const data = await bybit(
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
          url.searchParams.get("interval") || "5";

        let limit =
          Number(
            url.searchParams.get("limit") || 100
          );

        limit =
          Math.max(
            30,
            Math.min(limit, 200)
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
      // FAST SCAN
      // =================================================

      if (url.pathname === "/api/scan") {

        const result =
          await scanMarket();

        return json({
          ok: true,
          source: "Bybit Futures",
          scanned: result.scanned,
          deepAnalyzed: result.deepAnalyzed,
          enriched: result.enriched,
          found: result.results.length,
          results: result.results
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


// =====================================================
// FAST MARKET SCAN
// =====================================================

async function scanMarket() {

  // فقط یک درخواست برای گرفتن تیکر کل بازار
  const tickerData =
    await bybit(
      "/v5/market/tickers?category=linear"
    );

  const tickers =
    tickerData.result?.list || [];


  // ===================================================
  // مرحله اول
  // انتخاب ارزهای فعال‌تر
  // ===================================================

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
      .slice(
        0,
        SCAN_CANDIDATES
      );


  // ===================================================
  // مرحله دوم
  // فقط 5m برای 15 ارز
  // ===================================================

  const stage1 =
    await Promise.all(
      candidates.map(
        async ticker => {

          try {

            const rows =
              await getKlines(
                ticker.symbol,
                "5",
                80
              );

            const analysis =
              analyzeTimeframe(rows);

            return {
              symbol: ticker.symbol,
              turnover24h:
                Number(
                  ticker.turnover24h || 0
                ),
              change24h:
                Number(
                  ticker.price24hPcnt || 0
                ) * 100,
              tf5: analysis
            };

          } catch (e) {

            return null;
          }
        }
      )
    );


  const validStage1 =
    stage1.filter(Boolean);


  // ===================================================
  // مرحله سوم
  // انتخاب 5 ارز برتر از 5m
  // ===================================================

  validStage1.sort(
    (a, b) =>
      quickScore(b.tf5) -
      quickScore(a.tf5)
  );


  const deep =
    validStage1.slice(
      0,
      DEEP_CANDIDATES
    );


  // ===================================================
  // مرحله چهارم
  // فقط برای 5 ارز برتر، 1m و 3m
  // ===================================================

  const deepResults =
    await Promise.all(
      deep.map(
        async item => {

          try {

            const [rows1, rows3] =
              await Promise.all([
                getKlines(
                  item.symbol,
                  "1",
                  80
                ),
                getKlines(
                  item.symbol,
                  "3",
                  80
                )
              ]);


            const tf1 =
              analyzeTimeframe(rows1);

            const tf3 =
              analyzeTimeframe(rows3);


            const result =
              buildAnalysis(
                item.symbol,
                {
                  "1": tf1,
                  "3": tf3,
                  "5": item.tf5
                }
              );


            return result;

          } catch (e) {

            return null;
          }
        }
      )
    );


  let results =
    deepResults.filter(Boolean);


  // ===================================================
  // مرحله پنجم
  // فقط 5 کاندیدای برتر
  // اطلاعات سنگین
  // ===================================================

  results.sort(
    (a, b) =>
      b.score - a.score
  );


  const enrichTargets =
    results.slice(
      0,
      ENRICH_CANDIDATES
    );


  const enriched =
    await Promise.all(
      enrichTargets.map(
        async result => {

          try {

            const [
              footprint,
              oi,
              funding,
              orderBook
            ] =
              await Promise.all([

                getFootprint(
                  result.symbol
                ),

                getOpenInterest(
                  result.symbol
                ),

                getFunding(
                  result.symbol
                ),

                getOrderBook(
                  result.symbol
                )

              ]);


            result.footprint =
              footprint;

            result.oi =
              oi;

            result.funding =
              funding;

            result.orderBook =
              orderBook;


            // =========================================
            // تحلیل نهایی جریان سفارش
            // =========================================

            result.orderFlow =
              analyzeOrderFlow(
                result,
                footprint,
                oi,
                funding,
                orderBook
              );


            // =========================================
            // امتیاز نهایی
            // =========================================

            result.score =
              calculateAdvancedScore(
                result
              );


            // =========================================
            // اگر اطلاعات بازار خلاف سیگنال باشد
            // =========================================

            if (
              result.orderFlow.blockEntry
            ) {

              result.direction =
                "WAIT";

              result.signal =
                "⚠️ ورود ممنوع";

            }


            // =========================================
            // Entry / SL / TP
            // =========================================

            if (
              result.direction !== "WAIT"
            ) {

              result.targets =
                calculateSmartTargets(
                  result
                );

              result.entry =
                result.targets.entry;

              result.sl =
                result.targets.sl;

              result.tp1 =
                result.targets.tp1;

              result.tp2 =
                result.targets.tp2;

              result.tp3 =
                result.targets.tp3;

              result.rr =
                result.targets.rr;
            }


            return result;


          } catch (e) {

            result.enrichmentError =
              e.message;

            return result;
          }
        }
      )
    );


  // بقیه نتایج بدون داده سنگین
  const enrichedSymbols =
    new Set(
      enriched.map(x => x.symbol)
    );


  for (const r of results) {

    if (
      !enrichedSymbols.has(
        r.symbol
      )
    ) {

      r.enriched = false;

      r.entry =
        r.entry ||
        null;

      r.sl =
        r.sl ||
        null;

      r.tp1 =
        r.tp1 ||
        null;

      r.tp2 =
        r.tp2 ||
        null;

      r.tp3 =
        r.tp3 ||
        null;
    }
  }


  results.sort(
    (a, b) =>
      b.score - a.score
  );


  return {

    scanned:
      candidates.length,

    deepAnalyzed:
      deep.length,

    enriched:
      enriched.length,

    results:
      results.slice(0, 10)
  };
}


// =====================================================
// BUILD BASIC ANALYSIS
// =====================================================

function buildAnalysis(
  symbol,
  timeframes
) {

  let bullish = 0;
  let bearish = 0;


  for (const tf of TIMEFRAMES) {

    const x =
      timeframes[tf.key];

    if (!x) continue;


    if (
      x.trend === "BULLISH"
    )
      bullish++;


    if (
      x.trend === "BEARISH"
    )
      bearish++;
  }


  let longScore = 0;
  let shortScore = 0;


  for (const tf of TIMEFRAMES) {

    const x =
      timeframes[tf.key];

    if (!x) continue;


    const w =
      tf.weight;


    if (
      x.trend === "BULLISH"
    )
      longScore += w;


    if (
      x.trend === "BEARISH"
    )
      shortScore += w;


    if (
      x.maSlope === "UP"
    )
      longScore += 2;


    if (
      x.maSlope === "DOWN"
    )
      shortScore += 2;


    if (
      x.structure === "BULLISH"
    )
      longScore += 3;


    if (
      x.structure === "BEARISH"
    )
      shortScore += 3;


    if (
      x.bos === "BULLISH"
    )
      longScore += 3;


    if (
      x.bos === "BEARISH"
    )
      shortScore += 3;


    if (
      x.choch === "BULLISH"
    )
      longScore += 2;


    if (
      x.choch === "BEARISH"
    )
      shortScore += 2;


    if (
      x.fvg.type === "BULLISH"
    )
      longScore += 2;


    if (
      x.fvg.type === "BEARISH"
    )
      shortScore += 2;


    if (
      x.orderBlock.type === "BULLISH"
    )
      longScore += 2;


    if (
      x.orderBlock.type === "BEARISH"
    )
      shortScore += 2;


    if (
      x.volume.spike
    ) {

      if (
        x.trend === "BULLISH"
      )
        longScore += 2;


      if (
        x.trend === "BEARISH"
      )
        shortScore += 2;
    }


    if (
      x.liquidityHunt === "BULLISH"
    )
      longScore += 2;


    if (
      x.liquidityHunt === "BEARISH"
    )
      shortScore += 2;
  }


  // تأیید کامل سه تایم‌فریم
  if (
    bullish === 3
  )
    longScore += 10;


  if (
    bearish === 3
  )
    shortScore += 10;


  let direction =
    "WAIT";


  if (
    longScore >
      shortScore &&
    longScore >= 14
  ) {

    direction =
      "LONG";
  }


  if (
    shortScore >
      longScore &&
    shortScore >= 14
  ) {

    direction =
      "SHORT";
  }


  const main =
    timeframes["5"];


  const score =
    calculateBasicScore(
      main,
      direction,
      bullish,
      bearish
    );


  return {

    symbol,

    direction,

    signal:
      direction === "LONG"
        ? "🟢 خرید (LONG)"
        : direction === "SHORT"
        ? "🔴 فروش (SHORT)"
        : "🟡 انتظار (WAIT)",

    score,

    mainTimeframe:
      "۱ دقیقه / ۳ دقیقه / ۵ دقیقه (1m / 3m / 5m)",

    price:
      main?.price || null,

    entry: null,
    sl: null,
    tp1: null,
    tp2: null,
    tp3: null,

    rr: null,

    bullishTimeframes:
      bullish,

    bearishTimeframes:
      bearish,

    confirmations:
      countConfirmations(
        timeframes,
        direction,
        bullish,
        bearish
      ),

    timeframes,

    longScore,
    shortScore,

    enriched:
      false
  };
}


// =====================================================
// TIMEFRAME ANALYSIS
// =====================================================

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
    ma20 >
    previousMA20
  )
    maSlope = "UP";


  if (
    ma20 <
    previousMA20
  )
    maSlope = "DOWN";


  let trend =
    "RANGE";


  if (
    ma7 > ma20
  )
    trend =
      "BULLISH";


  if (
    ma7 < ma20
  )
    trend =
      "BEARISH";


  const current =
    rows[
      rows.length - 1
    ];


  const previous =
    rows[
      rows.length - 2
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
    detectStructure(
      rows
    );


  const bos =
    detectBOS(
      rows
    );


  const choch =
    detectCHoCH(
      rows
    );


  const fvg =
    detectFVG(
      rows
    );


  const orderBlock =
    detectOrderBlock(
      rows
    );


  const liquidityHunt =
    detectLiquidityHunt(
      rows
    );


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

    bos,

    choch,

    fvg,

    orderBlock,

    liquidityHunt,

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
    l3 > l2 &&
    l2 > l1
  ) {

    return "BULLISH";
  }


  if (
    h3 < h2 &&
    h2 < h1 &&
    l3 < l2 &&
    l2 < l1
  ) {

    return "BEARISH";
  }


  return "NONE";
}


// =====================================================
// BOS
// =====================================================

function detectBOS(rows) {

  if (
    rows.length < 10
  )
    return "NONE";


  const n =
    rows.length;


  const previousHigh =
    Math.max(
      ...rows
        .slice(n - 7, n - 2)
        .map(
          x => x.high
        )
    );


  const previousLow =
    Math.min(
      ...rows
        .slice(n - 7, n - 2)
        .map(
          x => x.low
        )
    );


  const current =
    rows[n - 1];


  if (
    current.close >
    previousHigh
  )
    return "BULLISH";


  if (
    current.close <
    previousLow
  )
    return "BEARISH";


  return "NONE";
}


// =====================================================
// CHOCH
// =====================================================

function detectCHoCH(rows) {

  if (
    rows.length < 12
  )
    return "NONE";


  const n =
    rows.length;


  const oldHigh =
    Math.max(
      ...rows
        .slice(n - 10, n - 4)
        .map(
          x => x.high
        )
    );


  const oldLow =
    Math.min(
      ...rows
        .slice(n - 10, n - 4)
        .map(
          x => x.low
        )
    );


  const current =
    rows[n - 1];


  const previous =
    rows[n - 2];


  // تغییر نزولی به صعودی
  if (
    previous.close <
      oldHigh &&
    current.close >
      oldHigh
  ) {

    return "BULLISH";
  }


  // تغییر صعودی به نزولی
  if (
    previous.close >
      oldLow &&
    current.close <
      oldLow
  ) {

    return "BEARISH";
  }


  return "NONE";
}


// =====================================================
// FVG
// =====================================================

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


  const b =
    rows[
      rows.length - 2
    ];


  const c =
    rows[
      rows.length - 1
    ];


  if (
    c.low >
    a.high
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


  if (
    c.high <
    a.low
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


// =====================================================
// ORDER BLOCK
// =====================================================

function detectOrderBlock(rows) {

  if (
    rows.length < 8
  ) {

    return {
      type: "NONE",
      low: null,
      high: null
    };
  }


  const n =
    rows.length;


  const impulse =
    rows[n - 1];


  const previous =
    rows[n - 2];


  const before =
    rows[n - 3];


  // آخر کندل نزولی قبل از حرکت صعودی
  if (
    impulse.close >
      impulse.open &&
    previous.close >
      previous.open &&
    before.close <
      before.open
  ) {

    return {

      type: "BULLISH",

      low:
        before.low,

      high:
        before.high
    };
  }


  // آخرین کندل صعودی قبل از حرکت نزولی
  if (
    impulse.close <
      impulse.open &&
    previous.close <
      previous.open &&
    before.close >
      before.open
  ) {

    return {

      type: "BEARISH",

      low:
        before.low,

      high:
        before.high
    };
  }


  return {

    type: "NONE",

    low: null,

    high: null
  };
}


// =====================================================
// LIQUIDITY HUNT
// =====================================================

function detectLiquidityHunt(rows) {

  if (
    rows.length < 10
  )
    return "NONE";


  const n =
    rows.length;


  const previousHigh =
    Math.max(
      ...rows
        .slice(n - 8, n - 1)
        .map(
          x => x.high
        )
    );


  const previousLow =
    Math.min(
      ...rows
        .slice(n - 8, n - 1)
        .map(
          x => x.low
        )
    );


  const current =
    rows[n - 1];


  // شکار نقدینگی بالای سقف
  if (
    current.high >
      previousHigh &&
    current.close <
      previousHigh
  ) {

    return "BEARISH";
  }


  // شکار نقدینگی زیر کف
  if (
    current.low <
      previousLow &&
    current.close >
      previousLow
  ) {

    return "BULLISH";
  }


  return "NONE";
}


// =====================================================
// QUICK SCORE
// =====================================================

function quickScore(x) {

  if (!x)
    return 0;


  let score = 0;


  if (
    x.trend !== "RANGE"
  )
    score += 5;


  if (
    x.maSlope !== "FLAT"
  )
    score += 4;


  if (
    x.structure !== "NONE"
  )
    score += 4;


  if (
    x.bos !== "NONE"
  )
    score += 5;


  if (
    x.fvg.type !== "NONE"
  )
    score += 3;


  if (
    x.volume.spike
  )
    score += 4;


  return score;
}


// =====================================================
// BASIC SCORE
// =====================================================

function calculateBasicScore(
  x,
  direction,
  bullish,
  bearish
) {

  if (
    !x ||
    direction === "WAIT"
  )
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


// =====================================================
// ADVANCED SCORE
// =====================================================

function calculateAdvancedScore(r) {

  if (
    r.direction === "WAIT"
  )
    return 0;


  let score =
    r.score || 0;


  const d =
    r.direction;


  const fp =
    r.footprint;


  const oi =
    r.oi;


  const funding =
    r.funding;


  const ob =
    r.orderBook;


  const flow =
    r.orderFlow;


  // Delta
  if (
    fp &&
    !fp.error
  ) {

    if (
      d === "LONG" &&
      fp.deltaPercent > 10
    )
      score += 8;


    if (
      d === "SHORT" &&
      fp.deltaPercent < -10
    )
      score += 8;
  }


  // OI
  if (
    oi &&
    oi.signal === d
  )
    score += 8;


  // Funding
  if (
    funding &&
    funding.signal === d
  )
    score += 5;


  // Order book
  if (
    ob &&
    ob.signal === d
  )
    score += 8;


  // دیوار مخالف
  if (
    flow &&
    flow.oppositeWall
  )
    score -= 15;


  // سفارش بزرگ مخالف
  if (
    flow &&
    flow.oppositeLargeOrder
  )
    score -= 15;


  // Hunt
  if (
    r.timeframes["1"]?.liquidityHunt === d ||
    r.timeframes["3"]?.liquidityHunt === d ||
    r.timeframes["5"]?.liquidityHunt === d
  )
    score += 5;


  return Math.max(
    0,
    Math.min(
      100,
      Math.round(score)
    )
  );
}


// =====================================================
// ORDER FLOW
// =====================================================

function analyzeOrderFlow(
  result,
  footprint,
  oi,
  funding,
  orderBook
) {

  const direction =
    result.direction;


  const flow = {

    blockEntry: false,

    oppositeWall: false,

    oppositeLargeOrder: false,

    deltaConfirms: false,

    oiConfirms: false,

    fundingWarning: false,

    orderBookConfirms: false,

    message: ""
  };


  if (
    direction === "WAIT"
  ) {

    return flow;
  }


  // ===================================================
  // DELTA
  // ===================================================

  if (
    footprint &&
    !footprint.error
  ) {

    if (
      direction === "LONG" &&
      footprint.deltaPercent >= 10
    ) {

      flow.deltaConfirms =
        true;
    }


    if (
      direction === "SHORT" &&
      footprint.deltaPercent <= -10
    ) {

      flow.deltaConfirms =
        true;
    }
  }


  // ===================================================
  // OI
  // ===================================================

  if (
    oi &&
    oi.signal === direction
  ) {

    flow.oiConfirms =
      true;
  }


  // ===================================================
  // FUNDING
  // ===================================================

  if (
    funding
  ) {

    /*
      LONG:
      funding خیلی مثبت = ازدحام لانگ
      SHORT:
      funding خیلی منفی = ازدحام شورت
    */

    if (
      direction === "LONG" &&
      funding.rate > 0.0015
    ) {

      flow.fundingWarning =
        true;
    }


    if (
      direction === "SHORT" &&
      funding.rate < -0.0015
    ) {

      flow.fundingWarning =
        true;
    }
  }


  // ===================================================
  // ORDER BOOK
  // ===================================================

  if (
    orderBook
  ) {

    if (
      direction === "LONG" &&
      orderBook.askWall
    ) {

      flow.oppositeWall =
        true;
    }


    if (
      direction === "SHORT" &&
      orderBook.bidWall
    ) {

      flow.oppositeWall =
        true;
    }


    if (
      direction === "LONG" &&
      orderBook.bidAskRatio > 1.15
    ) {

      flow.orderBookConfirms =
        true;
    }


    if (
      direction === "SHORT" &&
      orderBook.bidAskRatio < 0.87
    ) {

      flow.orderBookConfirms =
        true;
    }
  }


  // ===================================================
  // ورود ممنوع
  // ===================================================

  if (
    flow.oppositeWall
  ) {

    flow.blockEntry =
      true;

    flow.message =
      "دیوار سفارش مخالف نزدیک قیمت وجود دارد";
  }


  if (
    flow.fundingWarning &&
    !flow.deltaConfirms &&
    !flow.oiConfirms
  ) {

    flow.blockEntry =
      true;

    flow.message =
      "ازدحام Funding بدون تأیید جریان سفارش";
  }


  return flow;
}


// =====================================================
// SMART TARGETS
// =====================================================

function calculateSmartTargets(
  result
) {

  const direction =
    result.direction;


  const price =
    Number(
      result.price
    );


  const main =
    result.timeframes["5"];


  if (
    !price ||
    !main
  ) {

    return null;
  }


  let sl = null;


  // ===================================================
  // LONG
  // ===================================================

  if (
    direction === "LONG"
  ) {

    const candidates = [];


    if (
      main.orderBlock.low
    )
      candidates.push(
        main.orderBlock.low
      );


    if (
      main.fvg.bottom
    )
      candidates.push(
        main.fvg.bottom
      );


    if (
      main.swingLow
    )
      candidates.push(
        main.swingLow
      );


    if (
      candidates.length
    ) {

      sl =
        Math.min(
          ...candidates
        );
    }


    if (
      !sl ||
      sl >= price
    ) {

      sl =
        price * 0.985;
    }


    const risk =
      price - sl;


    return {

      entry:
        price,

      sl:

        roundPrice(
          sl
        ),

      tp1:

        roundPrice(
          price +
          risk * 1.5
        ),

      tp2:

        roundPrice(
          price +
          risk * 2
        ),

      tp3:

        roundPrice(
          price +
          risk * 3
        ),

      rr:
        "1:3"
    };
  }


  // ===================================================
  // SHORT
  // ===================================================

  const candidates = [];


  if (
    main.orderBlock.high
  )
    candidates.push(
      main.orderBlock.high
    );


  if (
    main.fvg.top
  )
    candidates.push(
      main.fvg.top
    );


  if (
    main.swingHigh
  )
    candidates.push(
      main.swingHigh
    );


  if (
    candidates.length
  ) {

    sl =
      Math.max(
        ...candidates
      );
  }


  if (
    !sl ||
    sl <= price
  ) {

    sl =
      price * 1.015;
  }


  const risk =
    sl - price;


  return {

    entry:
      price,

    sl:
      roundPrice(
        sl
      ),

    tp1:
      roundPrice(
        price -
        risk * 1.5
      ),

    tp2:
      roundPrice(
        price -
        risk * 2
      ),

    tp3:
      roundPrice(
        price -
        risk * 3
      ),

    rr:
      "1:3"
  };
}


// =====================================================
// CONFIRMATIONS
// =====================================================

function countConfirmations(
  timeframes,
  direction,
  bullish,
  bearish
) {

  let c = 0;


  for (
    const tf of TIMEFRAMES
  ) {

    const x =
      timeframes[tf.key];

    if (!x)
      continue;


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
  }


  if (
    bullish === 3 ||
    bearish === 3
  )
    c++;


  return c;
}


// =====================================================
// OPEN INTEREST
// =====================================================

async function getOpenInterest(
  symbol
) {

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


  if (!list.length) {

    return {

      available: false,

      oi: null,

      previousOI: null,

      changePercent: 0,

      signal: "NONE"
    };
  }


  const current =
    Number(
      list[0].openInterest ||
      list[0].singleOpenInterest ||
      0
    );


  const previous =
    Number(
      list[1]?.openInterest ||
      list[1]?.singleOpenInterest ||
      current
    );


  const change =
    previous > 0
      ? (
          (current - previous) /
          previous
        ) * 100
      : 0;


  return {

    available: true,

    oi:
      current,

    previousOI:
      previous,

    changePercent:
      change,

    signal:
      change > 1
        ? "LONG"
        : change < -1
        ? "SHORT"
        : "NEUTRAL"
  };
}


// =====================================================
// FUNDING
// =====================================================

async function getFunding(
  symbol
) {

  const data =
    await bybit(
      "/v5/market/funding/history" +
      "?category=linear" +
      "&symbol=" +
      encodeURIComponent(symbol) +
      "&limit=1"
    );


  const item =
    data.result?.list?.[0];


  if (!item) {

    return {

      available: false,

      rate: 0,

      signal: "NONE"
    };
  }


  const rate =
    Number(
      item.fundingRate ||
      0
    );


  return {

    available: true,

    rate,

    ratePercent:
      rate * 100,

    signal:
      rate > 0
        ? "SHORT"
        : rate < 0
        ? "LONG"
        : "NEUTRAL"
  };
}


// =====================================================
// ORDER BOOK
// =====================================================

async function getOrderBook(
  symbol
) {

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


  for (
    const b of bids
  ) {

    bidVolume +=
      Number(b[0]) *
      Number(b[1]);
  }


  for (
    const a of asks
  ) {

    askVolume +=
      Number(a[0]) *
      Number(a[1]);
  }


  const bidAskRatio =
    askVolume > 0
      ? bidVolume /
        askVolume
      : 1;


  const bestBid =
    Number(
      bids[0]?.[0] ||
      0
    );


  const bestAsk =
    Number(
      asks[0]?.[0] ||
      0
    );


  const mid =
    (
      bestBid +
      bestAsk
    ) / 2;


  // ===================================================
  // دیوار سفارش
  // میانگین اندازه سفارش‌ها
  // ===================================================

  const bidSizes =
    bids.map(
      x => Number(x[1])
    );


  const askSizes =
    asks.map(
      x => Number(x[1])
    );


  const avgBid =
    average(
      bidSizes
    );


  const avgAsk =
    average(
      askSizes
    );


  const largestBid =
    Math.max(
      ...bidSizes,
      0
    );


  const largestAsk =
    Math.max(
      ...askSizes,
      0
    );


  const bidWall =
    largestBid >
    avgBid * 8;


  const askWall =
    largestAsk >
    avgAsk * 8;


  return {

    available: true,

    bestBid,

    bestAsk,

    spread:
      mid > 0
        ? (
            (bestAsk - bestBid) /
            mid
          ) * 100
        : 0,

    bidVolume,

    askVolume,

    bidAskRatio,

    bidWall,

    askWall,

    largestBid,

    largestAsk,

    signal:
      bidAskRatio > 1.15
        ? "LONG"
        : bidAskRatio < 0.87
        ? "SHORT"
        : "NEUTRAL"
  };
}


// =====================================================
// FOOTPRINT
// =====================================================

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
      price *
      size;


    notionals.push(
      notional
    );


    totalNotional +=
      notional;


    if (
      String(
        t.side
      ).toLowerCase()
      === "buy"
    ) {

      buyVolume +=
        size;

    } else {

      sellVolume +=
        size;
    }
  }


  const totalVolume =
    buyVolume +
    sellVolume;


  const delta =
    buyVolume -
    sellVolume;


  const deltaPercent =
    totalVolume > 0
      ? (
          delta /
          totalVolume
        ) * 100
      : 0;


  const buyRatio =
    totalVolume > 0
      ? (
          buyVolume /
          totalVolume
        ) * 100
      : 0;


  const sellRatio =
    totalVolume > 0
      ? (
          sellVolume /
          totalVolume
        ) * 100
      : 0;


  const averageNotional =
    trades.length > 0
      ? totalNotional /
        trades.length
      : 0;


  const largeThreshold =
    averageNotional * 5;


  const largestTrade =
    Math.max(
      ...notionals,
      0
    );


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
      largestTrade >=
      largeThreshold,

    largeTradeNotional:
      largestTrade,

    averageTradeNotional:
      averageNotional
  };
}


// =====================================================
// BYBIT REQUEST
// =====================================================

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
// KLINES
// =====================================================

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
    data.result?.list ||
    []
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


// =====================================================
// HELPERS
// =====================================================

function normalizeSymbol(
  symbol
) {

  if (!symbol)
    return "";


  return String(symbol)
    .trim()
    .toUpperCase()
    .replace("/", "")
    .replace("-", "");
}


function sma(
  data,
  period
) {

  if (
    !data ||
    data.length <
      period
  )
    return null;


  const part =
    data.slice(
      data.length -
      period
    );


  return (
    part.reduce(
      (a, b) =>
        a +
        Number(b),
      0
    ) / period
  );
}


function average(
  arr
) {

  if (
    !arr ||
    !arr.length
  )
    return 0;


  return (
    arr.reduce(
      (a, b) =>
        a + b,
      0
    ) / arr.length
  );
}


function roundPrice(
  price
) {

  if (
    !Number.isFinite(
      price
    )
  )
    return null;


  if (
    price >= 1000
  )
    return Number(
      price.toFixed(2)
    );


  if (
    price >= 1
  )
    return Number(
      price.toFixed(4)
    );


  if (
    price >= 0.01
  )
    return Number(
      price.toFixed(6)
    );


  if (
    price >= 0.0001
  )
    return Number(
      price.toFixed(8)
    );


  return Number(
    price.toFixed(10)
  );
}


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
