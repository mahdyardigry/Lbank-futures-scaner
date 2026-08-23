const BYBIT = "https://api.bybit.com";

const SCAN_BATCH = 50;
const LIQUID_MARKETS = 200;
const TOP_SIGNALS = 10;

const DEEP_LIMIT = 10;
const RADAR_LIMIT = 10;
const DEEP_1M_LIMIT = 1300;

/* =========================================================
   TIMEFRAMES
========================================================= */

const TF = [
  {key:"1", label:"1 دقیقه", interval:"1", priority:"MA20"},
  {key:"3", label:"3 دقیقه", interval:"3", priority:"MA7/20"},
  {key:"5", label:"5 دقیقه", interval:"5", priority:"MA7/20"},
  {key:"15", label:"15 دقیقه", interval:"15", priority:"MA7/20"},
  {key:"60", label:"1 ساعت", interval:"60", priority:"MA7/20"}
];

const CONVERTED_MAS = [
  {source:"1m", ma:20, period:20},

  {source:"3m", ma:7, period:21},
  {source:"3m", ma:20, period:60},

  {source:"5m", ma:7, period:35},
  {source:"5m", ma:20, period:100},

  {source:"15m", ma:7, period:105},
  {source:"15m", ma:20, period:300},

  {source:"1h", ma:7, period:420},
  {source:"1h", ma:20, period:1200}
];

/* =========================================================
   6 REAL SIGNAL STRICTNESS LEVELS

   با افزایش level:
   - حداقل تعداد شواهد بیشتر می‌شود
   - حداقل امتیاز بیشتر می‌شود
   - HTF لازم می‌شود
   - Structure لازم می‌شود
   - Flow لازم می‌شود
   - Volume لازم می‌شود

   این سطح فقط ظاهر UI نیست و مستقیماً
   روی عبور سیگنال از فیلتر اثر می‌گذارد.
========================================================= */

const SIGNAL_LEVELS = {

  VERY_LOW:{
    label:"خیلی کم",
    minEvidence:2,
    minScore:45,
    requireHTF:false,
    requireStructure:false,
    requireFlow:false,
    requireVolume:false
  },

  LOW:{
    label:"کم",
    minEvidence:3,
    minScore:55,
    requireHTF:false,
    requireStructure:false,
    requireFlow:false,
    requireVolume:false
  },

  MEDIUM:{
    label:"متوسط",
    minEvidence:4,
    minScore:65,
    requireHTF:false,
    requireStructure:true,
    requireFlow:false,
    requireVolume:false
  },

  HIGH:{
    label:"زیاد",
    minEvidence:5,
    minScore:75,
    requireHTF:true,
    requireStructure:true,
    requireFlow:true,
    requireVolume:true
  },

  VERY_HIGH:{
    label:"خیلی زیاد",
    minEvidence:6,
    minScore:85,
    requireHTF:true,
    requireStructure:true,
    requireFlow:true,
    requireVolume:true
  },

  EXTREME:{
    label:"فوق‌العاده سخت",
    minEvidence:7,
    minScore:92,
    requireHTF:true,
    requireStructure:true,
    requireFlow:true,
    requireVolume:true
  }
};

/* =========================================================
   ONLY REAL METHODS PRESENT IN THIS WORKER

   MACD / RSI / ICHIMOKU / DIVERGENCE عمداً وجود ندارند.
========================================================= */

const SIGNAL_METHODS = [
  "MA",
  "CONVERTED_MA",
  "HUNT",
  "BOS",
  "CHoCH",
  "FVG",
  "ORDER_BLOCK",
  "VOLUME",
  "FOOTPRINT",
  "ORDER_BOOK"
];

function getSignalSettings(input={}){

  let level=
    String(
      input.level || "MEDIUM"
    ).toUpperCase();

  if(!SIGNAL_LEVELS[level]){
    level="MEDIUM";
  }

  let methods=input.methods;

  if(typeof methods==="string"){

    methods=
      methods
        .split(",")
        .map(
          x=>x.trim().toUpperCase()
        )
        .filter(
          x=>SIGNAL_METHODS.includes(x)
        );
  }

  if(!Array.isArray(methods)||!methods.length){
    methods=[...SIGNAL_METHODS];
  }

  return {
    level,
    ...SIGNAL_LEVELS[level],
    methods
  };
}

/* =========================================================
   BASIC
========================================================= */

const json=(data,status=200)=>
  new Response(
    JSON.stringify(data),
    {
      status,
      headers:{
        "content-type":
          "application/json; charset=UTF-8",
        "cache-control":"no-store"
      }
    }
  );

const n=(v,d=0)=>
  Number.isFinite(Number(v))
    ? Number(v)
    : d;

const clamp=(v,a,b)=>
  Math.max(a,Math.min(b,v));

const avg=a=>
  a.length
    ? a.reduce((x,y)=>x+y,0)/a.length
    : 0;

function pct(a,b){

  if(!b) return 0;

  return ((a-b)/b)*100;
}

function absPct(a,b){

  if(!b) return 999;

  return Math.abs(
    (a-b)/b
  )*100;
}

/* =========================================================
   BYBIT
========================================================= */

async function bybit(path,params={}){

  const u=
    new URL(
      BYBIT+path
    );

  for(
    const [k,v]
    of Object.entries(params)
  ){

    if(
      v!==undefined &&
      v!==null
    ){

      u.searchParams.set(
        k,
        String(v)
      );
    }
  }

  const r=
    await fetch(
      u,
      {
        headers:{
          accept:"application/json"
        }
      }
    );

  if(!r.ok){

    throw new Error(
      `Bybit HTTP ${r.status}`
    );
  }

  const d=await r.json();

  if(d.retCode!==0){

    throw new Error(
      d.retMsg ||
      `Bybit ${d.retCode}`
    );
  }

  return d;
}

/* =========================================================
   KLINES
========================================================= */

async function klines(
  category,
  symbol,
  interval,
  limit=100
){

  const d=
    await bybit(
      "/v5/market/kline",
      {
        category,
        symbol,
        interval,
        limit
      }
    );

  return (
    d?.result?.list||[]
  )
    .reverse()
    .map(k=>({

      time:n(k[0]),
      open:n(k[1]),
      high:n(k[2]),
      low:n(k[3]),
      close:n(k[4]),
      volume:n(k[5]),
      turnover:n(k[6])

    }));
}

/* =========================================================
   MA
========================================================= */

function sma(a,p){

  if(!a.length) return 0;

  return a.length<p
    ? avg(a)
    : avg(a.slice(-p));
}

function ema(a,p){

  if(!a.length) return 0;

  const k=2/(p+1);

  let x=a[0];

  for(
    let i=1;
    i<a.length;
    i++
  ){

    x=
      a[i]*k+
      x*(1-k);
  }

  return x;
}

/* =========================================================
   ATR / ADX / BB
========================================================= */

function atr(c,p=14){

  if(c.length<2) return 0;

  const tr=
    c.slice(1).map(
      (x,i)=>{

        const prev=
          c[i].close;

        return Math.max(
          x.high-x.low,
          Math.abs(
            x.high-prev
          ),
          Math.abs(
            x.low-prev
          )
        );
      }
    );

  return sma(tr,p);
}

function adx(c,p=14){

  if(c.length<p*2+1) return 0;

  const trs=[];
  const plus=[];
  const minus=[];

  for(
    let i=1;
    i<c.length;
    i++
  ){

    const x=c[i];
    const q=c[i-1];

    trs.push(
      Math.max(
        x.high-x.low,
        Math.abs(
          x.high-q.close
        ),
        Math.abs(
          x.low-q.close
        )
      )
    );

    const up=
      x.high-q.high;

    const dn=
      q.low-x.low;

    plus.push(
      up>dn&&up>0
        ? up
        : 0
    );

    minus.push(
      dn>up&&dn>0
        ? dn
        : 0
    );
  }

  const out=[];

  for(
    let i=p;
    i<trs.length;
    i++
  ){

    const tr=
      avg(
        trs.slice(i-p,i)
      )||1;

    const diP=
      100*
      avg(
        plus.slice(i-p,i)
      )/tr;

    const diM=
      100*
      avg(
        minus.slice(i-p,i)
      )/tr;

    const dx=
      diP+diM
        ? 100*
          Math.abs(
            diP-diM
          )/
          (diP+diM)
        : 0;

    out.push(dx);
  }

  return avg(
    out.slice(-p)
  );
}

function bollWidth(c,p=20){

  const a=
    c.slice(-p)
      .map(x=>x.close);

  if(!a.length) return 0;

  const m=avg(a);

  const sd=
    Math.sqrt(
      avg(
        a.map(
          x=>(x-m)**2
        )
      )
    );

  return m
    ? 4*sd/m*100
    : 0;
}

function rangeState(
  c,
  ma7,
  ma20,
  slope,
  volSpike
){

  if(!c.length){

    return {
      state:"UNKNOWN",
      adx:0,
      atr:0,
      atrPct:0,
      bollWidth:0,
      maGap:0
    };
  }

  const price=
    c.at(-1).close;

  const a=atr(c);

  const atrPct=
    price
      ? a/price*100
      : 0;

  const adxV=adx(c);
  const bw=bollWidth(c);

  const maGap=
    ma20
      ? Math.abs(
          ma7-ma20
        )/ma20*100
      : 0;

  const isRange=
    adxV<18 &&
    bw<1.8 &&
    Math.abs(slope)<0.0007;

  const waking=
    !isRange &&
    (
      adxV>=18||
      bw>=1.8||
      volSpike
    );

  return {

    state:
      isRange
        ? "RANGE"
        : waking
          ? "ACTIVE"
          : "TRANSITION",

    adx:adxV,
    atr:a,
    atrPct,
    bollWidth:bw,
    maGap
  };
}

/* =========================================================
   SWINGS
========================================================= */

function swingLevels(
  c,
  lookback=3
){

  const highs=[];
  const lows=[];

  for(
    let i=lookback;
    i<c.length-lookback;
    i++
  ){

    let high=true;
    let low=true;

    for(
      let j=1;
      j<=lookback;
      j++
    ){

      if(
        c[i].high<=c[i-j].high||
        c[i].high<c[i+j].high
      ){
        high=false;
      }

      if(
        c[i].low>=c[i-j].low||
        c[i].low>c[i+j].low
      ){
        low=false;
      }
    }

    if(high){

      highs.push({
        price:c[i].high,
        time:c[i].time,
        index:i
      });
    }

    if(low){

      lows.push({
        price:c[i].low,
        time:c[i].time,
        index:i
      });
    }
  }

  return {
    highs,
    lows
  };
}

/* =========================================================
   LIQUIDITY HUNT / SWEEP
========================================================= */

function hunt(c){

  if(c.length<25){

    return {
      type:"NONE",
      side:"NONE",
      confirmed:false
    };
  }

  const x=c.at(-1);

  const prev=
    c.slice(-21,-1);

  const hi=
    Math.max(
      ...prev.map(
        z=>z.high
      )
    );

  const lo=
    Math.min(
      ...prev.map(
        z=>z.low
      )
    );

  const range=
    x.high-x.low||1;

  const lowerWick=
    Math.min(
      x.open,
      x.close
    )-x.low;

  const upperWick=
    x.high-
    Math.max(
      x.open,
      x.close
    );

  const volAvg=
    sma(
      prev.map(
        z=>z.volume
      ),
      20
    );

  const volumeConfirm=
    volAvg>0&&
    x.volume>=volAvg*1.15;

  const longSweep=
    x.low<lo&&
    x.close>lo&&
    lowerWick/range>=0.25;

  const shortSweep=
    x.high>hi&&
    x.close<hi&&
    upperWick/range>=0.25;

  if(longSweep){

    return {

      type:"LIQUIDITY_SWEEP",
      side:"LONG",
      level:lo,

      wickPct:
        lowerWick/range*100,

      volumeConfirmed:
        volumeConfirm,

      confirmed:
        volumeConfirm||
        lowerWick/range>=0.4
    };
  }

  if(shortSweep){

    return {

      type:"LIQUIDITY_SWEEP",
      side:"SHORT",
      level:hi,

      wickPct:
        upperWick/range*100,

      volumeConfirmed:
        volumeConfirm,

      confirmed:
        volumeConfirm||
        upperWick/range>=0.4
    };
  }

  return {
    type:"NONE",
    side:"NONE",
    confirmed:false
  };
}

/* =========================================================
   FVG
========================================================= */

function detectFVG(c){

  if(c.length<3){

    return {
      type:"NONE",
      low:null,
      high:null
    };
  }

  const a=c.at(-3);
  const b=c.at(-2);
  const x=c.at(-1);

  if(x.low>a.high){

    return {

      type:"BULLISH",

      low:a.high,
      high:x.low,

      size:
        x.low-a.high,

      candle:b.time
    };
  }

  if(x.high<a.low){

    return {

      type:"BEARISH",

      low:x.high,
      high:a.low,

      size:
        a.low-x.high,

      candle:b.time
    };
  }

  return {
    type:"NONE",
    low:null,
    high:null
  };
}

/* =========================================================
   STRUCTURE
========================================================= */

function detectStructure(c){

  if(c.length<15){

    return {
      bos:"NONE",
      choch:"NONE"
    };
  }

  const s=
    swingLevels(c,2);

  const highs=s.highs;
  const lows=s.lows;

  const lastHigh=
    highs.length
      ? highs.at(-1).price
      : null;

  const prevHigh=
    highs.length>1
      ? highs.at(-2).price
      : null;

  const lastLow=
    lows.length
      ? lows.at(-1).price
      : null;

  const prevLow=
    lows.length>1
      ? lows.at(-2).price
      : null;

  const price=
    c.at(-1).close;

  let bos="NONE";
  let choch="NONE";

  if(
    lastHigh&&
    price>lastHigh
  ){
    bos="BULLISH";
  }

  if(
    lastLow&&
    price<lastLow
  ){
    bos="BEARISH";
  }

  if(
    prevHigh&&
    prevLow&&
    lastLow&&
    lastHigh
  ){

    if(
      lastLow>prevLow&&
      lastHigh>prevHigh&&
      price<lastLow
    ){

      choch="BEARISH";
    }

    if(
      lastLow<prevLow&&
      lastHigh<prevHigh&&
      price>lastHigh
    ){

      choch="BULLISH";
    }
  }

  return {

    bos,
    choch,

    swingHigh:lastHigh,
    swingLow:lastLow,

    previousSwingHigh:
      prevHigh,

    previousSwingLow:
      prevLow
  };
}

/* =========================================================
   ORDER BLOCK
========================================================= */

function detectOrderBlock(c){

  if(c.length<8){

    return {
      type:"NONE"
    };
  }

  const x=c.at(-1);

  for(
    let i=c.length-4;
    i>=Math.max(
      0,
      c.length-12
    );
    i--
  ){

    const z=c[i];

    if(
      z.close<z.open&&
      x.close>z.high
    ){

      return {

        type:"BULLISH",

        low:z.low,
        high:z.high,
        time:z.time
      };
    }

    if(
      z.close>z.open&&
      x.close<z.low
    ){

      return {

        type:"BEARISH",

        low:z.low,
        high:z.high,
        time:z.time
      };
    }
  }

  return {
    type:"NONE"
  };
}

/* =========================================================
   CANDLE
========================================================= */

function candleAnalysis(c){

  if(c.length<3){

    return {
      type:"NONE",
      bullish:false,
      bearish:false
    };
  }

  const x=c.at(-1);
  const p=c.at(-2);

  const body=
    Math.abs(
      x.close-x.open
    );

  const range=
    x.high-x.low||1;

  const upper=
    x.high-
    Math.max(
      x.open,
      x.close
    );

  const lower=
    Math.min(
      x.open,
      x.close
    )-x.low;

  const bodyRatio=
    body/range;

  let type="NORMAL";

  if(
    lower>body*2&&
    lower/range>.45
  ){
    type="HAMMER";
  }

  if(
    upper>body*2&&
    upper/range>.45
  ){
    type="SHOOTING_STAR";
  }

  if(
    x.close>p.open&&
    x.open<p.close&&
    x.close>=p.close&&
    x.open<=p.open
  ){
    type="BULLISH_ENGULFING";
  }

  if(
    x.close<p.open&&
    x.open>p.close&&
    x.close<=p.close&&
    x.open>=p.open
  ){
    type="BEARISH_ENGULFING";
  }

  if(bodyRatio<.15){
    type="DOJI";
  }

  return {

    type,

    bullish:
      x.close>x.open,

    bearish:
      x.close<x.open,

    body,
    range,
    bodyRatio,

    upperWick:upper,
    lowerWick:lower
  };
}

/* =========================================================
   CANDLE ANALYSIS
========================================================= */

function analyzeCandles(c){

  if(c.length<25){

    return {
      error:"کندل کافی نیست"
    };
  }

  const close=
    c.map(x=>x.close);

  const vol=
    c.map(x=>x.volume);

  const price=
    close.at(-1);

  const ma7=sma(close,7);
  const ma20=sma(close,20);

  const prev20=
    sma(
      close.slice(0,-1),
      20
    );

  const slope=
    prev20
      ? (ma20-prev20)/prev20
      : 0;

  const prevPrice=
    close.at(-2);

  const high=
    c.at(-1).high;

  const low=
    c.at(-1).low;

  const touch20=
    Math.abs(
      price-ma20
    )/ma20<=.0015||
    (
      low<=ma20&&
      high>=ma20
    )||
    (
      (prevPrice-ma20)*
      (price-ma20)<=0
    );

  const touch7=
    Math.abs(
      price-ma7
    )/ma7<=.0015||
    (
      low<=ma7&&
      high>=ma7
    )||
    (
      (prevPrice-ma7)*
      (price-ma7)<=0
    );

  const vol7=sma(vol,7);
  const vol20=sma(vol,20);

  const spike=
    vol.at(-1)>vol20*1.5||
    vol.at(-1)>vol7*1.8;

  const rs=
    rangeState(
      c,
      ma7,
      ma20,
      slope,
      spike
    );

  const trend=
    price>ma20&&ma7>ma20
      ? "BULLISH"
      : price<ma20&&ma7<ma20
        ? "BEARISH"
        : "RANGE";

  const candleDetails=
    candleAnalysis(c);

  const structure=
    detectStructure(c);

  return {

    price,

    ma7,
    ma20,

    maSlope:
      slope>.00007
        ? "UP"
        : slope<-.00007
          ? "DOWN"
          : "FLAT",

    slopePct:
      slope*100,

    touchMA20:touch20,
    touchMA7:touch7,

    trend,

    volume:{

      current:
        vol.at(-1),

      ma7:vol7,
      ma20:vol20,

      spike,

      ratio20:
        vol20
          ? vol.at(-1)/vol20
          : 0
    },

    market:rs,

    hunt:hunt(c),

    candle:candleDetails.type,

    candleDetails,

    fvg:detectFVG(c),

    bos:structure.bos,
    choch:structure.choch,

    structure,

    orderBlock:
      detectOrderBlock(c),

    timestamp:
      c.at(-1).time
  };
}

/* =========================================================
   CONVERTED MA
========================================================= */

function maValueSeries(
  c,
  p,
  type="SMA"
){

  const out=[];

  for(
    let i=0;
    i<c.length;
    i++
  ){

    const a=
      c.slice(
        Math.max(
          0,
          i-p+1
        ),
        i+1
      )
      .map(
        x=>x.close
      );

    if(a.length>=p){

      out.push(
        type==="EMA"
          ? ema(a,p)
          : avg(a)
      );

    }else{

      out.push(null);
    }
  }

  return out;
}

function convertedMAEvents(c){

  const price=
    c.at(-1)?.close||0;

  const prev=
    c.at(-2)?.close||price;

  const events=[];

  for(
    const m of CONVERTED_MAS
  ){

    const vals=
      maValueSeries(
        c,
        m.period,
        "SMA"
      );

    const ma=vals.at(-1);
    const prevMA=vals.at(-2);

    if(!ma||!prevMA) continue;

    const slopePct=
      (ma-prevMA)/
      prevMA*100;

    const candle=c.at(-1);

    const range=
      candle.high-
      candle.low||1;

    const lower=
      Math.min(
        candle.open,
        candle.close
      )-candle.low;

    const upper=
      candle.high-
      Math.max(
        candle.open,
        candle.close
      );

    const dist=
      price-ma;

    const prevDist=
      prev-prevMA;

    const touch=
      Math.abs(dist)/ma<=.0015||
      (
        candle.low<=ma&&
        candle.high>=ma
      )||
      (
        prevDist*dist<=0
      );

    const crossUp=
      prev<=prevMA&&
      price>ma;

    const crossDown=
      prev>=prevMA&&
      price<ma;

    const bullishRejection=
      candle.low<=ma&&
      candle.close>ma&&
      candle.close>candle.open&&
      lower/range>=.25;

    const bearishRejection=
      candle.high>=ma&&
      candle.close<ma&&
      candle.close<candle.open&&
      upper/range>=.25;

    const rejection=
      bullishRejection||
      bearishRejection;

    const slope=
      Math.abs(slopePct)<.003
        ? "FLAT"
        : slopePct>0
          ? "UP"
          : "DOWN";

    const direction=
      bullishRejection||crossUp
        ? "LONG"
        : bearishRejection||crossDown
          ? "SHORT"
          : "NONE";

    const volumeAvg=
      sma(
        c.slice(-21,-1)
          .map(
            x=>x.volume
          ),
        20
      );

    const volumeConfirm=
      volumeAvg>0&&
      candle.volume>=
        volumeAvg*1.15;

    const trendConfirm=
      direction==="LONG"
        ? price>ma
        : direction==="SHORT"
          ? price<ma
          : false;

    const strictConfirmation=
      touch&&
      rejection&&
      slope!=="FLAT"&&
      trendConfirm&&
      volumeConfirm;

    const crossConfirmation=
      touch&&
      slope!=="FLAT"&&
      trendConfirm&&
      (
        crossUp||
        crossDown
      )&&
      volumeConfirm;

    let confirmation="WAIT";

    if(
      direction==="LONG"&&
      (
        strictConfirmation||
        crossConfirmation
      )
    ){

      confirmation=
        "CONFIRMED_LONG";
    }

    if(
      direction==="SHORT"&&
      (
        strictConfirmation||
        crossConfirmation
      )
    ){

      confirmation=
        "CONFIRMED_SHORT";
    }

    let type="NONE";

    if(touch){

      type=
        rejection
          ? "REJECTION"
          : crossUp||crossDown
            ? "BREAK"
            : "TOUCH";
    }

    events.push({

      source:m.source,

      ma:`MA${m.ma}`,

      period1m:m.period,

      time:candle.time,

      price,
      maValue:ma,

      type,
      direction,

      rejection,

      bullishRejection,
      bearishRejection,

      crossUp,
      crossDown,

      slope,
      slopePct,

      volumeConfirmed:
        volumeConfirm,

      confirmation,

      distancePct:
        (price-ma)/ma*100
    });
  }

  return {

    events,

    recent:
      events.filter(
        x=>x.type!=="NONE"
      ),

    confirmed:
      events.filter(
        x=>
          x.confirmation===
            "CONFIRMED_LONG"||
          x.confirmation===
            "CONFIRMED_SHORT"
      ),

    latest:
      events
        .filter(
          x=>x.type!=="NONE"
        )
        .at(-1)||null
  };
}

/* =========================================================
   FOOTPRINT
========================================================= */

async function footprint(
  category,
  symbol
){

  try{

    const d=
      await bybit(
        "/v5/market/recent-trade",
        {
          category,
          symbol,
          limit:200
        }
      );

    const t=
      d?.result?.list||[];

    let buy=0;
    let sell=0;

    let buyNotional=0;
    let sellNotional=0;

    let largest=0;

    const trades=[];

    for(
      const x of t
    ){

      const q=n(x.size);
      const p=n(x.price);

      const notional=
        q*p;

      largest=
        Math.max(
          largest,
          notional
        );

      const side=
        String(
          x.side
        ).toLowerCase();

      if(side==="buy"){

        buy+=q;
        buyNotional+=
          notional;

      }else{

        sell+=q;
        sellNotional+=
          notional;
      }

      trades.push({

        price:p,
        size:q,
        side,
        notional
      });
    }

    const total=
      buyNotional+
      sellNotional;

    const delta=
      buyNotional-
      sellNotional;

    return {

      buyVolume:buy,
      sellVolume:sell,

      buyNotional,
      sellNotional,

      delta,

      deltaPercent:
        total
          ? delta/total*100
          : 0,

      buyShare:
        total
          ? buyNotional/
            total*100
          : 0,

      sellShare:
        total
          ? sellNotional/
            total*100
          : 0,

      trades:t.length,

      largeTradeNotional:
        largest,

      recentTrades:
        trades
          .sort(
            (a,b)=>
              b.notional-
              a.notional
          )
          .slice(0,20)
    };

  }catch(e){

    return {
      error:e.message
    };
  }
}

/* =========================================================
   ORDER BOOK / WALLS
========================================================= */

async function walls(
  category,
  symbol,
  price
){

  try{

    const d=
      await bybit(
        "/v5/market/orderbook",
        {
          category,
          symbol,
          limit:50
        }
      );

    const bids=
      d?.result?.b||[];

    const asks=
      d?.result?.a||[];

    const buyLevels=[];
    const sellLevels=[];

    for(
      const q of bids
    ){

      const p=n(q[0]);
      const sz=n(q[1]);

      if(
        p<=0||
        sz<=0
      ) continue;

      const notional=p*sz;

      const distance=
        absPct(
          p,
          price
        );

      if(distance<=3){

        buyLevels.push({

          price:p,
          size:sz,
          notional,

          distancePct:
            distance
        });
      }
    }

    for(
      const q of asks
    ){

      const p=n(q[0]);
      const sz=n(q[1]);

      if(
        p<=0||
        sz<=0
      ) continue;

      const notional=p*sz;

      const distance=
        absPct(
          p,
          price
        );

      if(distance<=3){

        sellLevels.push({

          price:p,
          size:sz,
          notional,

          distancePct:
            distance
        });
      }
    }

    buyLevels.sort(
      (a,b)=>
        b.notional-
        a.notional
    );

    sellLevels.sort(
      (a,b)=>
        b.notional-
        a.notional
    );

    const buyLiquidity=
      buyLevels.reduce(
        (s,x)=>
          s+x.notional,
        0
      );

    const sellLiquidity=
      sellLevels.reduce(
        (s,x)=>
          s+x.notional,
        0
      );

    const totalLiquidity=
      buyLiquidity+
      sellLiquidity;

    const buyWall=
      buyLevels[0]||null;

    const sellWall=
      sellLevels[0]||null;

    const avgBuy=
      buyLevels.length
        ? avg(
            buyLevels.map(
              x=>x.notional
            )
          )
        : 0;

    const avgSell=
      sellLevels.length
        ? avg(
            sellLevels.map(
              x=>x.notional
            )
          )
        : 0;

    const buyStrength=
      buyWall&&avgBuy
        ? clamp(
            buyWall.notional/
            avgBuy*20,
            0,
            100
          )
        : 0;

    const sellStrength=
      sellWall&&avgSell
        ? clamp(
            sellWall.notional/
            avgSell*20,
            0,
            100
          )
        : 0;

    return {

      buy:buyWall,
      sell:sellWall,

      buyLevels:
        buyLevels.slice(0,10),

      sellLevels:
        sellLevels.slice(0,10),

      buyLiquidity,
      sellLiquidity,
      totalLiquidity,

      buyShare:
        totalLiquidity
          ? buyLiquidity/
            totalLiquidity*100
          : 0,

      sellShare:
        totalLiquidity
          ? sellLiquidity/
            totalLiquidity*100
          : 0,

      buyStrength,
      sellStrength,

      buyNear:
        buyWall
          ? buyWall.distancePct<=1
          : false,

      sellNear:
        sellWall
          ? sellWall.distancePct<=1
          : false
    };

  }catch(e){

    return {
      error:e.message
    };
  }
}

/* =========================================================
   SUPPORT / RESISTANCE
========================================================= */

function supportResistance(
  c,
  wall,
  price
){

  const s=
    swingLevels(c,3);

  const supports=[];
  const resistances=[];

  for(
    const x of s.lows
  ){

    if(x.price<price){

      supports.push({

        price:x.price,

        type:
          "SWING_SUPPORT",

        distancePct:
          absPct(
            x.price,
            price
          )
      });
    }
  }

  for(
    const x of s.highs
  ){

    if(x.price>price){

      resistances.push({

        price:x.price,

        type:
          "SWING_RESISTANCE",

        distancePct:
          absPct(
            x.price,
            price
          )
      });
    }
  }

  if(wall?.buyLevels){

    for(
      const x of wall.buyLevels
    ){

      if(x.price<price){

        supports.push({

          price:x.price,

          type:"BUY_WALL",

          liquidity:
            x.notional,

          distancePct:
            x.distancePct
        });
      }
    }
  }

  if(wall?.sellLevels){

    for(
      const x of wall.sellLevels
    ){

      if(x.price>price){

        resistances.push({

          price:x.price,

          type:"SELL_WALL",

          liquidity:
            x.notional,

          distancePct:
            x.distancePct
        });
      }
    }
  }

  supports.sort(
    (a,b)=>
      a.distancePct-
      b.distancePct
  );

  resistances.sort(
    (a,b)=>
      a.distancePct-
      b.distancePct
  );

  return {

    nearestSupport:
      supports[0]||null,

    nearestResistance:
      resistances[0]||null,

    strongestSupport:
      supports
        .filter(
          x=>x.liquidity
        )
        .sort(
          (a,b)=>
            (b.liquidity||0)-
            (a.liquidity||0)
        )[0]||
      supports[0]||
      null,

    strongestResistance:
      resistances
        .filter(
          x=>x.liquidity
        )
        .sort(
          (a,b)=>
            (b.liquidity||0)-
            (a.liquidity||0)
        )[0]||
      resistances[0]||
      null,

    supports:
      supports.slice(0,10),

    resistances:
      resistances.slice(0,10)
  };
}

/* =========================================================
   TICKER
========================================================= */

async function ticker(
  category,
  symbol
){

  const d=
    await bybit(
      "/v5/market/tickers",
      {
        category,
        symbol
      }
    );

  return (
    d?.result?.list?.[0]||
    {}
  );
}

/* =========================================================
   OI + FUNDING
   تغییر نسبت به مقدار قبلی واقعی است.

   OI:
   current OI در برابر مقدار قبلی History

   Funding:
   current funding در برابر Funding قبلی History

   برای Spot:
   تمام این مقادیر null هستند.
========================================================= */

async function oiFunding(symbol){

  try{

    const t=
      await ticker(
        "linear",
        symbol
      );

    const currentOI=
      n(
        t.openInterest,
        null
      );

    const currentFunding=
      n(
        t.fundingRate,
        null
      );

    const currentPrice=
      n(
        t.markPrice,
        null
      );

    let previousOI=null;
    let oiChange=null;

    let previousFunding=null;
    let fundingChange=null;

    /* -------------------------
       OI HISTORY
    ------------------------- */

    try{

      const d=
        await bybit(
          "/v5/market/open-interest",
          {
            category:"linear",
            symbol,
            intervalTime:"5min",
            limit:2
          }
        );

      const list=
        d?.result?.list||[];

      if(list.length>=2){

        previousOI=
          n(
            list[1].openInterest,
            null
          );

        if(
          previousOI!==null&&
          previousOI!==0&&
          currentOI!==null
        ){

          oiChange=
            (
              (
                currentOI-
                previousOI
              )/
              previousOI
            )*100;
        }
      }

    }catch(e){}

    /* -------------------------
       FUNDING HISTORY
    ------------------------- */

    try{

      const d=
        await bybit(
          "/v5/market/funding/history",
          {
            category:"linear",
            symbol,
            limit:2
          }
        );

      const list=
        d?.result?.list||[];

      if(list.length>=2){

        previousFunding=
          n(
            list[1].fundingRate,
            null
          );

        if(
          previousFunding!==null&&
          currentFunding!==null
        ){

          fundingChange=
            currentFunding-
            previousFunding;
        }
      }

    }catch(e){}

    return {

      openInterest:
        currentOI,

      previousOpenInterest:
        previousOI,

      oiChangePercent:
        oiChange,

      fundingRate:
        currentFunding,

      previousFundingRate:
        previousFunding,

      fundingChange:
        fundingChange,

      turnover24h:
        n(
          t.turnover24h,
          null
        ),

      volume24h:
        n(
          t.volume24h,
          null
        ),

      change24h:
        t.price24hPcnt!=null
          ? n(
              t.price24hPcnt,
              0
            )*100
          : null,

      markPrice:
        currentPrice,

      indexPrice:
        n(
          t.indexPrice,
          null
        ),

      oiDirection:
        oiChange===null
          ? "UNKNOWN"
          : oiChange>0
            ? "RISING"
            : oiChange<0
              ? "FALLING"
              : "FLAT",

      fundingDirection:
        fundingChange===null
          ? "UNKNOWN"
          : fundingChange>0
            ? "RISING"
            : fundingChange<0
              ? "FALLING"
              : "FLAT"
    };

  }catch(e){

    return {

      error:e.message,

      openInterest:null,
      previousOpenInterest:null,
      oiChangePercent:null,

      fundingRate:null,
      previousFundingRate:null,
      fundingChange:null
    };
  }
}

/* =========================================================
   SIGNAL ENGINE
========================================================= */

function signalEngine(
  tf,
  converted,
  fp,
  wall,
  market,
  settings
){

  const methods=
    settings.methods;

  let long=0;
  let short=0;

  const longReasons=[];
  const shortReasons=[];

  const evidenceL=
    new Set();

  const evidenceS=
    new Set();

  function add(
    direction,
    points,
    method,
    reason
  ){

    if(
      !methods.includes(method)
    ){
      return;
    }

    if(direction==="LONG"){

      long+=points;

      longReasons.push(reason);

      evidenceL.add(method);

    }

    if(direction==="SHORT"){

      short+=points;

      shortReasons.push(reason);

      evidenceS.add(method);
    }
  }

  /* =======================================================
     MA
  ======================================================= */

  for(
    const [k,x]
    of Object.entries(tf)
  ){

    if(!x||x.error) continue;

    const weight=
      k==="1"
        ? 1.5
        : k==="60"
          ? 1.3
          : 1;

    if(
      x.touchMA20&&
      x.maSlope==="UP"&&
      x.trend==="BULLISH"
    ){

      add(
        "LONG",
        8*weight,
        "MA",
        `MA20 تایم ${k}m صعودی`
      );
    }

    if(
      x.touchMA20&&
      x.maSlope==="DOWN"&&
      x.trend==="BEARISH"
    ){

      add(
        "SHORT",
        8*weight,
        "MA",
        `MA20 تایم ${k}m نزولی`
      );
    }

    if(
      x.touchMA7&&
      x.maSlope==="UP"&&
      x.trend==="BULLISH"
    ){

      add(
        "LONG",
        6*weight,
        "MA",
        `MA7 تایم ${k}m صعودی`
      );
    }

    if(
      x.touchMA7&&
      x.maSlope==="DOWN"&&
      x.trend==="BEARISH"
    ){

      add(
        "SHORT",
        6*weight,
        "MA",
        `MA7 تایم ${k}m نزولی`
      );
    }

    /* HUNT */

    if(x.hunt?.confirmed){

      if(x.hunt.side==="LONG"){

        add(
          "LONG",
          10*weight,
          "HUNT",
          `Liquidity Sweep صعودی ${k}m`
        );
      }

      if(x.hunt.side==="SHORT"){

        add(
          "SHORT",
          10*weight,
          "HUNT",
          `Liquidity Sweep نزولی ${k}m`
        );
      }
    }

    /* BOS */

    if(x.bos==="BULLISH"){

      add(
        "LONG",
        7*weight,
        "BOS",
        `BOS صعودی ${k}m`
      );
    }

    if(x.bos==="BEARISH"){

      add(
        "SHORT",
        7*weight,
        "BOS",
        `BOS نزولی ${k}m`
      );
    }

    /* CHoCH */

    if(x.choch==="BULLISH"){

      add(
        "LONG",
        9*weight,
        "CHoCH",
        `CHoCH صعودی ${k}m`
      );
    }

    if(x.choch==="BEARISH"){

      add(
        "SHORT",
        9*weight,
        "CHoCH",
        `CHoCH نزولی ${k}m`
      );
    }

    /* FVG */

    if(
      x.fvg?.type==="BULLISH"
    ){

      add(
        "LONG",
        4*weight,
        "FVG",
        `FVG صعودی ${k}m`
      );
    }

    if(
      x.fvg?.type==="BEARISH"
    ){

      add(
        "SHORT",
        4*weight,
        "FVG",
        `FVG نزولی ${k}m`
      );
    }

    /* ORDER BLOCK */

    if(
      x.orderBlock?.type===
      "BULLISH"
    ){

      add(
        "LONG",
        4*weight,
        "ORDER_BLOCK",
        `Order Block صعودی ${k}m`
      );
    }

    if(
      x.orderBlock?.type===
      "BEARISH"
    ){

      add(
        "SHORT",
        4*weight,
        "ORDER_BLOCK",
        `Order Block نزولی ${k}m`
      );
    }

    /* VOLUME */

    if(x.volume?.spike){

      if(
        x.trend==="BULLISH"
      ){

        add(
          "LONG",
          5*weight,
          "VOLUME",
          `Volume Spike صعودی ${k}m`
        );
      }

      if(
        x.trend==="BEARISH"
      ){

        add(
          "SHORT",
          5*weight,
          "VOLUME",
          `Volume Spike نزولی ${k}m`
        );
      }
    }
  }

  /* =======================================================
     CONVERTED MA
  ======================================================= */

  for(
    const e of converted?.confirmed||[]
  ){

    const weight=
      e.source==="1h"
        ? 1.5
        : e.source==="15m"
          ? 1.3
          : e.source==="5m"
            ? 1.15
            : 1;

    if(
      e.confirmation===
      "CONFIRMED_LONG"
    ){

      add(
        "LONG",
        12*weight,
        "CONVERTED_MA",
        `${e.ma} ${e.source} Trigger صعودی`
      );
    }

    if(
      e.confirmation===
      "CONFIRMED_SHORT"
    ){

      add(
        "SHORT",
        12*weight,
        "CONVERTED_MA",
        `${e.ma} ${e.source} Trigger نزولی`
      );
    }
  }

  /* =======================================================
     FOOTPRINT
  ======================================================= */

  if(
    fp&&!fp.error
  ){

    if(
      fp.deltaPercent>=8
    ){

      add(
        "LONG",
        10,
        "FOOTPRINT",
        `Footprint Delta مثبت ${fp.deltaPercent.toFixed(1)}%`
      );
    }

    if(
      fp.deltaPercent<=-8
    ){

      add(
        "SHORT",
        10,
        "FOOTPRINT",
        `Footprint Delta منفی ${fp.deltaPercent.toFixed(1)}%`
      );
    }
  }

  /* =======================================================
     ORDER BOOK
  ======================================================= */

  if(
    wall&&!wall.error
  ){

    if(
      wall.buyNear&&
      wall.buyStrength>=60
    ){

      add(
        "LONG",
        7,
        "ORDER_BOOK",
        "Buy Wall قوی نزدیک قیمت"
      );
    }

    if(
      wall.sellNear&&
      wall.sellStrength>=60
    ){

      add(
        "SHORT",
        7,
        "ORDER_BOOK",
        "Sell Wall قوی نزدیک قیمت"
      );
    }
  }

  /* =======================================================
     NOTE:
     OI و FUNDING در این نسخه فقط در MARKET DATA می‌مانند
     و در signalMethods قابل انتخاب نیستند.
     دلیل: کاربر خواسته روش‌های انتخابی فقط همان روش‌های
     محاسبه‌شده اصلی باشند.
  ======================================================= */

  /* =======================================================
     EVIDENCE
  ======================================================= */

  const evidenceLong=
    evidenceL.size;

  const evidenceShort=
    evidenceS.size;

  const hasStructureL=
    evidenceL.has("BOS")||
    evidenceL.has("CHoCH");

  const hasStructureS=
    evidenceS.has("BOS")||
    evidenceS.has("CHoCH");

  const hasFlowL=
    evidenceL.has("FOOTPRINT")||
    evidenceL.has("ORDER_BOOK");

  const hasFlowS=
    evidenceS.has("FOOTPRINT")||
    evidenceS.has("ORDER_BOOK");

  const hasVolumeL=
    evidenceL.has("VOLUME");

  const hasVolumeS=
    evidenceS.has("VOLUME");

  const htfBull=
    tf?.["15"]?.trend===
      "BULLISH"||
    tf?.["60"]?.trend===
      "BULLISH";

  const htfBear=
    tf?.["15"]?.trend===
      "BEARISH"||
    tf?.["60"]?.trend===
      "BEARISH";

  function qualifies(direction){

    const evidence=
      direction==="LONG"
        ? evidenceLong
        : evidenceShort;

    const structure=
      direction==="LONG"
        ? hasStructureL
        : hasStructureS;

    const flow=
      direction==="LONG"
        ? hasFlowL
        : hasFlowS;

    const volume=
      direction==="LONG"
        ? hasVolumeL
        : hasVolumeS;

    const htf=
      direction==="LONG"
        ? htfBull
        : htfBear;

    if(
      evidence<
      settings.minEvidence
    ){
      return false;
    }

    if(
      settings.requireStructure&&
      !structure
    ){
      return false;
    }

    if(
      settings.requireFlow&&
      !flow
    ){
      return false;
    }

    if(
      settings.requireVolume&&
      !volume
    ){
      return false;
    }

    if(
      settings.requireHTF&&
      !htf
    ){
      return false;
    }

    return true;
  }

  let direction="WAIT";
  let score=0;

  /*
     فقط جهت قوی‌تر می‌تواند سیگنال بدهد.
     اگر دو طرف نزدیک باشند، WAIT.
  */

  const margin=
    Math.abs(
      long-short
    );

  const strongest=
    Math.max(
      long,
      short
    );

  /*
     برای جلوگیری از سیگنال‌های تصادفی،
     طرف قوی باید حداقل 8 امتیاز از طرف مقابل
     جلو باشد.
  */

  if(
    strongest>0&&
    margin<8
  ){

    return {

      direction:"WAIT",

      score:0,

      longScore:
        Math.round(
          clamp(long,0,100)
        ),

      shortScore:
        Math.round(
          clamp(short,0,100)
        ),

      longEvidence:
        evidenceLong,

      shortEvidence:
        evidenceShort,

      longMethods:
        [...evidenceL],

      shortMethods:
        [...evidenceS],

      longReasons,
      shortReasons,

      settings:{
        level:settings.level,
        label:settings.label,
        minEvidence:
          settings.minEvidence,
        minScore:
          settings.minScore,
        requireHTF:
          settings.requireHTF,
        requireStructure:
          settings.requireStructure,
        requireFlow:
          settings.requireFlow,
        requireVolume:
          settings.requireVolume,
        methods:
          settings.methods
      },

      rejectedReason:
        "قدرت Long و Short به اندازه کافی از هم فاصله ندارند."
    };
  }

  if(
    long>short&&
    qualifies("LONG")&&
    long>=settings.minScore
  ){

    direction="LONG";

    score=
      clamp(
        long,
        0,
        100
      );
  }

  if(
    short>long&&
    qualifies("SHORT")&&
    short>=settings.minScore
  ){

    direction="SHORT";

    score=
      clamp(
        short,
        0,
        100
      );
  }

  let rejectedReason=null;

  if(direction==="WAIT"){

    if(
      strongest<
      settings.minScore
    ){

      rejectedReason=
        `امتیاز ${Math.round(strongest)} از حداقل ${settings.minScore} کمتر است.`;

    }else{

      const stronger=
        long>short
          ? "LONG"
          : "SHORT";

      rejectedReason=
        `سمت ${stronger} شواهد لازم سطح ${settings.label} را کامل نکرده است.`;
    }
  }

  return {

    direction,

    score:
      Math.round(score),

    longScore:
      Math.round(
        clamp(
          long,
          0,
          100
        )
      ),

    shortScore:
      Math.round(
        clamp(
          short,
          0,
          100
        )
      ),

    longEvidence:
      evidenceLong,

    shortEvidence:
      evidenceShort,

    longMethods:
      [...evidenceL],

    shortMethods:
      [...evidenceS],

    longReasons,
    shortReasons,

    settings:{

      level:
        settings.level,

      label:
        settings.label,

      minEvidence:
        settings.minEvidence,

      minScore:
        settings.minScore,

      requireHTF:
        settings.requireHTF,

      requireStructure:
        settings.requireStructure,

      requireFlow:
        settings.requireFlow,

      requireVolume:
        settings.requireVolume,

      methods:
        settings.methods
    },

    rejectedReason
  };
}

/* =========================================================
   MOVEMENT / PUMP DUMP
   چندعاملی:
   Price Speed
   Volume
   MA
   Sweep
   BOS
   CHoCH
   FVG
   Order Block
   Order Book
   Footprint
   OI
   Funding
========================================================= */

function movementAnalysis(
  c,
  market,
  tf,
  wall,
  fp
){

  const price=
    c.at(-1)?.close||0;

  const p5=
    c.length>=5
      ? c.at(-5).close
      : price;

  const p15=
    c.length>=15
      ? c.at(-15).close
      : price;

  const p30=
    c.length>=30
      ? c.at(-30).close
      : price;

  const change5=
    pct(price,p5);

  const change15=
    pct(price,p15);

  const change30=
    pct(price,p30);

  const avgVol=
    sma(
      c.slice(-21,-1)
        .map(
          x=>x.volume
        ),
      20
    );

  const volumeRatio=
    avgVol
      ? c.at(-1).volume/
        avgVol
      : 0;

  const h=hunt(c);

  const structure=
    detectStructure(c);

  const candle=
    candleAnalysis(c);

  const fvg=
    detectFVG(c);

  const ob=
    detectOrderBlock(c);

  let pump=0;
  let dump=0;

  const pumpReasons=[];
  const dumpReasons=[];

  /* =======================================================
     SPEED
  ======================================================= */

  if(change5>=1){

    pump+=10;

    pumpReasons.push(
      `سرعت ۵ دقیقه‌ای +${change5.toFixed(2)}%`
    );
  }

  if(change5>=2){

    pump+=10;

    pumpReasons.push(
      "شتاب شدید ۵ دقیقه‌ای"
    );
  }

  if(change15>=2){

    pump+=10;

    pumpReasons.push(
      `حرکت ۱۵ دقیقه‌ای +${change15.toFixed(2)}%`
    );
  }

  if(change15>=4){

    pump+=15;

    pumpReasons.push(
      "حرکت Pump قوی ۱۵ دقیقه‌ای"
    );
  }

  if(change30>=5){

    pump+=10;

    pumpReasons.push(
      "رشد ۳۰ دقیقه‌ای سنگین"
    );
  }

  if(change5<=-1){

    dump+=10;

    dumpReasons.push(
      `سرعت ۵ دقیقه‌ای ${change5.toFixed(2)}%`
    );
  }

  if(change5<=-2){

    dump+=10;

    dumpReasons.push(
      "شتاب شدید نزولی ۵ دقیقه‌ای"
    );
  }

  if(change15<=-2){

    dump+=10;

    dumpReasons.push(
      `حرکت ۱۵ دقیقه‌ای ${change15.toFixed(2)}%`
    );
  }

  if(change15<=-4){

    dump+=15;

    dumpReasons.push(
      "حرکت Dump قوی ۱۵ دقیقه‌ای"
    );
  }

  if(change30<=-5){

    dump+=10;

    dumpReasons.push(
      "افت ۳۰ دقیقه‌ای سنگین"
    );
  }

  /* =======================================================
     VOLUME
  ======================================================= */

  if(volumeRatio>=1.5){

    pump+=8;
    dump+=8;

    pumpReasons.push(
      `Volume Ratio ${volumeRatio.toFixed(2)}x`
    );

    dumpReasons.push(
      `Volume Ratio ${volumeRatio.toFixed(2)}x`
    );
  }

  if(volumeRatio>=2.5){

    pump+=10;
    dump+=10;

    pumpReasons.push(
      "Volume بسیار سنگین"
    );

    dumpReasons.push(
      "Volume بسیار سنگین"
    );
  }

  /* =======================================================
     MA
  ======================================================= */

  if(
    tf?.["1"]?.maSlope==="UP"&&
    tf?.["1"]?.trend==="BULLISH"
  ){

    pump+=7;

    pumpReasons.push(
      "MA یک دقیقه‌ای صعودی"
    );
  }

  if(
    tf?.["1"]?.maSlope==="DOWN"&&
    tf?.["1"]?.trend==="BEARISH"
  ){

    dump+=7;

    dumpReasons.push(
      "MA یک دقیقه‌ای نزولی"
    );
  }

  /* =======================================================
     HUNT
  ======================================================= */

  if(h.confirmed){

    if(h.side==="LONG"){

      pump+=12;

      pumpReasons.push(
        "Sell-side Liquidity Sweep"
      );
    }

    if(h.side==="SHORT"){

      dump+=12;

      dumpReasons.push(
        "Buy-side Liquidity Sweep"
      );
    }
  }

  /* =======================================================
     BOS / CHoCH
  ======================================================= */

  if(
    structure.bos==="BULLISH"
  ){

    pump+=10;

    pumpReasons.push(
      "BOS صعودی"
    );
  }

  if(
    structure.bos==="BEARISH"
  ){

    dump+=10;

    dumpReasons.push(
      "BOS نزولی"
    );
  }

  if(
    structure.choch==="BULLISH"
  ){

    pump+=12;

    pumpReasons.push(
      "CHoCH صعودی"
    );
  }

  if(
    structure.choch==="BEARISH"
  ){

    dump+=12;

    dumpReasons.push(
      "CHoCH نزولی"
    );
  }

  /* =======================================================
     FVG
  ======================================================= */

  if(
    fvg.type==="BULLISH"
  ){

    pump+=5;

    pumpReasons.push(
      "FVG صعودی"
    );
  }

  if(
    fvg.type==="BEARISH"
  ){

    dump+=5;

    dumpReasons.push(
      "FVG نزولی"
    );
  }

  /* =======================================================
     ORDER BLOCK
  ======================================================= */

  if(
    ob.type==="BULLISH"
  ){

    pump+=5;

    pumpReasons.push(
      "Order Block صعودی"
    );
  }

  if(
    ob.type==="BEARISH"
  ){

    dump+=5;

    dumpReasons.push(
      "Order Block نزولی"
    );
  }

  /* =======================================================
     ORDER BOOK
  ======================================================= */

  if(
    wall?.buyNear&&
    wall.buyStrength>=60
  ){

    pump+=8;

    pumpReasons.push(
      "Buy Wall قوی نزدیک قیمت"
    );
  }

  if(
    wall?.sellNear&&
    wall.sellStrength>=60
  ){

    dump+=8;

    dumpReasons.push(
      "Sell Wall قوی نزدیک قیمت"
    );
  }

  /* =======================================================
     FOOTPRINT
  ======================================================= */

  if(
    fp&&!fp.error
  ){

    if(
      fp.deltaPercent>=8
    ){

      pump+=10;

      pumpReasons.push(
        `Footprint Delta +${fp.deltaPercent.toFixed(1)}%`
      );
    }

    if(
      fp.deltaPercent<=-8
    ){

      dump+=10;

      dumpReasons.push(
        `Footprint Delta ${fp.deltaPercent.toFixed(1)}%`
      );
    }
  }

  /* =======================================================
     OI
  ======================================================= */

  if(
    market&&
    !market.error&&
    market.oiChangePercent!==null
  ){

    if(
      market.oiChangePercent>1&&
      market.change24h>0
    ){

      pump+=6;

      pumpReasons.push(
        "OI در حال افزایش همراه با رشد قیمت"
      );
    }

    if(
      market.oiChangePercent>1&&
      market.change24h<0
    ){

      dump+=6;

      dumpReasons.push(
        "OI در حال افزایش همراه با افت قیمت"
      );
    }
  }

  /* =======================================================
     FUNDING
  ======================================================= */

  if(
    market&&
    !market.error&&
    market.fundingRate!==null&&
    market.fundingChange!==null
  ){

    if(
      market.fundingRate<0&&
      market.fundingChange<0
    ){

      pump+=4;

      pumpReasons.push(
        "Funding منفی‌تر شده"
      );
    }

    if(
      market.fundingRate>0&&
      market.fundingChange>0
    ){

      dump+=4;

      dumpReasons.push(
        "Funding مثبت‌تر شده"
      );
    }
  }

  /* =======================================================
     REVERSAL RADAR
  ======================================================= */

  let pumpReversal=0;
  let dumpReversal=0;

  const pumpRev=[];
  const dumpRev=[];

  if(change15>=5){

    pumpReversal+=20;

    pumpRev.push(
      "Pump شدید"
    );

    if(
      h.confirmed&&
      h.side==="SHORT"
    ){

      pumpReversal+=20;

      pumpRev.push(
        "Liquidity Sweep برگشتی"
      );
    }

    if(
      candle.type==="SHOOTING_STAR"
    ){

      pumpReversal+=15;

      pumpRev.push(
        "Shooting Star"
      );
    }

    if(
      structure.choch==="BEARISH"
    ){

      pumpReversal+=25;

      pumpRev.push(
        "CHoCH نزولی"
      );
    }

    if(
      wall?.sellNear&&
      wall.sellStrength>=60
    ){

      pumpReversal+=10;

      pumpRev.push(
        "Sell Wall قوی"
      );
    }

    if(
      fp&&!fp.error&&
      fp.deltaPercent<0
    ){

      pumpReversal+=10;

      pumpRev.push(
        "Footprint Delta منفی"
      );
    }
  }

  if(change15<=-5){

    dumpReversal+=20;

    dumpRev.push(
      "Dump شدید"
    );

    if(
      h.confirmed&&
      h.side==="LONG"
    ){

      dumpReversal+=20;

      dumpRev.push(
        "Liquidity Sweep برگشتی"
      );
    }

    if(
      candle.type==="HAMMER"
    ){

      dumpReversal+=15;

      dumpRev.push(
        "Hammer"
      );
    }

    if(
      structure.choch==="BULLISH"
    ){

      dumpReversal+=25;

      dumpRev.push(
        "CHoCH صعودی"
      );
    }

    if(
      wall?.buyNear&&
      wall.buyStrength>=60
    ){

      dumpReversal+=10;

      dumpRev.push(
        "Buy Wall قوی"
      );
    }

    if(
      fp&&!fp.error&&
      fp.deltaPercent>0
    ){

      dumpReversal+=10;

      dumpRev.push(
        "Footprint Delta مثبت"
      );
    }
  }

  return {

    change5m:change5,
    change15m:change15,
    change30m:change30,

    speedScore:
      Math.round(
        clamp(
          Math.max(
            Math.abs(change5)*10,
            Math.abs(change15)*7,
            Math.abs(change30)*3
          ),
          0,
          100
        )
      ),

    volumeRatio,

    pumpScore:
      Math.round(
        clamp(
          pump,
          0,
          100
        )
      ),

    dumpScore:
      Math.round(
        clamp(
          dump,
          0,
          100
        )
      ),

    pumpReasons,
    dumpReasons,

    pumpReversalScore:
      Math.round(
        clamp(
          pumpReversal,
          0,
          100
        )
      ),

    dumpReversalScore:
      Math.round(
        clamp(
          dumpReversal,
          0,
          100
        )
      ),

    pumpReversalReasons:
      pumpRev,

    dumpReversalReasons:
      dumpRev
  };
}

/* =========================================================
   DEEP ANALYSIS
========================================================= */

async function deepAnalyze(
  category,
  symbol,
  signalInput={}
){

  const settings=
    getSignalSettings(
      signalInput
    );

  const tf={};

  let oneMinute=[];

  try{

    oneMinute=
      await klines(
        category,
        symbol,
        "1",
        DEEP_1M_LIMIT
      );

    tf["1"]=
      analyzeCandles(
        oneMinute.slice(-300)
      );

  }catch(e){

    tf["1"]={
      error:e.message
    };
  }

  for(
    const x of
    TF.filter(
      z=>z.interval!=="1"
    )
  ){

    try{

      tf[x.key]=
        analyzeCandles(
          await klines(
            category,
            symbol,
            x.interval,
            150
          )
        );

    }catch(e){

      tf[x.key]={
        error:e.message
      };
    }
  }

  const converted=
    oneMinute.length
      ? convertedMAEvents(
          oneMinute
        )
      : {
          events:[],
          recent:[],
          confirmed:[],
          latest:null
        };

  const valid=
    Object.values(tf)
      .filter(
        x=>!x.error
      );

  const price=
    valid.length
      ? valid[0].price
      : 0;

  const fp=
    await footprint(
      category,
      symbol
    );

  const wall=
    await walls(
      category,
      symbol,
      price
    );

  /*
     Futures:
       OI + Funding

     Spot:
       null
  */

  const market=
    category==="linear"
      ? await oiFunding(symbol)
      : {

          openInterest:null,
          previousOpenInterest:null,
          oiChangePercent:null,

          fundingRate:null,
          previousFundingRate:null,
          fundingChange:null,

          turnover24h:null,
          volume24h:null,
          change24h:null,

          markPrice:null,
          indexPrice:null,

          oiDirection:"UNKNOWN",
          fundingDirection:"UNKNOWN"
        };

  const signal=
    signalEngine(
      tf,
      converted,
      fp,
      wall,
      market,
      settings
    );

  const movement=
    movementAnalysis(
      oneMinute,
      market,
      tf,
      wall,
      fp
    );

  let alert="NONE";

  if(
    movement.pumpReversalScore>=75
  ){

    alert=
      "PUMP_REVERSAL_WATCH";
  }

  if(
    movement.dumpReversalScore>=75
  ){

    alert=
      "DUMP_REVERSAL_WATCH";
  }

  if(
    movement.pumpReversalScore>=85&&
    (
      tf["1"]?.choch===
        "BEARISH"||
      signal.shortScore>=85
    )
  ){

    alert=
      "PUMP_REVERSAL_CONFIRMED";
  }

  if(
    movement.dumpReversalScore>=85&&
    (
      tf["1"]?.choch===
        "BULLISH"||
      signal.longScore>=85
    )
  ){

    alert=
      "DUMP_REVERSAL_CONFIRMED";
  }

  return {

    symbol,
    category,

    price,

    direction:
      signal.direction,

    score:
      signal.score,

    longScore:
      signal.longScore,

    shortScore:
      signal.shortScore,

    signalLevel:
      signal.direction==="WAIT"
        ? "NONE"
        : signal.score>=92
          ? "EXTREME"
          : signal.score>=85
            ? "VERY_STRONG"
            : signal.score>=75
              ? "CONFIRMED"
              : signal.score>=65
                ? "WATCH"
                : "NONE",

    signalSettings:
      signal.settings,

    signalEvidence:{

      long:
        signal.longEvidence,

      short:
        signal.shortEvidence,

      longMethods:
        signal.longMethods,

      shortMethods:
        signal.shortMethods
    },

    signalRejectedReason:
      signal.rejectedReason||null,

    reasons:
      signal.direction==="LONG"
        ? signal.longReasons
        : signal.direction==="SHORT"
          ? signal.shortReasons
          : [
              ...signal.longReasons,
              ...signal.shortReasons
            ],

    timeframes:tf,

    convertedMA1m:
      converted,

    footprint:fp,

    walls:wall,

    supportResistance:
      supportResistance(
        oneMinute,
        wall,
        price
      ),

    market,

    movement,

    pumpScore:
      movement.pumpScore,

    dumpScore:
      movement.dumpScore,

    pumpDumpStatus:
      movement.pumpScore>=75
        ? "PUMP"
        : movement.dumpScore>=75
          ? "DUMP"
          : "NORMAL",

    reversal:{

      pumpScore:
        movement.pumpReversalScore,

      dumpScore:
        movement.dumpReversalScore,

      pumpReasons:
        movement.pumpReversalReasons,

      dumpReasons:
        movement.dumpReversalReasons,

      alert
    },

    generatedAt:
      Date.now(),

    liquidation:{

      available:false,

      message:
        "داده لیکوئیدیشن تجمیعی از REST عمومی این اسکنر تولید نمی‌شود."
    }
  };
}

/* =========================================================
   INSTRUMENTS
========================================================= */

async function instruments(category){

  const d=
    await bybit(
      "/v5/market/instruments-info",
      {
        category,
        limit:1000
      }
    );

  return (
    d?.result?.list||[]
  );
}

function validFutures(list){

  return list.filter(
    x=>
      x.status==="Trading"&&
      x.quoteCoin==="USDT"&&
      x.contractType===
        "LinearPerpetual"
  );
}

/* =========================================================
   MANUAL SEARCH
   اول Futures
   سپس Spot
========================================================= */

async function findSymbol(input){

  const raw=
    String(input||"")
      .trim()
      .toUpperCase();

  const bare=
    raw
      .replace(
        /[-_/:\s]/g,
        ""
      )
      .replace(
        /USDT$/,
        ""
      );

  const [lin,spot]=
    await Promise.all([
      instruments("linear"),
      instruments("spot")
    ]);

  const futures=
    lin.find(
      x=>
        String(
          x.symbol
        ).toUpperCase()===raw||
        String(
          x.symbol
        ).toUpperCase()===
          bare+"USDT"
    );

  const spots=
    spot.find(
      x=>
        String(
          x.symbol
        ).toUpperCase()===raw||
        String(
          x.symbol
        ).toUpperCase()===
          bare+"USDT"
    );

  return {

    input:raw,

    symbol:
      futures?.symbol||
      spots?.symbol||
      null,

    category:
      futures
        ? "linear"
        : spots
          ? "spot"
          : null,

    futures:
      futures
        ? {

            symbol:
              futures.symbol,

            status:
              futures.status,

            baseCoin:
              futures.baseCoin,

            quoteCoin:
              futures.quoteCoin
          }
        : null,

    spot:
      spots
        ? {

            symbol:
              spots.symbol,

            status:
              spots.status,

            baseCoin:
              spots.baseCoin,

            quoteCoin:
              spots.quoteCoin
          }
        : null
  };
}

/* =========================================================
   LIQUID 200
========================================================= */

async function liquidMarkets(){

  const ms=
    validFutures(
      await instruments(
        "linear"
      )
    );

  const tickers=
    await bybit(
      "/v5/market/tickers",
      {
        category:"linear"
      }
    );

  const list=
    tickers?.result?.list||[];

  const map=
    new Map(
      list.map(
        x=>[
          String(x.symbol),
          x
        ]
      )
    );

  const candidates=[];

  for(
    const m of ms
  ){

    const t=
      map.get(
        m.symbol
      );

    if(!t) continue;

    const turnover=
      n(
        t.turnover24h
      );

    const volume=
      n(
        t.volume24h
      );

    const change=
      Math.abs(
        n(
          t.price24hPcnt
        )
      )*100;

    const activityScore=

      Math.log10(
        Math.max(
          turnover,
          1
        )
      )*20+

      Math.log10(
        Math.max(
          volume,
          1
        )
      )*10+

      Math.min(
        change*2,
        30
      );

    candidates.push({

      symbol:m.symbol,

      turnover24h:
        turnover,

      volume24h:
        volume,

      change24h:
        n(
          t.price24hPcnt
        )*100,

      activityScore
    });
  }

  candidates.sort(
    (a,b)=>
      b.activityScore-
      a.activityScore
  );

  return candidates.slice(
    0,
    LIQUID_MARKETS
  );
}

/* =========================================================
   ROTATING SCAN
========================================================= */

async function scan(
  offset=0,
  signalInput={}
){

  const settings=
    getSignalSettings(
      signalInput
    );

  const markets=
    await liquidMarkets();

  if(!markets.length){

    return {

      ok:false,

      error:
        "بازار USDT Perpetual پیدا نشد."
    };
  }

  const safeOffset=
    Math.max(
      0,
      Math.min(
        offset,
        Math.max(
          0,
          markets.length-1
        )
      )
    );

  const batchSize=
    Math.min(
      SCAN_BATCH,
      markets.length
    );

  const batch=[];

  for(
    let i=0;
    i<batchSize;
    i++
  ){

    const index=
      (
        safeOffset+i
      )%markets.length;

    batch.push(
      markets[index]
    );
  }

  const candidates=[];

  for(
    const m of batch
  ){

    try{

      const c=
        await klines(
          "linear",
          m.symbol,
          "1",
          80
        );

      if(c.length<30)
        continue;

      const a=
        analyzeCandles(c);

      if(a.error)
        continue;

      let activity=
        m.activityScore/10;

      if(a.touchMA20)
        activity+=15;

      if(a.touchMA7)
        activity+=10;

      if(a.volume.spike)
        activity+=20;

      if(
        a.market.state==="ACTIVE"
      )
        activity+=15;

      if(a.hunt.confirmed)
        activity+=20;

      if(a.bos!=="NONE")
        activity+=10;

      if(a.choch!=="NONE")
        activity+=20;

      if(
        a.fvg?.type!=="NONE"
      )
        activity+=8;

      if(
        a.orderBlock?.type!=="NONE"
      )
        activity+=8;

      candidates.push({

        symbol:m.symbol,

        activity,

        turnover24h:
          m.turnover24h,

        volume24h:
          m.volume24h,

        change24h:
          m.change24h
      });

    }catch(e){}
  }

  candidates.sort(
    (a,b)=>
      b.activity-
      a.activity
  );

  const selected=
    candidates.slice(
      0,
      TOP_SIGNALS
    );

  const results=
    await Promise.all(
      selected.map(
        x=>
          deepAnalyze(
            "linear",
            x.symbol,
            settings
          )
      )
    );

  /*
     فقط مواردی که واقعاً از فیلتر
     سطح انتخاب‌شده عبور کرده‌اند،
     در لیست سیگنال‌های نهایی اولویت می‌گیرند.
  */

  const qualified=
    results
      .filter(
        x=>
          x.direction!=="WAIT"&&
          x.score>=
            settings.minScore
      )
      .sort(
        (a,b)=>
          b.score-a.score
      );

  const waiting=
    results
      .filter(
        x=>
          x.direction==="WAIT"
      )
      .sort(
        (a,b)=>
          Math.max(
            b.longScore,
            b.shortScore
          )-
          Math.max(
            a.longScore,
            a.shortScore
          )
      );

  return {

    ok:true,

    totalMarkets:
      markets.length,

    liquidMarketLimit:
      LIQUID_MARKETS,

    offset:
      safeOffset,

    batchSize:
      batch.length,

    nextOffset:
      (
        safeOffset+
        batchSize
      )%markets.length,

    selectedCount:
      results.length,

    qualifiedCount:
      qualified.length,

    signalSettings:
      settings,

    results:
      qualified,

    candidates:
      waiting.slice(
        0,
        TOP_SIGNALS
      ),

    scannedSymbols:
      batch.map(
        x=>x.symbol
      ),

    selectedSymbols:
      selected.map(
        x=>x.symbol
      ),

    note:
      "اسکن چرخشی بین ۲۰۰ قرارداد USDT Perpetual انجام می‌شود. از هر بچ ارزهای فعال انتخاب و سپس تحلیل عمیق انجام می‌شود. فقط سیگنال‌هایی که از سطح سخت‌گیری انتخاب‌شده عبور کنند در نتایج اصلی قرار می‌گیرند."
  };
}

/* =========================================================
   RADAR
========================================================= */

async function radar(
  offset=0,
  signalInput={}
){

  const settings=
    getSignalSettings(
      signalInput
    );

  const markets=
    await liquidMarkets();

  if(!markets.length){

    return {

      ok:false,

      error:
        "بازار USDT Perpetual پیدا نشد."
    };
  }

  const safeOffset=
    Math.max(
      0,
      Math.min(
        offset,
        Math.max(
          0,
          markets.length-1
        )
      )
    );

  const batchSize=
    Math.min(
      SCAN_BATCH,
      markets.length
    );

  const batch=[];

  for(
    let i=0;
    i<batchSize;
    i++
  ){

    batch.push(
      markets[
        (
          safeOffset+i
        )%markets.length
      ]
    );
  }

  const candidates=[];

  for(
    const m of batch
  ){

    try{

      const c=
        await klines(
          "linear",
          m.symbol,
          "1",
          100
        );

      if(c.length<30)
        continue;

      const price=
        c.at(-1).close;

      const change5=
        pct(
          price,
          c.at(-5).close
        );

      const change15=
        pct(
          price,
          c.at(-15).close
        );

      const change30=
        pct(
          price,
          c.at(-30).close
        );

      const avgVol=
        sma(
          c.slice(-21,-1)
            .map(
              x=>x.volume
            ),
          20
        );

      const volumeRatio=
        avgVol
          ? c.at(-1).volume/
            avgVol
          : 0;

      const h=
        hunt(c);

      const structure=
        detectStructure(c);

      const fvg=
        detectFVG(c);

      const ob=
        detectOrderBlock(c);

      const a=
        analyzeCandles(c);

      /*
         Radar اولیه برای پیدا کردن ارزهای
         مشکوک/فعال.

         در این مرحله قیمت به تنهایی معیار نیست.
      */

      const speedScore=

        Math.min(
          Math.abs(change5)*8,
          30
        )+

        Math.min(
          Math.abs(change15)*4,
          25
        )+

        Math.min(
          Math.abs(change30)*2,
          20
        );

      const volumeScore=
        Math.min(
          volumeRatio*15,
          45
        );

      const structureScore=

        (
          structure.bos!=="NONE"
            ? 15
            : 0
        )+

        (
          structure.choch!=="NONE"
            ? 25
            : 0
        )+

        (
          h.confirmed
            ? 25
            : 0
        );

      const technicalScore=

        (
          fvg.type!=="NONE"
            ? 8
            : 0
        )+

        (
          ob.type!=="NONE"
            ? 8
            : 0
        )+

        (
          a.volume.spike
            ? 10
            : 0
        )+

        (
          a.market.state==="ACTIVE"
            ? 10
            : 0
        );

      candidates.push({

        symbol:m.symbol,

        radarScore:
          speedScore+
          volumeScore+
          structureScore+
          technicalScore,

        speedScore,
        volumeScore,
        structureScore,
        technicalScore,

        change5,
        change15,
        change30,

        volumeRatio,

        hunt:h,

        structure,

        fvg,

        orderBlock:ob
      });

    }catch(e){}
  }

  candidates.sort(
    (a,b)=>
      b.radarScore-
      a.radarScore
  );

  const selected=
    candidates.slice(
      0,
      RADAR_LIMIT
    );

  /*
     Deep دوباره همه عوامل اصلی را بررسی می‌کند:
     Footprint
     Order Book
     OI
     Funding
     MA
     Hunt
     BOS/CHoCH
     FVG
     OB
     Volume
  */

  const deep=
    await Promise.all(
      selected.map(
        x=>
          deepAnalyze(
            "linear",
            x.symbol,
            settings
          )
      )
    );

  /*
     Pump/Dump قوی:
     فقط درصد قیمت نیست.
     امتیاز نهایی از تحلیل چندعاملی Deep گرفته می‌شود.
  */

  const pump=
    deep
      .filter(
        x=>
          x.pumpScore>=40
      )
      .sort(
        (a,b)=>
          b.pumpScore-
          a.pumpScore
      );

  const dump=
    deep
      .filter(
        x=>
          x.dumpScore>=40
      )
      .sort(
        (a,b)=>
          b.dumpScore-
          a.dumpScore
      );

  const reversal=
    deep
      .filter(
        x=>
          x.reversal.pumpScore>=40||
          x.reversal.dumpScore>=40
      )
      .sort(
        (a,b)=>
          Math.max(
            b.reversal.pumpScore,
            b.reversal.dumpScore
          )-
          Math.max(
            a.reversal.pumpScore,
            a.reversal.dumpScore
          )
      );

  const qualifiedSignals=
    deep
      .filter(
        x=>
          x.direction!=="WAIT"&&
          x.score>=
            settings.minScore
      )
      .sort(
        (a,b)=>
          b.score-a.score
      );

  return {

    ok:true,

    totalMarkets:
      markets.length,

    liquidMarketLimit:
      LIQUID_MARKETS,

    offset:
      safeOffset,

    nextOffset:
      (
        safeOffset+
        batchSize
      )%markets.length,

    signalSettings:
      settings,

    pump,

    dump,

    reversal,

    signals:
      qualifiedSignals,

    results:
      deep,

    scannedSymbols:
      batch.map(
        x=>x.symbol
      ),

    radarSelectedSymbols:
      selected.map(
        x=>x.symbol
      ),

    note:
      "Radar چندعاملی است و علاوه بر سرعت حرکت، Volume، MA، Liquidity Sweep، BOS/CHoCH، FVG، Order Block، Order Book، Footprint، OI و Funding را در تحلیل عمیق وارد می‌کند."
  };
}

/* =========================================================
   ROUTER
========================================================= */

export default {

  async fetch(
    request,
    env
  ){

    const u=
      new URL(
        request.url
      );

    const p=
      u.pathname;

    try{

      /* =====================================================
         SEARCH
      ===================================================== */

      if(
        p==="/api/search"
      ){

        const q=
          u.searchParams.get(
            "symbol"
          );

        if(!q){

          return json(
            {
              ok:false,

              error:
                "نماد وارد نشده است."
            },
            400
          );
        }

        const found=
          await findSymbol(q);

        return json({

          ok:true,

          ...found
        });
      }

      /* =====================================================
         ANALYZE
      ===================================================== */

      if(
        p==="/api/analyze"
      ){

        const symbol=
          u.searchParams.get(
            "symbol"
          );

        if(!symbol){

          return json(
            {
              ok:false,

              error:
                "نماد وارد نشده است."
            },
            400
          );
        }

        const found=
          await findSymbol(
            symbol
          );

        if(!found.symbol){

          return json(
            {
              ok:false,

              error:
                "ارز پیدا نشد.",

              search:
                found
            },
            404
          );
        }

        /*
           اول Futures.
           اگر Futures وجود نداشت Spot.

           Spot بدون OI/Funding.
           هیچ پیام اضافه‌ای تولید نمی‌شود.
        */

        const category=
          found.futures
            ? "linear"
            : "spot";

        const chosen=
          found.futures||
          found.spot;

        const level=
          u.searchParams.get(
            "level"
          )||
          "MEDIUM";

        const methods=
          u.searchParams.get(
            "methods"
          );

        return json({

          ok:true,

          ...await deepAnalyze(
            category,
            chosen.symbol,
            {
              level,
              methods
            }
          ),

          search:found
        });
      }

      /* =====================================================
         SCAN
      ===================================================== */

      if(
        p==="/api/scan"
      ){

        const offset=
          n(
            u.searchParams.get(
              "offset"
            ),
            0
          );

        const level=
          u.searchParams.get(
            "level"
          )||
          "MEDIUM";

        const methods=
          u.searchParams.get(
            "methods"
          );

        return json(
          await scan(
            offset,
            {
              level,
              methods
            }
          )
        );
      }

      /* =====================================================
         RADAR
      ===================================================== */

      if(
        p==="/api/radar"
      ){

        const offset=
          n(
            u.searchParams.get(
              "offset"
            ),
            0
          );

        const level=
          u.searchParams.get(
            "level"
          )||
          "MEDIUM";

        const methods=
          u.searchParams.get(
            "methods"
          );

        return json(
          await radar(
            offset,
            {
              level,
              methods
            }
          )
        );
      }

      /* =====================================================
         HEALTH
      ===================================================== */

      if(
        p==="/api/health"
      ){

        return json({

          ok:true,

          service:
            "Bybit Smart Money MA Radar",

          version:
            "V10",

          timeframes:
            TF.map(
              x=>x.interval
            ),

          liquidMarkets:
            LIQUID_MARKETS,

          scanBatch:
            SCAN_BATCH,

          topSignals:
            TOP_SIGNALS,

          signalLevels:
            SIGNAL_LEVELS,

          signalMethods:
            SIGNAL_METHODS,

          convertedMA:
            CONVERTED_MAS,

          features:[

            "Futures Search",

            "Spot Search",

            "Futures First",

            "Spot Fallback",

            "MA",

            "Converted MA",

            "MA Trigger",

            "MA Slope",

            "MA Touch",

            "Liquidity Hunt",

            "Liquidity Sweep",

            "FVG",

            "BOS",

            "CHoCH",

            "Order Block",

            "Volume Spike",

            "ADX",

            "ATR",

            "Bollinger Width",

            "Order Book",

            "Buy Wall",

            "Sell Wall",

            "Support",

            "Resistance",

            "OI",

            "OI Change",

            "Funding",

            "Funding Change",

            "Footprint",

            "Footprint Delta",

            "Multi Factor Pump Radar",

            "Multi Factor Dump Radar",

            "Reversal Radar",

            "Rotating 200 Market Scan",

            "Deep Analysis",

            "6 Signal Strictness Levels"
          ]
        });
      }

      /* =====================================================
         STATIC ASSETS
      ===================================================== */

      return env.ASSETS.fetch(
        request
      );

    }catch(e){

      return json(
        {

          ok:false,

          error:e.message,

          detail:
            String(
              e.stack||""
            ).slice(
              0,
              1500
            )
        },
        500
      );
    }
  }
};
