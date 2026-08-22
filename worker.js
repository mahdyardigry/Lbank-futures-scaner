let futures = [];
let savedAt = null;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };

    // OPTIONS
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    try {
      // =========================
      // GET /api/futures
      // =========================
      if (
        url.pathname === "/api/futures" &&
        request.method === "GET"
      ) {
        const response = await fetch(
          "https://api.lbkex.com/v2/symbols.do"
        );

        const data = await response.json();

        const raw = Array.isArray(data)
          ? data
          : (data.data || data.result || []);

        const list = raw
          .map(item => {
            if (typeof item === "string") {
              return item.toUpperCase();
            }

            return String(
              item.symbol ||
              item.name ||
              ""
            ).toUpperCase();
          })
          .filter(Boolean)
          .sort();

        futures = [...new Set(list)];
        savedAt = new Date().toISOString();

        return json({
          ok: true,
          count: futures.length,
          futures,
          savedAt
        }, corsHeaders);
      }

      // =========================
      // GET /api/saved
      // =========================
      if (
        url.pathname === "/api/saved" &&
        request.method === "GET"
      ) {
        return json({
          futures,
          savedAt
        }, corsHeaders);
      }

      // =========================
      // POST /api/save
      // =========================
      if (
        url.pathname === "/api/save" &&
        request.method === "POST"
      ) {
        const body = await request.json();

        if (!Array.isArray(body.futures)) {
          return json({
            ok: false,
            error: "Invalid futures list"
          }, corsHeaders, 400);
        }

        futures = [
          ...new Set(
            body.futures.map(x =>
              String(x).toUpperCase()
            )
          )
        ];

        savedAt = new Date().toISOString();

        return json({
          ok: true,
          count: futures.length,
          savedAt
        }, corsHeaders);
      }

      // =========================
      // GET /api/kline
      // =========================
      if (
        url.pathname === "/api/kline" &&
        request.method === "GET"
      ) {
        const symbol =
          String(
            url.searchParams.get("symbol") || ""
          )
            .trim()
            .toUpperCase();

        const interval =
          String(
            url.searchParams.get("interval") || "15"
          );

        let limit =
          Number(
            url.searchParams.get("limit") || 200
          );

        if (!Number.isFinite(limit)) {
          limit = 200;
        }

        limit = Math.min(
          Math.max(limit, 1),
          1000
        );

        if (!symbol) {
          return json({
            ok: false,
            error: "symbol required"
          }, corsHeaders, 400);
        }

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
            error: data.retMsg || "Bybit error"
          }, corsHeaders, 500);
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
          symbol,
          interval,
          rows
        }, corsHeaders);
      }

      // =========================
      // Default
      // =========================
      return json({
        ok: false,
        error: "API endpoint not found",
        path: url.pathname
      }, corsHeaders, 404);

    } catch (error) {

      return json({
        ok: false,
        error: "Worker error",
        detail: error?.message || String(error)
      }, corsHeaders, 500);
    }
  }
};


// =========================
// JSON Response Helper
// =========================

function json(data, corsHeaders, status = 200) {

  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        ...corsHeaders
      }
    }
  );
}
