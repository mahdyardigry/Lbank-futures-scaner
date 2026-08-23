const BYBIT = "https://api.bybit.com";

const SCAN_BATCH = 20;
const DEEP_LIMIT = 3;
const RESULT_LIMIT = 10;
const DEEP_1M_LIMIT = 1300;

/*
  تبدیل MA تایم‌فریم‌های بالاتر به معادل روی 1 دقیقه:

  1m  MA20  = MA20
  3m  MA7   = MA21
  3m  MA20  = MA60
  5m  MA7   = MA35
  5m  MA20  = MA100
  15m MA7   = MA105
  15m MA20  = MA300
  1h  MA7   = MA420
  1h  MA20  = MA1200
*/

const CONVERTED_MAS = [
  { source: "1m", ma: 20, period: 20 },

  { source: "3m", ma: 7, period: 21 },
  { source: "3m", ma: 20, period: 60 },

  { source: "5m", ma: 7, period: 35 },
  { source: "5m", ma: 20, period: 100 },

  { source: "15m", ma: 7, period: 105 },
  { source: "15m", ma: 20, period: 300 },

  { source: "1h", ma: 7, period: 420 },
  { source: "1h", ma: 20, period: 1200 }
];

const TF = [
  {
    key: "1",
    label: "1 دقیقه",
    interval: "1",
    priority: "MA20"
  },
  {
    key: "3",
    label: "3 دقیقه",
    interval: "3",
    priority: "MA7"
  },
  {
    key: "5",
    label: "5 دقیقه",
    interval: "5",
    priority: "MA7"
  },
  {
    key: "15",
    label: "15 دقیقه",
    interval: "15",
    priority: "MA7"
  },
  {
    key: "60",
    label: "1 ساعت",
    interval: "60",
    priority: "MA7"
  }
];

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "cache-control": "no-store"
    }
  });

const n = (v, d = 0) =>
  Number.isFinite(Number(v)) ? Number(v) : d;

const clamp = (v, a, b) =>
  Math.max(a, Math.min(b, v));

const avg = a =>
  a.length
    ? a.reduce((x, y) => x + y, 0) / a.length
    : 0;


/* =========================
   BYBIT API
========================= */

async function bybit(path, params = {}) {
  const u = new URL(BYBIT + path);

  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) {
      u.searchParams.set(k, String(v));
    }
  }

  const r = await fetch(u, {
    headers: {
      accept: "application/json"
    }
  });

  if (!r.ok) {
    throw new Error(`Bybit HTTP ${r.status}`);
  }

  const d = await r.json();

  if (d.retCode !== 0) {
    throw new Error(
      d.retMsg || `Bybit ${d.retCode}`
    );
  }

  return d;
}


/* =========================
   KLINES
========================= */

async function klines(
  category,
  symbol,
  interval,
  limit = 100
) {
  const d = await bybit(
    "/v5/market/kline",
    {
      category,
      symbol,
      interval,
      limit
    }
  );

  return (d?.result?.list || [])
    .reverse()
    .map(k => ({
      time: n(k[0]),
      open: n(k[1]),
      high: n(k[2]),
      low: n(k[3]),
      close: n(k[4]),
      volume: n(k[5]),
      turnover: n(k[6])
    }));
}


/* =========================
   MOVING AVERAGES
========================= */

function sma(a, p) {
  if (!a.length) return 0;

  return a.length < p
    ? avg(a)
    : avg(a.slice(-p));
}

function ema(a, p) {
  if (!a.length) return 0;

  const k = 2 / (p + 1);
  let x = a[0];

  for (let i = 1; i < a.length; i++) {
    x = a[i] * k + x * (1 - k);
  }

  return x;
}


/* =========================
   ATR
========================= */

function atr(c, p = 14) {
  if (c.length < 2) return 0;

  const tr = c.slice(1).map((x, i) => {
    const prev = c[i].close;

    return Math.max(
      x.high - x.low,
      Math.abs(x.high - prev),
      Math.abs(x.low - prev)
    );
  });

  return sma(tr, p);
}


/* =========================
   ADX
========================= */

function adx(c, p = 14) {
  if (c.length < p * 2 + 1) {
    return 0;
  }

  const trs = [];
  const plus = [];
  const minus = [];

  for (let i = 1; i < c.length; i++) {
    const x = c[i];
    const q = c[i - 1];

    trs.push(
      Math.max(
        x.high - x.low,
        Math.abs(x.high - q.close),
        Math.abs(x.low - q.close)
      )
    );

    const up = x.high - q.high;
    const dn = q.low - x.low;

    plus.push(
      up > dn && up > 0 ? up : 0
    );

    minus.push(
      dn > up && dn > 0 ? dn : 0
    );
  }

  const out = [];

  for (let i = p; i < trs.length; i++) {
    const tr =
      avg(trs.slice(i - p, i)) || 1;

    const diP =
      100 *
      avg(plus.slice(i - p, i)) /
      tr;

    const diM =
      100 *
      avg(minus.slice(i - p, i)) /
      tr;

    const dx =
      diP + diM
        ? 100 *
          Math.abs(diP - diM) /
          (diP + diM)
        : 0;

    out.push(dx);
  }

  return avg(out.slice(-p));
}


/* =========================
   BOLLINGER WIDTH
========================= */

function bollWidth(c, p = 20) {
  const a = c
    .slice(-p)
    .map(x => x.close);

  const m = avg(a);

  const sd = Math.sqrt(
    avg(
      a.map(x =>
        (x - m) ** 2
      )
    )
  );

  return m
    ? (4 * sd / m) * 100
    : 0;
}


/* =========================
   MARKET STATE
========================= */

function rangeState(
  c,
  ma7,
  ma20,
  slope,
  volSpike
) {
  const price =
    c.at(-1)?.close || 0;

  const a = atr(c);

  const atrPct =
    price
      ? (a / price) * 100
      : 0;

  const adxV = adx(c);
  const bw = bollWidth(c);

  const maGap =
    ma20
      ? Math.abs(ma7 - ma20) /
        ma20 *
        100
      : 0;

  const isRange =
    adxV < 18 &&
    bw < 1.8 &&
    Math.abs(slope) < 0.0007;

  const waking =
    !isRange &&
    (
      adxV >= 18 ||
      bw >= 1.8 ||
      volSpike
    );

  return {
    state:
      isRange
        ? "RANGE"
        : waking
          ? "ACTIVE"
          : "TRANSITION",

    adx: adxV,
    atr: a,
    atrPct,
    bollWidth: bw,
    maGap
  };
}


/* =========================
   LIQUIDITY HUNT
========================= */

function hunt(c) {
  if (c.length < 22) {
    return {
      type: "NONE",
      side: "NONE"
    };
  }

  const x = c.at(-1);

  const prev =
    c.slice(-21, -1);

  const hi = Math.max(
    ...prev.map(z => z.high)
  );

  const lo = Math.min(
    ...prev.map(z => z.low)
  );

  /*
    Sell-side liquidity hunt:
    قیمت زیر کف قبلی می‌رود
    اما دوباره بالای کف بسته می‌شود
  */

  if (
    x.low < lo &&
    x.close > lo
  ) {
    return {
      type: "LIQUIDITY_SWEEP",
      side: "LONG",
      level: lo,
      description:
        "جمع‌آوری نقدینگی زیر کف و برگشت صعودی"
    };
  }

  /*
    Buy-side liquidity hunt:
    قیمت بالای سقف قبلی می‌رود
    اما دوباره زیر سقف بسته می‌شود
  */

  if (
    x.high > hi &&
    x.close < hi
  ) {
    return {
      type: "LIQUIDITY_SWEEP",
      side: "SHORT",
      level: hi,
      description:
        "جمع‌آوری نقدینگی بالای سقف و برگشت نزولی"
    };
  }

  return {
    type: "NONE",
    side: "NONE"
  };
}


/* =========================
   CANDLE ANALYSIS
========================= */

function candleSignal(c) {
  if (c.length < 3) {
    return "داده کافی نیست";
  }

  const x = c.at(-1);
  const p = c.at(-2);

  const body =
    Math.abs(x.close - x.open);

  const range =
    x.high - x.low || 1;

  const upper =
    x.high -
    Math.max(x.open, x.close);

  const lower =
    Math.min(x.open, x.close) -
    x.low;

  if (x.close > p.high) {
    return "BOS صعودی";
  }

  if (x.close < p.low) {
    return "BOS نزولی";
  }

  if (
    lower > body * 2 &&
    lower / range > 0.45
  ) {
    return "چکش / جذب فروش";
  }

  if (
    upper > body * 2 &&
    upper / range > 0.45
  ) {
    return "شوتینگ‌استار / جذب خرید";
  }

  return "عادی";
}


/* =========================
   CANDLE + SMC + ICT
========================= */

function analyzeCandles(c) {
  if (c.length < 25) {
    return {
      error: "کندل کافی نیست"
    };
  }

  const close =
    c.map(x => x.close);

  const vol =
    c.map(x => x.volume);

  const price =
    close.at(-1);

  const ma7 =
    sma(close, 7);

  const ma20 =
    sma(close, 20);

  const prev20 =
    sma(
      close.slice(0, -1),
      20
    );

  const slope =
    prev20
      ? (ma20 - prev20) /
        prev20
      : 0;

  const prevPrice =
    close.at(-2);

  const touch20 =
    Math.abs(price - ma20) /
      ma20 <= 0.0025 ||
    (prevPrice - ma20) *
      (price - ma20) <= 0;

  const touch7 =
    Math.abs(price - ma7) /
      ma7 <= 0.0025 ||
    (prevPrice - ma7) *
      (price - ma7) <= 0;

  const vol7 =
    sma(vol, 7);

  const vol20 =
    sma(vol, 20);

  const spike =
    vol.at(-1) >
      vol20 * 1.5 ||
    vol.at(-1) >
      vol7 * 1.8;

  const rs =
    rangeState(
      c,
      ma7,
      ma20,
      slope,
      spike
    );

  const trend =
    price > ma20 &&
    ma7 > ma20
      ? "BULLISH"
      : price < ma20 &&
        ma7 < ma20
        ? "BEARISH"
        : "RANGE";

  const h =
    hunt(c);

  /*
    FVG
  */

  const fvg =
    c.at(-1).low >
      c.at(-3).high
      ? "BULLISH"
      : c.at(-1).high <
          c.at(-3).low
        ? "BEARISH"
        : "NONE";

  /*
    BOS
  */

  const prevHigh =
    Math.max(
      ...c
        .slice(-13, -1)
        .map(x => x.high)
    );

  const prevLow =
    Math.min(
      ...c
        .slice(-13, -1)
        .map(x => x.low)
    );

  const bos =
    price > prevHigh
      ? "BULLISH"
      : price < prevLow
        ? "BEARISH"
        : "NONE";

  /*
    CHoCH ساده:
    تغییر جهت ساختار نسبت به روند قبلی
  */

  const old =
    c.slice(-8, -3);

  const oldHigh =
    Math.max(
      ...old.map(x => x.high)
    );

  const oldLow =
    Math.min(
      ...old.map(x => x.low)
    );

  const choch =
    trend === "BULLISH" &&
    price > oldHigh
      ? "BULLISH"
      : trend === "BEARISH" &&
        price < oldLow
        ? "BEARISH"
        : "NONE";

  /*
    Order Block تقریبی:
    آخرین کندل مخالف قبل از displacement
  */

  let orderBlock = "NONE";

  const last = c.at(-1);
  const before = c.at(-2);

  if (
    last.close > last.open &&
    before.close < before.open &&
    last.close > before.high
  ) {
    orderBlock = "BULLISH";
  }

  if (
    last.close < last.open &&
    before.close > before.open &&
    last.close < before.low
  ) {
    orderBlock = "BEARISH";
  }

  return {
    price,

    ma7,
    ma20,

    maSlope:
      slope > 0.00007
        ? "UP"
        : slope < -0.00007
          ? "DOWN"
          : "FLAT",

    slopePct:
      slope * 100,

    touchMA20: touch20,
    touchMA7: touch7,

    trend,

    volume: {
      current: vol.at(-1),
      ma7: vol7,
      ma20: vol20,
      spike
    },

    market: rs,

    hunt: h,

    candle:
      candleSignal(c),

    fvg,

    bos,

    choch,

    orderBlock,

    timestamp:
      c.at(-1).time
  };
}


/* =========================
   CONVERTED MA SERIES
========================= */

function maValueSeries(
  c,
  p,
  type = "SMA"
) {
  const out = [];

  for (
    let i = 0;
    i < c.length;
    i++
  ) {
    const a =
      c
        .slice(
          Math.max(
            0,
            i - p + 1
          ),
          i + 1
        )
        .map(x => x.close);

    if (a.length >= p) {
      out.push(
        type === "EMA"
          ? ema(a, p)
          : avg(a)
      );
    } else {
      out.push(null);
    }
  }

  return out;
}


/* =========================
   MA EVENTS
========================= */

function convertedMAEvents(c) {
  const price =
    c.at(-1)?.close || 0;

  const prev =
    c.at(-2)?.close || price;

  const events = [];

  for (
    const m of CONVERTED_MAS
  ) {
    const vals =
      maValueSeries(
        c,
        m.period,
        "SMA"
      );

    const ma =
      vals.at(-1);

    const prevMA =
      vals.at(-2);

    if (!ma || !prevMA) {
      continue;
    }

    const slopePct =
      ((ma - prevMA) /
        prevMA) *
      100;

    const prevDist =
      prev - prevMA;

    const dist =
      price - ma;

    /*
      Touch:
      قیمت به MA نزدیک شده
      یا از آن عبور کرده
    */

    const touch =
      Math.abs(dist) /
        ma <= 0.0025 ||
      prevDist * dist <= 0;

    const crossUp =
      prev <= prevMA &&
      price > ma;

    const crossDown =
      prev >= prevMA &&
      price < ma;

    const candle =
      c.at(-1);

    const body =
      Math.abs(
        candle.close -
        candle.open
      ) ||
      Math.max(
        candle.high -
          candle.low,
        1e-12
      );

    const lower =
      candle.close > ma &&
      candle.low <= ma &&
      candle.close >
        candle.open;

    const upper =
      candle.close < ma &&
      candle.high >= ma &&
      candle.close <
        candle.open;

    const rejection =
      lower || upper;

    let type = "NONE";
    let direction = "NONE";

    if (touch) {
      if (rejection) {
        type = "REJECTION";
      } else if (
        crossUp ||
        crossDown
      ) {
        type = "BREAK";
      } else {
        type = "TOUCH";
      }
    }

    if (
      lower ||
      crossUp
    ) {
      direction = "LONG";
    } else if (
      upper ||
      crossDown
    ) {
      direction = "SHORT";
    }

    const slope =
      Math.abs(slopePct) <
      0.003
        ? "FLAT"
        : slopePct > 0
          ? "UP"
          : "DOWN";

    let confirmation =
      "WAIT";

    /*
      تأیید MA:

      Long:
      برخورد + ریجکت/شکست + شیب صعودی

      Short:
      برخورد + ریجکت/شکست + شیب نزولی
    */

    if (
      direction === "LONG" &&
      slope === "UP" &&
      (rejection || crossUp)
    ) {
      confirmation =
        "CONFIRMED_LONG";
    }

    if (
      direction === "SHORT" &&
      slope === "DOWN" &&
      (rejection || crossDown)
    ) {
      confirmation =
        "CONFIRMED_SHORT";
    }

    events.push({
      source: m.source,

      ma:
        `MA${m.ma}`,

      period1m:
        m.period,

      time:
        candle.time,

      price,

      maValue:
        ma,

      type,

      direction,

      rejection,

      crossUp,

      crossDown,

      slope,

      slopePct,

      confirmation,

      distancePct:
        ((price - ma) /
          ma) *
        100
    });
  }

  const recent =
    events.filter(
      x => x.type !== "NONE"
    );

  return {
    events,

    recent,

    latest:
      recent.length
        ? recent[
            recent.length - 1
          ]
        : null
  };
}


/* =========================
   FOOTPRINT
========================= */

async function footprint(
  category,
  symbol
) {
  try {
    const d =
      await bybit(
        "/v5/market/recent-trade",
        {
          category,
          symbol,
          limit: 200
        }
      );

    const t =
      d?.result?.list || [];

    let buy = 0;
    let sell = 0;
    let largest = 0;

    for (const x of t) {
      const q = n(x.size);
      const p = n(x.price);

      const notional =
        q * p;

      largest =
        Math.max(
          largest,
          notional
        );

      if (
        String(x.side)
          .toLowerCase() ===
        "buy"
      ) {
        buy += q;
      } else {
        sell += q;
      }
    }

    const total =
      buy + sell;

    const delta =
      buy - sell;

    return {
      buyVolume: buy,
      sellVolume: sell,
      delta,

      deltaPercent:
        total
          ? (delta / total) *
            100
          : 0,

      trades:
        t.length,

      largeTradeNotional:
        largest
    };

  } catch (e) {
    return {
      error: e.message
    };
  }
}


/* =========================
   ORDER BOOK WALLS
========================= */

async function walls(
  category,
  symbol,
  price
) {
  try {
    const d =
      await bybit(
        "/v5/market/orderbook",
        {
          category,
          symbol,
          limit: 50
        }
      );

    const bids =
      d?.result?.b || [];

    const asks =
      d?.result?.a || [];

    const pick =
      (arr, side) => {
        let best = null;

        for (
          const q of arr
        ) {
          const p = n(q[0]);
          const sz = n(q[1]);

          if (
            (
              side === "buy"
                ? p < price
                : p > price
            )
          ) {
            const notional =
              p * sz;

            if (
              !best ||
              notional >
                best.notional
            ) {
              best = {
                price: p,
                size: sz,
                notional
              };
            }
          }
        }

        return best;
      };

    const b =
      pick(bids, "buy");

    const a =
      pick(asks, "sell");

    return {
      buy: b,
      sell: a,

      buyNear:
        b
          ? Math.abs(
              price - b.price
            ) /
              price <=
            0.01
          : false,

      sellNear:
        a
          ? Math.abs(
              a.price - price
            ) /
              price <=
            0.01
          : false
    };

  } catch (e) {
    return {
      error: e.message
    };
  }
}


/* =========================
   TICKER
========================= */

async function ticker(
  category,
  symbol
) {
  const d =
    await bybit(
      "/v5/market/tickers",
      {
        category,
        symbol
      }
    );

  return (
    d?.result?.list?.[0] ||
    {}
  );
}


/* =========================
   OI + FUNDING
========================= */

async function oiFunding(
  symbol
) {
  try {
    const t =
      await ticker(
        "linear",
        symbol
      );

    return {
      openInterest:
        n(t.openInterest),

      fundingRate:
        n(t.fundingRate),

      turnover24h:
        n(t.turnover24h),

      change24h:
        n(t.price24hPcnt) *
        100
    };

  } catch (e) {
    return {
      error: e.message
    };
  }
}


/* =========================
   SIGNAL SCORE
========================= */

function score(
  tf,
  converted = {
    events: []
  }
) {
  let L = 0;
  let S = 0;

  const reasons = [];

  const add =
    (
      dir,
      v,
      txt
    ) => {
      if (dir === "L") {
        L += v;
      } else {
        S += v;
      }

      if (txt) {
        reasons.push(txt);
      }
    };

  for (
    const [k, x]
    of Object.entries(tf)
  ) {
    if (
      !x ||
      x.error
    ) {
      continue;
    }

    const w =
      k === "1"
        ? 1.5
        : k === "60"
          ? 1.3
          : 1;

    /*
      MA20 Touch
    */

    if (
      x.touchMA20 &&
      x.trend === "BULLISH"
    ) {
      add(
        "L",
        12 * w,
        `برخورد MA20 در ${k}m`
      );
    }

    if (
      x.touchMA20 &&
      x.trend === "BEARISH"
    ) {
      add(
        "S",
        12 * w,
        `برخورد MA20 در ${k}m`
      );
    }

    /*
      MA7 Touch
    */

    if (
      x.touchMA7 &&
      x.trend === "BULLISH"
    ) {
      add(
        "L",
        10 * w,
        `برخورد MA7 در ${k}m`
      );
    }

    if (
      x.touchMA7 &&
      x.trend === "BEARISH"
    ) {
      add(
        "S",
        10 * w,
        `برخورد MA7 در ${k}m`
      );
    }

    /*
      MA Slope
    */

    if (
      x.maSlope === "UP"
    ) {
      add(
        "L",
        5 * w,
        `شیب MA صعودی ${k}m`
      );
    }

    if (
      x.maSlope === "DOWN"
    ) {
      add(
        "S",
        5 * w,
        `شیب MA نزولی ${k}m`
      );
    }

    /*
      Hunt
    */

    if (
      x.hunt.side ===
      "LONG"
    ) {
      add(
        "L",
        12 * w,
        "Hunt / Liquidity Sweep صعودی"
      );
    }

    if (
      x.hunt.side ===
      "SHORT"
    ) {
      add(
        "S",
        12 * w,
        "Hunt / Liquidity Sweep نزولی"
      );
    }

    /*
      BOS
    */

    if (
      x.bos ===
      "BULLISH"
    ) {
      add(
        "L",
        7 * w,
        "BOS صعودی"
      );
    }

    if (
      x.bos ===
      "BEARISH"
    ) {
      add(
        "S",
        7 * w,
        "BOS نزولی"
      );
    }

    /*
      CHoCH
    */

    if (
      x.choch ===
      "BULLISH"
    ) {
      add(
        "L",
        9 * w,
        "CHoCH صعودی"
      );
    }

    if (
      x.choch ===
      "BEARISH"
    ) {
      add(
        "S",
        9 * w,
        "CHoCH نزولی"
      );
    }

    /*
      FVG
    */

    if (
      x.fvg ===
      "BULLISH"
    ) {
      add(
        "L",
        6 * w,
        "FVG صعودی"
      );
    }

    if (
      x.fvg ===
      "BEARISH"
    ) {
      add(
        "S",
        6 * w,
        "FVG نزولی"
      );
    }

    /*
      Order Block
    */

    if (
      x.orderBlock ===
      "BULLISH"
    ) {
      add(
        "L",
        8 * w,
        "Order Block صعودی"
      );
    }

    if (
      x.orderBlock ===
      "BEARISH"
    ) {
      add(
        "S",
        8 * w,
        "Order Block نزولی"
      );
    }

    /*
      Volume Spike
    */

    if (
      x.volume.spike
    ) {
      add(
        x.trend ===
          "BEARISH"
          ? "S"
          : "L",

        5 * w,

        "افزایش غیرعادی حجم کوتاه‌مدت"
      );
    }
  }


  /*
    Converted MA Events
  */

  for (
    const e of
      converted.events.filter(
        x =>
          x.type !==
          "NONE"
      )
  ) {
    const w =
      e.source === "1h"
        ? 1.5
        : e.source === "15m"
          ? 1.3
          : e.source === "5m"
            ? 1.15
            : 1;

    /*
      Confirmed Long
    */

    if (
      e.confirmation ===
      "CONFIRMED_LONG"
    ) {
      add(
        "L",
        12 * w,

        `${e.ma} ${e.source} → MA${e.period1m} روی 1m: برخورد و تأیید صعودی`
      );
    }

    /*
      Confirmed Short
    */

    else if (
      e.confirmation ===
      "CONFIRMED_SHORT"
    ) {
      add(
        "S",
        12 * w,

        `${e.ma} ${e.source} → MA${e.period1m} روی 1m: برخورد و تأیید نزولی`
      );
    }

    /*
      فقط Touch/Rejection
    */

    else if (
      e.type ===
        "TOUCH" ||
      e.type ===
        "REJECTION"
    ) {
      if (
        e.slope ===
        "UP"
      ) {
        add(
          "L",
          5 * w,

          `${e.ma} ${e.source} → MA${e.period1m}: برخورد با شیب صعودی`
        );
      }

      if (
        e.slope ===
        "DOWN"
      ) {
        add(
          "S",
          5 * w,

          `${e.ma} ${e.source} → MA${e.period1m}: برخورد با شیب نزولی`
        );
      }
    }
  }

  return {
    L,
    S,
    reasons
  };
}


/* =========================
   DEEP ANALYSIS
========================= */

async function deepAnalyze(
  category,
  symbol
) {
  const tf = {};

  let oneMinute = [];

  /*
    1 Minute
  */

  try {
    oneMinute =
      await klines(
        category,
        symbol,
        "1",
        DEEP_1M_LIMIT
      );

    tf["1"] =
      analyzeCandles(
        oneMinute.slice(-100)
      );

  } catch (e) {
    tf["1"] = {
      error: e.message
    };
  }


  /*
    3m / 5m / 15m / 1h
  */

  for (
    const x of TF.filter(
      z => z.interval !== "1"
    )
  ) {
    try {
      tf[x.key] =
        analyzeCandles(
          await klines(
            category,
            symbol,
            x.interval,
            100
          )
        );

    } catch (e) {
      tf[x.key] = {
        error: e.message
      };
    }
  }


  /*
    Converted MA
  */

  const converted =
    oneMinute.length
      ? convertedMAEvents(
          oneMinute
        )
      : {
          events: [],
          recent: [],
          latest: null
        };


  const valid =
    Object.values(tf)
      .filter(
        x => !x.error
      );

  const price =
    valid.at(0)?.price ||
    0;


  /*
    Footprint
  */

  const fp =
    await footprint(
      category,
      symbol
    );


  /*
    Order Book
  */

  const wall =
    await walls(
      category,
      symbol,
      price
    );


  /*
    Futures data
  */

  const market =
    category ===
    "linear"

      ? await oiFunding(
          symbol
        )

      : {
          openInterest: null,
          fundingRate: null,
          turnover24h: null,
          change24h: null
        };


  /*
    Score
  */

  const sc =
    score(
      tf,
      converted
    );


  /*
    Footprint confirmation
  */

  if (
    fp &&
    !fp.error
  ) {
    if (
      fp.deltaPercent >=
      8
    ) {
      sc.L += 10;
    }

    if (
      fp.deltaPercent <=
      -8
    ) {
      sc.S += 10;
    }
  }


  /*
    Walls
  */

  if (
    wall.sellNear
  ) {
    sc.S += 3;
  }

  if (
    wall.buyNear
  ) {
    sc.L += 3;
  }


  /*
    Final Direction
  */

  const direction =
    sc.L > sc.S &&
    sc.L >= 45

      ? "LONG"

      : sc.S > sc.L &&
        sc.S >= 45

        ? "SHORT"

        : "WAIT";


  const top =
    direction === "LONG"
      ? sc.L
      : direction === "SHORT"
        ? sc.S
        : Math.max(
            sc.L,
            sc.S
          );


  /*
    Pump Probability
  */

  const pump =
    clamp(
      (sc.L * 1.2) +

      (
        market.change24h > 0
          ? market.change24h * 2
          : 0
      ) +

      (
        tf["1"]?.volume.spike
          ? 15
          : 0
      ) +

      (
        tf["5"]?.volume.spike
          ? 10
          : 0
      ),

      0,
      100
    );


  /*
    Dump Probability
  */

  const dump =
    clamp(
      (sc.S * 1.2) +

      (
        market.change24h < 0
          ? Math.abs(
              market.change24h
            ) * 2
          : 0
      ) +

      (
        tf["1"]?.volume.spike
          ? 15
          : 0
      ) +

      (
        tf["5"]?.volume.spike
          ? 10
          : 0
      ),

      0,
      100
    );


  return {
    symbol,
    category,

    price,

    direction,

    score:
      Math.round(
        clamp(
          top,
          0,
          100
        )
      ),

    pumpScore:
      Math.round(
        pump
      ),

    dumpScore:
      Math.round(
        dump
      ),

    /*
      تمام تایم‌فریم‌ها
    */

    timeframes: tf,

    /*
      MAهای تبدیل‌شده روی 1m
    */

    convertedMA1m:
      converted,

    /*
      Footprint
    */

    footprint: fp,

    /*
      Order Book
    */

    walls: wall,

    /*
      OI / Funding
    */

    market,

    /*
      دلایل سیگنال
    */

    reasons:
      sc.reasons,

    /*
      زمان تولید نتیجه
    */

    generatedAt:
      Date.now(),

    /*
      Liquidation واقعی
    */

    liquidation: {
      available: false,

      message:
        "داده لیکوئیدیشن تجمیعی از REST عمومی Bybit برای این اسکنر در دسترس نیست."
    }
  };
}


/* =========================
   INSTRUMENTS
========================= */

async function instruments(
  category
) {
  const d =
    await bybit(
      "/v5/market/instruments-info",
      {
        category,
        limit: 1000
      }
    );

  return (
    d?.result?.list ||
    []
  );
}


/* =========================
   MANUAL SEARCH
========================= */

async function findSymbol(
  input
) {
  const raw =
    String(input || "")
      .trim()
      .toUpperCase();

  const bare =
    raw
      .replace(
        /[-_/:\s]/g,
        ""
      )
      .replace(
        /USDT$/,
        ""
      );

  const [
    lin,
    spot
  ] = await Promise.all([
    instruments("linear"),
    instruments("spot")
  ]);

  const l =
    lin.find(
      x =>
        String(x.symbol)
          .toUpperCase() ===
          raw ||

        String(x.symbol)
          .toUpperCase() ===
          bare + "USDT"
    );

  const s =
    spot.find(
      x =>
        String(x.symbol)
          .toUpperCase() ===
          raw ||

        String(x.symbol)
          .toUpperCase() ===
          bare + "USDT"
    );

  return {
    input: raw,

    futures:
      l
        ? {
            symbol: l.symbol,
            status: l.status,
            baseCoin: l.baseCoin,
            quoteCoin: l.quoteCoin
          }
        : null,

    spot:
      s
        ? {
            symbol: s.symbol,
            status: s.status,
            baseCoin: s.baseCoin,
            quoteCoin: s.quoteCoin
          }
        : null
  };
}


/* =========================
   ROTATING MARKET SCAN
========================= */

async function scan(
  offset = 0
) {
  const ms =
    (
      await instruments(
        "linear"
      )
    ).filter(
      x =>
        x.status ===
          "Trading" &&

        x.quoteCoin ===
          "USDT" &&

        x.contractType ===
          "LinearPerpetual"
    );


  /*
    مرتب‌سازی ثابت
    برای اسکن چرخشی
  */

  const list =
    ms.sort(
      (a, b) =>
        String(
          a.symbol
        ).localeCompare(
          String(
            b.symbol
          )
        )
    );


  const batch =
    list.slice(
      offset,
      offset +
        SCAN_BATCH
    );


  const light = [];


  /*
    مرحله سبک:
    فقط برای پیدا کردن Trigger
  */

  for (
    const m of batch
  ) {
    try {
      const c =
        analyzeCandles(
          await klines(
            "linear",
            m.symbol,
            "1",
            60
          )
        );

      const activity =
        (
          c.touchMA20
            ? 30
            : 0
        ) +

        (
          c.volume.spike
            ? 25
            : 0
        ) +

        (
          c.market.state ===
          "ACTIVE"
            ? 20
            : 0
        ) +

        (
          c.hunt.side !==
          "NONE"
            ? 20
            : 0
        ) +

        (
          c.maSlope !==
          "FLAT"
            ? 5
            : 0
        );

      light.push({
        symbol:
          m.symbol,

        activity,

        tf1: c
      });

    } catch (e) {
      /*
        خطای یک ارز
        نباید کل اسکن متوقف شود
      */
    }
  }


  /*
    بالاترین Triggerها
  */

  light.sort(
    (a, b) =>
      b.activity -
      a.activity
  );


  /*
    فقط تعداد محدود
    وارد تحلیل سنگین می‌شوند
  */

  const deep =
    await Promise.all(
      light
        .slice(
          0,
          DEEP_LIMIT
        )
        .map(
          x =>
            deepAnalyze(
              "linear",
              x.symbol
            )
        )
    );


  deep.sort(
    (a, b) =>
      b.score -
      a.score
  );


  const next =
    list.length
      ? (
          offset +
          SCAN_BATCH
        ) %
        list.length
      : 0;


  return {
    ok: true,

    totalMarkets:
      list.length,

    offset,

    batchSize:
      batch.length,

    nextOffset:
      next,

    results:
      deep,

    scannedSymbols:
      batch.map(
        x => x.symbol
      ),

    note:
      "حجم ۲۴ساعته فقط اطلاعات جانبی است و معیار انتخاب نیست؛ اسکن بازار به‌صورت چرخشی انجام می‌شود تا محدودیت درخواست Cloudflare رعایت شود."
  };
}


/* =========================
   CLOUDFLARE WORKER
========================= */

export default {
  async fetch(
    request,
    env
  ) {
    const u =
      new URL(
        request.url
      );

    const p =
      u.pathname;

    try {

      /* =====================
         MANUAL SEARCH
      ===================== */

      if (
        p ===
        "/api/search"
      ) {
        const q =
          u.searchParams.get(
            "symbol"
          );

        if (!q) {
          return json(
            {
              ok: false,
              error:
                "نماد وارد نشده است."
            },
            400
          );
        }

        return json({
          ok: true,
          ...await findSymbol(q)
        });
      }


      /* =====================
         MANUAL DEEP ANALYSIS
      ===================== */

      if (
        p ===
        "/api/analyze"
      ) {
        const symbol =
          u.searchParams.get(
            "symbol"
          );

        const category =
          (
            u.searchParams.get(
              "category"
            ) || "linear"
          ) === "spot"
            ? "spot"
            : "linear";


        if (!symbol) {
          return json(
            {
              ok: false,
              error:
                "نماد وارد نشده است."
            },
            400
          );
        }


        const found =
          await findSymbol(
            symbol
          );


        const chosen =
          category ===
          "spot"
            ? found.spot
            : found.futures;


        if (!chosen) {
          return json(
            {
              ok: false,

              error:
                `${category === "spot" ? "Spot" : "Futures"} برای ${symbol} در Bybit پیدا نشد.`,

              search:
                found
            },
            404
          );
        }


        return json({
          ok: true,

          ...await deepAnalyze(
            category,
            chosen.symbol
          ),

          search:
            found
        });
      }


      /* =====================
         ROTATING SCAN
      ===================== */

      if (
        p ===
        "/api/scan"
      ) {
        return json(
          await scan(
            n(
              u.searchParams.get(
                "offset"
              ),
              0
            )
          )
        );
      }


      /* =====================
         HEALTH
      ===================== */

      if (
        p ===
        "/api/health"
      ) {
        return json({
          ok: true,

          service:
            "Bybit Scanner V7",

          timeframes:
            TF.map(
              x =>
                x.interval
            ),

          scanBatch:
            SCAN_BATCH,

          deepLimit:
            DEEP_LIMIT,

          convertedMA:
            CONVERTED_MAS
        });
      }


      /*
        فایل‌های Frontend
      */

      return env.ASSETS.fetch(
        request
      );


    } catch (e) {

      return json(
        {
          ok: false,

          error:
            e.message,

          detail:
            String(
              e.stack || ""
            ).slice(
              0,
              1200
            )
        },
        500
      );
    }
  }
};
