const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

const TF_MAP = {
  "1": "1",
  "3": "3",
  "5": "5",
  "15": "15",
  "30": "30",
  "60": "60",
  "120": "120",
  "240": "240",
  "D": "D"
};

let futures = [];
let savedAt = null;
let previousFutures = [];


export default {
  async fetch(request, env, ctx) {

    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS
      });
    }

    try {

      // =========================================
      // LBank Futures
      // =========================================
      if (
        url.pathname === "/api/futures" &&
        request.method === "GET"
      ) {

        return json({
          ok: true,
          count: futures.length,
          futures,
          savedAt
        });
      }


      // =========================================
      // UPDATE LBank Futures
      // =========================================
      if (
        url.pathname === "/api/futures/update" &&
        request.method === "GET"
      ) {

        const response = await fetch(
          "https://api.lbkex.com/v2/symbols.do"
        );

        if (!response.ok) {
          throw new Error(
            "LBank HTTP " + response.status
          );
        }

        const data = await response.json();

        const raw =
          Array.isArray(data)
            ? data
            : (
                data.data ||
                data.result ||
                []
              );

        const newList =
          raw
            .map(item => {

              if (typeof item === "string") {
                return normalizeSymbol(item);
              }

              return normalizeSymbol(
                item.symbol ||
                item.name ||
                ""
              );

            })
            .filter(Boolean);

        const unique =
          [...new Set(newList)]
            .sort();

        previousFutures = futures;

        const oldSet =
          new Set(previousFutures);

        const newSet =
          new Set(unique);

        const added =
          unique.filter(
            x => !oldSet.has(x)
          );

        const removed =
          previousFutures.filter(
            x => !newSet.has(x)
          );

        futures = unique;

        savedAt =
          new Date().toISOString();

        return json({
          ok: true,
          count: futures.length,
          futures,
          added,
          removed,
          addedCount: added.length,
          removedCount: removed.length,
          savedAt
        });
      }


      // =========================================
      // SAVED
      // =========================================
      if (
        url.pathname === "/api/saved" &&
        request.method === "GET"
      ) {

        return json({
          ok: true,
          futures,
          savedAt
        });
      }


      // =========================================
      // SAVE MANUAL LIST
      // =========================================
      if (
        url.pathname === "/api/save" &&
        request.method === "POST"
      ) {

        const body =
          await request.json();

        if (
          !Array.isArray(
            body.futures
          )
        ) {

          return json(
            {
              ok: false,
              error:
                "Invalid futures list"
            },
            400
          );
        }

        previousFutures =
          futures;

        futures =
          [
            ...new Set(
              body.futures
                .map(normalizeSymbol)
                .filter(Boolean)
            )
          ].sort();

        savedAt =
          new Date().toISOString();

        return json({
          ok: true,
          count: futures.length,
          futures,
          savedAt
        });
      }


      // =========================================
      // BYBIT KLINE
      // =========================================
      if (
        url.pathname === "/api/kline" &&
        request.method === "GET"
      ) {

        const symbol =
          normalizeSymbol(
            url.searchParams.get(
              "symbol"
            )
          );

        const interval =
          url.searchParams.get(
            "interval"
          ) || "15";

        let limit =
          Number(
            url.searchParams.get(
              "limit"
            ) || 200
          );

        limit =
          Math.min(
            Math.max(
              Number.isFinite(limit)
                ? limit
                : 200,
              1
            ),
            1000
          );

        if (!symbol) {
          return json(
            {
              ok: false,
              error:
                "symbol required"
            },
            400
          );
        }

        if (!TF_MAP[interval]) {
          return json(
            {
              ok: false,
              error:
                "invalid interval"
            },
            400
          );
        }

        const bybitUrl =
          "https://api.bybit.com/v5/market/kline" +
          "?category=linear" +
          "&symbol=" +
          encodeURIComponent(symbol) +
          "&interval=" +
          encodeURIComponent(
            TF_MAP[interval]
          ) +
          "&limit=" +
          limit;

        const response =
          await fetch(bybitUrl);

        const data =
          await response.json();

        if (
          data.retCode !== 0
        ) {

          return json(
            {
              ok: false,
              error:
                data.retMsg ||
                "Bybit error"
            },
            500
          );
        }

        const rows =
          (
            data.result?.list ||
            []
          )
            .reverse()
            .map(item => ({
              time:
                Number(item[0]),
              open:
                Number(item[1]),
              high:
                Number(item[2]),
              low:
                Number(item[3]),
              close:
                Number(item[4]),
              volume:
                Number(item[5])
            }));

        return json({
          ok: true,
          symbol,
          interval,
          rows
        });
      }


      // =========================================
      // BYBIT RECENT TRADES
      // =========================================
      if (
        url.pathname === "/api/trades" &&
        request.method === "GET"
      ) {

        const symbol =
          normalizeSymbol(
            url.searchParams.get(
              "symbol"
            )
          );

        let limit =
          Number(
            url.searchParams.get(
              "limit"
            ) || 500
          );

        limit =
          Math.min(
            Math.max(
              Number.isFinite(limit)
                ? limit
                : 500,
              1
            ),
            1000
          );

        if (!symbol) {
          return json(
            {
              ok: false,
              error:
                "symbol required"
            },
            400
          );
        }

        const bybitUrl =
          "https://api.bybit.com/v5/market/recent-trade" +
          "?category=linear" +
          "&symbol=" +
          encodeURIComponent(symbol) +
          "&limit=" +
          limit;

        const response =
          await fetch(bybitUrl);

        const data =
          await response.json();

        if (
          data.retCode !== 0
        ) {

          return json(
            {
              ok: false,
              error:
                data.retMsg ||
                "Bybit trade error"
            },
            500
          );
        }

        const trades =
          (
            data.result?.list ||
            []
          ).map(t => {

            const side =
              String(
                t.side || ""
              ).toLowerCase();

            const size =
              Number(
                t.size || 0
              );

            return {
              time:
                Number(t.time || 0),
              price:
                Number(t.price || 0),
              size,
              side:
                side === "buy"
                  ? "buy"
                  : "sell"
            };

          });

        let buyVolume = 0;
        let sellVolume = 0;

        for (
          const trade of trades
        ) {

          if (
            trade.side === "buy"
          ) {
            buyVolume +=
              trade.size;
          }
          else {
            sellVolume +=
              trade.size;
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

        return json({
          ok: true,
          symbol,
          count:
            trades.length,
          buyVolume,
          sellVolume,
          delta,
          deltaPercent,
          buyRatio:
            total > 0
              ? (
                  buyVolume /
                  total
                ) * 100
              : 0,
          sellRatio:
            total > 0
              ? (
                  sellVolume /
                  total
                ) * 100
              : 0,
          trades
        });
      }


      // =========================================
      // SCAN
      // =========================================
      if (
        url.pathname === "/api/scan" &&
        request.method === "GET"
      ) {

        const symbol =
          normalizeSymbol(
            url.searchParams.get(
              "symbol"
            )
          );

        const interval =
          url.searchParams.get(
            "interval"
          ) || "15";

        if (!symbol) {
          return json(
            {
              ok: false,
              error:
                "symbol required"
            },
            400
          );
        }

        const result =
          await scanSymbol(
            symbol,
            interval
          );

        return json({
          ok: true,
          ...result
        });
      }


      // =========================================
      // DEFAULT
      // =========================================
      return json(
        {
          ok: false,
          error:
            "API endpoint not found",
          path:
            url.pathname
        },
        404
      );

    }
    catch (error) {

      return json(
        {
          ok: false,
          error:
            "Worker error",
          detail:
            error?.message ||
            String(error)
        },
        500
      );
    }
  }
};


// =================================================
// SCANNER
// =================================================

async function scanSymbol(
  symbol,
  interval
) {

  const rows =
    await getKlines(
      symbol,
      interval,
      200
    );

  if (
    rows.length < 30
  ) {

    throw new Error(
      "داده کافی برای تحلیل وجود ندارد"
    );
  }

  const closes =
    rows.map(
      x => x.close
    );

  const highs =
    rows.map(
      x => x.high
    );

  const lows =
    rows.map(
      x => x.low
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

  const volumeMA7 =
    sma(volumes, 7);

  const volumeMA20 =
    sma(volumes, 20);


  // Trend
  let trend =
    "RANGE";

  if (
    ma7 > ma20
  ) {
    trend =
      "BULLISH";
  }
  else if (
    ma7 < ma20
  ) {
    trend =
      "BEARISH";
  }


  // Range
  const distance =
    Math.abs(
      ma7 - ma20
   
