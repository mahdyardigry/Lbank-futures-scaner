export default {
  async fetch(request) {
    const url = new URL(request.url);

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    try {

      // =========================
      // GET /api/kline
      // دریافت کندل از Bybit
      // =========================

      if (
        url.pathname === "/api/kline" &&
        request.method === "GET"
      ) {

        const symbol = String(
          url.searchParams.get("symbol") || ""
        ).trim().toUpperCase();

        const interval = String(
          url.searchParams.get("interval") || "15"
        );

        let limit = Number(
          url.searchParams.get("limit") || 100
        );

        if (!symbol) {
          return json({
            ok: false,
            error: "symbol required"
          }, corsHeaders, 400);
        }

        if (!Number.isFinite(limit)) {
          limit = 100;
        }

        limit = Math.min(
          Math.max(limit, 1),
          1000
        );

        const bybitUrl =
          "https://api.bybit.com/v5/market/kline" +
          "?category=linear" +
          "&symbol=" +
          encodeURIComponent(symbol) +
          "&interval=" +
          encodeURIComponent(interval) +
          "&limit=" +
          limit;

        const response = await fetch(bybitUrl);

        const data = await response.json();

        if (data.retCode !== 0) {

          return json({
            ok: false,
            error: data.retMsg || "Bybit error",
            symbol
          }, corsHeaders, 400);

        }

        const rows =
          (data.result?.list || [])
            .reverse()
            .map(item => ({
              time: Number(item[0]),
              open: Number(item[1]),
              high: Number(item[2]),
              low: Number(item[3]),
              close: Number(item[4]),
              volume: Number(item[5])
            }));

        return json({
          ok: true,
          source: "Bybit Futures",
          symbol,
          interval,
          rows
        }, corsHeaders);
      }


      // =========================
      // GET /api/check
      // بررسی وجود ارز در Bybit Futures
      // =========================

      if (
        url.pathname === "/api/check" &&
        request.method === "GET"
      ) {

        const symbol = String(
          url.searchParams.get("symbol") || ""
        ).trim().toUpperCase();

        if (!symbol) {
          return json({
            ok: false,
            error: "symbol required"
          }, corsHeaders, 400);
        }

        const response = await fetch(
          "https://api.bybit.com/v5/market/instruments-info" +
          "?category=linear" +
          "&symbol=" +
          encodeURIComponent(symbol)
        );

        const data = await response.json();

        if (data.retCode !== 0) {

          return json({
            ok: true,
            exists: false,
            symbol,
            message: data.retMsg || "Not found"
          }, corsHeaders);

        }

        const list =
          data.result?.list || [];

        return json({
          ok: true,
          exists: list.length > 0,
          symbol,
          market: "Bybit Futures"
        }, corsHeaders);
      }


      // =========================
      // GET /api/futures
      // دریافت لیست فیوچرز Bybit
      // =========================

      if (
        url.pathname === "/api/futures" &&
        request.method === "GET"
      ) {

        const response = await fetch(
          "https://api.bybit.com/v5/market/instruments-info" +
          "?category=linear" +
          "&limit=1000"
        );

        const data = await response.json();

        if (data.retCode !== 0) {

          return json({
            ok: false,
            error: data.retMsg || "Bybit error"
          }, corsHeaders, 500);

        }

        const list =
          data.result?.list || [];

        const futures =
          list
            .filter(item =>
              item.status === "Trading"
            )
            .map(item =>
              item.symbol
            )
            .sort();

        return json({
          ok: true,
          source: "Bybit Futures",
          count: futures.length,
          futures
        }, corsHeaders);
      }


      // =========================
      // DEFAULT
      // =========================

      return json({
        ok: false,
        error: "API endpoint not found",
        path: url.pathname
      }, corsHeaders, 404);

    }

    catch (error) {

      return json({
        ok: false,
        error: "Worker error",
        detail: error?.message || String(error)
      }, corsHeaders, 500);

    }
  }
};


// =========================
// JSON Helper
// =========================

function json(data, corsHeaders, status = 200) {

  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type":
          "application/json; charset=UTF-8",
        ...corsHeaders
      }
    }
  );
}
