const DATA_API = "https://api.bybit.com";

const SCAN_BATCH = 20;
const DEEP_LIMIT = 3;
const RADAR_LIMIT = 5;
const DEEP_1M_LIMIT = 1300;

const DEFAULT_MIN_SCORE = 75;
const DEFAULT_WATCH_SCORE = 60;

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

const TF = [
  {key:"1",  label:"1 دقیقه",  interval:"1"},
  {key:"3",  label:"3 دقیقه",  interval:"3"},
  {key:"5",  label:"5 دقیقه",  interval:"5"},
  {key:"15", label:"15 دقیقه", interval:"15"},
  {key:"60", label:"1 ساعت",   interval:"60"}
];

const ALL_METHODS = [
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
  new Response(JSON.stringify(data),{
    status,
    headers:{
      "content-type":"application/json; charset=UTF-8",
      "cache-control":"no-store",
      "access-control-allow-origin":"*",
      "access-control-allow-methods":"GET,OPTIONS",
      "access-control-allow-headers":"Content-Type"
    }
  });

const n=(v,d=0)=>
  Number.isFinite(Number(v)) ? Number(v) : d;

const clamp=(v,a,b)=>
  Math.max(a,Math.min(b,v));

const avg=a=>
  a.length ? a.reduce((x,y)=>x+y,0)/a.length : 0;

function pct(a,b){
  if(!b)return 0;
  return ((a-b)/b)*100;
}

function absPct(a,b){
  if(!b)return 999;
  return Math.abs((a-b)/b)*100;
}

async function api(path,params={}){
  const u=new URL(DATA_API+path);

  for(const [k,v] of Object.entries(params)){
    if(v!==undefined && v!==null){
      u.searchParams.set(k,String(v));
    }
  }

  const r=await fetch(u,{
    headers:{accept:"application/json"}
  });

  if(!r.ok){
    throw new Error(`Data source HTTP ${r.status}`);
  }

  const d=await r.json();

  if(d.retCode!==0){
    throw new Error(d.retMsg||`Data source ${d.retCode}`);
  }

  return d;
}

async function klines(category,symbol,interval,limit=100){
  const d=await api("/v5/market/kline",{
    category,
    symbol,
    interval,
    limit
  });

  return (d?.result?.list||[])
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

function sma(a,p){
  if(!a.length)return 0;
  return a.length<p ? avg(a) : avg(a.slice(-p));
}

function ema(a,p){
  if(!a.length)return 0;

  const k=2/(p+1);
  let x=a[0];

  for(let i=1;i<a.length;i++){
    x=a[i]*k+x*(1-k);
  }

  return x;
}

/* =========================================================
   RSI
========================================================= */

function rsi(c,p=14){

  if(c.length<p+1)return 50;

  const close=c.map(x=>x.close);

  let gain=0;
  let loss=0;

  for(let i=close.length-p;i<close.length;i++){

    const d=close[i]-close[i-1];

    if(d>0)gain+=d;
    else loss-=d;
  }

  if(loss===0)return 100;

  const rs=
    (gain/p)/
    (loss/p);

  return 100-(100/(1+rs));
}

/* =========================================================
   MACD
========================================================= */

function macd(c){

  const close=c.map(x=>x.close);

  if(close.length<35){
    return {
      macd:0,
      signal:0,
      histogram:0,
      direction:"NONE",
      cross:"NONE"
    };
  }

  const fast=[];
  const slow=[];

  for(let i=0;i<close.length;i++){

    const a=close.slice(0,i+1);

    fast.push(
      a.length>=12
        ? ema(a,12)
        : null
    );

    slow.push(
      a.length>=26
        ? ema(a,26)
        : null
    );
  }

  const line=fast.map((x,i)=>
    x!==null && slow[i]!==null
      ? x-slow[i]
      : null
  ).filter(x=>x!==null);

  const signalSeries=[];

  for(let i=0;i<line.length;i++){
    const a=line.slice(0,i+1);
    signalSeries.push(
      a.length>=9
        ? ema(a,9)
        : null
    );
  }

  const m=line.at(-1)||0;
  const s=signalSeries.at(-1)||0;

  const pm=line.at(-2)||m;
  const ps=signalSeries.at(-2)||s;

  let cross="NONE";

  if(pm<=ps && m>s){
    cross="BULLISH";
  }

  if(pm>=ps && m<s){
    cross="BEARISH";
  }

  return {
    macd:m,
    signal:s,
    histogram:m-s,

    direction:
      m>s
        ? "BULLISH"
        : m<s
          ? "BEARISH"
          : "NEUTRAL",

    cross
  };
}

/* =========================================================
   ICHIMOKU
========================================================= */

function ichimoku(c){

  if(c.length<52){
    return {
      direction:"NONE",
      tenkan:0,
      kijun:0,
      cloudTop:0,
      cloudBottom:0,
      priceAboveCloud:false,
      priceBelowCloud:false
    };
  }

  const mid=(arr)=>{
    const hi=Math.max(...arr.map(x=>x.high));
    const lo=Math.min(...arr.map(x=>x.low));
    return (hi+lo)/2;
  };

  const tenkan=mid(c.slice(-9));
  const kijun=mid(c.slice(-26));

  const spanA=(tenkan+kijun)/2;
  const spanB=mid(c.slice(-52));

  const cloudTop=Math.max(spanA,spanB);
  const cloudBottom=Math.min(spanA,spanB);

  const price=c.at(-1).close;

  const above=price>cloudTop;
  const below=price<cloudBottom;

  return {
    tenkan,
    kijun,
    cloudTop,
    cloudBottom,

    priceAboveCloud:above,
    priceBelowCloud:below,

    direction:
      above && tenkan>kijun
        ? "BULLISH"
        : below && tenkan<kijun
          ? "BEARISH"
          : "NEUTRAL"
  };
}

/* =========================================================
   DIVERGENCE
========================================================= */

function divergence(c){

  if(c.length<35){
    return {
      type:"NONE",
      side:"NONE",
      confirmed:false
    };
  }

  const recent=c.slice(-30);

  const mid=Math.floor(recent.length/2);

  const a=recent.slice(0,mid);
  const b=recent.slice(mid);

  const priceLowA=Math.min(...a.map(x=>x.low));
  const priceLowB=Math.min(...b.map(x=>x.low));

  const priceHighA=Math.max(...a.map(x=>x.high));
  const priceHighB=Math.max(...b.map(x=>x.high));

  const rsiA=rsi(a);
  const rsiB=rsi(b);

  if(
    priceLowB<priceLowA &&
    rsiB>rsiA+2
  ){
    return {
      type:"BULLISH_DIVERGENCE",
      side:"LONG",
      confirmed:true
    };
  }

  if(
    priceHighB>priceHighA &&
    rsiB<rsiA-2
  ){
    return {
      type:"BEARISH_DIVERGENCE",
      side:"SHORT",
      confirmed:true
    };
  }

  return {
    type:"NONE",
    side:"NONE",
    confirmed:false
  };
}

/* =========================================================
   ATR / ADX / BOLLINGER
========================================================= */

function atr(c,p=14){

  if(c.length<2)return 0;

  const tr=c.slice(1).map((x,i)=>{

    const prev=c[i].close;

    return Math.max(
      x.high-x.low,
      Math.abs(x.high-prev),
      Math.abs(x.low-prev)
    );
  });

  return sma(tr,p);
}

function adx(c,p=14){

  if(c.length<p*2+1)return 0;

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
      avg(trs.slice(i-p,i))||1;

    const diP=
      100*avg(plus.slice(i-p,i))/tr;

    const diM=
      100*avg(minus.slice(i-p,i))/tr;

    const dx=
      diP+diM
        ? 100*Math.abs(diP-diM)/(diP+diM)
        : 0;

    out.push(dx);
  }

  return avg(out.slice(-p));
}

function bollWidth(c,p=20){

  const a=c.slice(-p).map(x=>x.close);

  if(!a.length)return 0;

  const m=avg(a);

  const sd=Math.sqrt(
    avg(a.map(x=>(x-m)**2))
  );

  return m ? 4*sd/m*100 : 0;
}

/* =========================================================
   MARKET STATE
========================================================= */

function rangeState(c,ma7,ma20,slope,volSpike){

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
  const atrPct=price ? a/price*100 : 0;

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

  return {highs,lows};
}

/* =========================================================
   HUNT / SWEEP
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

  const prev=c.slice(-21,-1);

  const hi=Math.max(...prev.map(z=>z.high));
  const lo=Math.min(...prev.map(z=>z.low));

  const range=x.high-x.low||1;

  const lower=
    Math.min(x.open,x.close)-x.low;

  const upper=
    x.high-Math.max(x.open,x.close);

  const volAvg=
    sma(
      prev.map(z=>z.volume),
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
      wickPct:lower/range*100,
      volumeConfirmed:volumeConfirm,
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
      wickPct:upper/range*100,
      volumeConfirmed:volumeConfirm,
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
  const x=c.at(-1);

  if(x.low>a.high){

    return {
      type:"BULLISH",
      low:a.high,
      high:x.low,
      size:x.low-a.high,
      candle:c.at(-2).time
    };
  }

  if(x.high<a.low){

    return {
      type:"BEARISH",
      low:x.high,
      high:a.low,
      size:a.low-x.high,
      candle:c.at(-2).time
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

  const s=swingLevels(c,2);

  const highs=s.highs;
  const lows=s.lows;

  const lastHigh=
    highs.length?highs.at(-1).price:null;

  const prevHigh=
    highs.length>1?highs.at(-2).price:null;

  const lastLow=
    lows.length?lows.at(-1).price:null;

  const prevLow=
    lows.length>1?lows.at(-2).price:null;

  const price=c.at(-1).close;

  let bos="NONE";
  let choch="NONE";

  if(lastHigh&&price>lastHigh){
    bos="BULLISH";
  }

  if(lastLow&&price<lastLow){
    bos="BEARISH";
  }

  if(
    prevHigh&&
    prevLow&&
    lastHigh&&
    lastLow
  ){

    if(
      lastLow>prevLow &&
      lastHigh>prevHigh &&
      price<lastLow
    ){
      choch="BEARISH";
    }

    if(
      lastLow<prevLow &&
      lastHigh<prevHigh &&
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
    previousSwingHigh:prevHigh,
    previousSwingLow:prevLow
  };
}

/* =========================================================
   ORDER BLOCK
========================================================= */

function detectOrderBlock(c){

  if(c.length<8){
    return {type:"NONE"};
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

  return {type:"NONE"};
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

  const body=Math.abs(x.close-x.open);
  const range=x.high-x.low||1;

  const upper=
    x.high-Math.max(x.open,x.close);

  const lower=
    Math.min(x.open,x.close)-x.low;

  const bodyRatio=body/range;

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

  if(bodyRatio<.15){
    type="DOJI";
  }

  return {
    type,
    bullish:x.close>x.open,
    bearish:x.close<x.open,
    body,
    range,
    bodyRatio,
    upperWick:upper,
    lowerWick:lower
  };
}

/* =========================================================
   CANDLE / MA ANALYSIS
========================================================= */

function analyzeCandles(c){

  if(c.length<25){
    return {
      error:"کندل کافی نیست"
    };
  }

  const close=c.map(x=>x.close);
  const vol=c.map(x=>x.volume);

  const price=close.at(-1);

  const ma7=sma(close,7);
  const ma20=sma(close,20);

  const prev20=sma(
    close.slice(0,-1),
    20
  );

  const slope=
    prev20
      ? (ma20-prev20)/prev20
      : 0;

  const prevPrice=close.at(-2);

  const candle=c.at(-1);

  const touch20=
    Math.abs(price-ma20)/ma20<=.0015 ||
    (
      candle.low<=ma20 &&
      candle.high>=ma20
    ) ||
    (
      (prevPrice-ma20)*(price-ma20)<=0
    );

  const touch7=
    Math.abs(price-ma7)/ma7<=.0015 ||
    (
      candle.low<=ma7 &&
      candle.high>=ma7
    ) ||
    (
      (prevPrice-ma7)*(price-ma7)<=0
    );

  const vol7=sma(vol,7);
  const vol20=sma(vol,20);

  const spike=
    vol.at(-1)>vol20*1.5 ||
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

  const h=hunt(c);
  const fvg=detectFVG(c);
  const structure=detectStructure(c);
  const ob=detectOrderBlock(c);
  const candleInfo=candleAnalysis(c);

  const rsiValue=rsi(c);
  const macdValue=macd(c);
  const ichi=ichimoku(c);
  const div=divergence(c);

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

    market:rs,

    hunt:h,

    candle:candleInfo.type,
    candleDetails:candleInfo,

    fvg,

    bos:structure.bos,
    choch:structure.choch,

    structure,

    orderBlock:ob,

    rsi:rsiValue,
    macd:macdValue,
    ichimoku:ichi,
    divergence:div,

    timestamp:candle.time
  };
}

/* =========================================================
   CONVERTED MA
========================================================= */

function maValueSeries(c,p){

  const out=[];

  for(let i=0;i<c.length;i++){

    const a=c.slice(
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

  const price=c.at(-1)?.close||0;
  const prev=c.at(-2)?.close||price;

  const events=[];

  for(const m of CONVERTED_MAS){

    const vals=
      maValueSeries(c,m.period);

    const ma=vals.at(-1);
    const prevMA=vals.at(-2);

    if(!ma||!prevMA)continue;

    const slopePct=
      (ma-prevMA)/prevMA*100;

    const prevDist=prev-prevMA;
    const dist=price-ma;

    const candle=c.at(-1);
    const range=candle.high-candle.low||1;

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

    const touch=
      Math.abs(dist)/ma<=.0015 ||
      (
        candle.low<=ma &&
        candle.high>=ma
      ) ||
      prevDist*dist<=0;

    const crossUp=
      prev<=prevMA&&price>ma;

    const crossDown=
      prev>=prevMA&&price<ma;

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
          .map(x=>x.volume),
        20
      );

    const volumeConfirmed=
      volumeAvg>0&&
      candle.volume>=volumeAvg*1.15;

    const trendConfirm=
      direction==="LONG"
        ? price>ma
        : direction==="SHORT"
          ? price<ma
          : false;

    const notFlat=slope!=="FLAT";

    const strictConfirmation=
      touch&&
      rejection&&
      notFlat&&
      trendConfirm&&
      volumeConfirmed;

    const crossConfirmation=
      touch&&
      notFlat&&
      trendConfirm&&
      (crossUp||crossDown)&&
      volumeConfirmed;

    let confirmation="WAIT";

    if(
      direction==="LONG"&&
      (
        strictConfirmation||
        crossConfirmation
      )
    ){
      confirmation="CONFIRMED_LONG";
    }

    if(
      direction==="SHORT"&&
      (
        strictConfirmation||
        crossConfirmation
      )
    ){
      confirmation="CONFIRMED_SHORT";
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
          x.confirmation==="CONFIRMED_LONG"||
          x.confirmation==="CONFIRMED_SHORT"
      ),

    latest:
      events.filter(
        x=>x.type!=="NONE"
      ).at(-1)||null
  };
}

/* =========================================================
   FOOTPRINT / ORDER FLOW
========================================================= */

async function footprint(category,symbol){

  try{

    const d=
      await api(
        "/v5/market/recent-trade",
        {
          category,
          symbol,
          limit:200
        }
      );

    const trades=d?.result?.list||[];

    let buy=0;
    let sell=0;
    let largest=0;

    for(const x of trades){

      const q=n(x.size);
      const p=n(x.price);

      largest=
        Math.max(
          largest,
          q*p
        );

      if(
        String(x.side)
          .toLowerCase()==="buy"
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
      trades:trades.length,
      largeTradeNotional:largest
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

async function walls(category,symbol,price){

  try{

    const d=
      await api(
        "/v5/market/orderbook",
        {
          category,
          symbol,
          limit:50
        }
      );

    const bids=d?.result?.b||[];
    const asks=d?.result?.a||[];

    const buyLevels=[];
    const sellLevels=[];

    for(const q of bids){

      const p=n(q[0]);
      const sz=n(q[1]);

      if(p<=0||sz<=0)continue;

      const notional=p*sz;
      const distance=absPct(p,price);

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

      if(p<=0||sz<=0)continue;

      const notional=p*sz;
      const distance=absPct(p,price);

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

    const totalLiquidity=
      buyLiquidity+sellLiquidity;

    const buyWall=buyLevels[0]||null;
    const sellWall=sellLevels[0]||null;

    const avgBuy=
      buyLevels.length
        ? avg(buyLevels.map(x=>x.notional))
        : 0;

    const avgSell=
      sellLevels.length
        ? avg(sellLevels.map(x=>x.notional))
        : 0;

    const buyStrength=
      buyWall&&avgBuy
        ? clamp(
            buyWall.notional/avgBuy*20,
            0,
            100
          )
        : 0;

    const sellStrength=
      sellWall&&avgSell
        ? clamp(
            sellWall.notional/avgSell*20,
            0,
            100
          )
        : 0;

    return {

      buy:buyWall,
      sell:sellWall,

      buyLevels:buyLevels.slice(0,10),
      sellLevels:sellLevels.slice(0,10),

      buyLiquidity,
      sellLiquidity,
      totalLiquidity,

      buyShare:
        totalLiquidity
          ? buyLiquidity/totalLiquidity*100
          : 0,

      sellShare:
        totalLiquidity
          ? sellLiquidity/totalLiquidity*100
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
          : false,

      note:
        "نقدینگی قابل مشاهده فعلی است و ممکن است سفارش‌ها قبل از رسیدن قیمت حذف یا جابه‌جا شوند."
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

function supportResistance(c,wall,price){

  const s=swingLevels(c,3);

  const supports=[];
  const resistances=[];

  for(const x of s.lows){

    if(x.price<price){
      supports.push({
        price:x.price,
        type:"SWING_SUPPORT",
        distancePct:absPct(x.price,price)
      });
    }
  }

  for(const x of s.highs){

    if(x.price>price){
      resistances.push({
        price:x.price,
        type:"SWING_RESISTANCE",
        distancePct:absPct(x.price,price)
      });
    }
  }

  for(const x of wall?.buyLevels||[]){

    if(x.price<price){
      supports.push({
        price:x.price,
        type:"BUY_WALL",
        liquidity:x.notional,
        distancePct:x.distancePct
      });
    }
  }

  for(const x of wall?.sellLevels||[]){

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
    (a,b)=>a.distancePct-b.distancePct
  );

  resistances.sort(
    (a,b)=>a.distancePct-b.distancePct
  );

  return {

    nearestSupport:
      supports[0]||null,

    nearestResistance:
      resistances[0]||null,

    strongestSupport:
      supports
        .filter(x=>x.liquidity)
        .sort(
          (a,b)=>
            (b.liquidity||0)-
            (a.liquidity||0)
        )[0]||
      supports[0]||
      null,

    strongestResistance:
      resistances
        .filter(x=>x.liquidity)
        .sort(
          (a,b)=>
            (b.liquidity||0)-
            (a.liquidity||0)
        )[0]||
      resistances[0]||
      null,

    supports:supports.slice(0,10),
    resistances:resistances.slice(0,10)
  };
}

/* =========================================================
   MARKET DATA
========================================================= */

async function ticker(category,symbol){

  const d=
    await api(
      "/v5/market/tickers",
      {
        category,
        symbol
      }
    );

  return d?.result?.list?.[0]||{};
}

async function oiFunding(symbol){

  try{

    const t=
      await ticker(
        "linear",
        symbol
      );

    return {

      available:true,

      openInterest:n(t.openInterest),

      fundingRate:n(t.fundingRate),

      turnover24h:n(t.turnover24h),

      change24h:
        n(t.price24hPcnt)*100,

      markPrice:n(t.markPrice),

      indexPrice:n(t.indexPrice)
    };

  }catch(e){

    return {
      available:false,
      openInterest:null,
      fundingRate:null,
      turnover24h:null,
      change24h:null,
      markPrice:null,
      indexPrice:null
    };
  }
}

/* =========================================================
   SELECTED METHODS
========================================================= */

function normalizeMethods(input){

  if(
    !input||
    input==="ALL"
  ){
    return [...ALL_METHODS];
  }

  let arr=[];

  if(Array.isArray(input)){
    arr=input;
  }else{
    arr=String(input)
      .split(",")
      .map(x=>x.trim())
      .filter(Boolean);
  }

  const upper=
    arr.map(x=>String(x).toUpperCase());

  const valid=
    upper.filter(
      x=>ALL_METHODS.includes(x)
    );

  return valid.length
    ? [...new Set(valid)]
    : [...ALL_METHODS];
}

/* =========================================================
   SCORING
========================================================= */

function score(tf,converted,selected){

  const methods=
    new Set(
      normalizeMethods(selected)
    );

  let L=0;
  let S=0;

  const longReasons=[];
  const shortReasons=[];

  const add=(dir,value,text,method)=>{

    if(!methods.has(method))return;

    if(dir==="L"){
      L+=value;
      longReasons.push({
        method,
        text,
        score:value
      });
    }

    if(dir==="S"){
      S+=value;
      shortReasons.push({
        method,
        text,
        score:value
      });
    }
  };

  for(const [k,x] of Object.entries(tf)){

    if(!x||x.error)continue;

    const w=
      k==="1"
        ? 1.5
        : k==="60"
          ? 1.3
          : 1;

    if(x.market?.state==="RANGE"){
      continue;
    }

    if(
      x.touchMA20&&
      x.maSlope==="UP"&&
      x.trend==="BULLISH"
    ){
      add(
        "L",
        8*w,
        `برخورد MA20 در ${k} دقیقه در جهت صعود`,
        "MA"
      );
    }

    if(
      x.touchMA20&&
      x.maSlope==="DOWN"&&
      x.trend==="BEARISH"
    ){
      add(
        "S",
        8*w,
        `برخورد MA20 در ${k} دقیقه در جهت نزول`,
        "MA"
      );
    }

    if(
      x.touchMA7&&
      x.maSlope==="UP"&&
      x.trend==="BULLISH"
    ){
      add(
        "L",
        6*w,
        `برخورد MA7 در ${k} دقیقه در جهت صعود`,
        "MA"
      );
    }

    if(
      x.touchMA7&&
      x.maSlope==="DOWN"&&
      x.trend==="BEARISH"
    ){
      add(
        "S",
        6*w,
        `برخورد MA7 در ${k} دقیقه در جهت نزول`,
        "MA"
      );
    }

    if(
      x.hunt?.confirmed&&
      x.hunt.side==="LONG"
    ){
      add(
        "L",
        10*w,
        "شکار نقدینگی و Sweep صعودی تأیید شد",
        "LIQUIDITY"
      );

      add(
        "L",
        7*w,
        "ساختار Hunt صعودی",
        "SMC"
      );

      add(
        "L",
        7*w,
        "Liquidity Sweep مطابق ICT",
        "ICT"
      );
    }

    if(
      x.hunt?.confirmed&&
      x.hunt.side==="SHORT"
    ){
      add(
        "S",
        10*w,
        "شکار نقدینگی و Sweep نزولی تأیید شد",
        "LIQUIDITY"
      );

      add(
        "S",
        7*w,
        "ساختار Hunt نزولی",
        "SMC"
      );

      add(
        "S",
        7*w,
        "Liquidity Sweep مطابق ICT",
        "ICT"
      );
    }

    if(x.bos==="BULLISH"){
      add(
        "L",
        7*w,
        "شکست ساختار صعودی (BOS)",
        "BOS"
      );
      add(
        "L",
        5*w,
        "BOS صعودی در ساختار Smart Money",
        "SMC"
      );
    }

    if(x.bos==="BEARISH"){
      add(
        "S",
        7*w,
        "شکست ساختار نزولی (BOS)",
        "BOS"
      );
      add(
        "S",
        5*w,
        "BOS نزولی در ساختار Smart Money",
        "SMC"
      );
    }

    if(x.choch==="BULLISH"){
      add(
        "L",
        9*w,
        "تغییر شخصیت بازار صعودی (CHoCH)",
        "CHOCH"
      );
      add(
        "L",
        6*w,
        "CHoCH صعودی در Smart Money",
        "SMC"
      );
    }

    if(x.choch==="BEARISH"){
      add(
        "S",
        9*w,
        "تغییر شخصیت بازار نزولی (CHoCH)",
        "CHOCH"
      );
      add(
        "S",
        6*w,
        "CHoCH نزولی در Smart Money",
        "SMC"
      );
    }

    if(x.fvg?.type==="BULLISH"){
      add(
        "L",
        4*w,
        "شکاف ارزش منصفانه صعودی (FVG)",
        "FVG"
      );
      add(
        "L",
        4*w,
        "FVG صعودی مطابق ICT",
        "ICT"
      );
    }

    if(x.fvg?.type==="BEARISH"){
      add(
        "S",
        4*w,
        "شکاف ارزش منصفانه نزولی (FVG)",
        "FVG"
      );
      add(
        "S",
        4*w,
        "FVG نزولی مطابق ICT",
        "ICT"
      );
    }

    if(x.orderBlock?.type==="BULLISH"){
      add(
        "L",
        4*w,
        "Order Block صعودی شناسایی شد",
        "ORDERBLOCK"
      );
      add(
        "L",
        4*w,
        "ناحیه سفارش صعودی Smart Money",
        "SMC"
      );
    }

    if(x.orderBlock?.type==="BEARISH"){
      add(
        "S",
        4*w,
        "Order Block نزولی شناسایی شد",
        "ORDERBLOCK"
      );
      add(
        "S",
        4*w,
        "ناحیه سفارش نزولی Smart Money",
        "SMC"
      );
    }

    if(x.volume?.spike){

      if(x.trend==="BULLISH"){
        add(
          "L",
          5*w,
          "افزایش غیرعادی حجم در جهت صعود",
          "VOLUME"
        );
      }

      if(x.trend==="BEARISH"){
        add(
          "S",
          5*w,
          "افزایش غیرعادی حجم در جهت نزول",
          "VOLUME"
        );
      }
    }

    /* RSI */

    if(x.rsi<=30){
      add(
        "L",
        6*w,
        `RSI در محدوده اشباع فروش (${x.rsi.toFixed(1)})`,
        "RSI"
      );
    }

    if(x.rsi>=70){
      add(
        "S",
        6*w,
        `RSI در محدوده اشباع خرید (${x.rsi.toFixed(1)})`,
        "RSI"
      );
    }

    /* MACD */

    if(
      x.macd?.cross==="BULLISH"
    ){
      add(
        "L",
        8*w,
        "تقاطع صعودی MACD",
        "MACD"
      );
    }

    if(
      x.macd?.cross==="BEARISH"
    ){
      add(
        "S",
        8*w,
        "تقاطع نزولی MACD",
        "MACD"
      );
    }

    if(
      x.macd?.direction==="BULLISH"&&
      x.macd?.histogram>0
    ){
      add(
        "L",
        3*w,
        "MACD بالای خط سیگنال",
        "MACD"
      );
    }

    if(
      x.macd?.direction==="BEARISH"&&
      x.macd?.histogram<0
    ){
      add(
        "S",
        3*w,
        "MACD زیر خط سیگنال",
        "MACD"
      );
    }

    /* ICHIMOKU */

    if(x.ichimoku?.direction==="BULLISH"){
      add(
        "L",
        8*w,
        "ایچیموکو صعودی و قیمت بالای ابر",
        "ICHIMOKU"
      );
    }

    if(x.ichimoku?.direction==="BEARISH"){
      add(
        "S",
        8*w,
        "ایچیموکو نزولی و قیمت زیر ابر",
        "ICHIMOKU"
      );
    }

    /* DIVERGENCE */

    if(
      x.divergence?.type==="BULLISH_DIVERGENCE"
    ){
      add(
        "L",
        10*w,
        "واگرایی مثبت قیمت و RSI",
        "DIVERGENCE"
      );
    }

    if(
      x.divergence?.type==="BEARISH_DIVERGENCE"
    ){
      add(
        "S",
        10*w,
        "واگرایی منفی قیمت و RSI",
        "DIVERGENCE"
      );
    }
  }

  for(const e of converted?.confirmed||[]){

    const w=
      e.source==="1h"
        ? 1.5
        : e.source==="15m"
          ? 1.3
          : e.source==="5m"
            ? 1.15
            : 1;

    if(
      e.confirmation==="CONFIRMED_LONG"
    ){
      add(
        "L",
        12*w,
        `${e.ma} ${e.source} → MA${e.period1m}: تأیید صعودی`,
        "MA"
      );
    }

    if(
      e.confirmation==="CONFIRMED_SHORT"
    ){
      add(
        "S",
        12*w,
        `${e.ma} ${e.source} → MA${e.period1m}: تأیید نزولی`,
        "MA"
      );
    }
  }

  return {

    L,
    S,

    longScore:clamp(L,0,100),
    shortScore:clamp(S,0,100),

    longReasons,
    shortReasons,

    selectedMethods:[
      ...methods
    ]
  };
}

/* =========================================================
   MOVEMENT
========================================================= */

function movementAnalysis(c,market,tf,wall){

  const price=c.at(-1)?.close||0;

  const p15=
    c.length>=15
      ? c.at(-15).close
      : price;

  const p30=
    c.length>=30
      ? c.at(-30).close
      : price;

  const change15=pct(price,p15);
  const change30=pct(price,p30);

  const vol20=
    sma(
      c.slice(-21,-1)
        .map(x=>x.volume),
      20
    );

  const currentVol=c.at(-1)?.volume||0;

  const volumeRatio=
    vol20
      ? currentVol/vol20
      : 0;

  const h=hunt(c);
  const structure=detectStructure(c);
  const candle=candleAnalysis(c);
  const fvg=detectFVG(c);

  const distMA20=
    tf?.["1"]?.ma20
      ? absPct(price,tf["1"].ma20)
      : 0;

  let pump=0;
  let dump=0;

  const pumpReasons=[];
  const dumpReasons=[];

  if(change15>=3){
    pump+=20;
    pumpReasons.push(
      `رشد ۱۵ دقیقه‌ای ${change15.toFixed(2)}%`
    );
  }

  if(change30>=5){
    pump+=10;
  }

  if(change15<=-3){
    dump+=20;
    dumpReasons.push(
      `افت ۱۵ دقیقه‌ای ${change15.toFixed(2)}%`
    );
  }

  if(change30<=-5){
    dump+=10;
  }

  if(volumeRatio>=1.5){

    pump+=10;
    dump+=10;

    pumpReasons.push("افزایش حجم");
    dumpReasons.push("افزایش حجم");
  }

  if(tf?.["1"]?.maSlope==="UP"){
    pump+=8;
  }

  if(tf?.["1"]?.maSlope==="DOWN"){
    dump+=8;
  }

  if(
    h.confirmed&&
    h.side==="LONG"
  ){
    dump+=10;
    dumpReasons.push(
      "Sweep نقدینگی سمت فروش"
    );
  }

  if(
    h.confirmed&&
    h.side==="SHORT"
  ){
    pump+=10;
    pumpReasons.push(
      "Sweep نقدینگی سمت خرید"
    );
  }

  if(
    wall?.sellNear&&
    wall.sellStrength>=60
  ){
    dump+=8;
    dumpReasons.push(
      "دیوار فروش قوی"
    );
  }

  if(
    wall?.buyNear&&
    wall.buyStrength>=60
  ){
    pump+=8;
    pumpReasons.push(
      "دیوار خرید قوی"
    );
  }

  if(structure.bos==="BULLISH"){
    pump+=8;
  }

  if(structure.bos==="BEARISH"){
    dump+=8;
  }

  if(fvg.type==="BULLISH"){
    pump+=4;
  }

  if(fvg.type==="BEARISH"){
    dump+=4;
  }

  let pumpReversal=0;
  let dumpReversal=0;

  const pumpReversalReasons=[];
  const dumpReversalReasons=[];

  if(change15>=5){

    pumpReversal+=15;

    pumpReversalReasons.push(
      "پامپ شدید کوتاه‌مدت"
    );

    if(distMA20>=2){
      pumpReversal+=10;
      pumpReversalReasons.push(
        "فاصله زیاد از MA20"
      );
    }

    if(
      h.confirmed&&
      h.side==="SHORT"
    ){
      pumpReversal+=20;
      pumpReversalReasons.push(
        "Sweep سمت خرید و برگشت"
      );
    }

    if(candle.type==="SHOOTING_STAR"){
      pumpReversal+=10;
      pumpReversalReasons.push(
        "کندل رد قیمت در سقف"
      );
    }

    if(structure.choch==="BEARISH"){
      pumpReversal+=20;
      pumpReversalReasons.push(
        "CHoCH نزولی"
      );
    }

    if(
      wall?.sellNear&&
      wall.sellStrength>=60
    ){
      pumpReversal+=10;
      pumpReversalReasons.push(
        "دیوار فروش قوی"
      );
    }
  }

  if(change15<=-5){

    dumpReversal+=15;

    dumpReversalReasons.push(
      "دامپ شدید کوتاه‌مدت"
    );

    if(distMA20>=2){
      dumpReversal+=10;
      dumpReversalReasons.push(
        "فاصله زیاد از MA20"
      );
    }

    if(
      h.confirmed&&
      h.side==="LONG"
    ){
      dumpReversal+=20;
      dumpReversalReasons.push(
        "Sweep سمت فروش و برگشت"
      );
    }

    if(candle.type==="HAMMER"){
      dumpReversal+=10;
      dumpReversalReasons.push(
        "کندل جذب فروش"
      );
    }

    if(structure.choch==="BULLISH"){
      dumpReversal+=20;
      dumpReversalReasons.push(
        "CHoCH صعودی"
      );
    }

    if(
      wall?.buyNear&&
      wall.buyStrength>=60
    ){
      dumpReversal+=10;
      dumpReversalReasons.push(
        "دیوار خرید قوی"
      );
    }
  }

  return {

    change15m:change15,
    change30m:change30,

    volumeRatio,

    distanceFromMA20:distMA20,

    pumpScore:
      Math.round(clamp(pump,0,100)),

    dumpScore:
      Math.round(clamp(dump,0,100)),

    pumpReasons,
    dumpReasons,

    pumpReversalScore:
      Math.round(
        clamp(pumpReversal,0,100)
      ),

    dumpReversalScore:
      Math.round(
        clamp(dumpReversal,0,100)
      ),

    pumpReversalReasons,
    dumpReversalReasons
  };
}

/* =========================================================
   STYLE SCORES
========================================================= */

function styleAnalysis(tf,converted,movement,fp,wall){

  let SMC=50;
  let ICT=50;
  let MA=50;
  let MACD=50;
  let RSI=50;
  let Divergence=50;
  let Ichimoku=50;
  let Volume=50;
  let OrderFlow=50;
  let Liquidity=50;

  const x=tf?.["1"];

  if(x){

    if(
      x.bos!=="NONE"||
      x.choch!=="NONE"
    ){
      SMC+=20;
      ICT+=15;
    }

    if(x.hunt?.confirmed){
      SMC+=15;
      ICT+=20;
      Liquidity+=20;
    }

    if(x.fvg?.type!=="NONE"){
      ICT+=15;
    }

    if(x.orderBlock?.type!=="NONE"){
      SMC+=10;
      ICT+=10;
    }

    if(x.maSlope!=="FLAT"){
      MA+=15;
    }

    if(x.macd?.cross!=="NONE"){
      MACD+=20;
    }

    if(x.rsi<=30||x.rsi>=70){
      RSI+=20;
    }

    if(x.divergence?.confirmed){
      Divergence+=25;
    }

    if(x.ichimoku?.direction!=="NEUTRAL"){
      Ichimoku+=20;
    }

    if(x.volume?.spike){
      Volume+=20;
    }
  }

  if(converted?.confirmed?.length){
    MA+=20;
  }

  if(
    fp&&!fp.error&&
    Math.abs(fp.deltaPercent)>=8
  ){
    OrderFlow+=25;
  }

  if(
    wall&&!wall.error&&
    (
      wall.buyStrength>=60||
      wall.sellStrength>=60
    )
  ){
    Liquidity+=25;
  }

  return {
    SMC:Math.round(clamp(SMC,0,100)),
    ICT:Math.round(clamp(ICT,0,100)),
    MA:Math.round(clamp(MA,0,100)),
    MACD:Math.round(clamp(MACD,0,100)),
    RSI:Math.round(clamp(RSI,0,100)),
    Divergence:Math.round(clamp(Divergence,0,100)),
    Ichimoku:Math.round(clamp(Ichimoku,0,100)),
    Volume:Math.round(clamp(Volume,0,100)),
    OrderFlow:Math.round(clamp(OrderFlow,0,100)),
    Liquidity:Math.round(clamp(Liquidity,0,100))
  };
}

/* =========================================================
   DEEP ANALYSIS
========================================================= */

async function deepAnalyze(
  category,
  symbol,
  options={}
){

  const minScore=
    clamp(
      n(
        options.minScore,
        DEFAULT_MIN_SCORE
      ),
      1,
      100
    );

  const selected=
    normalizeMethods(
      options.methods
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
    const x of TF.filter(
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
      ? convertedMAEvents(oneMinute)
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
          available:false,
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

  const sc=
    score(
      tf,
      converted,
      selected
    );

  /* Order Flow */

  if(
    selected.includes("ORDERFLOW")&&
    fp&&!fp.error
  ){

    if(fp.deltaPercent>=8){
      sc.L+=10;
      sc.longReasons.push({
        method:"ORDERFLOW",
        text:"جریان سفارش خالص خریدار",
        score:10
      });
    }

    if(fp.deltaPercent<=-8){
      sc.S+=10;
      sc.shortReasons.push({
        method:"ORDERFLOW",
        text:"جریان سفارش خالص فروشنده",
        score:10
      });
    }
  }

  /* Liquidity */

  if(
    selected.includes("LIQUIDITY")&&
    wall&&!wall.error
  ){

    if(
      wall.buyNear&&
      wall.buyStrength>=60
    ){
      sc.L+=5;
      sc.longReasons.push({
        method:"LIQUIDITY",
        text:"Buy Wall قوی نزدیک قیمت",
        score:5
      });
    }

    if(
      wall.sellNear&&
      wall.sellStrength>=60
    ){
      sc.S+=5;
      sc.shortReasons.push({
        method:"LIQUIDITY",
        text:"Sell Wall قوی نزدیک قیمت",
        score:5
      });
    }
  }

  /* OI */

  if(
    selected.includes("OI")&&
    market.available
  ){

    if(
      market.openInterest>0&&
      market.change24h>3
    ){
      sc.L+=3;
      sc.longReasons.push({
        method:"OI",
        text:"Open Interest فعال همراه رشد قیمت",
        score:3
      });
    }

    if(
      market.openInterest>0&&
      market.change24h<-3
    ){
      sc.S+=3;
      sc.shortReasons.push({
        method:"OI",
        text:"Open Interest فعال همراه افت قیمت",
        score:3
      });
    }
  }

  /* FUNDING */

  if(
    selected.includes("FUNDING")&&
    market.available
  ){

    const fr=market.fundingRate;

    if(fr<-.0003){
      sc.L+=5;
      sc.longReasons.push({
        method:"FUNDING",
        text:"Funding منفی و احتمال فشار فروش",
        score:5
      });
    }

    if(fr>.0003){
      sc.S+=5;
      sc.shortReasons.push({
        method:"FUNDING",
        text:"Funding مثبت و احتمال ازدحام لانگ",
        score:5
      });
    }
  }

  const longScore=
    clamp(sc.L,0,100);

  const shortScore=
    clamp(sc.S,0,100);

  let direction="WAIT";
  let finalScore=
    Math.max(
      longScore,
      shortScore
    );

  if(
    longScore>=minScore&&
    longScore>shortScore
  ){
    direction="LONG";
    finalScore=longScore;
  }
  else if(
    shortScore>=minScore&&
    shortScore>longScore
  ){
    direction="SHORT";
    finalScore=shortScore;
  }

  const movement=
    movementAnalysis(
      oneMinute,
      market,
      tf,
      wall
    );

  const styles=
    styleAnalysis(
      tf,
      converted,
      movement,
      fp,
      wall
    );

  const pumpScore=movement.pumpScore;
  const dumpScore=movement.dumpScore;

  const pumpReversalScore=
    movement.pumpReversalScore;

  const dumpReversalScore=
    movement.dumpReversalScore;

  let alert="NONE";

  if(pumpReversalScore>=75){
    alert="PUMP_REVERSAL_WATCH";
  }

  if(dumpReversalScore>=75){
    alert="DUMP_REVERSAL_WATCH";
  }

  if(
    pumpReversalScore>=85&&
    (
      tf["1"]?.choch==="BEARISH"||
      converted.confirmed.some(
        x=>x.confirmation==="CONFIRMED_SHORT"
      )
    )
  ){
    alert="PUMP_REVERSAL_CONFIRMED";
  }

  if(
    dumpReversalScore>=85&&
    (
      tf["1"]?.choch==="BULLISH"||
      converted.confirmed.some(
        x=>x.confirmation==="CONFIRMED_LONG"
      )
    )
  ){
    alert="DUMP_REVERSAL_CONFIRMED";
  }

  return {

    symbol,

    /* عمداً نام صرافی در خروجی نیست */

    marketType:
      category==="linear"
        ? "FUTURES"
        : "SPOT",

    price,

    direction,

    score:Math.round(finalScore),

    longScore:Math.round(longScore),
    shortScore:Math.round(shortScore),

    minimumRequired:minScore,

    signalLevel:
      finalScore>=90
        ? "VERY_STRONG"
        : finalScore>=minScore
          ? "CONFIRMED"
          : finalScore>=60
            ? "WATCH"
            : "NONE",

    selectedMethods:selected,

    timeframes:tf,

    convertedMA1m:converted,

    footprint:fp,

    walls:wall,

    supportResistance:sr,

    market,

    movement,

    styles,

    pumpScore,
    dumpScore,

    pumpDumpStatus:
      pumpScore>=75
        ? "PUMP"
        : dumpScore>=75
          ? "DUMP"
          : "NORMAL",

    reversal:{
      pumpScore:pumpReversalScore,
      dumpScore:dumpReversalScore,

      pumpReasons:
        movement.pumpReversalReasons,

      dumpReasons:
        movement.dumpReversalReasons,

      alert
    },

    reasons:
      direction==="LONG"
        ? sc.longReasons
        : direction==="SHORT"
          ? sc.shortReasons
          : [
              ...sc.longReasons,
              ...sc.shortReasons
            ],

    generatedAt:Date.now(),

    liquidation:{
      available:false,
      message:
        "داده لیکوئیدیشن تجمیعی در این تحلیل ارائه نمی‌شود."
    }
  };
}

/* =========================================================
   INSTRUMENTS
========================================================= */

async function instruments(category){

  const d=
    await api(
      "/v5/market/instruments-info",
      {
        category,
        limit:1000
      }
    );

  return d?.result?.list||[];
}

function validFutures(list){

  return list.filter(
    x=>
      x.status==="Trading"&&
      x.quoteCoin==="USDT"&&
      x.contractType==="LinearPerpetual"
  );
}

function validSpot(list){

  return list.filter(
    x=>
      x.status==="Trading"&&
      x.quoteCoin==="USDT"
  );
}

/* =========================================================
   AUTO SEARCH
   کاربر فقط اسم ارز می‌دهد
========================================================= */

async function findAsset(input){

  const raw=
    String(input||"")
      .trim()
      .toUpperCase();

  if(!raw){
    return {
      found:false,
      error:"نام ارز وارد نشده است."
    };
  }

  const bare=
    raw
      .replace(/[-_/:\s]/g,"")
      .replace(/USDT$/,"");

  const [linear,spot]=
    await Promise.all([
      instruments("linear"),
      instruments("spot")
    ]);

  const futures=
    validFutures(linear)
      .find(
        x=>
          String(x.symbol).toUpperCase()===raw||
          String(x.symbol).toUpperCase()===
            bare+"USDT"||
          String(x.baseCoin||"").toUpperCase()===bare
      );

  if(futures){

    return {
      found:true,

      marketType:"FUTURES",

      symbol:futures.symbol,

      baseCoin:futures.baseCoin,

      quoteCoin:futures.quoteCoin
    };
  }

  const sp=
    validSpot(spot)
      .find(
        x=>
          String(x.symbol).toUpperCase()===raw||
          String(x.symbol).toUpperCase()===
            bare+"USDT"||
          String(x.baseCoin||"").toUpperCase()===bare
      );

  if(sp){

    return {
      found:true,

      marketType:"SPOT",

      symbol:sp.symbol,

      baseCoin:sp.baseCoin,

      quoteCoin:sp.quoteCoin
    };
  }

  return {
    found:false,
    symbol:raw,
    error:
      "این ارز در بازار قابل بررسی پیدا نشد."
  };
}

/* =========================================================
   ROTATING SCAN
========================================================= */

async function scan(offset=0,options={}){

  const minScore=
    clamp(
      n(
        options.minScore,
        DEFAULT_MIN_SCORE
      ),
      1,
      100
    );

  const methods=
    normalizeMethods(
      options.methods
    );

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
      error:"بازار قابل بررسی پیدا نشد."
    };
  }

  const safeOffset=
    Math.max(
      0,
      Math.min(
        offset,
        Math.max(0,list.length-1)
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
        await klines(
          "linear",
          m.symbol,
          "1",
          80
        );

      const a=
        analyzeCandles(c);

      if(a.error)continue;

      let activity=0;

      if(a.touchMA20)activity+=20;
      if(a.touchMA7)activity+=10;
      if(a.volume.spike)activity+=20;
      if(a.market.state==="ACTIVE")activity+=15;
      if(a.hunt.confirmed)activity+=20;
      if(a.bos!=="NONE")activity+=10;
      if(a.choch!=="NONE")activity+=15;

      light.push({
        symbol:m.symbol,
        activity
      });

    }catch(e){}
  }

  light.sort(
    (a,b)=>b.activity-a.activity
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
              {
                minScore,
                methods
              }
            )
        )
    );

  const signals=
    deep.filter(
      x=>
        x.score>=minScore&&
        x.direction!=="WAIT"
    );

  signals.sort(
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

    minimumRequired:minScore,

    selectedMethods:methods,

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
      error:"بازار قابل بررسی پیدا نشد."
    };
  }

  const safeOffset=
    Math.max(
      0,
      Math.min(
        offset,
        Math.max(0,list.length-1)
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

      if(c.length<30)continue;

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

      const avgVol=
        sma(
          c.slice(-21,-1)
            .map(x=>x.volume),
          20
        );

      const volumeRatio=
        avgVol
          ? c.at(-1).volume/avgVol
          : 0;

      const h=hunt(c);
      const structure=detectStructure(c);

      const activity=
        Math.abs(change15)*4+
        Math.abs(change30)*2+
        Math.min(volumeRatio*10,30)+
        (h.confirmed?20:0)+
        (structure.choch!=="NONE"?15:0);

      candidates.push({
        symbol:m.symbol,
        activity
      });

    }catch(e){}
  }

  candidates.sort(
    (a,b)=>b.activity-a.activity
  );

  const deep=
    await Promise.all(
      candidates
        .slice(0,RADAR_LIMIT)
        .map(
          x=>
            deepAnalyze(
              "linear",
              x.symbol,
              {
                minScore:DEFAULT_MIN_SCORE,
                methods:ALL_METHODS
              }
            )
        )
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

    scannedSymbols:
      batch.map(x=>x.symbol),

    pump:
      deep
        .filter(x=>x.pumpScore>=50)
        .sort(
          (a,b)=>b.pumpScore-a.pumpScore
        ),

    dump:
      deep
        .filter(x=>x.dumpScore>=50)
        .sort(
          (a,b)=>b.dumpScore-a.dumpScore
        ),

    reversal:
      deep
        .filter(
          x=>
            x.reversal.pumpScore>=50||
            x.reversal.dumpScore>=50
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
        ),

    results:deep
  };
}

/* =========================================================
   ROUTER
========================================================= */

export default {

  async fetch(request,env){

    const u=new URL(request.url);
    const p=u.pathname;

    if(request.method==="OPTIONS"){
      return new Response(null,{
        status:204,
        headers:{
          "access-control-allow-origin":"*",
          "access-control-allow-methods":"GET,OPTIONS",
          "access-control-allow-headers":"Content-Type"
        }
      });
    }

    try{

      /* -----------------------------------------
         SEARCH
         فقط نام ارز
      ----------------------------------------- */

      if(p==="/api/search"){

        const q=
          u.searchParams.get("symbol");

        if(!q){
          return json({
            ok:false,
            error:"نام ارز وارد نشده است."
          },400);
        }

        const found=
          await findAsset(q);

        if(!found.found){
          return json({
            ok:false,
            ...found
          },404);
        }

        return json({
          ok:true,
          ...found
        });
      }

      /* -----------------------------------------
         ANALYZE
         بدون انتخاب Spot/Futures
      ----------------------------------------- */

      if(p==="/api/analyze"){

        const symbol=
          u.searchParams.get("symbol");

        if(!symbol){
          return json({
            ok:false,
            error:"نام ارز وارد نشده است."
          },400);
        }

        const found=
          await findAsset(symbol);

        if(!found.found){
          return json({
            ok:false,
            ...found
          },404);
        }

        let methods=
          u.searchParams.get("methods");

        let minScore=
          n(
            u.searchParams.get("minScore"),
            DEFAULT_MIN_SCORE
          );

        minScore=
          clamp(
            minScore,
            1,
            100
          );

        return json({
          ok:true,

          ...await deepAnalyze(
            found.marketType==="FUTURES"
              ? "linear"
              : "spot",

            found.symbol,

            {
              minScore,
              methods
            }
          )
        });
      }

      /* -----------------------------------------
         SCAN
      ----------------------------------------- */

      if(p==="/api/scan"){

        const offset=
          n(
            u.searchParams.get("offset"),
            0
          );

        const minScore=
          clamp(
            n(
              u.searchParams.get("minScore"),
              DEFAULT_MIN_SCORE
            ),
            1,
            100
          );

        const methods=
          u.searchParams.get("methods");

        return json(
          await scan(
            offset,
            {
              minScore,
              methods
            }
          )
        );
      }

      /* -----------------------------------------
         RADAR
      ----------------------------------------- */

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

      /* -----------------------------------------
         HEALTH
      ----------------------------------------- */

      if(p==="/api/health"){

        return json({

          ok:true,

          service:
            "Smart Market Scanner",

          version:
            "V10",

          minimumDefault:
            DEFAULT_MIN_SCORE,

          watchDefault:
            DEFAULT_WATCH_SCORE,

          timeframes:
            TF.map(x=>x.interval),

          convertedMA:
            CONVERTED_MAS,

          methods:ALL_METHODS,

          features:[

            "Manual Auto Market Detection",

            "Strict Signal",

            "Custom Minimum Score",

            "MA",

            "MA Converted To 1m",

            "MA Touch",

            "MA Slope",

            "Liquidity Hunt",

            "Liquidity Sweep",

            "FVG",

            "BOS",

            "CHoCH",

            "Order Block",

            "Candle Analysis",

            "Volume",

            "MACD",

            "RSI",

            "Divergence",

            "Ichimoku",

            "Order Flow",

            "Liquidity",

            "Buy Wall",

            "Sell Wall",

            "Support",

            "Resistance",

            "OI",

            "Funding",

            "Pump Radar",

            "Dump Radar",

            "Reversal Radar",

            "SMC",

            "ICT"
          ]
        });
      }

      /*
        مهم:
        اگر مسیر API نبود، فایل‌های public را سرو کن.
        اگر ASSETS در محیط وجود نداشت، خطای
        undefined.fetch ایجاد نشود.
      */

      if(
        env &&
        env.ASSETS &&
        typeof env.ASSETS.fetch==="function"
      ){
        return env.ASSETS.fetch(request);
      }

      return new Response(
        "Not Found",
        {
          status:404,
          headers:{
            "content-type":
              "text/plain; charset=UTF-8"
          }
        }
      );

    }catch(e){

      return json({

        ok:false,

        error:
          "خطا در پردازش درخواست",

        message:
          e?.message||
          "خطای نامشخص",

        time:Date.now()

      },500);
    }
  }
};
