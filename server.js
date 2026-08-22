import express from "express";

const app = express();
const PORT = process.env.PORT || 8080;

let futures = [];
let savedAt = null;

app.use(express.json());
app.use(express.static("public"));

app.get("/api/futures", async (req, res) => {
  try {
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

    res.json({
      ok: true,
      count: futures.length,
      futures,
      savedAt
    });

  } catch (error) {

    console.error(error);

    res.status(500).json({
      ok: false,
      error: "LBank Futures دریافت نشد",
      detail: error.message
    });

  }
});

app.get("/api/saved", (req, res) => {

  res.json({
    futures,
    savedAt
  });

});

app.post("/api/save", (req, res) => {

  if (!Array.isArray(req.body.futures)) {

    return res.status(400).json({
      ok: false,
      error: "Invalid futures list"
    });

  }

  futures = [
    ...new Set(
      req.body.futures.map(x =>
        String(x).toUpperCase()
      )
    )
  ];

  savedAt = new Date().toISOString();

  res.json({
    ok: true,
    count: futures.length,
    savedAt
  });

});

app.get("/api/kline", async (req, res) => {

  const symbol =
    String(req.query.symbol || "")
      .trim()
      .toUpperCase();

  const interval =
    String(req.query.interval || "15");

  const limit =
    Math.min(
      Number(req.query.limit || 200),
      1000
    );

  if (!symbol) {

    return res.status(400).json({
      ok: false,
      error: "symbol required"
    });

  }

  try {

    const url =
      "https://api.bybit.com/v5/market/kline" +
      "?category=linear" +
      "&symbol=" +
      encodeURIComponent(symbol) +
      "&interval=" +
      encodeURIComponent(interval) +
      "&limit=" +
      limit;

    const response = await fetch(url);
    const data = await response.json();

    if (data.retCode !== 0) {

      return res.status(500).json({
        ok: false,
        error: data.retMsg || "Bybit error"
      });

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

    res.json({
      ok: true,
      symbol,
      interval,
      rows
    });

  } catch (error) {

    console.error(error);

    res.status(500).json({
      ok: false,
      error: "Bybit Kline دریافت نشد",
      detail: error.message
    });

  }

});

app.listen(PORT, () => {

  console.log(
    `LBank Scanner running on port ${PORT}`
  );

});
