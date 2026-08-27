const BYBIT = "https://api.bybit.com";

const PERSONAL_VERSION = "PERSONAL-MA20-LIVE-V4";

const SCAN_BATCH = 20;

const KLINE_LIMIT_1M = 200;
const KLINE_LIMIT_15M = 200;

const TRADE_LIMIT = 1000;
const ORDERBOOK_LIMIT = 50;

const DEFAULT_STRICTNESS = 20;

const sleep = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*"
    }
  });
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function clamp(v, min = 0, max = 100) {
  return Math.max(min, Math.min(max, num(v)));
}

function pct(a, b) {
  return b ? ((a - b) / b) * 100 : 0;
}

function average(values) {
  const a = values
    .map(Number)
    .filter(Number.isFinite);

  return a.length
    ? a.reduce((x, y) => x + y, 0) / a.length
    : 0;
}

function sma(values, period) {
  if (!values || values.length < period) {
    return 0;
  }

  return average(
    values.slice(-period)
  );
}

function ema(values, period) {
  if (!values || values.length < period) {
    return 0;
  }

  let e =
    average(values.slice(0, period));

  const k =
    2 / (period + 1);

  for (
    let i = period;
    i < values.length;
    i++
  ) {
    e =
      values[i] * k +
      e * (1 - k);
  }

  return e;
}

function stddev(values) {
  if (!values.length) return 0;

  const m = average(values);

  return Math.sqrt(
    average(
      values.map(
        x =>
          Math.pow(
            num(x) - m,
            2
          )
      )
    )
  );
}

/* ========================= RSI ========================= */

function rsi(values, period = 14) {
  if (
    !values ||
    values.length < period + 1
  ) {
    return null;
  }

  let gain = 0;
  let loss = 0;

  for (
    let i = 1;
    i <= period;
    i++
  ) {
    const d =
      values[i] -
      values[i - 1];

    if (d >= 0) {
      gain += d;
    } else {
      loss -= d;
    }
  }

  let avgGain =
    gain / period;

  let avgLoss =
    loss / period;

  for (
    let i = period + 1;
    i < values.length;
    i++
  ) {
    const d =
      values[i] -
      values[i - 1];

    const g =
      d > 0 ? d : 0;

    const l =
      d < 0 ? -d : 0;

    avgGain =
      (
        avgGain * (period - 1) +
        g
      ) / period;

    avgLoss =
      (
        avgLoss * (period - 1) +
        l
      ) / period;
  }

  if (avgLoss === 0) {
    return 100;
  }

  const rs =
    avgGain / avgLoss;

  return (
    100 -
    100 / (1 + rs)
  );
}

/* ========================= MACD ========================= */

function macd(
  values,
  fast = 12,
  slow = 26,
  signalPeriod = 9
) {
  if (
    !values ||
    values.length <
      slow + signalPeriod + 5
  ) {
    return {
      available: false,
      reason:
        "کندل کافی برای MACD وجود ندارد."
    };
  }

  const macdSeries = [];

  for (
    let i = slow - 1;
    i < values.length;
    i++
  ) {
    const fastEma =
      ema(
        values.slice(0, i + 1),
        fast
      );

    const slowEma =
      ema(
        values.slice(0, i + 1),
        slow
      );

    macdSeries.push(
      fastEma - slowEma
    );
  }

  if (
    macdSeries.length <
    signalPeriod + 2
  ) {
    return {
      available: false,
      reason:
        "داده MACD کافی نیست."
    };
  }

  const signalSeries = [];

  for (
    let i = signalPeriod - 1;
    i < macdSeries.length;
    i++
  ) {
    signalSeries.push(
      ema(
        macdSeries.slice(0, i + 1),
        signalPeriod
      )
    );
  }

  const currentMacd =
    macdSeries.at(-1);

  const previousMacd =
    macdSeries.at(-2);

  const currentSignal =
    signalSeries.at(-1);

  const previousSignal =
    signalSeries.at(-2);

  const histogram =
    currentMacd -
    currentSignal;

  const previousHistogram =
    previousMacd -
    previousSignal;

  let direction = "RANGE";

  if (
    currentMacd >
      currentSignal &&
    currentMacd > 0
  ) {
    direction = "LONG";
  } else if (
    currentMacd <
      currentSignal &&
    currentMacd < 0
  ) {
    direction = "SHORT";
  }

  let crossover = "NONE";

  if (
    previousMacd <=
      previousSignal &&
    currentMacd >
      currentSignal
  ) {
    crossover =
      "BULLISH_CROSS";
  }

  if (
    previousMacd >=
      previousSignal &&
    currentMacd <
      currentSignal
  ) {
    crossover =
      "BEARISH_CROSS";
  }

  return {
    available: true,
    macd: currentMacd,
    signal: currentSignal,
    histogram,
    previousMacd,
    previousSignal,
    previousHistogram,
    direction,
    crossover
  };
}

/* ========================= ATR ========================= */

function atr(candles, period = 14) {
  if (
    !candles ||
    candles.length <
      period + 1
  ) {
    return null;
  }

  const trs = [];

  for (
    let i = 1;
    i < candles.length;
    i++
  ) {
    const c =
      candles[i];

    const p =
      candles[i - 1];

    trs.push(
      Math.max(
        c.high - c.low,
        Math.abs(
          c.high - p.close
        ),
        Math.abs(
          c.low - p.close
        )
      )
    );
  }

  return average(
    trs.slice(-period)
  );
}

/* ========================= KLINES ========================= */

function parseKlines(list) {
  return (list || [])
    .map(x => ({
      time: num(x[0]),
      open: num(x[1]),
      high: num(x[2]),
      low: num(x[3]),
      close: num(x[4]),
      volume: num(x[5]),
      turnover: num(x[6])
    }))
    .filter(
      x =>
        x.close > 0 &&
        x.high >= x.low
    )
    .sort(
      (a, b) =>
        a.time - b.time
    );
}

/* ========================= BYBIT ========================= */

async function bybit(path) {
  const r =
    await fetch(
      BYBIT + path,
      {
        headers: {
          accept:
            "application/json"
        }
      }
    );

  if (!r.ok) {
    throw new Error(
      `Bybit HTTP ${r.status}`
    );
  }

  const d =
    await r.json();

  if (
    d.retCode !== 0
  ) {
    throw new Error(
      d.retMsg ||
      "Bybit API error"
    );
  }

  return d.result || {};
}

/* ========================= INSTRUMENTS ========================= */

async function getInstruments(category) {
  const all = [];

  let cursor = "";

  for (
    let page = 0;
    page < 5;
    page++
  ) {
    let url =
      `/v5/market/instruments-info?category=${category}&limit=1000`;

    if (cursor) {
      url +=
        `&cursor=${encodeURIComponent(cursor)}`;
    }

    const d =
      await bybit(url);

    all.push(
      ...(d.list || [])
    );

    cursor =
      d.nextPageCursor ||
      "";

    if (!cursor) {
      break;
    }
  }

  return all;
}

function validSymbol(x) {
  if (!x) return false;

  if (
    x.status !==
    "Trading"
  ) {
    return false;
  }

  if (
    x.quoteCoin !==
    "USDT"
  ) {
    return false;
  }

  if (
    x.symbol.includes("USDC") ||
    x.symbol.includes("USDE")
  ) {
    return false;
  }

  return true;
}

async function getSymbols() {
  const [
    spot,
    futures
  ] =
    await Promise.all([
      getInstruments("spot"),
      getInstruments("linear")
    ]);

  const map =
    new Map();

  /*
   * Futures اولویت دارد چون OI/Funding/
   * Long-Short فقط روی Futures قابل محاسبه است.
   */
  for (const x of futures) {
    if (!validSymbol(x)) {
      continue;
    }

    map.set(
      x.symbol,
      {
        symbol: x.symbol,
        category: "linear",
        baseCoin: x.baseCoin,
        quoteCoin: x.quoteCoin
      }
    );
  }

  for (const x of spot) {
    if (!validSymbol(x)) {
      continue;
    }

    if (!map.has(x.symbol)) {
      map.set(
        x.symbol,
        {
          symbol: x.symbol,
          category: "spot",
          baseCoin: x.baseCoin,
          quoteCoin: x.quoteCoin
        }
      );
    }
  }

  return [
    ...map.values()
  ];
}

/* ========================= TICKER ========================= */

async function getTicker(
  category,
  symbol
) {
  const d =
    await bybit(
      `/v5/market/tickers?category=${category}&symbol=${encodeURIComponent(symbol)}`
    );

  return (
    d.list?.[0] ||
    null
  );
}

/* ========================= KLINES ========================= */

async function getKlines(
  category,
  symbol,
  interval,
  limit
) {
  const d =
    await bybit(
      `/v5/market/kline?category=${category}&symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`
    );

  return parseKlines(
    d.list
  );
}

/* ========================= RECENT TRADES ========================= */

async function getRecentTrades(
  category,
  symbol
) {
  const d =
    await bybit(
      `/v5/market/recent-trade?category=${category}&symbol=${encodeURIComponent(symbol)}&limit=${TRADE_LIMIT}`
    );

  return (
    d.list || []
  ).map(t => ({
    execId:
      t.execId || "",

    price:
      num(t.price),

    size:
      num(t.size),

    side:
      String(
        t.side || ""
      ).toUpperCase(),

    time:
      num(t.time),

    isBlockTrade:
      Boolean(
        t.isBlockTrade
      )
  }));
}

/* ========================= ORDERBOOK ========================= */

async function getOrderbook(
  category,
  symbol
) {
  return bybit(
    `/v5/market/orderbook?category=${category}&symbol=${encodeURIComponent(symbol)}&limit=${ORDERBOOK_LIMIT}`
  );
}

/* ========================= OI ========================= */

async function getOIHistory(symbol) {
  return bybit(
    `/v5/market/open-interest?category=linear&symbol=${encodeURIComponent(symbol)}&intervalTime=5min&limit=200`
  );
}

/* ========================= FUNDING ========================= */

async function getFundingHistory(symbol) {
  return bybit(
    `/v5/market/funding/history?category=linear&symbol=${encodeURIComponent(symbol)}&limit=200`
  );
}

/* ========================= LONG SHORT ========================= */

async function getLongShort(symbol) {
  return bybit(
    `/v5/market/account-ratio?category=linear&symbol=${encodeURIComponent(symbol)}&period=5min&limit=200`
  );
}

/* ========================= FOOTPRINT ========================= */

function analyzeFootprint(trades) {
  if (
    !trades ||
    !trades.length
  ) {
    return {
      available: false,
      reason:
        "معاملات واقعی Bybit دریافت نشد."
    };
  }

  let buyVolume = 0;
  let sellVolume = 0;

  let buyNotional = 0;
  let sellNotional = 0;

  let buyTrades = 0;
  let sellTrades = 0;

  let largeBuyVolume = 0;
  let largeSellVolume = 0;

  let blockBuyVolume = 0;
  let blockSellVolume = 0;

  const notionals =
    trades
      .map(
        t =>
          t.price *
          t.size
      )
      .filter(
        x => x > 0
      )
      .sort(
        (a, b) =>
          a - b
      );

  const p95 =
    notionals.length
      ? notionals[
          Math.min(
            notionals.length - 1,
            Math.floor(
              notionals.length *
              0.95
            )
          )
        ]
      : 0;

  const averageNotional =
    notionals.length
      ? average(
          notionals
        )
      : 0;

  const largeThreshold =
    Math.max(
      averageNotional * 5,
      p95
    );

  for (const t of trades) {
    const n =
      t.price *
      t.size;

    if (
      t.side === "BUY"
    ) {
      buyVolume +=
        t.size;

      buyNotional += n;

      buyTrades++;

      if (
        n >=
        largeThreshold
      ) {
        largeBuyVolume +=
          t.size;
      }

      if (
        t.isBlockTrade
      ) {
        blockBuyVolume +=
          t.size;
      }
    }

    if (
      t.side === "SELL"
    ) {
      sellVolume +=
        t.size;

      sellNotional += n;

      sellTrades++;

      if (
        n >=
        largeThreshold
      ) {
        largeSellVolume +=
          t.size;
      }

      if (
        t.isBlockTrade
      ) {
        blockSellVolume +=
          t.size;
      }
    }
  }

  const totalVolume =
    buyVolume +
    sellVolume;

  const delta =
    buyVolume -
    sellVolume;

  const deltaPercent =
    totalVolume
      ? (
          delta /
          totalVolume
        ) * 100
      : 0;

  const totalNotional =
    buyNotional +
    sellNotional;

  const buyShare =
    totalNotional
      ? (
          buyNotional /
          totalNotional
        ) * 100
      : 0;

  const sellShare =
    totalNotional
      ? (
          sellNotional /
          totalNotional
        ) * 100
      : 0;

  let pressure =
    "NEUTRAL";

  if (
    deltaPercent >= 10
  ) {
    pressure =
      "BUY_PRESSURE";
  } else if (
    deltaPercent <= -10
  ) {
    pressure =
      "SELL_PRESSURE";
  }

  return {
    available: true,

    trades:
      trades.length,

    buyVolume,
    sellVolume,
    totalVolume,

    delta,
    deltaPercent,

    buyNotional,
    sellNotional,

    buyNotionalShare:
      buyShare,

    sellNotionalShare:
      sellShare,

    buyTrades,
    sellTrades,

    largeTradeThreshold:
      largeThreshold,

    largeBuyVolume,
    largeSellVolume,

    blockBuyVolume,
    blockSellVolume,

    largeDelta:
      largeBuyVolume -
      largeSellVolume,

    blockDelta:
      blockBuyVolume -
      blockSellVolume,

    pressure
  };
}

/* ========================= ORDERBOOK ========================= */

function analyzeOrderbook(
  book,
  currentPrice
) {
  if (
    !book ||
    (
      !book.b?.length &&
      !book.a?.length
    )
  ) {
    return {
      available: false,
      reason:
        "Order Book دریافت نشد."
    };
  }

  const bids =
    (book.b || [])
      .map(x => {
        const price =
          num(x[0]);

        const size =
          num(x[1]);

        return {
          price,
          size,
          notional:
            price * size,
          distancePct:
            currentPrice
              ? Math.abs(
                  (
                    price -
                    currentPrice
                  ) /
                  currentPrice
                ) * 100
              : 0
        };
      })
      .filter(
        x =>
          x.price > 0 &&
          x.size > 0
      );

  const asks =
    (book.a || [])
      .map(x => {
        const price =
          num(x[0]);

        const size =
          num(x[1]);

        return {
          price,
          size,
          notional:
            price * size,
          distancePct:
            currentPrice
              ? Math.abs(
                  (
                    price -
                    currentPrice
                  ) /
                  currentPrice
                ) * 100
              : 0
        };
      })
      .filter(
        x =>
          x.price > 0 &&
          x.size > 0
      );

  const buyLiquidity =
    bids.reduce(
      (s, x) =>
        s + x.notional,
      0
    );

  const sellLiquidity =
    asks.reduce(
      (s, x) =>
        s + x.notional,
      0
    );

  const allNotional =
    [
      ...bids,
      ...asks
    ]
      .map(
        x => x.notional
      )
      .filter(
        x => x > 0
      )
      .sort(
        (a, b) =>
          a - b
      );

  const median =
    allNotional.length
      ? allNotional[
          Math.floor(
            allNotional.length /
            2
          )
        ]
      : 0;

  /*
   * 4x median به جای 5x
   * تا دیوارهای واقعی بیشتری
   * شناسایی شوند.
   */
  const wallThreshold =
    median * 4;

  const buyWalls =
    bids
      .filter(
        x =>
          wallThreshold > 0 &&
          x.notional >=
            wallThreshold
      )
      .sort(
        (a, b) =>
          b.notional -
          a.notional
      );

  const sellWalls =
    asks
      .filter(
        x =>
          wallThreshold > 0 &&
          x.notional >=
            wallThreshold
      )
      .sort(
        (a, b) =>
          b.notional -
          a.notional
      );

  const totalLiquidity =
    buyLiquidity +
    sellLiquidity;

  const buyShare =
    totalLiquidity
      ? (
          buyLiquidity /
          totalLiquidity
        ) * 100
      : 0;

  const sellShare =
    totalLiquidity
      ? (
          sellLiquidity /
          totalLiquidity
        ) * 100
      : 0;

  const bestBid =
    bids
      .slice()
      .sort(
        (a, b) =>
          b.price -
          a.price
      )[0] ||
    null;

  const bestAsk =
    asks
      .slice()
      .sort(
        (a, b) =>
          a.price -
          b.price
      )[0] ||
    null;

  let pressure =
    "NEUTRAL";

  if (
    buyShare >
    sellShare + 8
  ) {
    pressure =
      "BUY_PRESSURE";
  } else if (
    sellShare >
    buyShare + 8
  ) {
    pressure =
      "SELL_PRESSURE";
  }

  return {
    available: true,

    buyLiquidity,
    sellLiquidity,
    totalLiquidity,

    buyShare,
    sellShare,

    pressure,

    bestBid,
    bestAsk,

    wallThreshold,

    buyWalls:
      buyWalls.slice(0, 20),

    sellWalls:
      sellWalls.slice(0, 20),

    buyLevels:
      bids
        .sort(
          (a, b) =>
            b.price -
            a.price
        )
        .slice(0, 25),

    sellLevels:
      asks
        .sort(
          (a, b) =>
            a.price -
            b.price
        )
        .slice(0, 25)
  };
}

/* ========================= PIVOTS ========================= */

function pivotHigh(
  candles,
  i,
  left = 2,
  right = 2
) {
  if (
    i - left < 0 ||
    i + right >=
      candles.length
  ) {
    return false;
  }

  const h =
    candles[i].high;

  for (
    let j = 1;
    j <= left;
    j++
  ) {
    if (
      candles[i - j].high >= h
    ) {
      return false;
    }
  }

  for (
    let j = 1;
    j <= right;
    j++
  ) {
    if (
      candles[i + j].high > h
    ) {
      return false;
    }
  }

  return true;
}

function pivotLow(
  candles,
  i,
  left = 2,
  right = 2
) {
  if (
    i - left < 0 ||
    i + right >=
      candles.length
  ) {
    return false;
  }

  const l =
    candles[i].low;

  for (
    let j = 1;
    j <= left;
    j++
  ) {
    if (
      candles[i - j].low <= l
    ) {
      return false;
    }
  }

  for (
    let j = 1;
    j <= right;
    j++
  ) {
    if (
      candles[i + j].low < l
    ) {
      return false;
    }
  }

  return true;
}

/* ========================= SUPPORT / RESISTANCE ========================= */

function supportResistance(
  candles,
  price,
  orderbook = null,
  footprint = null
) {
  if (
    !candles ||
    candles.length < 20
  ) {
    return {
      available: false,
      support: [],
      resistance: []
    };
  }

  const highs = [];
  const lows = [];

  for (
    let i = 3;
    i <
      candles.length - 3;
    i++
  ) {
    if (
      pivotHigh(
        candles,
        i,
        3,
        3
      )
    ) {
      highs.push({
        price:
          candles[i].high,
        time:
          candles[i].time,
        volume:
          candles[i].volume
      });
    }

    if (
      pivotLow(
        candles,
        i,
        3,
        3
      )
    ) {
      lows.push({
        price:
          candles[i].low,
        time:
          candles[i].time,
        volume:
          candles[i].volume
      });
    }
  }

  const tolerance =
    price * 0.0015;

  function mergeLevels(levels) {
    const sorted =
      levels
        .slice()
        .sort(
          (a, b) =>
            a.price -
            b.price
        );

    const groups = [];

    for (
      const level of sorted
    ) {
      const existing =
        groups.find(
          g =>
            Math.abs(
              g.price -
              level.price
            ) <=
            tolerance
        );

      if (existing) {
        existing.prices.push(
          level.price
        );

        existing.times.push(
          level.time
        );

        existing.volumes.push(
          level.volume
        );
      } else {
        groups.push({
          price:
            level.price,

          prices: [
            level.price
          ],

          times: [
            level.time
          ],

          volumes: [
            level.volume
          ]
        });
      }
    }

    return groups.map(g => ({
      price:
        average(
          g.prices
        ),

      touches:
        g.prices.length,

      volume:
        average(
          g.volumes
        ),

      time:
        Math.max(
          ...g.times
        )
    }));
  }

  const resistance =
    mergeLevels(
      highs.filter(
        x =>
          x.price >
          price
      )
    )
      .sort(
        (a, b) =>
          a.price -
          b.price
      )
      .slice(0, 10);

  const support =
    mergeLevels(
      lows.filter(
        x =>
          x.price <
          price
      )
    )
      .sort(
        (a, b) =>
          b.price -
          a.price
      )
      .slice(0, 10);

  function enrich(
    level,
    side
  ) {
    const wallSource =
      side === "SUPPORT"
        ? (
            orderbook
              ?.buyWalls ||
            []
          )
        : (
            orderbook
              ?.sellWalls ||
            []
          );

    const nearbyWall =
      wallSource
        .filter(
          w =>
            Math.abs(
              w.price -
              level.price
            ) <=
            tolerance
        )
        .sort(
          (a, b) =>
            b.notional -
            a.notional
        )[0] ||
      null;

    let buyerSeller =
      side === "SUPPORT"
        ? "BUYER"
        : "SELLER";

    let strength =
      30 +
      level.touches * 15 +
      (
        nearbyWall
          ? 30
          : 0
      );

    if (
      footprint?.available
    ) {
      if (
        footprint.deltaPercent >
          10 &&
        side === "SUPPORT"
      ) {
        buyerSeller =
          "BUYER";

        strength += 10;
      }

      if (
        footprint.deltaPercent <
          -10 &&
        side === "RESISTANCE"
      ) {
        buyerSeller =
          "SELLER";

        strength += 10;
      }
    }

    return {
      ...level,

      side,

      strength:
        Math.round(
          clamp(strength)
        ),

      buyerSeller,

      wall:
        nearbyWall
    };
  }

  return {
    available: true,

    support:
      support.map(
        x =>
          enrich(
            x,
            "SUPPORT"
          )
      ),

    resistance:
      resistance.map(
        x =>
          enrich(
            x,
            "RESISTANCE"
          )
      )
  };
}

/* ========================= LIQUIDITY SWEEP ========================= */

function detectLiquiditySweep(
  candles
) {
  if (
    !candles ||
    candles.length < 15
  ) {
    return {
      available: false,
      confirmed: false,
      side: "NONE"
    };
  }

  const current =
    candles.at(-1);

  const previous =
    candles.slice(-8, -1);

  const priorHigh =
    Math.max(
      ...previous.map(
        x => x.high
      )
    );

  const priorLow =
    Math.min(
      ...previous.map(
        x => x.low
      )
    );

  const range =
    Math.max(
      priorHigh -
        priorLow,
      current.close *
        0.000001
    );

  const upperWick =
    current.high -
    Math.max(
      current.open,
      current.close
    );

  const lowerWick =
    Math.min(
      current.open,
      current.close
    ) -
    current.low;

  const sweptHigh =
    current.high >
      priorHigh &&
    current.close <
      priorHigh;

  const sweptLow =
    current.low <
      priorLow &&
    current.close >
      priorLow;

  if (sweptHigh) {
    return {
      available: true,
      confirmed: true,
      side: "SHORT",
      type:
        "HIGH_SWEEP",
      sweepPrice:
        current.high,
      reference:
        priorHigh,
      distancePct:
        Math.abs(
          pct(
            current.high,
            priorHigh
          )
        ),
      wickStrength:
        clamp(
          (
            upperWick /
            range
          ) * 100
        )
    };
  }

  if (sweptLow) {
    return {
      available: true,
      confirmed: true,
      side: "LONG",
      type:
        "LOW_SWEEP",
      sweepPrice:
        current.low,
      reference:
        priorLow,
      distancePct:
        Math.abs(
          pct(
            current.low,
            priorLow
          )
        ),
      wickStrength:
        clamp(
          (
            lowerWick /
            range
          ) * 100
        )
    };
  }

  return {
    available: true,
    confirmed: false,
    side: "NONE",
    type: "NONE",
    sweepPrice: 0,
    reference: 0,
    distancePct: 0,
    wickStrength: 0
  };
}

/* ========================= BOS / CHOCH ========================= */

function detectStructure(
  candles
) {
  if (
    !candles ||
    candles.length < 20
  ) {
    return {
      available: false,
      bos: "NONE",
      choch: "NONE"
    };
  }

  const highs = [];
  const lows = [];

  for (
    let i = 3;
    i <
      candles.length - 3;
    i++
  ) {
    if (
      pivotHigh(
        candles,
        i,
        3,
        3
      )
    ) {
      highs.push({
        index: i,
        price:
          candles[i].high
      });
    }

    if (
      pivotLow(
        candles,
        i,
        3,
        3
      )
    ) {
      lows.push({
        index: i,
        price:
          candles[i].low
      });
    }
  }

  if (
    !highs.length ||
    !lows.length
  ) {
    return {
      available: true,
      bos: "NONE",
      choch: "NONE"
    };
  }

  const last =
    candles.at(-1);

  const previousHigh =
    highs.at(-1);

  const previousLow =
    lows.at(-1);

  let bos = "NONE";
  let choch = "NONE";

  if (
    last.close >
    previousHigh.price
  ) {
    bos = "BULLISH";
  } else if (
    last.close <
    previousLow.price
  ) {
    bos = "BEARISH";
  }

  const recentHighs =
    highs.slice(-3);

  const recentLows =
    lows.slice(-3);

  if (
    recentHighs.length >= 2 &&
    recentLows.length >= 2
  ) {
    const h1 =
      recentHighs[
        recentHighs.length - 2
      ].price;

    const h2 =
      recentHighs[
        recentHighs.length - 1
      ].price;

    const l1 =
      recentLows[
        recentLows.length - 2
      ].price;

    const l2 =
      recentLows[
        recentLows.length - 1
      ].price;

    if (
      h2 > h1 &&
      l2 > l1 &&
      last.close < l1
    ) {
      choch =
        "BEARISH";
    }

    if (
      h2 < h1 &&
      l2 < l1 &&
      last.close > h2
    ) {
      choch =
        "BULLISH";
    }
  }

  return {
    available: true,
    bos,
    choch,

    lastSwingHigh:
      previousHigh.price,

    lastSwingLow:
      previousLow.price
  };
}

/* ========================= FVG ========================= */

function detectFVG(
  candles
) {
  if (
    !candles ||
    candles.length < 5
  ) {
    return {
      available: false,
      bullish: [],
      bearish: []
    };
  }

  const bullish = [];
  const bearish = [];

  for (
    let i = 2;
    i < candles.length;
    i++
  ) {
    const a =
      candles[i - 2];

    const b =
      candles[i - 1];

    const c =
      candles[i];

    if (
      c.low >
      a.high
    ) {
      bullish.push({
        type:
          "BULLISH_FVG",

        low:
          a.high,

        high:
          c.low,

        midpoint:
          (
            a.high +
            c.low
          ) / 2,

        time:
          b.time,

        sizePct:
          pct(
            c.low,
            a.high
          )
      });
    }

    if (
      c.high <
      a.low
    ) {
      bearish.push({
        type:
          "BEARISH_FVG",

        low:
          c.high,

        high:
          a.low,

        midpoint:
          (
            c.high +
            a.low
          ) / 2,

        time:
          b.time,

        sizePct:
          pct(
            a.low,
            c.high
          )
      });
    }
  }

  return {
    available: true,

    bullish:
      bullish.slice(-10),

    bearish:
      bearish.slice(-10),

    latestBullish:
      bullish.at(-1) ||
      null,

    latestBearish:
      bearish.at(-1) ||
      null
  };
}

/* ========================= ORDER BLOCK ========================= */

function detectOrderBlocks(
  candles
) {
  if (
    !candles ||
    candles.length < 20
  ) {
    return {
      available: false,
      bullish: [],
      bearish: []
    };
  }

  const bullish = [];
  const bearish = [];

  for (
    let i = 3;
    i <
      candles.length - 2;
    i++
  ) {
    const c =
      candles[i];

    const next =
      candles[i + 1];

    const next2 =
      candles[i + 2];

    const body =
      Math.abs(
        c.close -
        c.open
      );

    const range =
      Math.max(
        c.high -
          c.low,
        0.0000000001
      );

    const bodyRatio =
      body / range;

    if (
      c.close <
        c.open &&
      next.close >
        c.high &&
      next2.close >=
        next.open
    ) {
      bullish.push({
        type:
          "BULLISH_ORDER_BLOCK",

        low:
          c.low,

        high:
          c.high,

        midpoint:
          (
            c.low +
            c.high
          ) / 2,

        time:
          c.time,

        volume:
          c.volume,

        bodyRatio
      });
    }

    if (
      c.close >
        c.open &&
      next.close <
        c.low &&
      next2.close <=
        next.open
    ) {
      bearish.push({
        type:
          "BEARISH_ORDER_BLOCK",

        low:
          c.low,

        high:
          c.high,

        midpoint:
          (
            c.low +
            c.high
          ) / 2,

        time:
          c.time,

        volume:
          c.volume,

        bodyRatio
      });
    }
  }

  return {
    available: true,

    bullish:
      bullish.slice(-10),

    bearish:
      bearish.slice(-10),

    latestBullish:
      bullish.at(-1) ||
      null,

    latestBearish:
      bearish.at(-1) ||
      null
  };
}

/* ========================= CISD ========================= */

function detectCISD(
  candles
) {
  if (
    !candles ||
    candles.length < 12
  ) {
    return {
      available: false,
      confirmed: false,
      direction: "NONE"
    };
  }

  const current =
    candles.at(-1);

  const previous =
    candles.at(-2);

  const recent =
    candles.slice(-8, -1);

  const recentHigh =
    Math.max(
      ...recent.map(
        x => x.high
      )
    );

  const recentLow =
    Math.min(
      ...recent.map(
        x => x.low
      )
    );

  if (
    current.close >
      recentHigh &&
    current.close >
      previous.close
  ) {
    return {
      available: true,
      confirmed: true,
      direction: "LONG",
      type:
        "BULLISH_CISD",
      level:
        recentHigh
    };
  }

  if (
    current.close <
      recentLow &&
    current.close <
      previous.close
  ) {
    return {
      available: true,
      confirmed: true,
      direction: "SHORT",
      type:
        "BEARISH_CISD",
      level:
        recentLow
    };
  }

  return {
    available: true,
    confirmed: false,
    direction: "NONE",
    type: "NONE",
    level: 0
  };
}

/* ========================= DIVERGENCE ========================= */

function findPivotIndexes(
  candles,
  type
) {
  const indexes = [];

  for (
    let i = 4;
    i <
      candles.length - 4;
    i++
  ) {
    if (
      type === "HIGH" &&
      pivotHigh(
        candles,
        i,
        3,
        3
      )
    ) {
      indexes.push(i);
    }

    if (
      type === "LOW" &&
      pivotLow(
        candles,
        i,
        3,
        3
      )
    ) {
      indexes.push(i);
    }
  }

  return indexes;
}

function divergence(
  candles
) {
  if (
    !candles ||
    candles.length < 50
  ) {
    return {
      available: false,
      type: "NONE",
      side: "NONE"
    };
  }

  const closes =
    candles.map(
      x => x.close
    );

  const rsiValues = [];

  for (
    let i = 15;
    i < closes.length;
    i++
  ) {
    rsiValues.push({
      index: i,
      value:
        rsi(
          closes.slice(
            0,
            i + 1
          ),
          14
        )
    });
  }

  const validRsi =
    new Map(
      rsiValues.map(
        x => [
          x.index,
          x.value
        ]
      )
    );

  const highs =
    findPivotIndexes(
      candles,
      "HIGH"
    );

  const lows =
    findPivotIndexes(
      candles,
      "LOW"
    );

  if (
    highs.length >= 2
  ) {
    const i1 =
      highs.at(-2);

    const i2 =
      highs.at(-1);

    const r1 =
      validRsi.get(i1);

    const r2 =
      validRsi.get(i2);

    if (
      r1 != null &&
      r2 != null &&
      candles[i2].high >
        candles[i1].high &&
      r2 < r1
    ) {
      return {
        available: true,

        type:
          "BEARISH_DIVERGENCE",

        side:
          "SHORT",

        priceFirst:
          candles[i1].high,

        priceSecond:
          candles[i2].high,

        rsiFirst:
          r1,

        rsiSecond:
          r2
      };
    }
  }

  if (
    lows.length >= 2
  ) {
    const i1 =
      lows.at(-2);

    const i2 =
      lows.at(-1);

    const r1 =
      validRsi.get(i1);

    const r2 =
      validRsi.get(i2);

    if (
      r1 != null &&
      r2 != null &&
      candles[i2].low <
        candles[i1].low &&
      r2 > r1
    ) {
      return {
        available: true,

        type:
          "BULLISH_DIVERGENCE",

        side:
          "LONG",

        priceFirst:
          candles[i1].low,

        priceSecond:
          candles[i2].low,

        rsiFirst:
          r1,

        rsiSecond:
          r2
      };
    }
  }

  return {
    available: true,
    type: "NONE",
    side: "NONE"
  };
}

/* ========================= ICHIMOKU ========================= */

function ichimoku(
  candles
) {
  if (
    candles.length < 52
  ) {
    return {
      available: false
    };
  }

  const highest =
    arr =>
      Math.max(
        ...arr.map(
          x => x.high
        )
      );

  const lowest =
    arr =>
      Math.min(
        ...arr.map(
          x => x.low
        )
      );

  const last =
    candles.length - 1;

  const tenkan =
    (
      highest(
        candles.slice(
          last - 8,
          last + 1
        )
      ) +
      lowest(
        candles.slice(
          last - 8,
          last + 1
        )
      )
    ) / 2;

  const kijun =
    (
      highest(
        candles.slice(
          last - 25,
          last + 1
        )
      ) +
      lowest(
        candles.slice(
          last - 25,
          last + 1
        )
      )
    ) / 2;

  const spanA =
    (
      tenkan +
      kijun
    ) / 2;

  const spanB =
    (
      highest(
        candles.slice(
          last - 51,
          last + 1
        )
      ) +
      lowest(
        candles.slice(
          last - 51,
          last + 1
        )
      )
    ) / 2;

  const price =
    candles[last].close;

  let direction =
    "RANGE";

  if (
    price > spanA &&
    price > spanB &&
    tenkan > kijun
  ) {
    direction =
      "LONG";
  } else if (
    price < spanA &&
    price < spanB &&
    tenkan < kijun
  ) {
    direction =
      "SHORT";
  }

  return {
    available: true,
    tenkan,
    kijun,
    spanA,
    spanB,
    price,
    direction
  };
}

/* ========================= BOLLINGER ========================= */

function bollinger(
  closes,
  period = 20,
  mult = 2
) {
  if (
    closes.length < period
  ) {
    return {
      available: false
    };
  }

  const values =
    closes.slice(-period);

  const middle =
    average(values);

  const sd =
    stddev(values);

  const upper =
    middle +
    mult * sd;

  const lower =
    middle -
    mult * sd;

  const width =
    middle
      ? (
          (
            upper -
            lower
          ) /
          middle
        ) * 100
      : 0;

  const price =
    closes.at(-1);

  let position =
    "MIDDLE";

  if (
    price >= upper
  ) {
    position =
      "UPPER";
  } else if (
    price <= lower
  ) {
    position =
      "LOWER";
  }

  return {
    available: true,
    middle,
    upper,
    lower,
    width,
    position
  };
}

/* ========================= TREND ========================= */

function trendState(
  candles
) {
  if (
    !candles ||
    candles.length < 60
  ) {
    return {
      available: false,
      direction: "RANGE",
      reasons: []
    };
  }

  const closes =
    candles.map(
      x => x.close
    );

  const ma7 =
    sma(closes, 7);

  const ma20 =
    sma(closes, 20);

  const prevMa20 =
    sma(
      closes.slice(0, -1),
      20
    );

  const ma50 =
    sma(closes, 50);

  const slope =
    pct(
      ma20,
      prevMa20
    );

  const reasons = [];

  let direction =
    "RANGE";

  if (
    ma7 > ma20 &&
    ma20 > ma50 &&
    closes.at(-1) >
      ma20 &&
    slope > 0
  ) {
    direction =
      "LONG";

    reasons.push(
      "MA7 بالای MA20 و MA20 بالای MA50 است."
    );

    reasons.push(
      "قیمت بالای MA20 قرار دارد."
    );

    reasons.push(
      "شیب MA20 مثبت است."
    );
  } else if (
    ma7 < ma20 &&
    ma20 < ma50 &&
    closes.at(-1) <
      ma20 &&
    slope < 0
  ) {
    direction =
      "SHORT";

    reasons.push(
      "MA7 زیر MA20 و MA20 زیر MA50 است."
    );

    reasons.push(
      "قیمت زیر MA20 قرار دارد."
    );

    reasons.push(
      "شیب MA20 منفی است."
    );
  } else {
    reasons.push(
      "چیدمان میانگین‌ها روند یک‌طرفه کافی نشان نمی‌دهد."
    );
  }

  return {
    available: true,

    direction,

    ma7,
    ma20,
    ma50,

    slopePct:
      slope,

    reasons
  };
}

/* ========================= 1M ========================= */

function analyze1m(
  candles
) {
  if (
    !candles ||
    candles.length < 60
  ) {
    return {
      available: false,
      reason:
        "کندل کافی برای تحلیل 1m وجود ندارد."
    };
  }

  const closes =
    candles.map(
      x => x.close
    );

  const current =
    candles.at(-1);

  const previous =
    candles.at(-2);

  const ma7 =
    sma(closes, 7);

  const ma20 =
    sma(closes, 20);

  const prevMa20 =
    sma(
      closes.slice(0, -1),
      20
    );

  const ma50 =
    sma(closes, 50);

  const slope =
    ma20 -
    prevMa20;

  const slopePct =
    pct(
      ma20,
      prevMa20
    );

  const distancePct =
    pct(
      current.close,
      ma20
    );

  const touched =
    current.low <= ma20 &&
    current.high >= ma20;

  const near =
    Math.abs(
      distancePct
    ) <= 0.30;

  const crossUp =
    previous.close <
      prevMa20 &&
    current.close >=
      ma20;

  const crossDown =
    previous.close >
      prevMa20 &&
    current.close <=
      ma20;

  const rejectionUp =
    current.low <=
      ma20 &&
    current.close >
      ma20;

  const rejectionDown =
    current.high >=
      ma20 &&
    current.close <
      ma20;

  let direction =
    "RANGE";

  if (
    rejectionUp ||
    crossUp
  ) {
    direction =
      "LONG";
  } else if (
    rejectionDown ||
    crossDown
  ) {
    direction =
      "SHORT";
  }

  const volumeAverage =
    average(
      candles
        .slice(-21, -1)
        .map(
          x => x.volume
        )
    );

  const volumeRatio =
    volumeAverage
      ? current.volume /
        volumeAverage
      : 0;

  const rsiValue =
    rsi(
      closes,
      14
    );

  const macdValue =
    macd(closes);

  const atrValue =
    atr(
      candles,
      14
    );

  const bb =
    bollinger(
      closes
    );

  const div =
    divergence(
      candles
    );

  const ichi =
    ichimoku(
      candles
    );

  const sweep =
    detectLiquiditySweep(
      candles
    );

  const structure =
    detectStructure(
      candles
    );

  const fvg =
    detectFVG(
      candles
    );

  const orderBlocks =
    detectOrderBlocks(
      candles
    );

  const cisd =
    detectCISD(
      candles
    );

  const trend =
    trendState(
      candles
    );

  let marketStyle =
    "RANGE";

  if (
    trend.direction ===
    "LONG"
  ) {
    marketStyle =
      "BULLISH";
  } else if (
    trend.direction ===
    "SHORT"
  ) {
    marketStyle =
      "BEARISH";
  }

  return {
    available: true,

    price:
      current.close,

    ma7,
    ma20,
    ma50,

    previousMA20:
      prevMa20,

    slope,
    slopePct,

    distancePct,

    touched,
    near,

    crossUp,
    crossDown,

    rejectionUp,
    rejectionDown,

    direction,

    volume:
      current.volume,

    averageVolume:
      volumeAverage,

    volumeRatio,

    volumeSpike:
      volumeRatio >= 1.5,

    rsi:
      rsiValue,

    macd:
      macdValue,

    atr:
      atrValue,

    atrPct:
      current.close &&
      atrValue
        ? (
            atrValue /
            current.close
          ) * 100
        : 0,

    bollinger:
      bb,

    ichimoku:
      ichi,

    divergence:
      div,

    liquiditySweep:
      sweep,

    structure:
      structure,

    fvg:
      fvg,

    orderBlocks:
      orderBlocks,

    cisd:
      cisd,

    trend,

    supportResistance:
      null,

    marketStyle
  };
}

/* ========================= 15M ========================= */

function analyze15m(
  candles
) {
  if (
    !candles ||
    candles.length < 60
  ) {
    return {
      available: false,
      reason:
        "کندل کافی برای تحلیل 15m وجود ندارد."
    };
  }

  const closes =
    candles.map(
      x => x.close
    );

  const current =
    closes.at(-1);

  const ma7 =
    sma(closes, 7);

  const ma20 =
    sma(closes, 20);

  const prevMa20 =
    sma(
      closes.slice(0, -1),
      20
    );

  const ma50 =
    sma(closes, 50);

  const slope =
    pct(
      ma20,
      prevMa20
    );

  const trend =
    trendState(
      candles
    );

  let direction =
    "RANGE";

  if (
    current > ma20 &&
    ma7 > ma20 &&
    ma20 > ma50 &&
    slope > 0
  ) {
    direction =
      "LONG";
  } else if (
    current < ma20 &&
    ma7 < ma20 &&
    ma20 < ma50 &&
    slope < 0
  ) {
    direction =
      "SHORT";
  }

  return {
    available: true,

    price:
      current,

    ma7,
    ma20,
    ma50,

    previousMA20:
      prevMa20,

    slope,
    slopePct:

      slope,

    direction,

    rsi:
      rsi(
        closes,
        14
      ),

    macd:
      macd(closes),

    atr:
      atr(
        candles,
        14
      ),

    bollinger:
      bollinger(
        closes
      ),

    ichimoku:
      ichimoku(
        candles
      ),

    divergence:
      divergence(
        candles
      ),

    structure:
      detectStructure(
        candles
      ),

    fvg:
      detectFVG(
        candles
      ),

    orderBlocks:
      detectOrderBlocks(
        candles
      ),

    cisd:
      detectCISD(
        candles
      ),

    trend,

    marketStyle:
      direction === "LONG"
        ? "BULLISH"
        : direction ===
            "SHORT"
          ? "BEARISH"
          : "RANGE"
  };
}

/* ========================= OI ========================= */

function analyzeOI(
  history
) {
  const list =
    history?.list || [];

  if (!list.length) {
    return {
      available: false,
      reason:
        "OI فقط برای Futures قابل دریافت است."
    };
  }

  const sorted =
    list
      .map(x => ({
        timestamp:
          num(
            x.timestamp
          ),

        openInterest:
          num(
            x.openInterest
          )
      }))
      .filter(
        x =>
          x.timestamp > 0
      )
      .sort(
        (a, b) =>
          a.timestamp -
          b.timestamp
      );

  if (!sorted.length) {
    return {
      available: false,
      reason:
        "داده معتبر OI دریافت نشد."
    };
  }

  const latest =
    sorted.at(-1);

  function changeFromMinutes(
    minutes
  ) {
    const target =
      latest.timestamp -
      minutes *
        60 *
        1000;

    let previous =
      sorted
        .filter(
          x =>
            x.timestamp <=
            target
        )
        .at(-1);

    if (!previous) {
      previous =
        sorted[0];
    }

    if (!previous) {
      return {
        change: 0,
        changePct: 0,
        previousTimestamp: 0
      };
    }

    return {
      change:
        latest.openInterest -
        previous.openInterest,

      changePct:
        pct(
          latest.openInterest,
          previous.openInterest
        ),

      previousTimestamp:
        previous.timestamp
    };
  }

  /*
   * Endpoint فعلی Bybit روی 5min است.
   * بنابراین OI یک دقیقه‌ای جعلی تولید نمی‌کنیم.
   */
  const c5 =
    changeFromMinutes(5);

  const c15 =
    changeFromMinutes(15);

  const c60 =
    changeFromMinutes(60);

  let direction =
    "RANGE";

  if (
    c15.changePct > 0 &&
    c5.changePct > 0
  ) {
    direction =
      "RISING";
  } else if (
    c15.changePct < 0 &&
    c5.changePct < 0
  ) {
    direction =
      "FALLING";
  }

  return {
    available: true,

    current:
      latest.openInterest,

    change1m:
      null,

    change1mPct:
      null,

    change5m:
      c5.change,

    change5mPct:
      c5.changePct,

    change15m:
      c15.change,

    change15mPct:
      c15.changePct,

    change1h:
      c60.change,

    change1hPct:
      c60.changePct,

    direction,

    latestTimestamp:
      latest.timestamp,

    history:
      sorted.slice(-50)
  };
}

/* ========================= FUNDING ========================= */

function analyzeFunding(
  history,
  ticker
) {
  const list =
    history?.list || [];

  const tickerFunding =
    ticker?.fundingRate;

  const current =
    tickerFunding !==
      undefined
      ? num(
          tickerFunding
        )
      : null;

  if (
    !list.length &&
    current === null
  ) {
    return {
      available: false,
      reason:
        "Funding برای این بازار در دسترس نیست."
    };
  }

  const rates =
    list
      .map(x => ({
        timestamp:
          num(
            x.fundingRateTimestamp
          ),

        rate:
          num(
            x.fundingRate
          )
      }))
      .sort(
        (a, b) =>
          a.timestamp -
          b.timestamp
      );

  const lastHistory =
    rates.at(-1)?.rate;

  const actual =
    current !== null
      ? current
      : lastHistory;

  const previous =
    rates.length >= 2
      ? rates[
          rates.length - 2
        ].rate
      : null;

  let pressure =
    "NEUTRAL";

  if (
    actual > 0
  ) {
    pressure =
      "LONG_PAYS_SHORT";
  } else if (
    actual < 0
  ) {
    pressure =
      "SHORT_PAYS_LONG";
  }

  return {
    available: true,

    current:
      actual,

    previous,

    change:
      previous == null
        ? null
        : actual -
          previous,

    changePct:
      previous == null ||
      previous === 0
        ? null
        : (
            (
              actual -
              previous
            ) /
            Math.abs(
              previous
            )
          ) * 100,

    pressure,

    history:
      rates.slice(-50)
  };
}

/* ========================= LONG SHORT ========================= */

function analyzeLongShort(
  data
) {
  const list =
    data?.list || [];

  if (!list.length) {
    return {
      available: false
    };
  }

  const sorted =
    list
      .map(x => ({
        timestamp:
          num(
            x.timestamp
          ),

        buyRatio:
          num(
            x.buyRatio
          ),

        sellRatio:
          num(
            x.sellRatio
          )
      }))
      .sort(
        (a, b) =>
          a.timestamp -
          b.timestamp
      );

  const latest =
    sorted.at(-1);

  return {
    available: true,

    buyRatio:
      latest.buyRatio,

    sellRatio:
      latest.sellRatio,

    ratio:
      latest.sellRatio
        ? latest.buyRatio /
          latest.sellRatio
        : null,

    history:
      sorted.slice(-50)
  };
}

/* ========================= SIGNALS ========================= */

function calculateRSISignal(
  one
) {
  if (
    !one?.available ||
    one.rsi == null
  ) {
    return {
      direction: "RANGE",
      score: 0,
      reasons: []
    };
  }

  const value =
    one.rsi;

  const reasons = [];

  let direction =
    "RANGE";

  let score = 0;

  if (
    value <= 30
  ) {
    direction =
      "LONG";

    score = 90;

    reasons.push({
      side: "LONG",
      points: 90,
      text:
        `RSI واقعی 1m در اشباع فروش: ${value.toFixed(2)}`
    });
  } else if (
    value >= 70
  ) {
    direction =
      "SHORT";

    score = 90;

    reasons.push({
      side: "SHORT",
      points: 90,
      text:
        `RSI واقعی 1m در اشباع خرید: ${value.toFixed(2)}`
    });
  } else if (
    value > 52
  ) {
    direction =
      "LONG";

    score =
      50 +
      (
        value - 52
      ) * 2;

    reasons.push({
      side: "LONG",
      points:
        score,
      text:
        `RSI بالای 52 است: ${value.toFixed(2)}`
    });
  } else if (
    value < 48
  ) {
    direction =
      "SHORT";

    score =
      50 +
      (
        48 - value
      ) * 2;

    reasons.push({
      side: "SHORT",
      points:
        score,
      text:
        `RSI زیر 48 است: ${value.toFixed(2)}`
    });
  }

  return {
    direction,
    score:
      clamp(score),
    reasons
  };
}

/* ========================= MACD SIGNAL ========================= */

function calculateMACDSignal(
  one
) {
  if (
    !one?.macd?.available
  ) {
    return {
      direction: "RANGE",
      score: 0,
      reasons: []
    };
  }

  const m =
    one.macd;

  const reasons = [];

  let long = 0;
  let short = 0;

  if (
    m.crossover ===
    "BULLISH_CROSS"
  ) {
    long += 60;

    reasons.push({
      side: "LONG",
      points: 60,
      text:
        "کراس صعودی واقعی MACD."
    });
  }

  if (
    m.crossover ===
    "BEARISH_CROSS"
  ) {
    short += 60;

    reasons.push({
      side: "SHORT",
      points: 60,
      text:
        "کراس نزولی واقعی MACD."
    });
  }

  if (
    m.direction ===
    "LONG"
  ) {
    long += 35;

    reasons.push({
      side: "LONG",
      points: 35,
      text:
        "MACD در وضعیت صعودی واقعی است."
    });
  }

  if (
    m.direction ===
    "SHORT"
  ) {
    short += 35;

    reasons.push({
      side: "SHORT",
      points: 35,
      text:
        "MACD در وضعیت نزولی واقعی است."
    });
  }

  if (
    long === 0 &&
    short === 0
  ) {
    return {
      direction: "RANGE",
      score: 0,
      reasons,
      data: m
    };
  }

  if (
    long > short
  ) {
    return {
      direction: "LONG",
      score:
        clamp(long),
      reasons,
      data: m
    };
  }

  return {
    direction: "SHORT",
    score:
      clamp(short),
    reasons,
    data: m
  };
}

/* ========================= DIVERGENCE SIGNAL ========================= */

function calculateDivergenceSignal(
  one
) {
  const d =
    one?.divergence;

  if (
    !d?.available ||
    d.side === "NONE"
  ) {
    return {
      direction: "RANGE",
      score: 0,
      reasons: []
    };
  }

  return {
    direction:
      d.side,

    score: 85,

    reasons: [
      {
        side:
          d.side,

        points: 85,

        text:
          d.type ===
          "BULLISH_DIVERGENCE"
            ? "واگرایی صعودی واقعی قیمت و RSI."
            : "واگرایی نزولی واقعی قیمت و RSI."
      }
    ]
  };
}

/* ========================= STYLE ========================= */

function calculateStyle(
  style,
  one,
  fifteen,
  footprint,
  orderbook,
  strictness
) {
  let long = 0;
  let short = 0;

  const reasons = [];

  function add(
    side,
    points,
    text
  ) {
    if (
      side === "LONG"
    ) {
      long += points;
    }

    if (
      side === "SHORT"
    ) {
      short += points;
    }

    reasons.push({
      side,
      points,
      text
    });
  }

  if (
    !one?.available
  ) {
    return {
      style,
      direction: "RANGE",
      score: 0,
      longScore: 0,
      shortScore: 0,
      threshold: 0,
      reasons
    };
  }

  /* ================= TREND ================= */

  if (
    style ===
    "Trend Following"
  ) {
    if (
      one.trend?.direction ===
      "LONG"
    ) {
      add(
        "LONG",
        40,
        "چیدمان MA7/MA20/MA50 در 1m صعودی است."
      );
    }

    if (
      one.trend?.direction ===
      "SHORT"
    ) {
      add(
        "SHORT",
        40,
        "چیدمان MA7/MA20/MA50 در 1m نزولی است."
      );
    }

    if (
      one.slopePct > 0
    ) {
      add(
        "LONG",
        20,
        "شیب MA20 در 1m مثبت است."
      );
    }

    if (
      one.slopePct < 0
    ) {
      add(
        "SHORT",
        20,
        "شیب MA20 در 1m منفی است."
      );
    }

    if (
      one.macd?.direction ===
      "LONG"
    ) {
      add(
        "LONG",
        20,
        "MACD روند صعودی را تأیید می‌کند."
      );
    }

    if (
      one.macd?.direction ===
      "SHORT"
    ) {
      add(
        "SHORT",
        20,
        "MACD روند نزولی را تأیید می‌کند."
      );
    }
  }

  /* ================= BREAKOUT ================= */

  if (
    style ===
    "Breakout"
  ) {
    if (
      one.structure?.bos ===
      "BULLISH"
    ) {
      add(
        "LONG",
        50,
        "BOS صعودی واقعی از ساختار کندل‌ها."
      );
    }

    if (
      one.structure?.bos ===
      "BEARISH"
    ) {
      add(
        "SHORT",
        50,
        "BOS نزولی واقعی از ساختار کندل‌ها."
      );
    }

    if (
      one.structure?.choch ===
      "BULLISH"
    ) {
      add(
        "LONG",
        25,
        "CHoCH صعودی واقعی."
      );
    }

    if (
      one.structure?.choch ===
      "BEARISH"
    ) {
      add(
        "SHORT",
        25,
        "CHoCH نزولی واقعی."
      );
    }

    if (
      one.volumeRatio >=
      1.30
    ) {
      if (
        one.direction ===
        "LONG"
      ) {
        add(
          "LONG",
          25,
          "شکست همراه با افزایش حجم 1m."
        );
      }

      if (
        one.direction ===
        "SHORT"
      ) {
        add(
          "SHORT",
          25,
          "شکست همراه با افزایش حجم 1m."
        );
      }
    }

    if (
      one.cisd?.direction ===
      "LONG"
    ) {
      add(
        "LONG",
        15,
        "CISD صعودی همراه شکست."
      );
    }

    if (
      one.cisd?.direction ===
      "SHORT"
    ) {
      add(
        "SHORT",
        15,
        "CISD نزولی همراه شکست."
      );
    }
  }

  /* ================= REVERSAL ================= */

  if (
    style ===
    "Reversal"
  ) {
    if (
      one.divergence?.side ===
      "LONG"
    ) {
      add(
        "LONG",
        40,
        "واگرایی صعودی واقعی RSI."
      );
    }

    if (
      one.divergence?.side ===
      "SHORT"
    ) {
      add(
        "SHORT",
        40,
        "واگرایی نزولی واقعی RSI."
      );
    }

    if (
      one.rsi != null &&
      one.rsi <= 30
    ) {
      add(
        "LONG",
        30,
        `RSI اشباع فروش: ${one.rsi.toFixed(2)}`
      );
    }

    if (
      one.rsi != null &&
      one.rsi >= 70
    ) {
      add(
        "SHORT",
        30,
        `RSI اشباع خرید: ${one.rsi.toFixed(2)}`
      );
    }

    if (
      one.macd?.crossover ===
      "BULLISH_CROSS"
    ) {
      add(
        "LONG",
        25,
        "کراس صعودی MACD."
      );
    }

    if (
      one.macd?.crossover ===
      "BEARISH_CROSS"
    ) {
      add(
        "SHORT",
        25,
        "کراس نزولی MACD."
      );
    }

    if (
      one.liquiditySweep?.side ===
      "LONG"
    ) {
      add(
        "LONG",
        30,
        "شکار نقدینگی پایین و برگشت قیمت."
      );
    }

    if (
      one.liquiditySweep?.side ===
      "SHORT"
    ) {
      add(
        "SHORT",
        30,
        "شکار نقدینگی بالا و برگشت قیمت."
      );
    }
  }

  /* ================= LIQUIDITY ================= */

  if (
    style ===
    "Liquidity / Smart Money"
  ) {
    if (
      one.liquiditySweep?.side ===
      "LONG"
    ) {
      add(
        "LONG",
        35,
        "Liquidity Sweep پایین تأیید شده."
      );
    }

    if (
      one.liquiditySweep?.side ===
      "SHORT"
    ) {
      add(
        "SHORT",
        35,
        "Liquidity Sweep بالا تأیید شده."
      );
    }

    if (
      one.fvg?.latestBullish
    ) {
      add(
        "LONG",
        20,
        "FVG صعودی واقعی."
      );
    }

    if (
      one.fvg?.latestBearish
    ) {
      add(
        "SHORT",
        20,
        "FVG نزولی واقعی."
      );
    }

    if (
      one.orderBlocks?.latestBullish
    ) {
      add(
        "LONG",
        25,
        "Order Block صعودی واقعی."
      );
    }

    if (
      one.orderBlocks?.latestBearish
    ) {
      add(
        "SHORT",
        25,
        "Order Block نزولی واقعی."
      );
    }

    if (
      one.cisd?.direction ===
      "LONG"
    ) {
      add(
        "LONG",
        25,
        "CISD صعودی واقعی."
      );
    }

    if (
      one.cisd?.direction ===
      "SHORT"
    ) {
      add(
        "SHORT",
        25,
        "CISD نزولی واقعی."
      );
    }

    if (
      one.structure?.choch ===
      "BULLISH"
    ) {
      add(
        "LONG",
        10,
        "CHoCH صعودی."
      );
    }

    if (
      one.structure?.choch ===
      "BEARISH"
    ) {
      add(
        "SHORT",
        10,
        "CHoCH نزولی."
      );
    }
  }

  /* ================= ORDER FLOW ================= */

  if (
    style ===
    "Order Flow"
  ) {
    if (
      footprint?.available
    ) {
      if (
        footprint.deltaPercent >
        10
      ) {
        add(
          "LONG",
          40,
          `Delta مثبت: ${footprint.deltaPercent.toFixed(2)}%`
        );
      }

      if (
        footprint.deltaPercent <
        -10
      ) {
        add(
          "SHORT",
          40,
          `Delta منفی: ${footprint.deltaPercent.toFixed(2)}%`
        );
      }

      if (
        footprint.largeDelta >
        0
      ) {
        add(
          "LONG",
          20,
          "معاملات بزرگ به نفع خریداران."
        );
      }

      if (
        footprint.largeDelta <
        0
      ) {
        add(
          "SHORT",
          20,
          "معاملات بزرگ به نفع فروشندگان."
        );
      }
    }

    if (
      orderbook?.available
    ) {
      if (
        orderbook.buyShare >
        orderbook.sellShare + 8
      ) {
        add(
          "LONG",
          30,
          "نقدینگی Bid بیشتر از Ask است."
        );
      }

      if (
        orderbook.sellShare >
        orderbook.buyShare + 8
      ) {
        add(
          "SHORT",
          30,
          "نقدینگی Ask بیشتر از Bid است."
        );
      }
    }
  }

  /* ================= MOMENTUM ================= */

  if (
    style ===
    "Momentum / Pump-Dump"
  ) {
    if (
      one.volumeRatio >=
      1.8
    ) {
      if (
        one.direction ===
        "LONG"
      ) {
        add(
          "LONG",
          35,
          "افزایش غیرعادی حجم در حرکت صعودی."
        );
      }

      if (
        one.direction ===
        "SHORT"
      ) {
        add(
          "SHORT",
          35,
          "افزایش غیرعادی حجم در حرکت نزولی."
        );
      }
    }

    if (
      Math.abs(
        one.distancePct
      ) >= 0.5
    ) {
      if (
        one.direction ===
        "LONG"
      ) {
        add(
          "LONG",
          25,
          "حرکت سریع بالاتر از MA20."
        );
      }

      if (
        one.direction ===
        "SHORT"
      ) {
        add(
          "SHORT",
          25,
          "حرکت سریع پایین‌تر از MA20."
        );
      }
    }
  }

  const maxScore =
    Math.max(
      long,
      short
    );

  /*
   * سخت‌گیری:
   * 0 = حداقل حدود 25
   * 100 = حدود 65
   *
   * بنابراین 20 واقعاً آسان‌تر است
   * ولی سیگنال کاملاً بدون شرط تولید نمی‌شود.
   */
  const threshold =
    25 +
    clamp(strictness) *
    0.40;

  let direction =
    "RANGE";

  if (
    long > short &&
    long >= threshold
  ) {
    direction =
      "LONG";
  } else if (
    short > long &&
    short >= threshold
  ) {
    direction =
      "SHORT";
  }

  return {
    style,

    direction,

    score:
      Math.round(
        clamp(maxScore)
      ),

    longScore:
      Math.round(
        clamp(long)
      ),

    shortScore:
      Math.round(
        clamp(short)
      ),

    threshold:
      Math.round(
        threshold
      ),

    reasons
  };
}

/* ========================= MASTER ============================ */

function calculateMasterSignal(
  one,
  fifteen,
  footprint,
  orderbook,
  styles,
  rsiSignal,
  macdSignal,
  divergenceSignal,
  strictness,
  selectedBases = []
) {
  let long = 0;
  let short = 0;

  const reasons = [];

  /*
   * مبناهای قابل انتخاب:
   * RSI
   * MACD
   * DIVERGENCE
   * PRICE
   * FOOTPRINT
   * ORDERBOOK
   * 15M
   *
   * اگر selectedBases خالی باشد،
   * رفتار قبلی حفظ می‌شود و همه مبناهای اصلی فعال هستند.
   */

  const defaults = [
    "RSI",
    "MACD",
    "DIVERGENCE"
  ];

  const bases =
    Array.isArray(selectedBases) &&
    selectedBases.length
      ? selectedBases
          .map(x =>
            String(x)
              .trim()
              .toUpperCase()
          )
          .filter(Boolean)
      : defaults;

  const has =
    key =>
      bases.includes(key);

  function add(
    direction,
    score,
    text
  ) {
    if (
      !Number.isFinite(score) ||
      score === 0
    ) {
      return;
    }

    if (
      direction === "LONG"
    ) {
      long += score;
    }

    if (
      direction === "SHORT"
    ) {
      short += score;
    }

    reasons.push({
      side:
        direction,

      points:
        Math.round(score),

      text
    });
  }

  /*
   * PRICE / MARKET DIRECTION
   */
  if (
    has("PRICE")
  ) {
    if (
      one?.direction ===
      "LONG"
    ) {
      add(
        "LONG",
        25,
        "واکنش صعودی قیمت در 1m."
      );
    }

    if (
      one?.direction ===
      "SHORT"
    ) {
      add(
        "SHORT",
        25,
        "واکنش نزولی قیمت در 1m."
      );
    }
  }

  /*
   * RSI
   */
  if (
    has("RSI") &&
    rsiSignal
  ) {
    add(
      rsiSignal.direction,
      rsiSignal.score * 0.15,
      `RSI واقعی در امتیاز نهایی لحاظ شد: ${Math.round(rsiSignal.score)}`
    );
  }

  /*
   * MACD
   */
  if (
    has("MACD") &&
    macdSignal
  ) {
    add(
      macdSignal.direction,
      macdSignal.score * 0.15,
      `MACD واقعی در امتیاز نهایی لحاظ شد: ${Math.round(macdSignal.score)}`
    );
  }

  /*
   * DIVERGENCE
   */
  if (
    has("DIVERGENCE") &&
    divergenceSignal
  ) {
    add(
      divergenceSignal.direction,
      divergenceSignal.score * 0.15,
      `واگرایی واقعی در امتیاز نهایی لحاظ شد: ${Math.round(divergenceSignal.score)}`
    );
  }

  /*
   * سبک‌های معاملاتی
   * فعلاً همیشه به‌صورت اطلاعات تحلیلی باقی می‌مانند
   * و فقط وقتی مبنای STYLE انتخاب شده باشد وارد امتیاز می‌شوند.
   */
  if (
    has("STYLE")
  ) {
    for (
      const style of styles || []
    ) {
      if (
        style.direction ===
        "LONG"
      ) {
        long +=
          style.score *
          0.08;

        reasons.push({
          side: "LONG",
          points:
            Math.round(
              style.score *
              0.08
            ),
          text:
            `${style.name || "سبک معاملاتی"} صعودی است.`
        });
      }

      if (
        style.direction ===
        "SHORT"
      ) {
        short +=
          style.score *
          0.08;

        reasons.push({
          side: "SHORT",
          points:
            Math.round(
              style.score *
              0.08
            ),
          text:
            `${style.name || "سبک معاملاتی"} نزولی است.`
        });
      }
    }
  }

  /*
   * FOOTPRINT / ORDER FLOW
   */
  if (
    has("FOOTPRINT") &&
    footprint?.available
  ) {
    if (
      Number.isFinite(
        footprint.deltaPercent
      ) &&
      footprint.deltaPercent > 10
    ) {
      add(
        "LONG",
        8,
        `Footprint مثبت است؛ Delta واقعی: ${footprint.deltaPercent.toFixed(2)}%`
      );
    }

    if (
      Number.isFinite(
        footprint.deltaPercent
      ) &&
      footprint.deltaPercent < -10
    ) {
      add(
        "SHORT",
        8,
        `Footprint منفی است؛ Delta واقعی: ${footprint.deltaPercent.toFixed(2)}%`
      );
    }
  }

  /*
   * ORDER BOOK
   */
  if (
    has("ORDERBOOK") &&
    orderbook?.available
  ) {
    const buyShare =
      Number(
        orderbook.buyShare
      );

    const sellShare =
      Number(
        orderbook.sellShare
      );

    if (
      Number.isFinite(buyShare) &&
      Number.isFinite(sellShare)
    ) {
      if (
        buyShare >
        sellShare + 8
      ) {
        add(
          "LONG",
          5,
          `Order Book به نفع خریداران است: Buy ${buyShare.toFixed(2)}% / Sell ${sellShare.toFixed(2)}%`
        );
      }

      if (
        sellShare >
        buyShare + 8
      ) {
        add(
          "SHORT",
          5,
          `Order Book به نفع فروشندگان است: Buy ${buyShare.toFixed(2)}% / Sell ${sellShare.toFixed(2)}%`
        );
      }
    }
  }

  /*
   * 15M CONFIRMATION
   *
   * 15m همچنان تأییدکننده است،
   * نه اینکه خودش به‌تنهایی سیگنال بسازد.
   */
  if (
    has("15M")
  ) {
    if (
      fifteen?.direction ===
        "LONG" &&
      long > short
    ) {
      long += 10;

      reasons.push({
        side: "LONG",
        points: 10,
        text:
          "15m جهت صعودی را تأیید می‌کند."
      });
    }

    if (
      fifteen?.direction ===
        "SHORT" &&
      short > long
    ) {
      short += 10;

      reasons.push({
        side: "SHORT",
        points: 10,
        text:
          "15m جهت نزولی را تأیید می‌کند."
      });
    }

    if (
      fifteen?.direction ===
        "SHORT" &&
      long > short
    ) {
      long -= 10;

      reasons.push({
        side: "LONG",
        points: -10,
        text:
          "15m خلاف جهت LONG است."
      });
    }

    if (
      fifteen?.direction ===
        "LONG" &&
      short > long
    ) {
      short -= 10;

      reasons.push({
        side: "SHORT",
        points: -10,
        text:
          "15m خلاف جهت SHORT است."
      });
    }
  }

  long =
    Math.max(
      0,
      long
    );

  short =
    Math.max(
      0,
      short
    );

  const finalRaw =
    Math.max(
      long,
      short
    );

  const threshold =
    30 +
    clamp(strictness) *
    0.45;

  let direction =
    "RANGE";

  if (
    long > short
  ) {
    direction =
      "LONG";
  } else if (
    short > long
  ) {
    direction =
      "SHORT";
  }

  const qualifies =
    direction !==
      "RANGE" &&
    finalRaw >=
      threshold;

  const selectedCount =
    bases.length;

  const longReasons =
    reasons.filter(
      x =>
        x.side === "LONG"
    ).length;

  const shortReasons =
    reasons.filter(
      x =>
        x.side === "SHORT"
    ).length;

  return {
    score:
      Math.round(
        clamp(finalRaw)
      ),

    longScore:
      Math.round(
        clamp(long)
      ),

    shortScore:
      Math.round(
        clamp(short)
      ),

    threshold:
      Math.round(
        threshold
      ),

    direction:
      qualifies
        ? direction
        : "WAIT",

    qualifies,

    selectedBases:
      bases,

    selectedBaseCount:
      selectedCount,

    confirmation:
      qualifies
        ? "CONFIRMED"
        : finalRaw > 0
          ? "WEAK"
          : "NO_CONFIRMATION",

    reasonCount:
      Math.max(
        longReasons,
        shortReasons
      ),

    reasons
  };
}

/* ========================= SYMBOL RESOLVER ========================= */

async function resolveSymbol(
  input
) {
  const clean =
    String(
      input || ""
    )
      .trim()
      .toUpperCase()
      .replace(
        /[^A-Z0-9]/g,
        ""
      );

  if (!clean) {
    return null;
  }

  const symbols =
    await getSymbols();

  let found =
    symbols.find(
      x =>
        x.symbol ===
        clean
    );

  if (found) {
    return found;
  }

  if (
    !clean.endsWith(
      "USDT"
    )
  ) {
    found =
      symbols.find(
        x =>
          x.symbol ===
          clean +
            "USDT"
      );

    if (found) {
      return found;
    }
  }

  const base =
    clean.endsWith(
      "USDT"
    )
      ? clean.slice(
          0,
          -4
        )
      : clean;

  const matches =
    symbols.filter(
      x =>
        x.baseCoin ===
          base &&
        x.quoteCoin ===
          "USDT"
    );

  if (
    !matches.length
  ) {
    return null;
  }

  return (
    matches.find(
      x =>
        x.category ===
        "linear"
    ) ||
    matches[0]
  );
}

/* ========================= SIGNAL SELECTOR ========================= */

function selectSignal(
  result,
  signalBase
) {
  const base =
    String(
      signalBase ||
        "ALL"
    )
      .trim()
      .toUpperCase();

  if (
    base === "RSI"
  ) {
    return {
      direction:
        result.signalBases
          .rsi.direction,

      score:
        result.signalBases
          .rsi.score,

      reasons:
        result.signalBases
          .rsi.reasons
    };
  }

  if (
    base === "MACD"
  ) {
    return {
      direction:
        result.signalBases
          .macd.direction,

      score:
        result.signalBases
          .macd.score,

      reasons:
        result.signalBases
          .macd.reasons
    };
  }

  if (
    base ===
    "DIVERGENCE"
  ) {
    return {
      direction:
        result.signalBases
          .divergence.direction,

      score:
        result.signalBases
          .divergence.score,

      reasons:
        result.signalBases
          .divergence.reasons
    };
  }

  const map = {
    TREND_FOLLOWING:
      "Trend Following",

    BREAKOUT:
      "Breakout",

    REVERSAL:
      "Reversal",

    LIQUIDITY_SMART_MONEY:
      "Liquidity / Smart Money",

    ORDER_FLOW:
      "Order Flow",

    MOMENTUM_PUMPDUMP:
      "Momentum / Pump-Dump"
  };

  if (
    map[base]
  ) {
    const style =
      result.tradingStyles.find(
        s =>
          s.style ===
          map[base]
      );

    return (
      style || {
        direction:
          "RANGE",

        score: 0,

        reasons: []
      }
    );
  }

  return {
    direction:
      result.direction,

    score:
      result.score,

    reasons:
      result.reasons
  };
}

/* ========================= ROTATING SCAN ========================= */

async function scanMarket(
  offset,
  strictness,
  signalBase = "ALL"
) {
  const symbols =
    await getSymbols();

  if (
    !symbols.length
  ) {
    throw new Error(
      "بازارهای Bybit دریافت نشد."
    );
  }

  const total =
    symbols.length;

  const selected = [];

  for (
    let i = 0;
    i < SCAN_BATCH;
    i++
  ) {
    selected.push(
      symbols[
        (
          offset +
          i
        ) % total
      ]
    );
  }

  const results = [];

  /*
   * همزمانی پایین نگه داشته شده
   * تا Rate Limit کمتر شود.
   */
  const concurrency = 3;

  for (
    let i = 0;
    i <
      selected.length;
    i += concurrency
  ) {
    const chunk =
      selected.slice(
        i,
        i + concurrency
      );

    const data =
      await Promise.all(
        chunk.map(
          async x => {
            try {
              const result =
                await analyzeSymbol(
                  x.symbol,
                  x.category,
                  strictness,
                  false
                );

              const selectedSignal =
                selectSignal(
                  result,
                  signalBase
                );

              /*
               * برای مبنای انتخابی،
               * فقط همان مبنا تعیین‌کننده
               * scanDirection و scanScore است.
               */
              const direction =
                selectedSignal.direction;

              const score =
                clamp(
                  selectedSignal.score
                );

              return {
                ...result,

                scanDirection:
                  direction ===
                    "LONG" ||
                  direction ===
                    "SHORT"
                    ? direction
                    : "WAIT",

                scanScore:
                  Math.round(
                    score
                  ),

                scanBase:
                  String(
                    signalBase ||
                      "ALL"
                  )
                    .trim()
                    .toUpperCase(),

                scanReasons:
                  selectedSignal.reasons ||
                  []
              };
            } catch (
              error
            ) {
              return null;
            }
          }
        )
      );

    results.push(
      ...data.filter(
        Boolean
      )
    );

    await sleep(80);
  }

  /*
   * آستانه اسکن با همان منطق
   * سخت‌گیری Worker هماهنگ است.
   */
  const threshold =
    25 +
    clamp(strictness) *
    0.40;

  const signals =
    results
      .filter(
        x =>
          (
            x.scanDirection ===
              "LONG" ||
            x.scanDirection ===
              "SHORT"
          ) &&
          x.scanScore >=
            threshold
      )
      .sort(
        (a, b) =>
          b.scanScore -
          a.scanScore
      );

  return {
    ok: true,

    mode:
      "personal",

    version:
      PERSONAL_VERSION,

    strictness:
      clamp(strictness),

    signalBase,

    threshold:
      Math.round(
        threshold
      ),

    checked:
      results.length,

    totalMarkets:
      total,

    offset,

    nextOffset:
      (
        offset +
        SCAN_BATCH
      ) % total,

    results:
      signals,

    generatedAt:
      Date.now()
  };
}

/* ========================= HEALTH ========================= */

async function health() {
  return {
    ok: true,

    service:
      "Bybit Personal Live Smart Money Scanner",

    version:
      PERSONAL_VERSION,

    mode:
      "personal",

    signalCore:
      "REAL 1m multi-factor signal engine",

    higherTimeframe:
      "REAL 15m confirmation",

    strictness:
      "0-100",

    styles: [
      "Trend Following",
      "Breakout",
      "Reversal",
      "Liquidity / Smart Money",
      "Order Flow",
      "Momentum / Pump-Dump"
    ],

    signalBases: [
      "ALL",
      "RSI",
      "MACD",
      "DIVERGENCE",
      "TREND_FOLLOWING",
      "BREAKOUT",
      "REVERSAL",
      "LIQUIDITY_SMART_MONEY",
      "ORDER_FLOW",
      "MOMENTUM_PUMPDUMP"
    ],

    features: [
      "REAL 1m MA7",
      "REAL 1m MA20",
      "REAL 1m MA50",
      "REAL MA20 slope",

      "REAL RSI",
      "REAL MACD",
      "REAL MACD crossover",

      "REAL ATR",
      "REAL Bollinger",
      "REAL Ichimoku",

      "REAL RSI divergence",

      "REAL Liquidity Sweep",
      "REAL BOS",
      "REAL CHoCH",
      "REAL FVG",
      "REAL Order Block",
      "REAL CISD",

      "REAL Footprint",
      "REAL Delta",
      "REAL Buy/Sell Volume",
      "REAL Large Trades",
      "REAL Block Trades",

      "REAL Order Book",
      "REAL Buy Walls",
      "REAL Sell Walls",

      "REAL Support Resistance",

      "REAL OI",
      "REAL OI 5m",
      "REAL OI 15m",
      "REAL OI 1h",

      "REAL Funding",
      "REAL Long Short Ratio",

      "REAL 15m confirmation",

      "Rotating Scan",
      "Manual Deep Analysis"
    ],

    timeframes: [
      "1",
      "15"
    ],

    dataPolicy:
      "No synthetic indicator values",

    oiPolicy:
      "Bybit OI endpoint is 5-minute; no fake 1-minute OI is generated.",

    time:
      Date.now()
  };
}

/* ========================= ROUTER ========================= */

async function handle(
  request
) {
  const url =
    new URL(
      request.url
    );

  const path =
    url.pathname;

  if (
    request.method ===
    "OPTIONS"
  ) {
    return new Response(
      null,
      {
        headers: {
          "access-control-allow-origin":
            "*",

          "access-control-allow-methods":
            "GET,OPTIONS",

          "access-control-allow-headers":
            "*"
        }
      }
    );
  }

  /* ================= HEALTH ================= */

  if (
    path ===
    "/api/health"
  ) {
    return json(
      await health()
    );
  }

  if (
    path ===
    "/api/personal/health"
  ) {
    return json(
      await health()
    );
  }

  /* ================= SCAN ================= */

  if (
    path ===
      "/api/personal/scan" ||
    path ===
      "/api/scan"
  ) {
    try {
      const offset =
        Math.max(
          0,
          Math.floor(
            num(
              url.searchParams.get(
                "offset"
              )
            )
          )
        );

      const strictness =
        clamp(
          num(
            url.searchParams.get(
              "strictness"
            ) ??
              DEFAULT_STRICTNESS
          )
        );

      const signalBase =
        String(
          url.searchParams.get(
            "signalBase"
          ) ||
            "ALL"
        )
          .trim()
          .toUpperCase();

      return json(
        await scanMarket(
          offset,
          strictness,
          signalBase
        )
      );
    } catch (e) {
      return json(
        {
          ok: false,

          error:
            e.message ||
            "خطا در اسکن بازار"
        },
        500
      );
    }
  }

  /* ================= DEEP ANALYSIS ================= */

  if (
    path ===
      "/api/personal/analyze" ||
    path ===
      "/api/analyze"
  ) {
    try {
      const input =
        url.searchParams.get(
          "symbol"
        );

      const strictness =
        clamp(
          num(
            url.searchParams.get(
              "strictness"
            ) ??
              DEFAULT_STRICTNESS
          )
        );

      if (!input) {
        return json(
          {
            ok: false,

            error:
              "نام ارز وارد نشده است."
          },
          400
        );
      }

      const found =
        await resolveSymbol(
          input
        );

      if (!found) {
        return json(
          {
            ok: false,

            error:
              `${String(
                input
              ).toUpperCase()} در Spot یا Futures Bybit پیدا نشد.`,

            search: {
              input:
                String(
                  input
                ).toUpperCase(),

              selected:
                null
            }
          },
          404
        );
      }

      const data =
        await analyzeSymbol(
          found.symbol,
          found.category,
          strictness,
          true
        );

      return json({
        ...data,

        baseCoin:
          found.baseCoin,

        quoteCoin:
          found.quoteCoin,

        strictness,

        search: {
          input:
            String(
              input
            ).toUpperCase(),

          selected:
            found.category ===
            "linear"
              ? "FUTURES"
              : "SPOT"
        }
      });
    } catch (e) {
      return json(
        {
          ok: false,

          error:
            e.message ||
            "تحلیل انجام نشد."
        },
        500
      );
    }
  }

  return json(
    {
      ok: false,

      error:
        "Personal API route not found.",

      routes: [
        "/api/health",
        "/api/personal/health",
        "/api/personal/scan",
        "/api/personal/analyze"
      ]
    },
    404
  );
}

/* ========================= CLOUDFLARE WORKER ========================= */

export default {
  async fetch(
    request,
    env,
    ctx
  ) {
    return handle(
      request
    );
  }
};
