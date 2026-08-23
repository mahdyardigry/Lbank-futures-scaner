const DATA_BASE = "https://api.bybit.com";

const SCAN_BATCH = 20;
const DEEP_LIMIT = 3;
const RADAR_LIMIT = 5;
const DEEP_1M_LIMIT = 1300;

const DEFAULT_THRESHOLD = 75;
const MIN_THRESHOLD = 50;
const MAX_THRESHOLD = 95;

const TF = [
  { key:"1",  label:"1 دقیقه", interval:"1"  },
  { key:"3",  label:"3 دقیقه", interval:"3"  },
  { key:"5",  label:"5 دقیقه", interval:"5"  },
  { key:"15", label:"15 دقیقه", interval:"15" },
  { key:"60", label:"1 ساعت", interval:"60" }
];

const METHODS = [
  "MA",
  "SMC",
  "ICT",
  "MACD",
  "RSI",
  "DIVERGENCE",
  "ICHIMOKU",
  "VOLUME",
  "ORDERFLOW",
  "LIQUIDITY",
  "FVG",
  "BOS",
  "CHOCH",
  "ORDERBLOCK",
  "SR",
  "OI",
  "FUNDING"
];

const json = (data,status=200) =>
  new Response(
    JSON.stringify(data),
    {
      status,
      headers:{
        "content-type":"application/json; charset=UTF-8",
        "cache-control":"no-store",
        "access-control-allow-origin":"*",
        "access-control-allow-methods":"GET,OPTIONS",
        "access-control-allow-headers":"Content-Type"
      }
    }
  );

const n = (v,d=0) =>
  Number.isFinite(Number(v)) ? Number(v) : d;

const clamp = (v,a,b) =>
  Math.max(a,Math.min(b,v));

const avg = a =>
  a.length
    ? a.reduce((x,y)=>x+y,0)/a.length
    : 0;

function pct(a,b){
  if(!b) return 0;
  return ((a-b)/b)*100;
}

function absPct(a,b){
  if(!b) return 999;
  return Math.abs((a-b)/b)*100;
}

/* =========================================================
   API
========================================================= */

async function dataApi(path,params={}){

  const u = new URL(DATA_BASE + path);

  for(const [k,v] of Object.entries(params)){
    if(v!==undefined && v!==null){
      u.searchParams.set(k,String(v));
    }
  }

  const r = await fetch(u,{
    headers:{
      accept:"application/json"
    }
  });

  if(!r.ok){
    throw new Error(`Data HTTP ${r.status}`);
  }

  const d = await r.json();

  if(d.retCode !== 0){
    throw new Error(
      d.retMsg ||
      `Data error ${d.retCode}`
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

  const d = await dataApi(
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
   MOVING AVERAGE
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

  for(let i=1;i<a.length;i++){
    x=a[i]*k+x*(1-k);
  }

  return x;
}

/* =========================================================
   ATR
========================================================= */

function atr(c,p=14){

  if(c.length<2) return 0;

  const tr=[];

  for(let i=1;i<c.length;i++){

    const x=c[i];
    const q=c[i-1];

    tr.push(
      Math.max(
        x.high-x.low,
        Math.abs(x.high-q.close),
        Math.abs(x.low-q.close)
      )
    );
  }

  return sma(tr,p);
}

/* =========================================================
   ADX
========================================================= */

function adx(c,p=14){

  if(c.length<p*2+1) return 0;

  const trs=[];
  const plus=[];
  const minus=[];

  for(let i=1;i<c.length;i++){

    const x=c[i];
    const q=c[i-1];

    trs.push(
      Math.max(
        x.high-x.low,
        Math.abs(x.high-q.close),
        Math.abs(x.low-q.close)
      )
    );

    const up=x.high-q.high;
    const dn=q.low-x.low;

    plus.push(
      up>dn && up>0 ? up : 0
    );

    minus.push(
      dn>up && dn>0 ? dn : 0
    );
  }

  const out=[];

  for(let i=p;i<trs.length;i++){

    const tr=
      avg(trs.slice(i-p,i)) || 1;

    const diP=
      100*
      avg(plus.slice(i-p,i))/
      tr;

    const diM=
      100*
      avg(minus.slice(i-p,i))/
      tr;

    const dx=
      diP+diM
        ? 100*Math.abs(diP-diM)/(diP+diM)
        : 0;

    out.push(dx);
  }

  return avg(out.slice(-p));
}

/* =========================================================
   BOLLINGER
========================================================= */

function bollWidth(c,p=20){

  const a=
    c.slice(-p).map(x=>x.close);

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
    ? (4*sd/m)*100
    : 0;
}

/* =========================================================
   MARKET STATE
========================================================= */

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

  const price=c.at(-1).close;

  const a=atr(c);

  const atrPct=
    price
      ? a/price*100
      : 0;

  const adxV=adx(c);
  const bw=bollWidth(c);

  const maGap=
    ma20
      ? Math.abs(ma7-ma20)/ma20*100
      : 0;

  const isRange=
    adxV<18 &&
    bw<1.8 &&
    Math.abs(slope)<0.0007;

  const waking=
    !isRange &&
    (
      adxV>=18 ||
      bw>=1.8 ||
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

function swingLevels(c,lookback=3){

  const highs=[];
  const lows=[];

  for(
    let i=lookback;
    i<c.length-lookback;
    i++
  ){

    let high=true;
    let low=true;

    for(let j=1;j<=lookback;j++){

      if(
        c[i].high<=c[i-j].high ||
        c[i].high<c[i+j].high
      ){
        high=false;
      }

      if(
        c[i].low>=c[i-j].low ||
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
   LIQUIDITY HUNT
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
      ...prev.map(z=>z.high)
    );

  const lo=
    Math.min(
      ...prev.map(z=>z.low)
    );

  const range=
    x.high-x.low || 1;

  const lower=
    Math.min(x.open,x.close)-x.low;

  const upper=
    x.high-
    Math.max(x.open,x.close);

  const volAvg=
    sma(
      c.slice(-21,-1)
        .map(z=>z.volume),
      20
    );

  const volumeConfirm=
    volAvg>0 &&
    x.volume>=volAvg*1.15;

  const longSweep=
    x.low<lo &&
    x.close>lo &&
    lower/range>=0.25;

  const shortSweep=
    x.high>hi &&
    x.close<hi &&
    upper/range>=0.25;

  if(longSweep){

    return {

      type:"LIQUIDITY_SWEEP",
      side:"LONG",

      level:lo,

      wickPct:
        lower/range*100,

      volumeConfirmed:
        volumeConfirm,

      confirmed:
        volumeConfirm ||
        lower/range>=0.4
    };
  }

  if(shortSweep){

    return {

      type:"LIQUIDITY_SWEEP",
      side:"SHORT",

      level:hi,

      wickPct:
        upper/range*100,

      volumeConfirmed:
        volumeConfirm,

      confirmed:
        volumeConfirm ||
        upper/range>=0.4
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
      choch:"NONE",
      swingHigh:null,
      swingLow:null
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

  if(lastHigh && price>lastHigh){
    bos="BULLISH";
  }

  if(lastLow && price<lastLow){
    bos="BEARISH";
  }

  if(
    prevHigh &&
    prevLow &&
    lastLow &&
    lastHigh &&
    lastLow>prevLow &&
    lastHigh>prevHigh &&
    price<lastLow
  ){
    choch="BEARISH";
  }

  if(
    prevHigh &&
    prevLow &&
    lastLow &&
    lastHigh &&
    lastLow<prevLow &&
    lastHigh<prevHigh &&
    price>lastHigh
  ){
    choch="BULLISH";
  }

  return {

    bos,
    choch,

    swingHigh:lastHigh,
    swingLow:lastLow,

    previousSwingHigh:prevHigh,
    previousSwingLow:prevLow
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
    i>=Math.max(0,c.length-12);
    i--
  ){

    const z=c[i];

    if(
      z.close<z.open &&
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
      z.close>z.open &&
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
    Math.abs(x.close-x.open);

  const range=
    x.high-x.low || 1;

  const upper=
    x.high-
    Math.max(x.open,x.close);

  const lower=
    Math.min(x.open,x.close)-
    x.low;

  const bodyRatio=
    body/range;

  let type="NORMAL";

  if(
    lower>body*2 &&
    lower/range>.45
  ){
    type="HAMMER";
  }

  if(
    upper>body*2 &&
    upper/range>.45
  ){
    type="SHOOTING_STAR";
  }

  if(
    x.close>p.open &&
    x.open<p.close &&
    x.close>=p.close &&
    x.open<=p.open
  ){
    type="BULLISH_ENGULFING";
  }

  if(
    x.close<p.open &&
    x.open>p.close &&
    x.close<=p.close &&
    x.open>=p.open
  ){
    type="BEARISH_ENGULFING";
  }

  if(bodyRatio<0.15){
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
   MACD
========================================================= */

function macd(c){

  const closes=
    c.map(x=>x.close);

  if(closes.length<35){

    return {
      direction:"NONE",
      histogram:0,
      macd:0,
      signal:0,
      cross:"NONE"
    };
  }

  const fast=[];
  const slow=[];
  const macdLine=[];

  for(let i=0;i<closes.length;i++){

    const a=
      closes.slice(0,i+1);

    fast.push(
      ema(a,12)
    );

    slow.push(
      ema(a,26)
    );

    macdLine.push(
      fast.at(-1)-slow.at(-1)
    );
  }

  const signal=
    ema(macdLine,9);

  const prevMacd=
    macdLine.at(-2);

  const prevSignal=
    ema(
      macdLine.slice(0,-1),
      9
    );

  const crossUp=
    prevMacd<=prevSignal &&
    macdLine.at(-1)>signal;

  const crossDown=
    prevMacd>=prevSignal &&
    macdLine.at(-1)<signal;

  const histogram=
    macdLine.at(-1)-signal;

  return {

    macd:macdLine.at(-1),
    signal,
    histogram,

    direction:
      histogram>0
        ? "LONG"
        : histogram<0
          ? "SHORT"
          : "NONE",

    cross:
      crossUp
        ? "BULLISH"
        : crossDown
          ? "BEARISH"
          : "NONE",

    bullish:
      histogram>0,

    bearish:
      histogram<0
  };
}

/* =========================================================
   RSI
========================================================= */

function rsi(c,p=14){

  if(c.length<p+2){

    return {
      value:50,
      state:"NEUTRAL"
    };
  }

  const changes=[];

  for(let i=1;i<c.length;i++){
    changes.push(
      c[i].close-c[i-1].close
    );
  }

  const gains=
    changes.map(x=>Math.max(x,0));

  const losses=
    changes.map(x=>Math.max(-x,0));

  const ag=
    avg(gains.slice(-p));

  const al=
    avg(losses.slice(-p));

  let value=50;

  if(al===0){
    value=100;
  }else{

    const rs=ag/al;

    value=
      100-(100/(1+rs));
  }

  return {

    value,

    state:
      value>=70
        ? "OVERBOUGHT"
        : value<=30
          ? "OVERSOLD"
          : value>50
            ? "BULLISH"
            : value<50
              ? "BEARISH"
              : "NEUTRAL",

    bullish:value>50,
    bearish:value<50
  };
}

/* =========================================================
   DIVERGENCE
========================================================= */

function divergence(c){

  if(c.length<30){

    return {
      type:"NONE",
      strength:0
    };
  }

  const price=c.map(x=>x.close);
  const rv=[];

  for(let i=0;i<c.length;i++){

    const part=
      price.slice(
        Math.max(0,i-14),
        i+1
      );

    if(part.length<5){
      rv.push(50);
      continue;
    }

    const gains=[];
    const losses=[];

    for(let j=1;j<part.length;j++){

      const d=
        part[j]-part[j-1];

      if(d>=0){
        gains.push(d);
        losses.push(0);
      }else{
        gains.push(0);
        losses.push(-d);
      }
    }

    const g=avg(gains);
    const l=avg(losses);

    rv.push(
      l===0
        ? 100
        : 100-(100/(1+g/l))
    );
  }

  const p1=Math.min(
    ...price.slice(-20,-10)
  );

  const p2=Math.min(
    ...price.slice(-10)
  );

  const r1=Math.min(
    ...rv.slice(-20,-10)
  );

  const r2=Math.min(
    ...rv.slice(-10)
  );

  const h1=Math.max(
    ...price.slice(-20,-10)
  );

  const h2=Math.max(
    ...price.slice(-10)
  );

  const rh1=Math.max(
    ...rv.slice(-20,-10)
  );

  const rh2=Math.max(
    ...rv.slice(-10)
  );

  if(
    p2<p1 &&
    r2>r1+2
  ){

    return {
      type:"BULLISH",
      strength:Math.min(100,70+(r2-r1)*3)
    };
  }

  if(
    h2>h1 &&
    rh2<rh1-2
  ){

    return {
      type:"BEARISH",
      strength:Math.min(100,70+(rh1-rh2)*3)
    };
  }

  return {
    type:"NONE",
    strength:0
  };
}

/* =========================================================
   ICHIMOKU
========================================================= */

function ichimoku(c){

  if(c.length<52){

    return {
      direction:"NONE",
      state:"INSUFFICIENT"
    };
  }

  const mid=(a,b)=>(a+b)/2;

  const high9=
    Math.max(
      ...c.slice(-9).map(x=>x.high)
    );

  const low9=
    Math.min(
      ...c.slice(-9).map(x=>x.low)
    );

  const tenkan=
    mid(high9,low9);

  const high26=
    Math.max(
      ...c.slice(-26).map(x=>x.high)
    );

  const low26=
    Math.min(
      ...c.slice(-26).map(x=>x.low)
    );

  const kijun=
    mid(high26,low26);

  const high52=
    Math.max(
      ...c.slice(-52).map(x=>x.high)
    );

  const low52=
    Math.min(
      ...c.slice(-52).map(x=>x.low)
    );

  const spanB=
    mid(high52,low52);

  const spanA=
    mid(tenkan,kijun);

  const price=c.at(-1).close;

  const bullish=
    price>spanA &&
    price>spanB &&
    tenkan>kijun;

  const bearish=
    price<spanA &&
    price<spanB &&
    tenkan<kijun;

  return {

    tenkan,
    kijun,
    spanA,
    spanB,

    direction:
      bullish
        ? "LONG"
        : bearish
          ? "SHORT"
          : "NONE",

    state:
      bullish
        ? "BULLISH"
        : bearish
          ? "BEARISH"
          : "RANGE"
  };
}

/* =========================================================
   CANDLE / MA
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

  const high=c.at(-1).high;
  const low=c.at(-1).low;

  const touch20=
    Math.abs(price-ma20)/ma20<=0.0015 ||
    (
      low<=ma20 &&
      high>=ma20
    ) ||
    (
      (prevPrice-ma20)*(price-ma20)<=0
    );

  const touch7=
    Math.abs(price-ma7)/ma7<=0.0015 ||
    (
      low<=ma7 &&
      high>=ma7
    ) ||
    (
      (prevPrice-ma7)*(price-ma7)<=0
    );

  const vol7=sma(vol,7);
  const vol20=sma(vol,20);

  const spike=
    vol.at(-1)>vol20*1.5 ||
    vol.at(-1)>vol7*1.8;

  const market=
    rangeState(
      c,
      ma7,
      ma20,
      slope,
      spike
    );

  const trend=
    price>ma20 &&
    ma7>ma20
      ? "BULLISH"
      : price<ma20 &&
        ma7<ma20
          ? "BEARISH"
          : "RANGE";

  const h=hunt(c);
  const fvg=detectFVG(c);
  const structure=detectStructure(c);
  const ob=detectOrderBlock(c);
  const candle=candleAnalysis(c);

  const m=macd(c);
  const r=rsi(c);
  const d=divergence(c);
  const ichi=ichimoku(c);

  return {

    price,

    ma7,
    ma20,

    maSlope:
      slope>0.00007
        ? "UP"
        : slope<-0.00007
          ? "DOWN"
          : "FLAT",

    slopePct:slope*100,

    touchMA20:touch20,
    touchMA7:touch7,

    trend,

    volume:{
      current:vol.at(-1),
      ma7:vol7,
      ma20:vol20,
      spike,
      ratio20:
        vol20
          ? vol.at(-1)/vol20
          : 0
    },

    market,

    hunt:h,

    candle:candle.type,

    candleDetails:candle,

    fvg,

    bos:structure.bos,

    choch:structure.choch,

    structure,

    orderBlock:ob,

    macd:m,
    rsi:r,
    divergence:d,
    ichimoku:ichi,

    timestamp:c.at(-1).time
  };
}

/* =========================================================
   ORDER FLOW
========================================================= */

async function footprint(
  category,
  symbol
){

  try{

    const d=
      await dataApi(
        "/v5/market/recent-trade",
        {
          category,
          symbol,
          limit:200
        }
      );

    const t=
      d?.result?.list || [];

    let buy=0;
    let sell=0;
    let largest=0;

    for(const x of t){

      const q=n(x.size);
      const p=n(x.price);

      largest=
        Math.max(
          largest,
          q*p
        );

      if(
        String(x.side).toLowerCase()==="buy"
      ){
        buy+=q;
      }else{
        sell+=q;
      }
    }

    const total=buy+sell;

    const delta=buy-sell;

    return {

      buyVolume:buy,
      sellVolume:sell,

      delta,

      deltaPercent:
        total
          ? delta/total*100
          : 0,

      trades:t.length,

      largeTradeNotional:
        largest
    };

  }catch(e){

    return {
      error:e.message
    };
  }
}

/* =========================================================
   ORDER BOOK
========================================================= */

async function walls(
  category,
  symbol,
  price
){

  try{

    const d=
      await dataApi(
        "/v5/market/orderbook",
        {
          category,
          symbol,
          limit:50
        }
      );

    const bids=
      d?.result?.b || [];

    const asks=
      d?.result?.a || [];

    const buyLevels=[];
    const sellLevels=[];

    for(const q of bids){

      const p=n(q[0]);
      const sz=n(q[1]);

      if(p<=0 || sz<=0) continue;

      const notional=p*sz;

      const distance=
        absPct(p,price);

      if(distance<=3){

        buyLevels.push({
          price:p,
          size:sz,
          notional,
          distancePct:distance
        });
      }
    }

    for(const q of asks){

      const p=n(q[0]);
      const sz=n(q[1]);

      if(p<=0 || sz<=0) continue;

      const notional=p*sz;

      const distance=
        absPct(p,price);

      if(distance<=3){

        sellLevels.push({
          price:p,
          size:sz,
          notional,
          distancePct:distance
        });
      }
    }

    buyLevels.sort(
      (a,b)=>b.notional-a.notional
    );

    sellLevels.sort(
      (a,b)=>b.notional-a.notional
    );

    const buyLiquidity=
      buyLevels.reduce(
        (s,x)=>s+x.notional,
        0
      );

    const sellLiquidity=
      sellLevels.reduce(
        (s,x)=>s+x.notional,
        0
      );

    const total=
      buyLiquidity+sellLiquidity;

    const buyWall=
      buyLevels[0] || null;

    const sellWall=
      sellLevels[0] || null;

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
      buyWall && avgBuy
        ? clamp(
            buyWall.notional/
            avgBuy*20,
            0,
            100
          )
        : 0;

    const sellStrength=
      sellWall && avgSell
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
      totalLiquidity:total,

      buyShare:
        total
          ? buyLiquidity/total*100
          : 0,

      sellShare:
        total
          ? sellLiquidity/total*100
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

  for(const x of s.lows){

    if(x.price<price){

      supports.push({

        price:x.price,

        type:"SWING_SUPPORT",

        distancePct:
          absPct(
            x.price,
            price
          )
      });
    }
  }

  for(const x of s.highs){

    if(x.price>price){

      resistances.push({

        price:x.price,

        type:"SWING_RESISTANCE",

        distancePct:
          absPct(
            x.price,
            price
          )
      });
    }
  }

  for(const x of wall?.buyLevels || []){

    if(x.price<price){

      supports.push({

        price:x.price,

        type:"BUY_WALL",

        liquidity:x.notional,

        distancePct:x.distancePct
      });
    }
  }

  for(const x of wall?.sellLevels || []){

    if(x.price>price){

      resistances.push({

        price:x.price,

        type:"SELL_WALL",

        liquidity:x.notional,

        distancePct:x.distancePct
      });
    }
  }

  supports.sort(
    (a,b)=>
      a.distancePct-b.distancePct
  );

  resistances.sort(
    (a,b)=>
      a.distancePct-b.distancePct
  );

  return {

    nearestSupport:
      supports[0] || null,

    nearestResistance:
      resistances[0] || null,

    strongestSupport:
      supports
        .filter(x=>x.liquidity)
        .sort(
          (a,b)=>
            (b.liquidity||0)-
            (a.liquidity||0)
        )[0] ||
      supports[0] ||
      null,

    strongestResistance:
      resistances
        .filter(x=>x.liquidity)
        .sort(
          (a,b)=>
            (b.liquidity||0)-
            (a.liquidity||0)
        )[0] ||
      resistances[0] ||
      null,

    supports:
      supports.slice(0,10),

    resistances:
      resistances.slice(0,10)
  };
}

/* =========================================================
   MARKET DATA
========================================================= */

async function ticker(
  category,
  symbol
){

  const d=
    await dataApi(
      "/v5/market/tickers",
      {
        category,
        symbol
      }
    );

  return d?.result?.list?.[0] || {};
}

async function oiFunding(symbol){

  try{

    const t=
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
        n(t.price24hPcnt)*100,

      markPrice:
        n(t.markPrice),

      indexPrice:
        n(t.indexPrice)
    };

  }catch(e){

    return {
      error:e.message
    };
  }
}

/* =========================================================
   CONVERTED MA
========================================================= */

const CONVERTED_MAS = [

  {source:"1m",ma:20,period:20},

  {source:"3m",ma:7,period:21},
  {source:"3m",ma:20,period:60},

  {source:"5m",ma:7,period:35},
  {source:"5m",ma:20,period:100},

  {source:"15m",ma:7,period:105},
  {source:"15m",ma:20,period:300},

  {source:"1h",ma:7,period:420},
  {source:"1h",ma:20,period:1200}
];

function maValueSeries(c,p){

  const out=[];

  for(let i=0;i<c.length;i++){

    const a=
      c.slice(
        Math.max(0,i-p+1),
        i+1
      ).map(x=>x.close);

    out.push(
      a.length>=p
        ? avg(a)
        : null
    );
  }

  return out;
}

function convertedMAEvents(c){

  const price=
    c.at(-1)?.close || 0;

  const prev=
    c.at(-2)?.close || price;

  const events=[];

  for(const m of CONVERTED_MAS){

    const vals=
      maValueSeries(
        c,
        m.period
      );

    const ma=vals.at(-1);
    const prevMA=vals.at(-2);

    if(!ma || !prevMA) continue;

    const slopePct=
      (ma-prevMA)/prevMA*100;

    const candle=c.at(-1);

    const range=
      candle.high-candle.low || 1;

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
      Math.abs(dist)/ma<=0.0015 ||
      (
        candle.low<=ma &&
        candle.high>=ma
      ) ||
      prevDist*dist<=0;

    const crossUp=
      prev<=prevMA &&
      price>ma;

    const crossDown=
      prev>=prevMA &&
      price<ma;

    const bullishRejection=
      candle.low<=ma &&
      candle.close>ma &&
      candle.close>candle.open &&
      lower/range>=0.25;

    const bearishRejection=
      candle.high>=ma &&
      candle.close<ma &&
      candle.close<candle.open &&
      upper/range>=0.25;

    const direction=
      bullishRejection || crossUp
        ? "LONG"
        : bearishRejection || crossDown
          ? "SHORT"
          : "NONE";

    const volumeAvg=
      sma(
        c.slice(-21,-1)
          .map(x=>x.volume),
        20
      );

    const volumeConfirmed=
      volumeAvg>0 &&
      candle.volume>=volumeAvg*1.15;

    const slope=
      Math.abs(slopePct)<0.003
        ? "FLAT"
        : slopePct>0
          ? "UP"
          : "DOWN";

    const trendConfirm=
      direction==="LONG"
        ? price>ma
        : direction==="SHORT"
          ? price<ma
          : false;

    const strict=
      touch &&
      slope!=="FLAT" &&
      trendConfirm &&
      volumeConfirmed &&
      (
        bullishRejection ||
        bearishRejection
      );

    const crossConfirm=
      touch &&
      slope!=="FLAT" &&
      trendConfirm &&
      volumeConfirmed &&
      (
        crossUp ||
        crossDown
      );

    const confirmation=
      strict || crossConfirm
        ? direction==="LONG"
          ? "CONFIRMED_LONG"
          : direction==="SHORT"
            ? "CONFIRMED_SHORT"
            : "WAIT"
        : "WAIT";

    events.push({

      source:m.source,

      ma:`MA${m.ma}`,

      period1m:m.period,

      time:candle.time,

      price,
      maValue:ma,

      type:
        !touch
          ? "NONE"
          : (
              bullishRejection ||
              bearishRejection
            )
              ? "REJECTION"
              : (
                  crossUp ||
                  crossDown
                )
                  ? "BREAK"
                  : "TOUCH",

      direction,

      rejection:
        bullishRejection ||
        bearishRejection,

      bullishRejection,
      bearishRejection,

      crossUp,
      crossDown,

      slope,
      slopePct,

      volumeConfirmed,

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
            "CONFIRMED_LONG" ||
          x.confirmation===
            "CONFIRMED_SHORT"
      ),

    latest:
      events
        .filter(x=>x.type!=="NONE")
        .at(-1) || null
  };
}

/* =========================================================
   SCORE SELECTED METHODS
========================================================= */

function calculateSelectedScore(
  tf,
  converted,
  fp,
  wall,
  market,
  selected,
  threshold
){

  const methods=
    selected?.length
      ? selected
      : METHODS;

  let long=0;
  let short=0;

  const longReasons=[];
  const shortReasons=[];

  const add=(dir,score,reason,method)=>{

    if(!methods.includes(method)){
      return;
    }

    if(dir==="LONG"){

      long+=score;

      longReasons.push({
        method,
        score,
        reason
      });
    }

    if(dir==="SHORT"){

      short+=score;

      shortReasons.push({
        method,
        score,
        reason
      });
    }
  };

  const one=tf["1"];

  if(one){

    /* MA */

    if(
      one.trend==="BULLISH" &&
      one.maSlope==="UP"
    ){

      add(
        "LONG",
        8,
        "قیمت بالای MA20 و MA7 بالای MA20 است.",
        "MA"
      );
    }

    if(
      one.trend==="BEARISH" &&
      one.maSlope==="DOWN"
    ){

      add(
        "SHORT",
        8,
        "قیمت زیر MA20 و MA7 زیر MA20 است.",
        "MA"
      );
    }

    if(one.touchMA20){

      if(one.maSlope==="UP"){

        add(
          "LONG",
          6,
          "قیمت با MA20 برخورد کرده و شیب آن صعودی است.",
          "MA"
        );
      }

      if(one.maSlope==="DOWN"){

        add(
          "SHORT",
          6,
          "قیمت با MA20 برخورد کرده و شیب آن نزولی است.",
          "MA"
        );
      }
    }

    /* SMC */

    if(one.hunt?.confirmed){

      add(
        one.hunt.side,
        10,
        "Liquidity Sweep تأیید شده است.",
        "SMC"
      );
    }

    if(one.orderBlock?.type==="BULLISH"){

      add(
        "LONG",
        5,
        "Order Block صعودی شناسایی شد.",
        "SMC"
      );
    }

    if(one.orderBlock?.type==="BEARISH"){

      add(
        "SHORT",
        5,
        "Order Block نزولی شناسایی شد.",
        "SMC"
      );
    }

    /* ICT */

    if(one.fvg?.type==="BULLISH"){

      add(
        "LONG",
        6,
        "FVG صعودی شناسایی شد.",
        "ICT"
      );
    }

    if(one.fvg?.type==="BEARISH"){

      add(
        "SHORT",
        6,
        "FVG نزولی شناسایی شد.",
        "ICT"
      );
    }

    /* MACD */

    if(
      one.macd?.cross==="BULLISH"
    ){

      add(
        "LONG",
        8,
        "کراس صعودی MACD.",
        "MACD"
      );
    }

    if(
      one.macd?.cross==="BEARISH"
    ){

      add(
        "SHORT",
        8,
        "کراس نزولی MACD.",
        "MACD"
      );
    }

    if(one.macd?.bullish){

      add(
        "LONG",
        4,
        "هیستوگرام MACD مثبت است.",
        "MACD"
      );
    }

    if(one.macd?.bearish){

      add(
        "SHORT",
        4,
        "هیستوگرام MACD منفی است.",
        "MACD"
      );
    }

    /* RSI */

    if(
      one.rsi?.value>50 &&
      one.rsi?.value<70
    ){

      add(
        "LONG",
        5,
        `RSI صعودی است (${one.rsi.value.toFixed(1)}).`,
        "RSI"
      );
    }

    if(
      one.rsi?.value<50 &&
      one.rsi?.value>30
    ){

      add(
        "SHORT",
        5,
        `RSI نزولی است (${one.rsi.value.toFixed(1)}).`,
        "RSI"
      );
    }

    if(
      one.rsi?.value<=30
    ){

      add(
        "LONG",
        7,
        "RSI در محدوده اشباع فروش قرار دارد.",
        "RSI"
      );
    }

    if(
      one.rsi?.value>=70
    ){

      add(
        "SHORT",
        7,
        "RSI در محدوده اشباع خرید قرار دارد.",
        "RSI"
      );
    }

    /* DIVERGENCE */

    if(
      one.divergence?.type==="BULLISH"
    ){

      add(
        "LONG",
        10,
        "واگرایی مثبت قیمت و RSI.",
        "DIVERGENCE"
      );
    }

    if(
      one.divergence?.type==="BEARISH"
    ){

      add(
        "SHORT",
        10,
        "واگرایی منفی قیمت و RSI.",
        "DIVERGENCE"
      );
    }

    /* ICHIMOKU */

    if(
      one.ichimoku?.direction==="LONG"
    ){

      add(
        "LONG",
        8,
        "قیمت بالای ابر و Tenkan بالای Kijun است.",
        "ICHIMOKU"
      );
    }

    if(
      one.ichimoku?.direction==="SHORT"
    ){

      add(
        "SHORT",
        8,
        "قیمت زیر ابر و Tenkan زیر Kijun است.",
        "ICHIMOKU"
      );
    }

    /* VOLUME */

    if(one.volume?.spike){

      if(one.trend==="BULLISH"){

        add(
          "LONG",
          7,
          "افزایش غیرعادی حجم در روند صعودی.",
          "VOLUME"
        );
      }

      if(one.trend==="BEARISH"){

        add(
          "SHORT",
          7,
          "افزایش غیرعادی حجم در روند نزولی.",
          "VOLUME"
        );
      }
    }

    /* FVG */

    if(
      one.fvg?.type==="BULLISH"
    ){

      add(
        "LONG",
        5,
        "FVG صعودی.",
        "FVG"
      );
    }

    if(
      one.fvg?.type==="BEARISH"
    ){

      add(
        "SHORT",
        5,
        "FVG نزولی.",
        "FVG"
      );
    }

    /* BOS */

    if(one.bos==="BULLISH"){

      add(
        "LONG",
        9,
        "شکست ساختار صعودی.",
        "BOS"
      );
    }

    if(one.bos==="BEARISH"){

      add(
        "SHORT",
        9,
        "شکست ساختار نزولی.",
        "BOS"
      );
    }

    /* CHOCH */

    if(one.choch==="BULLISH"){

      add(
        "LONG",
        12,
        "تغییر شخصیت بازار به صعودی.",
        "CHOCH"
      );
    }

    if(one.choch==="BEARISH"){

      add(
        "SHORT",
        12,
        "تغییر شخصیت بازار به نزولی.",
        "CHOCH"
      );
    }

    /* ORDER BLOCK */

    if(
      one.orderBlock?.type==="BULLISH"
    ){

      add(
        "LONG",
        6,
        "Order Block صعودی.",
        "ORDERBLOCK"
      );
    }

    if(
      one.orderBlock?.type==="BEARISH"
    ){

      add(
        "SHORT",
        6,
        "Order Block نزولی.",
        "ORDERBLOCK"
      );
    }
  }

  /* ORDER FLOW */

  if(
    fp &&
    !fp.error
  ){

    if(fp.deltaPercent>=8){

      add(
        "LONG",
        10,
        `Delta مثبت ${fp.deltaPercent.toFixed(2)}%.`,
        "ORDERFLOW"
      );
    }

    if(fp.deltaPercent<=-8){

      add(
        "SHORT",
        10,
        `Delta منفی ${fp.deltaPercent.toFixed(2)}%.`,
        "ORDERFLOW"
      );
    }
  }

  /* LIQUIDITY */

  if(
    wall &&
    !wall.error
  ){

    if(
      wall.buyNear &&
      wall.buyStrength>=60
    ){

      add(
        "LONG",
        8,
        "Buy Wall قوی نزدیک قیمت.",
        "LIQUIDITY"
      );
    }

    if(
      wall.sellNear &&
      wall.sellStrength>=60
    ){

      add(
        "SHORT",
        8,
        "Sell Wall قوی نزدیک قیمت.",
        "LIQUIDITY"
      );
    }
  }

  /* SR */

  if(wall){

    if(wall.buyNear){

      add(
        "LONG",
        5,
        "حمایت نقدینگی نزدیک قیمت.",
        "SR"
      );
    }

    if(wall.sellNear){

      add(
        "SHORT",
        5,
        "مقاومت نقدینگی نزدیک قیمت.",
        "SR"
      );
    }
  }

  /* OI */

  if(
    market &&
    market.openInterest
  ){

    if(
      market.change24h>2
    ){

      add(
        "LONG",
        4,
        "حرکت قیمت صعودی همراه با OI قابل توجه.",
        "OI"
      );
    }

    if(
      market.change24h<-2
    ){

      add(
        "SHORT",
        4,
        "حرکت قیمت نزولی همراه با OI قابل توجه.",
        "OI"
      );
    }
  }

  /* FUNDING */

  if(
    market &&
    Number.isFinite(
      market.fundingRate
    )
  ){

    if(
      market.fundingRate<0
    ){

      add(
        "LONG",
        3,
        "Funding منفی است.",
        "FUNDING"
      );
    }

    if(
      market.fundingRate>0
    ){

      add(
        "SHORT",
        3,
        "Funding مثبت است.",
        "FUNDING"
      );
    }
  }

  /*
    سخت‌گیری:
    حداقل آستانه کاربر رعایت می‌شود.
    اگر چند روش فعال باشند،
    حداقل سه نوع تأیید مستقل برای سیگنال نهایی لازم است.
  */

  const selectedLongMethods=
    new Set(
      longReasons.map(x=>x.method)
    );

  const selectedShortMethods=
    new Set(
      shortReasons.map(x=>x.method)
    );

  const longStrong=
    long>=threshold &&
    selectedLongMethods.size>=3;

  const shortStrong=
    short>=threshold &&
    selectedShortMethods.size>=3;

  let direction="WAIT";

  if(longStrong && long>short){
    direction="LONG";
  }

  if(shortStrong && short>long){
    direction="SHORT";
  }

  return {

    longScore:
      Math.round(
        clamp(long,0,100)
      ),

    shortScore:
      Math.round(
        clamp(short,0,100)
      ),

    direction,

    finalScore:
      Math.round(
        clamp(
          Math.max(long,short),
          0,
          100
        )
      ),

    signalConfirmed:
      direction!=="WAIT",

    selectedMethods:methods,

    longMethods:[
      ...selectedLongMethods
    ],

    shortMethods:[
      ...selectedShortMethods
    ],

    longReasons,
    shortReasons,

    threshold,

    confirmationRule:
      "حداقل امتیاز انتخابی + حداقل ۳ نوع تأیید مستقل"
  };
}

/* =========================================================
   STYLE DETAILS
========================================================= */

function styleDetails(
  tf,
  fp,
  wall
){

  const one=tf["1"];

  return {

    MA:{
      score:
        one?.maSlope==="UP" ||
        one?.maSlope==="DOWN"
          ? 75
          : 40,

      direction:
        one?.trend==="BULLISH"
          ? "LONG"
          : one?.trend==="BEARISH"
            ? "SHORT"
            : "NONE",

      details:{
        MA7:one?.ma7 || null,
        MA20:one?.ma20 || null,
        slope:one?.maSlope || "UNKNOWN",
        touchMA7:one?.touchMA7 || false,
        touchMA20:one?.touchMA20 || false,
        trend:one?.trend || "UNKNOWN"
      }
    },

    SMC:{
      score:
        one?.hunt?.confirmed ||
        one?.orderBlock?.type!=="NONE"
          ? 80
          : 40,

      direction:
        one?.hunt?.side || "NONE",

      details:{
        hunt:one?.hunt || null,
        orderBlock:one?.orderBlock || null,
        BOS:one?.bos || "NONE",
        CHoCH:one?.choch || "NONE"
      }
    },

    ICT:{
      score:
        one?.fvg?.type!=="NONE"
          ? 75
          : 40,

      direction:
        one?.fvg?.type==="BULLISH"
          ? "LONG"
          : one?.fvg?.type==="BEARISH"
            ? "SHORT"
            : "NONE",

      details:{
        FVG:one?.fvg || null,
        liquidityHunt:one?.hunt || null
      }
    },

    MACD:{
      score:
        one?.macd?.cross!=="NONE"
          ? 80
          : 50,

      direction:
        one?.macd?.direction || "NONE",

      details:one?.macd || null
    },

    RSI:{
      score:
        one?.rsi?.state==="OVERSOLD" ||
        one?.rsi?.state==="OVERBOUGHT"
          ? 75
          : 55,

      direction:
        one?.rsi?.value>50
          ? "LONG"
          : one?.rsi?.value<50
            ? "SHORT"
            : "NONE",

      details:one?.rsi || null
    },

    DIVERGENCE:{
      score:
        one?.divergence?.strength || 0,

      direction:
        one?.divergence?.type==="BULLISH"
          ? "LONG"
          : one?.divergence?.type==="BEARISH"
            ? "SHORT"
            : "NONE",

      details:one?.divergence || null
    },

    ICHIMOKU:{
      score:
        one?.ichimoku?.direction!=="NONE"
          ? 75
          : 45,

      direction:
        one?.ichimoku?.direction || "NONE",

      details:one?.ichimoku || null
    },

    VOLUME:{
      score:
        one?.volume?.spike
          ? 80
          : 45,

      direction:
        one?.trend==="BULLISH"
          ? "LONG"
          : one?.trend==="BEARISH"
            ? "SHORT"
            : "NONE",

      details:one?.volume || null
    },

    ORDERFLOW:{
      score:
        fp && !fp.error
          ? clamp(
              50+
              Math.abs(fp.deltaPercent),
              0,
              100
            )
          : 0,

      direction:
        fp?.deltaPercent>8
          ? "LONG"
          : fp?.deltaPercent<-8
            ? "SHORT"
            : "NONE",

      details:fp || null
    },

    LIQUIDITY:{
      score:
        wall && !wall.error
          ? Math.max(
              wall.buyStrength||0,
              wall.sellStrength||0
            )
          : 0,

      direction:
        wall?.buyStrength>
        wall?.sellStrength
          ? "LONG"
          : wall?.sellStrength>
            wall?.buyStrength
              ? "SHORT"
              : "NONE",

      details:wall || null
    },

    FVG:{
      score:
        one?.fvg?.type!=="NONE"
          ? 75
          : 0,

      direction:
        one?.fvg?.type==="BULLISH"
          ? "LONG"
          : one?.fvg?.type==="BEARISH"
            ? "SHORT"
            : "NONE",

      details:one?.fvg || null
    },

    BOS:{
      score:
        one?.bos!=="NONE"
          ? 80
          : 0,

      direction:
        one?.bos==="BULLISH"
          ? "LONG"
          : one?.bos==="BEARISH"
            ? "SHORT"
            : "NONE",

      details:{
        value:one?.bos || "NONE",
        text:
          one?.bos==="BULLISH"
            ? "شکست ساختار صعودی"
            : one?.bos==="BEARISH"
              ? "شکست ساختار نزولی"
              : "شکست ساختار مشاهده نشد"
      }
    },

    CHOCH:{
      score:
        one?.choch!=="NONE"
          ? 90
          : 0,

      direction:
        one?.choch==="BULLISH"
          ? "LONG"
          : one?.choch==="BEARISH"
            ? "SHORT"
            : "NONE",

      details:{
        value:one?.choch || "NONE",
        text:
          one?.choch==="BULLISH"
            ? "تغییر شخصیت صعودی"
            : one?.choch==="BEARISH"
              ? "تغییر شخصیت نزولی"
              : "تغییر شخصیت مشاهده نشد"
      }
    },

    ORDERBLOCK:{
      score:
        one?.orderBlock?.type!=="NONE"
          ? 75
          : 0,

      direction:
        one?.orderBlock?.type==="BULLISH"
          ? "LONG"
          : one?.orderBlock?.type==="BEARISH"
            ? "SHORT"
            : "NONE",

      details:one?.orderBlock || null
    },

    SR:{
      score:
        wall && !wall.error
          ? 60
          : 0,

      direction:"NONE",

      details:{
        buyWall:wall?.buy || null,
        sellWall:wall?.sell || null
      }
    },

    OI:{
      score:0,
      direction:"NONE",
      details:null
    },

    FUNDING:{
      score:0,
      direction:"NONE",
      details:null
    }
  };
}

/* =========================================================
   PUMP / DUMP
========================================================= */

function movementAnalysis(
  c,
  tf,
  wall
){

  const price=
    c.at(-1)?.close || 0;

  const p15=
    c.length>=15
      ? c.at(-15).close
      : price;

  const p30=
    c.length>=30
      ? c.at(-30).close
      : price;

  const change15=
    pct(price,p15);

  const change30=
    pct(price,p30);

  const vol20=
    sma(
      c.slice(-21,-1)
        .map(x=>x.volume),
      20
    );

  const volumeRatio=
    vol20
      ? c.at(-1).volume/vol20
      : 0;

  let pump=0;
  let dump=0;

  const pumpReasons=[];
  const dumpReasons=[];

  if(change15>=3){

    pump+=20;

    pumpReasons.push(
      `رشد کوتاه‌مدت ${change15.toFixed(2)}٪`
    );
  }

  if(change15<=-3){

    dump+=20;

    dumpReasons.push(
      `افت کوتاه‌مدت ${Math.abs(change15).toFixed(2)}٪`
    );
  }

  if(change30>=5){
    pump+=10;
  }

  if(change30<=-5){
    dump+=10;
  }

  if(volumeRatio>=1.5){

    pump+=10;
    dump+=10;

    pumpReasons.push(
      "افزایش شدید حجم"
    );

    dumpReasons.push(
      "افزایش شدید حجم"
    );
  }

  if(tf?.["1"]?.maSlope==="UP"){
    pump+=8;
  }

  if(tf?.["1"]?.maSlope==="DOWN"){
    dump+=8;
  }

  if(tf?.["1"]?.hunt?.confirmed){

    if(tf["1"].hunt.side==="LONG"){
      pump+=8;
    }

    if(tf["1"].hunt.side==="SHORT"){
      dump+=8;
    }
  }

  if(
    wall?.buyNear &&
    wall.buyStrength>=60
  ){

    pump+=8;

    pumpReasons.push(
      "Buy Wall قوی"
    );
  }

  if(
    wall?.sellNear &&
    wall.sellStrength>=60
  ){

    dump+=8;

    dumpReasons.push(
      "Sell Wall قوی"
    );
  }

  return {

    change15m:change15,
    change30m:change30,

    volumeRatio,

    pumpScore:
      Math.round(
        clamp(pump,0,100)
      ),

    dumpScore:
      Math.round(
        clamp(dump,0,100)
      ),

    pumpReasons,
    dumpReasons
  };
}

/* =========================================================
   DEEP ANALYSIS
========================================================= */

async function deepAnalyze(
  category,
  symbol,
  threshold=DEFAULT_THRESHOLD,
  selectedMethods=METHODS
){

  threshold=
    clamp(
      n(threshold,DEFAULT_THRESHOLD),
      MIN_THRESHOLD,
      MAX_THRESHOLD
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
        oneMinute.slice(-200)
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
            120
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
      .filter(x=>!x.error);

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

  const market=
    category==="linear"
      ? await oiFunding(symbol)
      : {
          openInterest:null,
          fundingRate:null,
          turnover24h:null,
          change24h:null,
          markPrice:null,
          indexPrice:null
        };

  const sr=
    supportResistance(
      oneMinute,
      wall,
      price
    );

  const scoring=
    calculateSelectedScore(
      tf,
      converted,
      fp,
      wall,
      market,
      selectedMethods,
      threshold
    );

  const styles=
    styleDetails(
      tf,
      fp,
      wall
    );

  styles.OI.details=market;

  styles.FUNDING.details={
    fundingRate:
      market.fundingRate
  };

  const movement=
    movementAnalysis(
      oneMinute,
      tf,
      wall
    );

  const signalLevel=
    scoring.finalScore>=85
      ? "VERY_STRONG"
      : scoring.finalScore>=threshold
        ? "CONFIRMED"
        : scoring.finalScore>=60
          ? "WATCH"
          : "NONE";

  return {

    symbol,

    marketType:
      category==="linear"
        ? "DERIVATIVES"
        : "SPOT",

    price,

    direction:
      scoring.direction,

    score:
      scoring.finalScore,

    longScore:
      scoring.longScore,

    shortScore:
      scoring.shortScore,

    signalConfirmed:
      scoring.signalConfirmed,

    signalLevel,

    threshold,

    selectedMethods,

    timeframes:tf,

    convertedMA1m:converted,

    footprint:fp,

    walls:wall,

    supportResistance:sr,

    market,

    movement,

    styles,

    reasons:
      scoring.direction==="LONG"
        ? scoring.longReasons
        : scoring.direction==="SHORT"
          ? scoring.shortReasons
          : [
              ...scoring.longReasons,
              ...scoring.shortReasons
            ],

    scoreDetails:{
      longReasons:scoring.longReasons,
      shortReasons:scoring.shortReasons,

      confirmationRule:
        scoring.confirmationRule
    },

    generatedAt:Date.now(),

    liquidation:{
      available:false,

      message:
        "داده تجمیعی لیکوئیدیشن در این خروجی تولید نمی‌شود."
    }
  };
}

/* =========================================================
   INSTRUMENTS
========================================================= */

async function instruments(category){

  const d=
    await dataApi(
      "/v5/market/instruments-info",
      {
        category,
        limit:1000
      }
    );

  return d?.result?.list || [];
}

function validFutures(list){

  return list.filter(
    x=>
      x.status==="Trading" &&
      x.quoteCoin==="USDT" &&
      x.contractType==="LinearPerpetual"
  );
}

/* =========================================================
   SEARCH
========================================================= */

async function findSymbol(input){

  const raw=
    String(input||"")
      .trim()
      .toUpperCase();

  const bare=
    raw
      .replace(/[-_/:\s]/g,"")
      .replace(/USDT$/,"");

  const [
    futuresList,
    spotList
  ]=
    await Promise.all([
      instruments("linear"),
      instruments("spot")
    ]);

  const futures=
    validFutures(
      futuresList
    );

  const f=
    futures.find(
      x=>
        String(x.symbol).toUpperCase()===raw ||
        String(x.symbol).toUpperCase()===
          bare+"USDT" ||
        String(x.baseCoin).toUpperCase()===bare
    );

  const s=
    spotList.find(
      x=>
        x.status==="Trading" &&
        (
          String(x.symbol).toUpperCase()===raw ||
          String(x.symbol).toUpperCase()===
            bare+"USDT" ||
          String(x.baseCoin).toUpperCase()===bare
        )
    );

  /*
    Futures اولویت دارد.
  */

  if(f){

    return {

      found:true,

      category:"linear",

      symbol:f.symbol,

      marketType:"DERIVATIVES",

      baseCoin:f.baseCoin,
      quoteCoin:f.quoteCoin
    };
  }

  if(s){

    return {

      found:true,

      category:"spot",

      symbol:s.symbol,

      marketType:"SPOT",

      baseCoin:s.baseCoin,
      quoteCoin:s.quoteCoin
    };
  }

  return {
    found:false,
    category:null,
    symbol:null
  };
}

/* =========================================================
   ROTATING SCAN
========================================================= */

async function scan(
  offset=0,
  threshold=DEFAULT_THRESHOLD,
  selectedMethods=METHODS
){

  const ms=
    validFutures(
      await instruments("linear")
    );

  const list=
    ms.sort(
      (a,b)=>
        String(a.symbol)
          .localeCompare(
            String(b.symbol)
          )
    );

  if(!list.length){

    return {
      ok:false,
      error:"بازار فعالی پیدا نشد."
    };
  }

  const safeOffset=
    Math.max(
      0,
      Math.min(
        offset,
        Math.max(
          0,
          list.length-1
        )
      )
    );

  const batch=
    list.slice(
      safeOffset,
      safeOffset+SCAN_BATCH
    );

  const light=[];

  for(const m of batch){

    try{

      const c=
        analyzeCandles(
          await klines(
            "linear",
            m.symbol,
            "1",
            80
          )
        );

      if(c.error) continue;

      let activity=0;

      if(c.touchMA20) activity+=15;
      if(c.touchMA7) activity+=10;
      if(c.volume.spike) activity+=20;
      if(c.market.state==="ACTIVE") activity+=15;
      if(c.hunt.confirmed) activity+=20;
      if(c.bos!=="NONE") activity+=10;
      if(c.choch!=="NONE") activity+=15;
      if(c.macd.cross!=="NONE") activity+=10;
      if(c.divergence.type!=="NONE") activity+=15;

      light.push({
        symbol:m.symbol,
        activity
      });

    }catch(e){}
  }

  light.sort(
    (a,b)=>
      b.activity-a.activity
  );

  const deep=
    await Promise.all(
      light
        .slice(0,DEEP_LIMIT)
        .map(
          x=>
            deepAnalyze(
              "linear",
              x.symbol,
              threshold,
              selectedMethods
            )
        )
    );

  const signals=
    deep
      .filter(
        x=>x.signalConfirmed
      )
      .sort(
        (a,b)=>b.score-a.score
      );

  const next=
    (
      safeOffset+
      SCAN_BATCH
    )%list.length;

  return {

    ok:true,

    totalMarkets:list.length,

    offset:safeOffset,

    batchSize:batch.length,

    nextOffset:next,

    threshold,

    selectedMethods,

    results:signals,

    scannedSymbols:
      batch.map(x=>x.symbol)
  };
}

/* =========================================================
   RADAR
========================================================= */

async function radar(offset=0){

  const ms=
    validFutures(
      await instruments("linear")
    );

  const list=
    ms.sort(
      (a,b)=>
        String(a.symbol)
          .localeCompare(
            String(b.symbol)
          )
    );

  if(!list.length){

    return {
      ok:false,
      error:"بازار فعال پیدا نشد."
    };
  }

  const safeOffset=
    Math.max(
      0,
      Math.min(
        offset,
        Math.max(
          0,
          list.length-1
        )
      )
    );

  const batch=
    list.slice(
      safeOffset,
      safeOffset+SCAN_BATCH
    );

  const candidates=[];

  for(const m of batch){

    try{

      const c=
        await klines(
          "linear",
          m.symbol,
          "1",
          80
        );

      if(c.length<30) continue;

      const price=c.at(-1).close;

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

      const volume=
        c.at(-1).volume;

      const avgVol=
        sma(
          c.slice(-21,-1)
            .map(x=>x.volume),
          20
        );

      const volumeRatio=
        avgVol
          ? volume/avgVol
          : 0;

      const h=hunt(c);
      const structure=detectStructure(c);

      const activity=
        Math.abs(change15)*4+
        Math.abs(change30)*2+
        Math.min(
          volumeRatio*10,
          30
        )+
        (h.confirmed?20:0)+
        (structure.choch!=="NONE"?15:0);

      candidates.push({
        symbol:m.symbol,
        activity
      });

    }catch(e){}
  }

  candidates.sort(
    (a,b)=>
      b.activity-a.activity
  );

  const deep=
    await Promise.all(
      candidates
        .slice(0,RADAR_LIMIT)
        .map(
          x=>
            deepAnalyze(
              "linear",
              x.symbol
            )
        )
    );

  const pump=
    deep
      .filter(x=>x.movement.pumpScore>=50)
      .sort(
        (a,b)=>
          b.movement.pumpScore-
          a.movement.pumpScore
      );

  const dump=
    deep
      .filter(x=>x.movement.dumpScore>=50)
      .sort(
        (a,b)=>
          b.movement.dumpScore-
          a.movement.dumpScore
      );

  return {

    ok:true,

    totalMarkets:list.length,

    offset:safeOffset,

    nextOffset:
      (
        safeOffset+
        SCAN_BATCH
      )%list.length,

    pump,
    dump,

    reversal:
      deep.filter(
        x=>
          (
            x.movement.pumpScore>=50 &&
            x.timeframes["1"]?.choch==="BEARISH"
          ) ||
          (
            x.movement.dumpScore>=50 &&
            x.timeframes["1"]?.choch==="BULLISH"
          )
      ),

    results:deep,

    scannedSymbols:
      batch.map(x=>x.symbol)
  };
}

/* =========================================================
   OPTIONS
========================================================= */

function parseMethods(value){

  if(!value){
    return METHODS;
  }

  const arr=
    String(value)
      .split(",")
      .map(x=>x.trim().toUpperCase())
      .filter(
        x=>METHODS.includes(x)
      );

  return arr.length
    ? [...new Set(arr)]
    : METHODS;
}

/* =========================================================
   ROUTER
========================================================= */

export default {

  async fetch(request,env){

    const u=
      new URL(request.url);

    const p=u.pathname;

    if(request.method==="OPTIONS"){

      return json({
        ok:true
      });
    }

    try{

      /* -------------------------------------
         MANUAL SEARCH
      ------------------------------------- */

      if(p==="/api/search"){

        const q=
          u.searchParams.get("symbol");

        if(!q){

          return json(
            {
              ok:false,
              error:"نام ارز وارد نشده است."
            },
            400
          );
        }

        const found=
          await findSymbol(q);

        if(!found.found){

          return json({
            ok:false,

            error:
              "این ارز در بازارهای قابل بررسی پیدا نشد."
          },404);
        }

        return json({
          ok:true,
          ...found
        });
      }

      /* -------------------------------------
         DEEP ANALYSIS
      ------------------------------------- */

      if(p==="/api/analyze"){

        const symbol=
          u.searchParams.get("symbol");

        if(!symbol){

          return json(
            {
              ok:false,
              error:"نام ارز وارد نشده است."
            },
            400
          );
        }

        const threshold=
          clamp(
            n(
              u.searchParams.get(
                "threshold"
              ),
              DEFAULT_THRESHOLD
            ),
            MIN_THRESHOLD,
            MAX_THRESHOLD
          );

        const selectedMethods=
          parseMethods(
            u.searchParams.get(
              "methods"
            )
          );

        const found=
          await findSymbol(symbol);

        if(!found.found){

          return json(
            {
              ok:false,

              error:
                "ارز موردنظر پیدا نشد."
            },
            404
          );
        }

        const analysis=
          await deepAnalyze(
            found.category,
            found.symbol,
            threshold,
            selectedMethods
          );

        return json({

          ok:true,

          ...analysis,

          search:{
            input:symbol,
            marketType:found.marketType
          }
        });
      }

      /* -------------------------------------
         SCAN
      ------------------------------------- */

      if(p==="/api/scan"){

        const offset=
          n(
            u.searchParams.get("offset"),
            0
          );

        const threshold=
          clamp(
            n(
              u.searchParams.get("threshold"),
              DEFAULT_THRESHOLD
            ),
            MIN_THRESHOLD,
            MAX_THRESHOLD
          );

        const methods=
          parseMethods(
            u.searchParams.get("methods")
          );

        return json(
          await scan(
            offset,
            threshold,
            methods
          )
        );
      }

      /* -------------------------------------
         RADAR
      ------------------------------------- */

      if(p==="/api/radar"){

        return json(
          await radar(
            n(
              u.searchParams.get("offset"),
              0
            )
          )
        );
      }

      /* -------------------------------------
         HEALTH
      ------------------------------------- */

      if(p==="/api/health"){

        return json({

          ok:true,

          service:
            "Smart Market Scanner",

          version:
            "V9",

          timeframes:
            TF.map(x=>x.interval),

          minimumThreshold:
            MIN_THRESHOLD,

          maximumThreshold:
            MAX_THRESHOLD,

          defaultThreshold:
            DEFAULT_THRESHOLD,

          methods:METHODS,

          features:[

            "Manual Auto Market Search",

            "Derivatives Analysis",

            "Spot Analysis",

            "Moving Average",

            "Smart Money",

            "ICT",

            "MACD",

            "RSI",

            "Divergence",

            "Ichimoku",

            "Volume",

            "Order Flow",

            "Liquidity",

            "FVG",

            "BOS",

            "CHoCH",

            "Order Block",

            "Support Resistance",

            "Open Interest",

            "Funding",

            "Pump Radar",

            "Dump Radar"
          ]
        });
      }

      /* -------------------------------------
         STATIC FILES
      ------------------------------------- */

      if(
        env &&
        env.ASSETS &&
        typeof env.ASSETS.fetch==="function"
      ){

        return env.ASSETS.fetch(
          request
        );
      }

      return new Response(
        "Not Found",
        {
          status:404
        }
      );

    }catch(e){

      return json(
        {
          ok:false,

          error:
            "خطا در پردازش درخواست.",

          code:
            String(e.message||"ERROR")
        },
        500
      );
    }
  }
};
