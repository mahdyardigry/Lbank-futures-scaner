const BYBIT_BASE = "https://api.bybit.com";

const TIMEFRAMES = [
  { key: "1", label: "1m" },
  { key: "3", label: "3m" },
  { key: "5", label: "5m" },
  { key: "15", label: "15m" },
  { key: "30", label: "30m" },
  { key: "60", label: "1H" },
  { key: "120", label: "2H" },
  { key: "240", label: "4H" },
  { key: "D", label: "1D" }
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
      // CHECK SYMBOL
      // =========================
      if (url.pathname === "/api/check") {

        const symbol = normalizeSymbol(
          url.searchParams.get("symbol")
        );

        if (!symbol) {
          return json({
            ok: false,
            error: "symbol required"
          }, 400);
        }

        const data = await bybit(
          "/v5/market/instruments-info?category=linear&limit=1000"
        );

        const list = data.result?.list || [];

        const found = list.find(
          x => x.symbol === symbol &&
          x.status === "Trading"
        );

        return json({
          ok: true,
          exists: !!found,
          symbol,
          market: "Bybit Futures"
        });
      }


      // =========================
      // FUTURES LIST
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

        limit = Math.max(
          20,
          Math.min(limit, 200)
        );

        if (!symbol) {
          return json({
            ok: false,
            error: "symbol required"
          }, 400);
        }

        const data = await bybit(
          "/v5/market/kline" +
          "?category=linear" +
          "&symbol=" + encodeURIComponent(symbol) +
          "&interval=" + encodeURIComponent(interval) +
          "&limit=" + limit
        );

        const rows =
          (data.result?.list || [])
            .reverse()
            .map(x => ({
              time: Number(x[0]),
              open: Number(x[1]),
              high: Number(x[2]),
              low: Number(x[3]),
              close: Number(x[4]),
              volume: Number(x[5])
            }));

        return json({
          ok: true,
          source: "Bybit Futures",
          symbol,
          interval,
          rows
        });
      }


      // =========================
      // ANALYZE SYMBOL
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
          await analyzeSymbol(symbol);

        return json({
          ok: true,
          ...result
        });
      }


      // =========================
      // AUTO SCAN
      // =========================
      if (url.pathname === "/api/scan") {

        const data = await bybit(
          "/v5/market/instruments-info?category=linear&limit=1000"
        );

        const instruments =
          data.result?.list || [];

        const symbols =
          instruments
            .filter(x =>
              x.status === "Trading" &&
              x.quoteCoin === "USDT" &&
              !x.symbol.includes("-")
            )
            .map(x => x.symbol);

        const results = [];

        /*
         * برای اینکه Worker بیش از حد
         * درخواست نفرستد، فعلاً تعداد
         * ارزهای اسکن شده محدود است.
         *
         * بعداً می‌توانیم اسکن هوشمند
         * بر اساس volume اضافه کنیم.
         */

        const limited =
          symbols.slice(0, 120);

        for (const symbol of limited) {

          try {

            const result =
              await analyzeSymbol(symbol);

            if (
              result.signal !== "WAIT"
            ) {
              results.push(result);
            }

          } catch (e) {
            // یک ارز خراب نباید کل اسکن را متوقف کند
          }
        }

        results.sort(
          (a, b) =>
            b.score.final -
            a.score.final
        );

        return json({
          ok: true,
          source: "Bybit Futures",
          scanned: limited.length,
          found: results.length,
          results
        });
      }


      return json({
        ok: false,
        error: "API endpoint not found",
        path: url.pathname
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
// ANALYZE ALL TIMEFRAMES
// =================================================

async function analyzeSymbol(symbol) {

  const timeframes = {};

  for (const tf of TIMEFRAMES) {

    try {

      const data = await getKlines(
        symbol,
        tf.key,
        100
      );

      timeframes[tf.key] =
        analyzeTimeframe(data);

    } catch (e) {

      timeframes[tf.key] = {
        error: e.message
      };
    }
  }

  const main =
    timeframes["15"];

  let bullish = 0;
  let bearish = 0;

  for (const tf of TIMEFRAMES) {

    const x = timeframes[tf.key];

    if (!x || x.error) continue;

    if (x.trend === "BULLISH") bullish++;
    if (x.trend === "BEARISH") bearish++;
  }

  let longScore = 0;
  let shortScore = 0;

  for (const tf of TIMEFRAMES) {

    const x = timeframes[tf.key];

    if (!x || x.error) continue;

    if (x.touchMA20) {

      if (x.confirmation === "LONG") {
        longScore += tfWeight(tf.key);
      }

      if (x.confirmation === "SHORT") {
        shortScore += tfWeight(tf.key);
      }
    }
  }

  // روندهای تایم بالاتر
  if (
    ["60", "240", "D"].some(tf =>
      timeframes[tf]?.trend === "BULLISH"
    )
  ) {
    longScore += 10;
  }

  if (
    ["60", "240", "D"].some(tf =>
      timeframes[tf]?.trend === "BEARISH"
    )
  ) {
    shortScore += 10;
  }

  let signal = "WAIT";

  if (
    longScore >= 30 &&
    longScore > shortScore
  ) {
    signal = "LONG";
  }

  if (
    shortScore >= 30 &&
    shortScore > longScore
  ) {
    signal = "SHORT";
  }

  const entry =
    main?.close || null;

  let sl = null;
  let tp1 = null;
  let tp2 = null;
  let tp3 = null;

  if (signal === "LONG" && entry) {

    sl = main.swingLow;

    if (sl && sl >= entry) {
      sl = entry * 0.99;
    }

    const risk = entry - sl;

    tp1 = entry + risk * 1.5;
    tp2 = entry + risk * 2;
    tp3 = entry + risk * 3;
  }

  if (signal === "SHORT" && entry) {

    sl = main.swingHigh;

    if (sl && sl <= entry) {
      sl = entry * 1.01;
    }

    const risk = sl - entry;

    tp1 = entry - risk * 1.5;
    tp2 = entry - risk * 2;
    tp3 = entry - risk * 3;
  }

  return {

    source: "Bybit Futures",

    symbol,

    mainTimeframe: "15",

    price: main?.close || null,

    signal,

    score: {
      long: longScore,
      short: shortScore,
      final: Math.max(
        longScore,
        shortScore
      )
    },

    bullishTimeframes: bullish,

    bearishTimeframes: bearish,

    entry,

    sl,

    tp1,
    tp2,
    tp3,

    timeframes

  };
}


// =================================================
// TIMEFRAME ANALYSIS
// =================================================

function analyzeTimeframe(rows) {

  if (!rows || rows.length < 30) {

    throw new Error(
      "Not enough candles"
    );
  }

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

  const volumeMA7 =
    sma(volumes, 7);

  const volumeMA20 =
    sma(volumes, 20);

  const previous =
    rows[rows.length - 2];

  const current =
    rows[rows.length - 1];

  let trend = "RANGE";

  if (ma7 > ma20) {
    trend = "BULLISH";
  }

  if (ma7 < ma20) {
    trend = "BEARISH";
  }

  const distance =
    Math.abs(ma7 - ma20) / ma20;

  const range =
    distance < 0.0015;

  // ==================================
  // MA20 TOUCH
  // ==================================

  const touchMA20 =
    current.low <= ma20 &&
    current.high >= ma20;

  // ==================================
  // CONFIRMATION
  // ==================================

  let confirmation = "NONE";

  if (
    trend === "BULLISH" &&
    touchMA20 &&
    current.close > ma20 &&
    current.close > current.open
  ) {
    confirmation = "
