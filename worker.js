const BYBIT = "https://api.bybit.com";

const SCAN_BATCH = 20;
const DEEP_LIMIT = 3;
const RADAR_LIMIT = 8;
const DEEP_1M_LIMIT = 1300;

const MIN_SIGNAL_SCORE = 75;
const WATCH_SCORE = 60;

const DEFAULT_STRICTNESS = 50;

const DEFAULT_METHODS = [
  "MA","MACD","RSI","ICHIMOKU","DIVERGENCE",
  "SMC","ICT","HUNT","FVG","BOS_CHOCH",
  "ORDER_BLOCK","VOLUME","FOOTPRINT","ORDERBOOK"
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

const TF = [
  {key:"1", label:"1 دقیقه", interval:"1", priority:"MA20"},
  {key:"3", label:"3 دقیقه", interval:"3", priority:"MA7/20"},
  {key:"5", label:"5 دقیقه", interval:"5", priority:"MA7/20"},
  {key:"15", label:"15 دقیقه", interval:"15", priority:"MA7/20"},
  {key:"60", label:"1 ساعت", interval:"60", priority:"MA7/20"}
];

const json = (data,status=200) =>
  new Response(JSON.stringify(data),{
    status,
    headers:{
      "content-type":"application/json; charset=UTF-8",
      "cache-control":"no-store",
      "access-control-allow-origin":"*"
    }
  });

const n=(v,d=0)=>Number.isFinite(Number(v))?Number(v):d;
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const avg=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:0;

function pct(a,b){
  return !b?0:(a-b)/b*100;
}

function absPct(a,b){
  return !b?999:Math.abs((a-b)/b)*100;
}

function parseMethods(value){
  if(!value) return DEFAULT_METHODS.slice();

  let arr=[];

  try{
    arr=JSON.parse(value);
    if(!Array.isArray(arr)) arr=[];
  }catch{
    arr=String(value)
      .split(",")
      .map(x=>x.trim().toUpperCase())
      .filter(Boolean);
  }

  return arr.length ? arr : DEFAULT_METHODS.slice();
}

function parseSettings(searchParams){
  let strictness=n(
    searchParams.get("strictness"),
    DEFAULT_STRICTNESS
  );

  strictness=clamp(strictness,0,100);

  return {
    strictness,
    methods:parseMethods(
      searchParams.get("methods")
    )
  };
}

async function bybit(path,params={}){
  const u=new URL(BYBIT+path);

  for(const [k,v] of Object.entries(params)){
    if(v!==undefined&&v!==null){
      u.searchParams.set(k,String(v));
    }
  }

  const r=await fetch(u,{
    headers:{accept:"application/json"}
  });

  if(!r.ok){
    throw new Error(`Bybit HTTP ${r.status}`);
  }

  const d=await r.json();

  if(d.retCode!==0){
    throw new Error(
      d.retMsg||`Bybit ${d.retCode}`
    );
  }

  return d;
}

async function klines(
  category,
  symbol,
  interval,
  limit=100
){
  const d=await bybit(
    "/v5/market/kline",
    {
      category,
      symbol,
      interval,
      limit
    }
  );

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

function atr(c,p=14){
  if(c.length<2) return 0;

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

  for(let i=p;i<trs.length;i++){

    const tr=
      avg(trs.slice(i-p,i))||1;

    const diP=
      100*avg(
        plus.slice(i-p,i)
      )/tr;

    const diM=
      100*avg(
        minus.slice(i-p,i)
      )/tr;

    const dx=
      diP+diM
        ? 100*Math.abs(diP-diM)/(diP+diM)
        : 0;

    out.push(dx);
  }

  return avg(out.slice(-p));
}

function bollWidth(c,p=20){

  const a=
    c.slice(-p)
      .map(x=>x.close);

  if(!a.length) return 0;

  const m=avg(a);

  const sd=Math.sqrt(
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
   MARKET STRUCTURE
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

    for(
      let j=1;
      j<=lookback;
      j++
    ){

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
    x.high-x.low||1;

  const lower=
    Math.min(x.open,x.close)-x.low;

  const upper=
    x.high-
    Math.max(x.open,x.close);

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
      size:x.low-a.high,
      candle:b.time
    };
  }

  if(x.high<a.low){

    return {
      type:"BEARISH",
      low:x.high,
      high:a.low,
      size:a.low-x.high,
      candle:b.time
    };
  }

  return {
    type:"NONE",
    low:null,
    high:null
  };
}

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
    low<=ma20&&high>=ma20 ||
    (prevPrice-ma20)*(price-ma20)<=0;

  const touch7=
    Math.abs(price-ma7)/ma7<=0.0015 ||
    low<=ma7&&high>=ma7 ||
    (prevPrice-ma7)*(price-ma7)<=0;

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
    price>ma20&&ma7>ma20
      ? "BULLISH"
      : price<ma20&&ma7<ma20
        ? "BEARISH"
        : "RANGE";

  const candle=
    candleAnalysis(c);

  return {

    price,
    ma7,
    ma20,

    maSlope:
      slope>0.00007
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

    market,

    hunt:hunt(c),

    candle:candle.type,

    candleDetails:candle,

    fvg:detectFVG(c),

    ...detectStructure(c),

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

  for(let i=0;i<c.length;i++){

    const a=
      c.slice(
        Math.max(0,i-p+1),
        i+1
      ).map(
        x=>x.close
      );

    out.push(
      a.length>=p
        ? type==="EMA"
          ? ema(a,p)
          : avg(a)
        : null
    );
  }

  return out;
}

function convertedMAEvents(c){

  const price=
    c.at(-1)?.close||0;

  const prev=
    c.at(-2)?.close||price;

  const events=[];

  for(const m of CONVERTED_MAS){

    const vals=
      maValueSeries(
        c,
        m.period,
        "SMA"
      );

    const ma=vals.at(-1);
    const prevMA=vals.at(-2);

    if(!ma||!prevMA)continue;

    const slopePct=
      (ma-prevMA)/prevMA*100;

    const prevDist=
      prev-prevMA;

    const dist=
      price-ma;

    const candle=
      c.at(-1);

    const range=
      candle.high-candle.low||1;

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
      Math.abs(dist)/ma<=0.0015 ||
      candle.low<=ma&&candle.high>=ma ||
      prevDist*dist<=0;

    const crossUp=
      prev<=prevMA&&price>ma;

    const crossDown=
      prev>=prevMA&&price<ma;

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

    const rejection=
      bullishRejection||
      bearishRejection;

    const slope=
      Math.abs(slopePct)<0.003
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

    const volumeConfirm=
      volumeAvg>0 &&
      candle.volume>=volumeAvg*1.15;

    const trendConfirm=
      direction==="LONG"
        ? price>ma
        : direction==="SHORT"
          ? price<ma
          : false;

    const notFlat=
      slope!=="FLAT";

    const strictConfirmation=
      touch &&
      rejection &&
      notFlat &&
      trendConfirm &&
      volumeConfirm;

    const crossConfirmation=
      touch &&
      notFlat &&
      trendConfirm &&
      (crossUp||crossDown) &&
      volumeConfirm;

    let confirmation="WAIT";

    if(
      direction==="LONG" &&
      (
        strictConfirmation||
        crossConfirmation
      )
    ){
      confirmation="CONFIRMED_LONG";
    }

    if(
      direction==="SHORT" &&
      (
        strictConfirmation||
        crossConfirmation
      )
    ){
      confirmation="CONFIRMED_SHORT";
    }

    let type="NONE";

    if(touch){

      if(rejection){
        type="REJECTION";
      }else if(crossUp||crossDown){
        type="BREAK";
      }else{
        type="TOUCH";
      }
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

      volumeConfirmed:volumeConfirm,

      confirmation,

      distancePct:
        (price-ma)/ma*100
    });
  }

  const recent=
    events.filter(
      x=>x.type!=="NONE"
    );

  const confirmed=
    events.filter(
      x=>
        x.confirmation==="CONFIRMED_LONG"||
        x.confirmation==="CONFIRMED_SHORT"
    );

  return {

    events,

    recent,

    confirmed,

    latest:
      recent.length
        ? recent.at(-1)
        : null
  };
}

/* =========================================================
   INDICATORS
========================================================= */

function rsi(c,p=14){

  if(c.length<p+1)return 50;

  const changes=[];

  for(let i=1;i<c.length;i++){
    changes.push(
      c[i].close-c[i-1].close
    );
  }

  const recent=
    changes.slice(-p);

  let gain=0;
  let loss=0;

  for(const x of recent){

    if(x>0)gain+=x;
    if(x<0)loss+=Math.abs(x);
  }

  const avgGain=gain/p;
  const avgLoss=loss/p;

  if(avgLoss===0)return 100;

  const rs=avgGain/avgLoss;

  return 100-(100/(1+rs));
}

function macd(c){

  if(c.length<35){
    return {
      macd:0,
      signal:0,
      histogram:0,
      direction:"NONE"
    };
  }

  const close=
    c.map(x=>x.close);

  const macdSeries=[];

  for(
    let i=0;
    i<close.length;
    i++
  ){

    const a=
      close.slice(0,i+1);

    if(a.length<26){
      macdSeries.push(null);
      continue;
    }

    macdSeries.push(
      ema(a,12)-
      ema(a,26)
    );
  }

  const valid=
    macdSeries.filter(
      x=>x!==null
    );

  const signal=
    ema(
      valid.slice(-9),
      9
    );

  const m=
    valid.at(-1)||0;

  const prev=
    valid.at(-2)||m;

  const histogram=
    m-signal;

  return {

    macd:m,

    signal,

    histogram,

    direction:
      m>signal
        ? "BULLISH"
        : m<signal
          ? "BEARISH"
          : "NONE",

    crossUp:
      prev<=signal&&m>signal,

    crossDown:
      prev>=signal&&m<signal
  };
}

function ichimoku(c){

  if(c.length<52){
    return {
      direction:"NONE",
      tenkan:null,
      kijun:null,
      spanA:null,
      spanB:null
    };
  }

  const mid=(arr)=>{
    const hi=Math.max(
      ...arr.map(x=>x.high)
    );

    const lo=Math.min(
      ...arr.map(x=>x.low)
    );

    return (hi+lo)/2;
  };

  const tenkan=
    mid(c.slice(-9));

  const kijun=
    mid(c.slice(-26));

  const spanB=
    mid(c.slice(-52));

  const spanA=
    (tenkan+kijun)/2;

  const price=
    c.at(-1).close;

  const top=
    Math.max(spanA,spanB);

  const bottom=
    Math.min(spanA,spanB);

  return {

    tenkan,
    kijun,
    spanA,
    spanB,

    direction:
      price>top
        ? "BULLISH"
        : price<bottom
          ? "BEARISH"
          : "RANGE",

    priceAboveCloud:
      price>top,

    priceBelowCloud:
      price<bottom
  };
}

function divergence(c){

  if(c.length<35){
    return {
      type:"NONE",
      side:"NONE"
    };
  }

  const prices=
    c.slice(-30)
      .map(x=>x.close);

  const rsis=[];

  for(
    let i=0;
    i<prices.length;
    i++
  ){

    const start=
      Math.max(0,i-14);

    const part=
      prices.slice(start,i+1);

    if(part.length<5){
      rsis.push(null);
      continue;
    }

    let gain=0;
    let loss=0;

    for(
      let j=1;
      j<part.length;
      j++
    ){

      const d=
        part[j]-part[j-1];

      if(d>0)gain+=d;
      else loss+=Math.abs(d);
    }

    const ag=
      gain/Math.max(1,part.length-1);

    const al=
      loss/Math.max(1,part.length-1);

    rsis.push(
      al===0
        ? 100
        : 100-(100/(1+ag/al))
    );
  }

  const valid=
    rsis
      .map((x,i)=>({x,i}))
      .filter(x=>x.x!==null);

  if(valid.length<10){
    return {
      type:"NONE",
      side:"NONE"
    };
  }

  const half=
    Math.floor(valid.length/2);

  const first=
    valid.slice(0,half);

  const second=
    valid.slice(half);

  const firstPrice=
    avg(
      first.map(
        x=>prices[x.i]
      )
    );

  const secondPrice=
    avg(
      second.map(
        x=>prices[x.i]
      )
    );

  const firstRSI=
    avg(
      first.map(x=>x.x)
    );

  const secondRSI=
    avg(
      second.map(x=>x.x)
    );

  if(
    secondPrice<firstPrice &&
    secondRSI>firstRSI+3
  ){

    return {
      type:"BULLISH_DIVERGENCE",
      side:"LONG",
      priceChange:pct(
        secondPrice,
        firstPrice
      ),
      rsiChange:
        secondRSI-firstRSI
    };
  }

  if(
    secondPrice>firstPrice &&
    secondRSI<firstRSI-3
  ){

    return {
      type:"BEARISH_DIVERGENCE",
      side:"SHORT",
      priceChange:pct(
        secondPrice,
        firstPrice
      ),
      rsiChange:
        secondRSI-firstRSI
    };
  }

  return {
    type:"NONE",
    side:"NONE"
  };
}

function extraSignals(c){

  const r=rsi(c);
  const m=macd(c);
  const i=ichimoku(c);
  const d=divergence(c);

  return {
    RSI:r,
    MACD:m,
    ICHIMOKU:i,
    DIVERGENCE:d
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

    for(const x of t){

      const q=n(x.size);
      const p=n(x.price);
      const notional=q*p;

      largest=
        Math.max(
          largest,
          notional
        );

      if(
        String(x.side).toLowerCase()==="buy"
      ){

        buy+=q;
        buyNotional+=notional;

      }else{

        sell+=q;
        sellNotional+=notional;
      }
    }

    const total=buy+sell;
    const delta=buy-sell;

    const totalNotional=
      buyNotional+sellNotional;

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

      notionalDelta:
        buyNotional-sellNotional,

      notionalDeltaPercent:
        totalNotional
          ? (buyNotional-sellNotional)/
            totalNotional*100
          : 0,

      trades:t.length,

      largeTradeNotional:largest,

      direction:
        delta>0
          ? "BUY_PRESSURE"
          : delta<0
            ? "SELL_PRESSURE"
            : "NEUTRAL"
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

    for(const q of bids){

      const p=n(q[0]);
      const sz=n(q[1]);

      if(p<=0||sz<=0)continue;

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

      if(p<=0||sz<=0)continue;

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

    const totalLiquidity=
      buyLiquidity+sellLiquidity;

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
          : false,

      note:
        "Order Book نقدینگی قابل مشاهده فعلی است و سفارش‌ها ممکن است قبل از رسیدن قیمت حذف یا جابه‌جا شوند."
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

  if(wall?.buyLevels){

    for(const x of wall.buyLevels){

      if(x.price<price){

        supports.push({
          price:x.price,
          type:"BUY_WALL",
          liquidity:x.notional,
          distancePct:x.distancePct
        });
      }
    }
  }

  if(wall?.sellLevels){

    for(const x of wall.sellLevels){

      if(x.price>price){

        resistances.push({
          price:x.price,
          type:"SELL_WALL",
          liquidity:x.notional,
          distancePct:x.distancePct
        });
      }
    }
  }

  supports.sort(
    (a,b)=>a.distancePct-b.distancePct
  );

  resistances.sort(
    (a,b)=>a.distancePct-b.distancePct
  );

  const nearestSupport=
    supports[0]||null;

  const nearestResistance=
    resistances[0]||null;

  const strongestSupport=
    supports
      .filter(x=>x.liquidity)
      .sort(
        (a,b)=>
          (b.liquidity||0)-
          (a.liquidity||0)
      )[0]||
      nearestSupport;

  const strongestResistance=
    resistances
      .filter(x=>x.liquidity)
      .sort(
        (a,b)=>
          (b.liquidity||0)-
          (a.liquidity||0)
      )[0]||
      nearestResistance;

  return {

    nearestSupport,

    nearestResistance,

    strongestSupport,

    strongestResistance,

    supports:
      supports.slice(0,10),

    resistances:
      resistances.slice(0,10)
  };
}

/* =========================================================
   TICKER / OI / FUNDING + CHANGE
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

  return d?.result?.list?.[0]||{};
}

const previousMarketCache=new Map();

async function oiFunding(symbol){

  try{

    const t=
      await ticker(
        "linear",
        symbol
      );

    const currentOI=
      n(t.openInterest);

    const currentFunding=
      n(t.fundingRate);

    const previous=
      previousMarketCache.get(symbol)||null;

    const oiChange=
      previous&&previous.openInterest
        ? currentOI-previous.openInterest
        : null;

    const oiChangePct=
      previous&&previous.openInterest
        ? (
            (currentOI-previous.openInterest)/
            previous.openInterest
          )*100
        : null;

    const fundingChange=
      previous
        ? currentFunding-previous.fundingRate
        : null;

    const fundingChangePct=
      previous&&previous.fundingRate!==0
        ? (
            (currentFunding-previous.fundingRate)/
            Math.abs(previous.fundingRate)
          )*100
        : null;

    previousMarketCache.set(
      symbol,
      {
        openInterest:currentOI,
        fundingRate:currentFunding,
        timestamp:Date.now()
      }
    );

    return {

      openInterest:currentOI,

      openInterestPrevious:
        previous?.openInterest??null,

      openInterestChange:oiChange,

      openInterestChangePct:
        oiChangePct,

      fundingRate:currentFunding,

      fundingRatePrevious:
        previous?.fundingRate??null,

      fundingRateChange:
        fundingChange,

      fundingRateChangePct:
        fundingChangePct,

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
   SIGNAL SCORING
========================================================= */

function signalScore(
  tf,
  converted,
  extra,
  fp,
  wall,
  strictness=DEFAULT_STRICTNESS,
  methods=DEFAULT_METHODS
){

  strictness=
    clamp(
      strictness,
      0,
      100
    );

  const enabled=
    new Set(
      methods.map(
        x=>String(x).toUpperCase()
      )
    );

  let L=0;
  let S=0;

  const evidence=[];

  function add(
    side,
    points,
    text,
    method
  ){

    if(
      !enabled.has(method)
    )return;

    const p=
      points*
      (
        1+
        strictness/200
      );

    if(side==="LONG"){
      L+=p;
    }

    if(side==="SHORT"){
      S+=p;
    }

    evidence.push({
      side,
      points:p,
      method,
      text
    });
  }

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
        "LONG",
        8*w,
        `MA20 تایم ${k}m: برخورد در جهت صعود`,
        "MA"
      );
    }

    if(
      x.touchMA20&&
      x.maSlope==="DOWN"&&
      x.trend==="BEARISH"
    ){

      add(
        "SHORT",
        8*w,
        `MA20 تایم ${k}m: برخورد در جهت نزول`,
        "MA"
      );
    }

    if(
      x.touchMA7&&
      x.maSlope==="UP"&&
      x.trend==="BULLISH"
    ){

      add(
        "LONG",
        6*w,
        `MA7 تایم ${k}m: برخورد در جهت صعود`,
        "MA"
      );
    }

    if(
      x.touchMA7&&
      x.maSlope==="DOWN"&&
      x.trend==="BEARISH"
    ){

      add(
        "SHORT",
        6*w,
        `MA7 تایم ${k}m: برخورد در جهت نزول`,
        "MA"
      );
    }

    if(
      x.hunt?.confirmed&&
      x.hunt.side==="LONG"
    ){

      add(
        "LONG",
        10*w,
        "Hunt / Liquidity Sweep صعودی تأییدشده",
        "HUNT"
      );
    }

    if(
      x.hunt?.confirmed&&
      x.hunt.side==="SHORT"
    ){

      add(
        "SHORT",
        10*w,
        "Hunt / Liquidity Sweep نزولی تأییدشده",
        "HUNT"
      );
    }

    if(x.bos==="BULLISH"){

      add(
        "LONG",
        7*w,
        "BOS صعودی",
        "BOS_CHOCH"
      );
    }

    if(x.bos==="BEARISH"){

      add(
        "SHORT",
        7*w,
        "BOS نزولی",
        "BOS_CHOCH"
      );
    }

    if(x.choch==="BULLISH"){

      add(
        "LONG",
        9*w,
        "CHoCH صعودی",
        "BOS_CHOCH"
      );
    }

    if(x.choch==="BEARISH"){

      add(
        "SHORT",
        9*w,
        "CHoCH نزولی",
        "BOS_CHOCH"
      );
    }

    if(x.fvg?.type==="BULLISH"){

      add(
        "LONG",
        4*w,
        "FVG صعودی",
        "FVG"
      );
    }

    if(x.fvg?.type==="BEARISH"){

      add(
        "SHORT",
        4*w,
        "FVG نزولی",
        "FVG"
      );
    }

    if(x.orderBlock?.type==="BULLISH"){

      add(
        "LONG",
        4*w,
        "Order Block صعودی",
        "ORDER_BLOCK"
      );
    }

    if(x.orderBlock?.type==="BEARISH"){

      add(
        "SHORT",
        4*w,
        "Order Block نزولی",
        "ORDER_BLOCK"
      );
    }

    if(x.volume?.spike){

      if(x.trend==="BULLISH"){

        add(
          "LONG",
          5*w,
          "Volume Spike در جهت صعود",
          "VOLUME"
        );
      }

      if(x.trend==="BEARISH"){

        add(
          "SHORT",
          5*w,
          "Volume Spike در جهت نزول",
          "VOLUME"
        );
      }
    }
  }

  for(
    const e of
    converted?.confirmed||[]
  ){

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
        "LONG",
        12*w,
        `${e.ma} ${e.source} → MA${e.period1m}: Trigger صعودی تأییدشده`,
        "MA"
      );
    }

    if(
      e.confirmation==="CONFIRMED_SHORT"
    ){

      add(
        "SHORT",
        12*w,
        `${e.ma} ${e.source} → MA${e.period1m}: Trigger نزولی تأییدشده`,
        "MA"
      );
    }
  }

  /* MACD */

  if(
    extra?.MACD?.direction==="BULLISH"
  ){

    add(
      "LONG",
      10,
      "MACD صعودی",
      "MACD"
    );
  }

  if(
    extra?.MACD?.direction==="BEARISH"
  ){

    add(
      "SHORT",
      10,
      "MACD نزولی",
      "MACD"
    );
  }

  if(extra?.MACD?.crossUp){

    add(
      "LONG",
      8,
      "MACD Cross صعودی",
      "MACD"
    );
  }

  if(extra?.MACD?.crossDown){

    add(
      "SHORT",
      8,
      "MACD Cross نزولی",
      "MACD"
    );
  }

  /* RSI */

  if(
    extra?.RSI!==undefined &&
    extra.RSI<=30
  ){

    add(
      "LONG",
      10,
      `RSI اشباع فروش: ${extra.RSI.toFixed(1)}`,
      "RSI"
    );
  }

  if(
    extra?.RSI!==undefined &&
    extra.RSI>=70
  ){

    add(
      "SHORT",
      10,
      `RSI اشباع خرید: ${extra.RSI.toFixed(1)}`,
      "RSI"
    );
  }

  /* ICHIMOKU */

  if(
    extra?.ICHIMOKU?.direction==="BULLISH"
  ){

    add(
      "LONG",
      9,
      "Ichimoku صعودی",
      "ICHIMOKU"
    );
  }

  if(
    extra?.ICHIMOKU?.direction==="BEARISH"
  ){

    add(
      "SHORT",
      9,
      "Ichimoku نزولی",
      "ICHIMOKU"
    );
  }

  /* DIVERGENCE */

  if(
    extra?.DIVERGENCE?.side==="LONG"
  ){

    add(
      "LONG",
      12,
      "واگرایی مثبت",
      "DIVERGENCE"
    );
  }

  if(
    extra?.DIVERGENCE?.side==="SHORT"
  ){

    add(
      "SHORT",
      12,
      "واگرایی منفی",
      "DIVERGENCE"
    );
  }

  /* FOOTPRINT */

  if(
    fp&&!fp.error
  ){

    if(fp.deltaPercent>=8){

      add(
        "LONG",
        10,
        `Footprint Delta مثبت ${fp.deltaPercent.toFixed(1)}%`,
        "FOOTPRINT"
      );
    }

    if(fp.deltaPercent<=-8){

      add(
        "SHORT",
        10,
        `Footprint Delta منفی ${fp.deltaPercent.toFixed(1)}%`,
        "FOOTPRINT"
      );
    }
  }

  /* ORDER BOOK */

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
        "Buy Wall قوی نزدیک قیمت",
        "ORDERBOOK"
      );
    }

    if(
      wall.sellNear&&
      wall.sellStrength>=60
    ){

      add(
        "SHORT",
        7,
        "Sell Wall قوی نزدیک قیمت",
        "ORDERBOOK"
      );
    }
  }

  /*
    هرچه سخت‌گیری بیشتر باشد
    آستانه لازم برای سیگنال بیشتر می‌شود.
  */

  const threshold=
    clamp(
      MIN_SIGNAL_SCORE+
      strictness*0.25,
      MIN_SIGNAL_SCORE,
      100
    );

  const requiredMethods=
    strictness>=80
      ? 4
      : strictness>=60
        ? 3
        : strictness>=30
          ? 2
          : 1;

  function methodCount(side){

    return new Set(
      evidence
        .filter(
          x=>x.side===side
        )
        .map(
          x=>x.method
        )
    ).size;
  }

  const longMethods=
    methodCount("LONG");

  const shortMethods=
    methodCount("SHORT");

  let direction="WAIT";

  let finalScore=
    Math.max(
      clamp(L,0,100),
      clamp(S,0,100)
    );

  if(
    L>=threshold &&
    L>S &&
    longMethods>=requiredMethods
  ){

    direction="LONG";
    finalScore=
      clamp(L,0,100);

  }else if(
    S>=threshold &&
    S>L &&
    shortMethods>=requiredMethods
  ){

    direction="SHORT";
    finalScore=
      clamp(S,0,100);
  }

  return {

    direction,

    score:
      Math.round(
        finalScore
      ),

    longScore:
      Math.round(
        clamp(L,0,100)
      ),

    shortScore:
      Math.round(
        clamp(S,0,100)
      ),

    threshold,

    requiredMethods,

    longMethods,

    shortMethods,

    evidence
  };
}

/* =========================================================
   MOVEMENT / PUMP / DUMP
========================================================= */

function movementAnalysis(
  c,
  market,
  tf,
  wall,
  sr,
  fp,
  extra
){

  const price=
    c.at(-1)?.close||0;

  const p5=
    c.length>=6
      ? c.at(-6).close
      : price;

  const p15=
    c.length>=16
      ? c.at(-16).close
      : price;

  const p30=
    c.length>=31
      ? c.at(-31).close
      : price;

  const p60=
    c.length>=61
      ? c.at(-61).close
      : price;

  const change5=
    pct(price,p5);

  const change15=
    pct(price,p15);

  const change30=
    pct(price,p30);

  const change60=
    pct(price,p60);

  const vol20=
    sma(
      c.slice(-21,-1)
        .map(x=>x.volume),
      20
    );

  const currentVol=
    c.at(-1)?.volume||0;

  const volumeRatio=
    vol20
      ? currentVol/vol20
      : 0;

  const h=hunt(c);

  const structure=
    detectStructure(c);

  const candle=
    candleAnalysis(c);

  const fvg=
    detectFVG(c);

  const distMA20=
    tf?.["1"]?.ma20
      ? absPct(
          price,
          tf["1"].ma20
        )
      : 0;

  let pump=0;
  let dump=0;

  const pumpReasons=[];
  const dumpReasons=[];

  if(change5>=1.5){
    pump+=10;
    pumpReasons.push(
      `رشد ۵ دقیقه‌ای ${change5.toFixed(2)}%`
    );
  }

  if(change15>=3){
    pump+=18;
    pumpReasons.push(
      `رشد ۱۵ دقیقه‌ای ${change15.toFixed(2)}%`
    );
  }

  if(change30>=5){
    pump+=15;
    pumpReasons.push(
      `رشد ۳۰ دقیقه‌ای ${change30.toFixed(2)}%`
    );
  }

  if(change60>=7){
    pump+=10;
  }

  if(change5<=-1.5){
    dump+=10;
    dumpReasons.push(
      `افت ۵ دقیقه‌ای ${change5.toFixed(2)}%`
    );
  }

  if(change15<=-3){
    dump+=18;
    dumpReasons.push(
      `افت ۱۵ دقیقه‌ای ${change15.toFixed(2)}%`
    );
  }

  if(change30<=-5){
    dump+=15;
    dumpReasons.push(
      `افت ۳۰ دقیقه‌ای ${change30.toFixed(2)}%`
    );
  }

  if(change60<=-7){
    dump+=10;
  }

  if(volumeRatio>=1.5){

    pump+=10;
    dump+=10;

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
  }

  if(
    tf?.["1"]?.maSlope==="UP"
  ){
    pump+=8;
  }

  if(
    tf?.["1"]?.maSlope==="DOWN"
  ){
    dump+=8;
  }

  if(
    h.confirmed&&
    h.side==="SHORT"
  ){

    pump+=10;

    pumpReasons.push(
      "Buy-side Liquidity Sweep"
    );
  }

  if(
    h.confirmed&&
    h.side==="LONG"
  ){

    dump+=10;

    dumpReasons.push(
      "Sell-side Liquidity Sweep"
    );
  }

  if(
    structure.bos==="BULLISH"
  ){

    pump+=8;

    pumpReasons.push(
      "BOS صعودی"
    );
  }

  if(
    structure.bos==="BEARISH"
  ){

    dump+=8;

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

  if(
    fp&&!fp.error
  ){

    if(fp.deltaPercent>=8){

      pump+=8;

      pumpReasons.push(
        "Footprint Buy Delta"
      );
    }

    if(fp.deltaPercent<=-8){

      dump+=8;

      dumpReasons.push(
        "Footprint Sell Delta"
      );
    }
  }

  if(
    wall?.sellNear&&
    wall.sellStrength>=60
  ){

    dump+=8;

    dumpReasons.push(
      "Sell Wall قوی"
    );
  }

  if(
    wall?.buyNear&&
    wall.buyStrength>=60
  ){

    pump+=8;

    pumpReasons.push(
      "Buy Wall قوی"
    );
  }

  if(
    fvg.type==="BULLISH"
  ){
    pump+=4;
  }

  if(
    fvg.type==="BEARISH"
  ){
    dump+=4;
  }

  const pumpScore=
    Math.round(
      clamp(pump,0,100)
    );

  const dumpScore=
    Math.round(
      clamp(dump,0,100)
    );

  /* PUMP REVERSAL */

  let pumpReversal=0;

  const pumpReversalReasons=[];

  if(change15>=5){

    pumpReversal+=15;

    pumpReversalReasons.push(
      "Pump شدید کوتاه‌مدت"
    );

    if(distMA20>=2){

      pumpReversal+=10;

      pumpReversalReasons.push(
        "فاصله زیاد از MA20 یک دقیقه"
      );
    }

    if(
      h.confirmed&&
      h.side==="SHORT"
    ){

      pumpReversal+=20;

      pumpReversalReasons.push(
        "Buy-side Sweep + Reclaim"
      );
    }

    if(
      candle.type==="SHOOTING_STAR"
    ){

      pumpReversal+=10;

      pumpReversalReasons.push(
        "Shooting Star"
      );
    }

    if(
      structure.choch==="BEARISH"
    ){

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
        "Sell Wall قوی"
      );
    }

    if(
      fp&&!fp.error&&
      fp.deltaPercent<0
    ){

      pumpReversal+=10;

      pumpReversalReasons.push(
        "Footprint به سمت فروش برگشته"
      );
    }

    if(
      extra?.DIVERGENCE?.side==="SHORT"
    ){

      pumpReversal+=12;

      pumpReversalReasons.push(
        "واگرایی منفی"
      );
    }
  }

  /* DUMP REVERSAL */

  let dumpReversal=0;

  const dumpReversalReasons=[];

  if(change15<=-5){

    dumpReversal+=15;

    dumpReversalReasons.push(
      "Dump شدید کوتاه‌مدت"
    );

    if(distMA20>=2){

      dumpReversal+=10;

      dumpReversalReasons.push(
        "فاصله زیاد از MA20 یک دقیقه"
      );
    }

    if(
      h.confirmed&&
      h.side==="LONG"
    ){

      dumpReversal+=20;

      dumpReversalReasons.push(
        "Sell-side Sweep + Reclaim"
      );
    }

    if(
      candle.type==="HAMMER"
    ){

      dumpReversal+=10;

      dumpReversalReasons.push(
        "Hammer"
      );
    }

    if(
      structure.choch==="BULLISH"
    ){

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
        "Buy Wall قوی"
      );
    }

    if(
      fp&&!fp.error&&
      fp.deltaPercent>0
    ){

      dumpReversal+=10;

      dumpReversalReasons.push(
        "Footprint به سمت خرید برگشته"
      );
    }

    if(
      extra?.DIVERGENCE?.side==="LONG"
    ){

      dumpReversal+=12;

      dumpReversalReasons.push(
        "واگرایی مثبت"
      );
    }
  }

  return {

    change5m:change5,
    change15m:change15,
    change30m:change30,
    change60m:change60,

    volumeRatio,

    distanceFromMA20:distMA20,

    pumpScore,
    dumpScore,

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

    pumpReversalReasons,
    dumpReversalReasons
  };
}

/* =========================================================
   STYLE
========================================================= */

function styleAnalysis(
  tf,
  converted,
  movement,
  fp,
  wall
){

  let smc=50;
  let ict=50;
  let ma=50;
  let volume=50;
  let candle=50;
  let orderFlow=50;
  let liquidity=50;

  const one=tf?.["1"];

  if(one){

    if(
      one.bos!=="NONE"||
      one.choch!=="NONE"
    ){

      smc+=20;
      ict+=15;
    }

    if(one.hunt?.confirmed){

      smc+=15;
      ict+=20;
      liquidity+=20;
    }

    if(
      one.fvg?.type!=="NONE"
    ){
      ict+=15;
    }

    if(
      one.orderBlock?.type!=="NONE"
    ){

      smc+=10;
      ict+=10;
    }

    if(one.maSlope!=="FLAT"){
      ma+=15;
    }

    if(one.volume?.spike){
      volume+=20;
    }

    if(one.candle!=="NORMAL"){
      candle+=15;
    }
  }

  if(
    converted?.confirmed?.length
  ){
    ma+=20;
  }

  if(
    fp&&!fp.error&&
    Math.abs(fp.deltaPercent)>=8
  ){
    orderFlow+=25;
  }

  if(
    wall&&!wall.error&&
    (
      wall.buyStrength>=60||
      wall.sellStrength>=60
    )
  ){
    liquidity+=25;
  }

  return {

    SMC:Math.round(
      clamp(smc,0,100)
    ),

    ICT:Math.round(
      clamp(ict,0,100)
    ),

    MA:Math.round(
      clamp(ma,0,100)
    ),

    Volume:Math.round(
      clamp(volume,0,100)
    ),

    Candles:Math.round(
      clamp(candle,0,100)
    ),

    OrderFlow:Math.round(
      clamp(orderFlow,0,100)
    ),

    Liquidity:Math.round(
      clamp(liquidity,0,100)
    )
  };
}

/* =========================================================
   DEEP ANALYSIS
========================================================= */

async function deepAnalyze(
  category,
  symbol,
  settings={}
){

  settings={
    strictness:
      clamp(
        n(
          settings.strictness,
          DEFAULT_STRICTNESS
        ),
        0,
        100
      ),

    methods:
      Array.isArray(settings.methods)&&
      settings.methods.length
        ? settings.methods
        : DEFAULT_METHODS.slice()
  };

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

  const market=
    category==="linear"
      ? await oiFunding(symbol)
      : {
          openInterest:null,
          openInterestPrevious:null,
          openInterestChange:null,
          openInterestChangePct:null,
          fundingRate:null,
          fundingRatePrevious:null,
          fundingRateChange:null,
          fundingRateChangePct:null,
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

  const extra=
    extraSignals(
      oneMinute
    );

  const signal=
    signalScore(
      tf,
      converted,
      extra,
      fp,
      wall,
      settings.strictness,
      settings.methods
    );

  const movement=
    movementAnalysis(
      oneMinute,
      market,
      tf,
      wall,
      sr,
      fp,
      extra
    );

  const styles=
    styleAnalysis(
      tf,
      converted,
      movement,
      fp,
      wall
    );

  let alert="NONE";

  if(
    movement.pumpReversalScore>=75
  ){
    alert="PUMP_REVERSAL_WATCH";
  }

  if(
    movement.dumpReversalScore>=75
  ){
    alert="DUMP_REVERSAL_WATCH";
  }

  if(
    movement.pumpReversalScore>=85&&
    (
      tf["1"]?.choch==="BEARISH"||
      signal.direction==="SHORT"
    )
  ){
    alert="PUMP_REVERSAL_CONFIRMED";
  }

  if(
    movement.dumpReversalScore>=85&&
    (
      tf["1"]?.choch==="BULLISH"||
      signal.direction==="LONG"
    )
  ){
    alert="DUMP_REVERSAL_CONFIRMED";
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
      signal.direction!=="WAIT"
        ? signal.score>=85
          ? "VERY_STRONG"
          : signal.score>=75
            ? "CONFIRMED"
            : "WATCH"
        : signal.score>=60
          ? "WATCH"
          : "NONE",

    signalSettings:{
      strictness:
        settings.strictness,

      selectedMethods:
        settings.methods,

      threshold:
        signal.threshold,

      requiredMethods:
        signal.requiredMethods
    },

    signalEvidence:
      signal.evidence,

    timeframes:
      tf,

    convertedMA1m:
      converted,

    indicators:
      extra,

    footprint:
      fp,

    walls:
      wall,

    supportResistance:
      sr,

    market,

    movement,

    styles,

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

    reasons:
      signal.evidence
        .filter(
          x=>x.side===
            signal.direction
        )
        .map(
          x=>x.text
        ),

    generatedAt:
      Date.now(),

    liquidation:{
      available:false,

      message:
        "داده لیکوئیدیشن تجمیعی از REST عمومی این اسکنر تولید نمی‌شود؛ عدد ساختگی نمایش داده نمی‌شود."
    }
  };
}

/* =========================================================
   MARKET INSTRUMENTS
========================================================= */

async function instruments(category){

  const all=[];
  let cursor="";

  for(
    let page=0;
    page<5;
    page++
  ){

    const d=
      await bybit(
        "/v5/market/instruments-info",
        {
          category,
          limit:1000,
          ...(cursor
            ? {cursor}
            : {})
        }
      );

    all.push(
      ...(d?.result?.list||[])
    );

    cursor=
      d?.result?.nextPageCursor||"";

    if(!cursor)break;
  }

  return all;
}

function validFutures(list){

  return list.filter(
    x=>
      x.status==="Trading"&&
      x.quoteCoin==="USDT"&&
      x.contractType==="LinearPerpetual"
  );
}

/* =========================================================
   MANUAL SEARCH
   Futures + Spot
   Futures priority
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

  const [lin,spot]=
    await Promise.all([
      instruments("linear"),
      instruments("spot")
    ]);

  const l=
    lin.find(
      x=>
        String(x.symbol)
          .toUpperCase()===raw||
        String(x.symbol)
          .toUpperCase()===
          bare+"USDT"
    );

  const s=
    spot.find(
      x=>
        String(x.symbol)
          .toUpperCase()===raw||
        String(x.symbol)
          .toUpperCase()===
          bare+"USDT"
    );

  return {

    input:raw,

    selected:
      l
        ? "FUTURES"
        : s
          ? "SPOT"
          : null,

    futures:
      l
        ? {
            symbol:l.symbol,
            status:l.status,
            baseCoin:l.baseCoin,
            quoteCoin:l.quoteCoin
          }
        : null,

    spot:
      s
        ? {
            symbol:s.symbol,
            status:s.status,
            baseCoin:s.baseCoin,
            quoteCoin:s.quoteCoin
          }
        : null
  };
}

/* =========================================================
   ROTATING SCAN
========================================================= */

async function scan(
  offset=0,
  settings={}
){

  const ms=
    validFutures(
      await instruments("linear")
    ).sort(
      (a,b)=>
        String(a.symbol)
          .localeCompare(
            String(b.symbol)
          )
    );

  if(!ms.length){

    return {
      ok:false,
      error:
        "هیچ قرارداد USDT Perpetual فعال پیدا نشد."
    };
  }

  const safeOffset=
    Math.max(
      0,
      Math.min(
        offset,
        Math.max(
          0,
          ms.length-1
        )
      )
    );

  const batch=
    ms.slice(
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

      if(c.error)continue;

      let activity=0;

      if(c.touchMA20)
        activity+=20;

      if(c.touchMA7)
        activity+=10;

      if(c.volume.spike)
        activity+=20;

      if(c.market.state==="ACTIVE")
        activity+=15;

      if(c.hunt.confirmed)
        activity+=20;

      if(c.bos!=="NONE")
        activity+=10;

      if(c.choch!=="NONE")
        activity+=15;

      if(c.maSlope!=="FLAT")
        activity+=5;

      activity+=
        Math.abs(
          pct(
            c.price,
            c.price/
            (
              1+
              0.01*
              (
                c.volume.ratio20-1
              )
            )
          )
        )*.5;

      light.push({
        symbol:m.symbol,
        activity,
        tf1:c
      });

    }catch(_){}
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
              settings
            )
        )
    );

  deep.sort(
    (a,b)=>
      b.score-a.score
  );

  return {

    ok:true,

    totalMarkets:
      ms.length,

    offset:
      safeOffset,

    batchSize:
      batch.length,

    nextOffset:
      (
        safeOffset+
        SCAN_BATCH
      )%ms.length,

    results:
      deep,

    scannedSymbols:
      batch.map(
        x=>x.symbol
      ),

    settings,

    note:
      "اسکن چرخشی است و بازار بر اساس فعالیت برای تحلیل سنگین انتخاب می‌شود."
  };
}

/* =========================================================
   PUMP / DUMP RADAR
========================================================= */

async function radar(
  offset=0,
  settings={}
){

  const ms=
    validFutures(
      await instruments("linear")
    ).sort(
      (a,b)=>
        String(a.symbol)
          .localeCompare(
            String(b.symbol)
          )
    );

  if(!ms.length){

    return {
      ok:false,
      error:"بازار Futures پیدا نشد."
    };
  }

  const safeOffset=
    Math.max(
      0,
      Math.min(
        offset,
        Math.max(
          0,
          ms.length-1
        )
      )
    );

  const batch=
    ms.slice(
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
          100
        );

      if(c.length<61)continue;

      const price=
        c.at(-1).close;

      const ch5=
        Math.abs(
          pct(
            price,
            c.at(-6).close
          )
        );

      const ch15=
        Math.abs(
          pct(
            price,
            c.at(-16).close
          )
        );

      const ch30=
        Math.abs(
          pct(
            price,
            c.at(-31).close
          )
        );

      const ch60=
        Math.abs(
          pct(
            price,
            c.at(-61).close
          )
        );

      const avgVol=
        sma(
          c.slice(-21,-1)
            .map(
              x=>x.volume
            ),
          20
        );

      const vr=
        avgVol
          ? c.at(-1).volume/avgVol
          : 0;

      const h=hunt(c);

      const st=
        detectStructure(c);

      const oi=
        await oiFunding(
          m.symbol
        );

      const activity=
        ch5*2+
        ch15*4+
        ch30*2+
        ch60+
        Math.min(
          vr*12,
          35
        )+
        (
          h.confirmed
            ? 20
            : 0
        )+
        (
          st.choch!=="NONE"
            ? 20
            : 0
        )+
        Math.min(
          Math.abs(
            oi.openInterestChangePct||0
          )*2,
          15
        );

      candidates.push({
        symbol:m.symbol,
        activity
      });

    }catch(_){}
  }

  candidates.sort(
    (a,b)=>
      b.activity-a.activity
  );

  const deep=
    await Promise.all(
      candidates
        .slice(
          0,
          RADAR_LIMIT
        )
        .map(
          x=>
            deepAnalyze(
              "linear",
              x.symbol,
              settings
            )
        )
    );

  const pump=
    deep
      .filter(
        x=>x.pumpScore>=40
      )
      .sort(
        (a,b)=>
          b.pumpScore-
          a.pumpScore
      );

  const dump=
    deep
      .filter(
        x=>x.dumpScore>=40
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

  return {

    ok:true,

    totalMarkets:
      ms.length,

    offset:
      safeOffset,

    nextOffset:
      (
        safeOffset+
        SCAN_BATCH
      )%ms.length,

    scannedSymbols:
      batch.map(
        x=>x.symbol
      ),

    pump,

    dump,

    reversal,

    results:
      deep,

    settings,

    note:
      "Radar تقویت‌شده با حرکت چندبازه‌ای، حجم، OI، Funding، Footprint/Delta، Sweep، BOS/CHoCH، MA، FVG، Walls و برگشت پس از Pump/Dump."
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
      new URL(request.url);

    const p=
      u.pathname;

    try{

      const settings=
        parseSettings(
          u.searchParams
        );

      /* SEARCH */

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

      /* ANALYZE */

      if(
        p==="/api/analyze"
      ){

        const symbol=
          u.searchParams.get(
            "symbol"
          );

        const category=
          (
            u.searchParams.get(
              "category"
            )||"auto"
          ).toLowerCase();

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

        const chosen=
          category==="spot"
            ? found.spot
            : category==="linear"
              ? found.futures
              : (
                  found.futures||
                  found.spot
                );

        if(!chosen){

          return json(
            {
              ok:false,

              error:
                `${symbol} در Spot یا Futures Bybit پیدا نشد.`,

              search:found
            },
            404
          );
        }

        const chosenCategory=
          chosen===found.futures
            ? "linear"
            : "spot";

        return json({

          ok:true,

          ...await deepAnalyze(
            chosenCategory,
            chosen.symbol,
            settings
          ),

          search:found
        });
      }

      /* SCAN */

      if(
        p==="/api/scan"
      ){

        return json(
          await scan(
            n(
              u.searchParams.get(
                "offset"
              ),
              0
            ),
            settings
          )
        );
      }

      /* RADAR */

      if(
        p==="/api/radar"
      ){

        return json(
          await radar(
            n(
              u.searchParams.get(
                "offset"
              ),
              0
            ),
            settings
          )
        );
      }

      /* HEALTH */

      if(
        p==="/api/health"
      ){

        return json({

          ok:true,

          service:
            "Bybit Smart Money MA Radar",

          version:
            "V9",

          timeframes:
            TF.map(
              x=>x.interval
            ),

          scanBatch:
            SCAN_BATCH,

          deepLimit:
            DEEP_LIMIT,

          radarLimit:
            RADAR_LIMIT,

          minimumSignalScore:
            MIN_SIGNAL_SCORE,

          watchScore:
            WATCH_SCORE,

          defaultStrictness:
            DEFAULT_STRICTNESS,

          signalMethods:
            DEFAULT_METHODS,

          convertedMA:
            CONVERTED_MAS,

          features:[
            "MA",
            "MACD",
            "RSI",
            "Ichimoku",
            "Divergence",
            "Liquidity Hunt",
            "Liquidity Sweep",
            "FVG",
            "BOS",
            "CHoCH",
            "Order Block",
            "Candle Analysis",
            "Volume Spike",
            "ADX",
            "ATR",
            "Bollinger Width",
            "Order Book",
            "Buy Wall",
            "Sell Wall",
            "Support",
            "Resistance",
            "OI Current",
            "OI Previous",
            "OI Change",
            "OI Change %",
            "Funding Current",
            "Funding Previous",
            "Funding Change",
            "Funding Change %",
            "Footprint",
            "Delta",
            "Pump Radar",
            "Dump Radar",
            "Reversal Radar",
            "SMC",
            "ICT"
          ]
        });
      }

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
