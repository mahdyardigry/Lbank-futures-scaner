const BYBIT = "https://api.bybit.com";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

const TF = {
  "1":  "1",
  "3":  "3",
  "5":  "5",
  "15": "15",
  "60": "60"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function bad(message, status = 400) {
  return json({
    ok: false,
    error: message
  }, status);
}

async function bybit(path, params = {}) {
  const url = new URL(BYBIT + path);

  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") {
      url.searchParams.set(k, String(v));
    }
  });

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "Accept": "application/json"
    }
  });

  const text = await res.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Bybit returned invalid JSON");
  }

  if (!res.ok) {
    throw new Error(`Bybit HTTP ${res.status}`);
  }

  if (data.retCode !== 0) {
    throw new Error(data.retMsg || "Bybit API error");
  }

  return data;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round(v, n = 2) {
  const p = Math.pow(10, n);
  return Math.round(v * p) / p;
}

function pct(a, b) {
  if (!b) return 0;
  return ((a - b) / Math.abs(b)) * 100;
}

/* -------------------------------------------------------
   KLINES
------------------------------------------------------- */

async function getKlines(category, symbol, interval = "1", limit = 200) {
  const data = await bybit("/v5/market/kline", {
    category,
    symbol,
    interval,
    limit
  });

  return (data.result.list || [])
    .reverse()
    .map(x => ({
      time: Number(x[0]),
      open: num(x[1]),
      high: num(x[2]),
      low: num(x[3]),
      close: num(x[4]),
      volume: num(x[5]),
      turnover: num(x[6])
    }));
}

/* -------------------------------------------------------
   MA
------------------------------------------------------- */

function sma(values, period) {
  if (values.length < period) return null;

  let sum = 0;

  for (let i = values.length - period; i < values.length; i++) {
    sum += values[i];
  }

  return sum / period;
}

function ema(values, period) {
  if (!values.length) return null;

  const k = 2 / (period + 1);
  let result = values[0];

  for (let i = 1; i < values.length; i++) {
    result = values[i] * k + result * (1 - k);
  }

  return result;
}

function movingAverage(values, period, type = "EMA") {
  return type === "SMA"
    ? sma(values, period)
    : ema(values, period);
}

/* -------------------------------------------------------
   RSI
------------------------------------------------------- */

function calcRSI(closes, period = 14) {
  if (closes.length <= period) return 50;

  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];

    if (d >= 0) gain += d;
    else loss += Math.abs(d);
  }

  let avgGain = gain / period;
  let avgLoss = loss / period;

  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];

    const g = d > 0 ? d : 0;
    const l = d < 0 ? Math.abs(d) : 0;

    avgGain = ((avgGain * (period - 1)) + g) / period;
    avgLoss = ((avgLoss * (period - 1)) + l) / period;
  }

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;

  return 100 - (100 / (1 + rs));
}

/* -------------------------------------------------------
   MACD
------------------------------------------------------- */

function calcMACD(closes) {
  if (closes.length < 35) {
    return {
      macd: 0,
      signal: 0,
      histogram: 0
    };
  }

  const fast = [];
  const slow = [];

  for (let i = 0; i < closes.length; i++) {
    fast.push(ema(closes.slice(0, i + 1), 12));
    slow.push(ema(closes.slice(0, i + 1), 26));
  }

  const macdValues = fast.map((x, i) => x - slow[i]);

  const signal = ema(macdValues, 9);
  const macd = macdValues[macdValues.length - 1];

  return {
    macd,
    signal,
    histogram: macd - signal
  };
}

/* -------------------------------------------------------
   VOLUME
------------------------------------------------------- */

function volumeAnalysis(candles, level = 3) {
  const volumes = candles.map(x => x.volume);

  const current = volumes[volumes.length - 1];

  const avg20 = volumes.length >= 20
    ? sma(volumes, 20)
    : sma(volumes, volumes.length);

  const ratio = avg20 ? current / avg20 : 1;

  const thresholds = {
    1: [0.8, 1.1, 1.4, 1.8, 2.5, 3.5],
    2: [0.9, 1.2, 1.6, 2.0, 3.0, 4.0],
    3: [1.0, 1.3, 1.8, 2.2, 3.2, 4.5],
    4: [1.1, 1.5, 2.0, 2.5, 3.5, 5.0],
    5: [1.2, 1.7, 2.2, 2.8, 4.0, 5.5],
    6: [1.3, 1.9, 2.5, 3.0, 4.5, 6.0]
  };

  const t = thresholds[level] || thresholds[3];

  let score = 0;

  if (ratio >= t[0]) score += 10;
  if (ratio >= t[1]) score += 10;
  if (ratio >= t[2]) score += 15;
  if (ratio >= t[3]) score += 15;
  if (ratio >= t[4]) score += 15;
  if (ratio >= t[5]) score += 15;

  return {
    current,
    average20: avg20,
    ratio,
    score: Math.min(score, 80),
    strong: ratio >= t[3],
    extreme: ratio >= t[4],
    level
  };
}

/* -------------------------------------------------------
   MARKET STRUCTURE
------------------------------------------------------- */

function structureAnalysis(candles) {
  if (candles.length < 10) {
    return {
      trend: "neutral",
      bos: false,
      choch: false,
      swingHigh: null,
      swingLow: null
    };
  }

  const last = candles[candles.length - 1];

  const prevHigh = Math.max(
    ...candles.slice(-8, -1).map(x => x.high)
  );

  const prevLow = Math.min(
    ...candles.slice(-8, -1).map(x => x.low)
  );

  const bosUp = last.close > prevHigh;
  const bosDown = last.close < prevLow;

  const closes = candles.map(x => x.close);

  const fast = ema(closes, 7);
  const slow = ema(closes, 20);

  let trend = "neutral";

  if (fast > slow) trend = "bullish";
  if (fast < slow) trend = "bearish";

  return {
    trend,
    bos: bosUp || bosDown,
    bosDirection: bosUp ? "bullish" : bosDown ? "bearish" : null,
    choch: false,
    swingHigh: prevHigh,
    swingLow: prevLow
  };
}

/* -------------------------------------------------------
   FVG
------------------------------------------------------- */

function findFVG(candles) {
  const result = [];

  for (let i = 2; i < candles.length; i++) {
    const a = candles[i - 2];
    const b = candles[i - 1];
    const c = candles[i];

    if (c.low > a.high) {
      result.push({
        type: "bullish",
        low: a.high,
        high: c.low,
        index: i
      });
    }

    if (c.high < a.low) {
      result.push({
        type: "bearish",
        low: c.high,
        high: a.low,
        index: i
      });
    }
  }

  return result.slice(-10);
}

/* -------------------------------------------------------
   HUNT / LIQUIDITY SWEEP
------------------------------------------------------- */

function detectHunt(candles) {
  if (candles.length < 8) {
    return {
      detected: false,
      type: null
    };
  }

  const last = candles[candles.length - 1];

  const previous = candles.slice(-7, -1);

  const high = Math.max(...previous.map(x => x.high));
  const low = Math.min(...previous.map(x => x.low));

  const upperSweep =
    last.high > high &&
    last.close < high;

  const lowerSweep =
    last.low < low &&
    last.close > low;

  if (upperSweep) {
    return {
      detected: true,
      type: "bearish",
      level: high
    };
  }

  if (lowerSweep) {
    return {
      detected: true,
      type: "bullish",
      level: low
    };
  }

  return {
    detected: false,
    type: null
  };
}

/* -------------------------------------------------------
   SUPPORT / RESISTANCE
------------------------------------------------------- */

function supportResistance(candles) {
  const highs = candles.map(x => x.high);
  const lows = candles.map(x => x.low);

  const resistance = Math.max(...highs.slice(-50));
  const support = Math.min(...lows.slice(-50));

  const price = candles[candles.length - 1].close;

  return {
    support,
    resistance,
    distanceToSupport: pct(price, support),
    distanceToResistance: pct(resistance, price)
  };
}

/* -------------------------------------------------------
   ORDER BOOK
------------------------------------------------------- */

async function getOrderBook(category, symbol, limit = 200) {
  const data = await bybit("/v5/market/orderbook", {
    category,
    symbol,
    limit
  });

  const r = data.result;

  const bids = (r.b || []).map(x => ({
    price: num(x[0]),
    size: num(x[1])
  }));

  const asks = (r.a || []).map(x => ({
    price: num(x[0]),
    size: num(x[1])
  }));

  const bidTotal = bids.reduce((s, x) => s + x.size, 0);
  const askTotal = asks.reduce((s, x) => s + x.size, 0);

  const bidWalls = [...bids]
    .sort((a, b) => b.size - a.size)
    .slice(0, 10);

  const askWalls = [...asks]
    .sort((a, b) => b.size - a.size)
    .slice(0, 10);

  return {
    bids,
    asks,
    bidTotal,
    askTotal,
    imbalance: (bidTotal + askTotal)
      ? (bidTotal - askTotal) / (bidTotal + askTotal)
      : 0,
    bidWalls,
    askWalls
  };
}

/* -------------------------------------------------------
   RECENT TRADES / FOOTPRINT
------------------------------------------------------- */

async function getTrades(category, symbol, limit = 1000) {
  const data = await bybit("/v5/market/recent-trade", {
    category,
    symbol,
    limit: Math.min(limit, 1000)
  });

  const trades = (data.result.list || []).map(x => ({
    price: num(x.p),
    size: num(x.v),
    side: x.S,
    time: Number(x.T)
  }));

  let buy = 0;
  let sell = 0;

  for (const t of trades) {
    if (t.side === "Buy") buy += t.size;
    else sell += t.size;
  }

  const total = buy + sell;

  return {
    trades,
    buy,
    sell,
    delta: buy - sell,
    buyPercent: total ? buy / total * 100 : 50,
    sellPercent: total ? sell / total * 100 : 50
  };
}

/* -------------------------------------------------------
   OI
------------------------------------------------------- */

async function getOpenInterest(category, symbol, intervalTime = "5", limit = 50) {
  if (category !== "linear" && category !== "inverse") {
    return {
      list: [],
      current: 0,
      change: 0
    };
  }

  const data = await bybit("/v5/market/open-interest", {
    category,
    symbol,
    intervalTime,
    limit
  });

  const list = (data.result.list || [])
    .reverse()
    .map(x => ({
      time: Number(x.timestamp),
      oi: num(x.openInterest)
    }));

  const current = list.length
    ? list[list.length - 1].oi
    : 0;

  const old = list.length > 1
    ? list[0].oi
    : current;

  return {
    list,
    current,
    change: pct(current, old)
  };
}

/* -------------------------------------------------------
   FUNDING
------------------------------------------------------- */

async function getFunding(category, symbol) {
  if (category !== "linear" && category !== "inverse") {
    return {
      rate: 0
    };
  }

  const data = await bybit("/v5/market/funding/history", {
    category,
    symbol,
    limit: 10
  });

  const list = data.result.list || [];

  const latest = list.length
    ? list[0]
    : null;

  return {
    rate: latest ? num(latest.fundingRate) : 0,
    time: latest ? Number(latest.fundingRateTimestamp) : null,
    history: list
  };
}

/* -------------------------------------------------------
   TICKER
------------------------------------------------------- */

async function getTicker(category, symbol) {
  const data = await bybit("/v5/market/tickers", {
    category,
    symbol
  });

  const x = data.result.list?.[0];

  if (!x) throw new Error("Symbol not found");

  return {
    symbol: x.symbol,
    lastPrice: num(x.lastPrice),
    price24hPcnt: num(x.price24hPcnt) * 100,
    volume24h: num(x.volume24h),
    turnover24h: num(x.turnover24h),
    high24h: num(x.highPrice24h),
    low24h: num(x.lowPrice24h),
    openInterest: num(x.openInterest),
    fundingRate: num(x.fundingRate)
  };
}

/* -------------------------------------------------------
   SIGNAL ENGINE
------------------------------------------------------- */

function calculateSignal({
  candles,
  volume,
  structure,
  hunt,
  sr,
  footprint,
  orderbook,
  oi,
  funding,
  category
}) {
  const closes = candles.map(x => x.close);

  const price = closes[closes.length - 1];

  const ma7 = ema(closes, 7);
  const ma20 = ema(closes, 20);

  const rsi = calcRSI(closes, 14);
  const macd = calcMACD(closes);

  let long = 0;
  let short = 0;

  /* MA */

  if (ma7 > ma20) long += 12;
  if (ma7 < ma20) short += 12;

  /* RSI */

  if (rsi >= 52 && rsi <= 70) long += 8;
  if (rsi <= 48 && rsi >= 30) short += 8;

  /* MACD */

  if (macd.histogram > 0) long += 10;
  if (macd.histogram < 0) short += 10;

  /* Volume */

  if (volume.strong) {
    if (candles[candles.length - 1].close >
        candles[candles.length - 1].open) {
      long += 12;
    } else {
      short += 12;
    }
  }

  /* Structure */

  if (structure.trend === "bullish") long += 10;
  if (structure.trend === "bearish") short += 10;

  if (structure.bosDirection === "bullish") long += 10;
  if (structure.bosDirection === "bearish") short += 10;

  /* Hunt */

  if (hunt.detected) {
    if (hunt.type === "bullish") long += 15;
    if (hunt.type === "bearish") short += 15;
  }

  /* Footprint */

  if (footprint.delta > 0) long += 8;
  if (footprint.delta < 0) short += 8;

  /* Orderbook */

  if (orderbook.imbalance > 0.12) long += 8;
  if (orderbook.imbalance < -0.12) short += 8;

  /* OI */

  if (oi.change > 3) {
    if (long > short) long += 5;
    if (short > long) short += 5;
  }

  if (oi.change < -3) {
    if (long > short) long += 3;
    if (short > long) short += 3;
  }

  /* Funding */

  if (funding.rate > 0.0015) short += 5;
  if (funding.rate < -0.0015) long += 5;

  const total = Math.max(long, short);

  let direction = "WAIT";

  if (long > short + 10) direction = "LONG";
  if (short > long + 10) direction = "SHORT";

  let strength = "WEAK";

  if (total >= 25) strength = "NORMAL";
  if (total >= 45) strength = "STRONG";
  if (total >= 65) strength = "VERY_STRONG";
  if (total >= 80) strength = "EXTREME";

  return {
    direction,
    strength,
    score: Math.min(total, 100),
    long: Math.min(long, 100),
    short: Math.min(short, 100),

    indicators: {
      price,
      ma7,
      ma20,
      rsi,
      macd
    },

    reasons: {
      volume,
      structure,
      hunt,
      support: sr.support,
      resistance: sr.resistance,
      footprintDelta: footprint.delta,
      orderbookImbalance: orderbook.imbalance,
      oiChange: oi.change,
      fundingRate: funding.rate
    }
  };
}

/* -------------------------------------------------------
   FULL ANALYSIS
------------------------------------------------------- */

async function analyze(category, symbol, interval = "1", volumeLevel = 3) {
  const [
    ticker,
    candles,
    orderbook,
    footprint,
    oi,
    funding
  ] = await Promise.all([
    getTicker(category, symbol),
    getKlines(category, symbol, interval, 200),
    getOrderBook(category, symbol, 200),
    getTrades(category, symbol, 1000),
    getOpenInterest(category, symbol, "5", 50),
    getFunding(category, symbol)
  ]);

  const volume = volumeAnalysis(candles, volumeLevel);

  const structure = structureAnalysis(candles);

  const hunt = detectHunt(candles);

  const sr = supportResistance(candles);

  const fvg = findFVG(candles);

  const signal = calculateSignal({
    candles,
    volume,
    structure,
    hunt,
    sr,
    footprint,
    orderbook,
    oi,
    funding,
    category
  });

  return {
    ok: true,

    market: {
      category,
      symbol,
      interval
    },

    ticker,

    signal,

    volume,

    structure,

    hunt,

    supportResistance: sr,

    fvg,

    orderbook,

    footprint,

    openInterest: oi,

    funding,

    candles
  };
}

/* -------------------------------------------------------
   FAST SCAN
------------------------------------------------------- */

async function getSymbols(category) {
  const data = await bybit("/v5/market/instruments-info", {
    category,
    limit: 1000
  });

  return (data.result.list || [])
    .filter(x => {
      if (category === "spot") {
        return x.status === "Trading" &&
          x.quoteCoin === "USDT";
      }

      return x.status === "Trading" &&
        x.quoteCoin === "USDT" &&
        x.contractType === "LinearPerpetual";
    })
    .map(x => x.symbol);
}

async function scan(category, interval = "1", volumeLevel = 3) {
  const symbols = await getSymbols(category);

  const tickerData = await bybit("/v5/market/tickers", {
    category
  });

  let tickers = tickerData.result.list || [];

  tickers = tickers
    .filter(x => symbols.includes(x.symbol))
    .map(x => ({
      symbol: x.symbol,
      price: num(x.lastPrice),
      change24h: num(x.price24hPcnt) * 100,
      volume24h: num(x.volume24h),
      turnover24h: num(x.turnover24h),
      oi: num(x.openInterest)
    }))
    .filter(x => x.volume24h > 0);

  /*
    غربال اولیه:
    ارزهای کم‌حجم حذف می‌شوند.
    سپس ارزهای دارای حرکت بیشتر در اولویت قرار می‌گیرند.
  */

  tickers.sort((a, b) => {
    const sa =
      Math.abs(a.change24h) * 0.6 +
      Math.log10(a.turnover24h + 1) * 4;

    const sb =
      Math.abs(b.change24h) * 0.6 +
      Math.log10(b.turnover24h + 1) * 4;

    return sb - sa;
  });

  /*
    فقط تعداد محدودی تحلیل کامل می‌شوند
    تا گوشی و Worker سنگین نشوند.
  */

  const candidates = tickers.slice(0, 30);

  const results = [];

  for (let i = 0; i < candidates.length; i += 5) {
    const batch = candidates.slice(i, i + 5);

    const out = await Promise.all(
      batch.map(async x => {
        try {
          const a = await analyze(
            category,
            x.symbol,
            interval,
            volumeLevel
          );

          return {
            symbol: x.symbol,
            price: x.price,
            change24h: x.change24h,
            volume24h: x.volume24h,

            direction: a.signal.direction,
            strength: a.signal.strength,
            score: a.signal.score,

            long: a.signal.long,
            short: a.signal.short,

            volumeRatio: a.volume.ratio,

            hunt: a.hunt,

            oiChange: a.openInterest.change,

            funding: a.funding.rate,

            orderbookImbalance:
              a.orderbook.imbalance,

            footprintDelta:
              a.footprint.delta
          };

        } catch (e) {
          return null;
        }
      })
    );

    results.push(...out.filter(Boolean));
  }

  results.sort((a, b) => b.score - a.score);

  return {
    ok: true,
    category,
    interval,
    volumeLevel,
    scanned: candidates.length,
    results: results.slice(0, 20)
  };
}

/* -------------------------------------------------------
   ROUTER
------------------------------------------------------- */

export default {
  async fetch(request) {

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS
      });
    }

    try {

      const url = new URL(request.url);

      const path = url.pathname;

      /* Health */

      if (path === "/" || path === "/health") {
        return json({
          ok: true,
          service: "Crypto Scanner Worker",
          exchange: "Bybit",
          version: "V12"
        });
      }

      /* Manual analysis */

      if (path === "/api/analyze") {

        const category =
          url.searchParams.get("category") || "linear";

        const symbol =
          (url.searchParams.get("symbol") || "")
            .toUpperCase();

        const interval =
          url.searchParams.get("interval") || "1";

        const volumeLevel =
          Number(
            url.searchParams.get("volumeLevel") || 3
          );

        if (!symbol) {
          return bad("symbol is required");
        }

        if (!TF[interval]) {
          return bad("invalid interval");
        }

        return json(
          await analyze(
            category,
            symbol,
            interval,
            volumeLevel
          )
        );
      }

      /* Scan */

      if (path === "/api/scan") {

        const category =
          url.searchParams.get("category") || "linear";

        const interval =
          url.searchParams.get("interval") || "1";

        const volumeLevel =
          Number(
            url.searchParams.get("volumeLevel") || 3
          );

        if (!TF[interval]) {
          return bad("invalid interval");
        }

        return json(
          await scan(
            category,
            interval,
            volumeLevel
          )
        );
      }

      /* Ticker */

      if (path === "/api/ticker") {

        const category =
          url.searchParams.get("category") || "linear";

        const symbol =
          (url.searchParams.get("symbol") || "")
            .toUpperCase();

        if (!symbol) {
          return bad("symbol is required");
        }

        return json(
          await getTicker(category, symbol)
        );
      }

      /* Orderbook */

      if (path === "/api/orderbook") {

        const category =
          url.searchParams.get("category") || "linear";

        const symbol =
          (url.searchParams.get("symbol") || "")
            .toUpperCase();

        if (!symbol) {
          return bad("symbol is required");
        }

        return json(
          await getOrderBook(
            category,
            symbol,
            200
          )
        );
      }

      /* Trades */

      if (path === "/api/trades") {

        const category =
          url.searchParams.get("category") || "linear";

        const symbol =
          (url.searchParams.get("symbol") || "")
            .toUpperCase();

        if (!symbol) {
          return bad("symbol is required");
        }

        return json(
          await getTrades(
            category,
            symbol,
            1000
          )
        );
      }

      /* Klines */

      if (path === "/api/klines") {

        const category =
          url.searchParams.get("category") || "linear";

        const symbol =
          (url.searchParams.get("symbol") || "")
            .toUpperCase();

        const interval =
          url.searchParams.get("interval") || "1";

        if (!symbol) {
          return bad("symbol is required");
        }

        return json(
          await getKlines(
            category,
            symbol,
            interval,
            200
          )
        );
      }

      return bad("Endpoint not found", 404);

    } catch (error) {

      return json({
        ok: false,
        error: error.message || "Unknown error"
      }, 500);
    }
  }
};
