const BYBIT = "https://api.bybit.com";

const SCAN_BATCH = 20;
const DEEP_LIMIT = 3;
const RADAR_LIMIT = 5;
const DEEP_1M_LIMIT = 1300;

const MIN_SIGNAL_SCORE = 75;
const WATCH_SCORE = 60;

/*
=========================================================
SIGNAL STRICTNESS
1 = خیلی آسان / سیگنال زیاد
2 = آسان
3 = متعادل
4 = سخت
5 = خیلی سخت
6 = فوق سخت / فقط ستاپ‌های قوی
=========================================================
*/

const STRICTNESS = {
  1:{
    minScore:58,
    minGap:5,
    minEvidence:2,
    requireMA:false,
    requireVolume:false,
    requireStructure:false,
    requireConfirm:false
  },
  2:{
    minScore:64,
    minGap:7,
    minEvidence:2,
    requireMA:false,
    requireVolume:false,
    requireStructure:false,
    requireConfirm:false
  },
  3:{
    minScore:70,
    minGap:10,
    minEvidence:3,
    requireMA:true,
    requireVolume:false,
    requireStructure:false,
    requireConfirm:false
  },
  4:{
    minScore:76,
    minGap:12,
    minEvidence:4,
    requireMA:true,
    requireVolume:true,
    requireStructure:false,
    requireConfirm:false
  },
  5:{
    minScore:82,
    minGap:15,
    minEvidence:5,
    requireMA:true,
    requireVolume:true,
    requireStructure:true,
    requireConfirm:true
  },
  6:{
    minScore:88,
    minGap:20,
    minEvidence:6,
    requireMA:true,
    requireVolume:true,
    requireStructure:true,
    requireConfirm:true
  }
};

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

const TF = [
  {key:"1",label:"1 دقیقه",interval:"1",priority:"MA20"},
  {key:"3",label:"3 دقیقه",interval:"3",priority:"MA7/20"},
  {key:"5",label:"5 دقیقه",interval:"5",priority:"MA7/20"},
  {key:"15",label:"15 دقیقه",interval:"15",priority:"MA7/20"},
  {key:"60",label:"1 ساعت",interval:"60",priority:"MA7/20"}
];

const json=(data,status=200)=>new Response(
  JSON.stringify(data),
  {
    status,
    headers:{
      "content-type":"application/json; charset=UTF-8",
      "cache-control":"no-store",
      "access-control-allow-origin":"*"
    }
  }
);

const n=(v,d=0)=>Number.isFinite(Number(v))?Number(v):d;
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const avg=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:0;

function pct(a,b){
  if(!b)return 0;
  return (a-b)/b*100;
}

function absPct(a,b){
  if(!b)return 999;
  return Math.abs((a-b)/b)*100;
}

/* =========================================================
STRICTNESS
========================================================= */

function getStrictness(value){
  const x=Number(value);

  if(!Number.isFinite(x))return 3;

  return clamp(
    Math.round(x),
    1,
    6
  );
}

function getStrictConfig(value){
  const level=getStrictness(value);
  return{
    level,
    ...STRICTNESS[level]
  };
}

/* =========================================================
BYBIT
========================================================= */

async function bybit(path,params={}){
  const u=new URL(BYBIT+path);

  for(const[k,v]of Object.entries(params)){
    if(v!==undefined&&v!==null&&v!==""){
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
    throw new Error(d.retMsg||`Bybit ${d.retCode}`);
  }

  return d;
}

/* =========================================================
KLINES
========================================================= */

async function klines(category,symbol,interval,limit=100){
  const d=await bybit("/v5/market/kline",{
    category,
    symbol,
    interval,
    limit
  });

  return(d?.result?.list||[])
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
MATH
========================================================= */

function sma(a,p){
  if(!a.length)return 0;
  return a.length<p?avg(a):avg(a.slice(-p));
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

    plus.push(up>dn&&up>0?up:0);
    minus.push(dn>up&&dn>0?dn:0);
  }

  const out=[];

  for(let i=p;i<trs.length;i++){
    const tr=avg(trs.slice(i-p,i))||1;
    const diP=100*avg(plus.slice(i-p,i))/tr;
    const diM=100*avg(minus.slice(i-p,i))/tr;

    const dx=(diP+diM)
      ?100*Math.abs(diP-diM)/(diP+diM)
      :0;

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

  return m?4*sd/m*100:0;
}

/* =========================================================
MARKET RANGE
========================================================= */

function rangeState(c,ma7,ma20,slope,volSpike){
  if(!c.length){
    return{
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
  const atrPct=price?a/price*100:0;
  const adxV=adx(c);
  const bw=bollWidth(c);
  const maGap=ma20
    ?Math.abs(ma7-ma20)/ma20*100
    :0;

  const isRange=
    adxV<18&&
    bw<1.8&&
    Math.abs(slope)<0.0007;

  const waking=
    !isRange&&
    (
      adxV>=18||
      bw>=1.8||
      volSpike
    );

  return{
    state:isRange
      ?"RANGE"
      :waking
        ?"ACTIVE"
        :"TRANSITION",
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
        c[i].high<=c[i-j].high||
        c[i].high<c[i+j].high
      )high=false;

      if(
        c[i].low>=c[i-j].low||
        c[i].low>c[i+j].low
      )low=false;
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

  return{highs,lows};
}

/* =========================================================
HUNT
========================================================= */

function hunt(c){
  if(c.length<25){
    return{
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

  const lowerWick=
    Math.min(x.open,x.close)-x.low;

  const upperWick=
    x.high-Math.max(x.open,x.close);

  const volAvg=sma(
    c.slice(-21,-1).map(z=>z.volume),
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
    return{
      type:"LIQUIDITY_SWEEP",
      side:"LONG",
      level:lo,
      wickPct:lowerWick/range*100,
      volumeConfirmed:volumeConfirm,
      confirmed:
        volumeConfirm||
        lowerWick/range>=0.4
    };
  }

  if(shortSweep){
    return{
      type:"LIQUIDITY_SWEEP",
      side:"SHORT",
      level:hi,
      wickPct:upperWick/range*100,
      volumeConfirmed:volumeConfirm,
      confirmed:
        volumeConfirm||
        upperWick/range>=0.4
    };
  }

  return{
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
    return{
      type:"NONE",
      low:null,
      high:null
    };
  }

  const a=c.at(-3);
  const b=c.at(-2);
  const x=c.at(-1);

  if(x.low>a.high){
    return{
      type:"BULLISH",
      low:a.high,
      high:x.low,
      size:x.low-a.high,
      candle:b.time
    };
  }

  if(x.high<a.low){
    return{
      type:"BEARISH",
      low:x.high,
      high:a.low,
      size:a.low-x.high,
      candle:b.time
    };
  }

  return{
    type:"NONE",
    low:null,
    high:null
  };
}

/* =========================================================
BOS / CHOCH
========================================================= */

function detectStructure(c){
  if(c.length<15){
    return{
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
    highs.length>1
      ?highs.at(-2).price
      :null;

  const lastLow=
    lows.length?lows.at(-1).price:null;

  const prevLow=
    lows.length>1
      ?lows.at(-2).price
      :null;

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
    lastLow&&
    lastHigh&&
    lastLow>prevLow&&
    lastHigh>prevHigh&&
    price<lastLow
  ){
    choch="BEARISH";
  }

  if(
    prevHigh&&
    prevLow&&
    lastLow&&
    lastHigh&&
    lastLow<prevLow&&
    lastHigh<prevHigh&&
    price>lastHigh
  ){
    choch="BULLISH";
  }

  return{
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
    return{type:"NONE"};
  }

  const x=c.at(-1);

  for(
    let i=c.length-4;
    i>=Math.max(0,c.length-12);
    i--
  ){
    const z=c[i];

    if(
      z.close<z.open&&
      x.close>z.high
    ){
      return{
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
      return{
        type:"BEARISH",
        low:z.low,
        high:z.high,
        time:z.time
      };
    }
  }

  return{type:"NONE"};
}

/* =========================================================
CANDLE
========================================================= */

function candleAnalysis(c){
  if(c.length<3){
    return{
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

  if(bodyRatio<0.15){
    type="DOJI";
  }

  return{
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
    return{error:"کندل کافی نیست"};
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
      ?(ma20-prev20)/prev20
      :0;

  const prevPrice=close.at(-2);
  const high=c.at(-1).high;
  const low=c.at(-1).low;

  const touch20=
    Math.abs(price-ma20)/ma20<=0.0015||
    (low<=ma20&&high>=ma20)||
    ((prevPrice-ma20)*(price-ma20)<=0);

  const touch7=
    Math.abs(price-ma7)/ma7<=0.0015||
    (low<=ma7&&high>=ma7)||
    ((prevPrice-ma7)*(price-ma7)<=0);

  const vol7=sma(vol,7);
  const vol20=sma(vol,20);

  const spike=
    vol.at(-1)>vol20*1.5||
    vol.at(-1)>vol7*1.8;

  const rs=rangeState(
    c,
    ma7,
    ma20,
    slope,
    spike
  );

  const trend=
    price>ma20&&ma7>ma20
      ?"BULLISH"
      :price<ma20&&ma7<ma20
        ?"BEARISH"
        :"RANGE";

  const candleDetails=
    candleAnalysis(c);

  return{
    price,
    ma7,
    ma20,

    maSlope:
      slope>0.00007
        ?"UP"
        :slope<-0.00007
          ?"DOWN"
          :"FLAT",

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
          ?vol.at(-1)/vol20
          :0
    },

    market:rs,

    hunt:hunt(c),

    candle:candleDetails.type,

    candleDetails,

    fvg:detectFVG(c),

    ...(()=>{
      const s=detectStructure(c);

      return{
        bos:s.bos,
        choch:s.choch,
        structure:s
      };
    })(),

    orderBlock:detectOrderBlock(c),

    timestamp:c.at(-1).time
  };
}

/* =========================================================
CONVERTED MA
========================================================= */

function maValueSeries(c,p,type="SMA"){
  const out=[];

  for(let i=0;i<c.length;i++){

    const a=c.slice(
      Math.max(0,i-p+1),
      i+1
    ).map(x=>x.close);

    out.push(
      a.length>=p
        ?type==="EMA"
          ?ema(a,p)
          :avg(a)
        :null
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

    const prevDist=prev-prevMA;
    const dist=price-ma;

    const candle=c.at(-1);

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
      Math.abs(dist)/ma<=0.0015||
      (candle.low<=ma&&candle.high>=ma)||
      prevDist*dist<=0;

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
      lower/range>=0.25;

    const bearishRejection=
      candle.high>=ma&&
      candle.close<ma&&
      candle.close<candle.open&&
      upper/range>=0.25;

    const rejection=
      bullishRejection||
      bearishRejection;

    const slope=
      Math.abs(slopePct)<0.003
        ?"FLAT"
        :slopePct>0
          ?"UP"
          :"DOWN";

    const direction=
      bullishRejection||crossUp
        ?"LONG"
        :bearishRejection||crossDown
          ?"SHORT"
          :"NONE";

    const volumeAvg=sma(
      c.slice(-21,-1).map(x=>x.volume),
      20
    );

    const volumeConfirm=
      volumeAvg>0&&
      candle.volume>=volumeAvg*1.15;

    const trendConfirm=
      direction==="LONG"
        ?price>ma
        :direction==="SHORT"
          ?price<ma
          :false;

    const notFlat=slope!=="FLAT";

    const strictConfirmation=
      touch&&
      rejection&&
      notFlat&&
      trendConfirm&&
      volumeConfirm;

    const crossConfirmation=
      touch&&
      notFlat&&
      trendConfirm&&
      (crossUp||crossDown)&&
      volumeConfirm;

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
      if(rejection)type="REJECTION";
      else if(crossUp||crossDown)type="BREAK";
      else type="TOUCH";
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

  return{
    events,
    recent,
    confirmed,
    latest:
      recent.length
        ?recent.at(-1)
        :null
  };
}

/* =========================================================
FOOTPRINT
========================================================= */

async function footprint(category,symbol){
  try{

    const d=await bybit(
      "/v5/market/recent-trade",
      {
        category,
        symbol,
        limit:200
      }
    );

    const t=d?.result?.list||[];

    let buy=0;
    let sell=0;
    let largest=0;
    let buyNotional=0;
    let sellNotional=0;

    for(const x of t){

      const q=n(x.size);
      const p=n(x.price);
      const notional=q*p;

      largest=
        Math.max(
          largest,
          notional
        );

      const side=
        String(x.side||"").toLowerCase();

      if(side==="buy"){
        buy+=q;
        buyNotional+=notional;
      }

      if(side==="sell"){
        sell+=q;
        sellNotional+=notional;
      }
    }

    const total=buy+sell;

    const totalNotional=
      buyNotional+sellNotional;

    const delta=buy-sell;

    const notionalDelta=
      buyNotional-sellNotional;

    return{
      buyVolume:buy,
      sellVolume:sell,
      totalVolume:total,
      delta,

      deltaPercent:
        total
          ?delta/total*100
          :0,

      buyNotional,
      sellNotional,
      totalNotional,
      notionalDelta,

      notionalDeltaPercent:
        totalNotional
          ?notionalDelta/
           totalNotional*100
          :0,

      buyShare:
        total
          ?buy/total*100
          :0,

      sellShare:
        total
          ?sell/total*100
          :0,

      trades:t.length,

      largeTradeNotional:
        largest,

      pressure:
        delta>0
          ?"BUY_PRESSURE"
          :delta<0
            ?"SELL_PRESSURE"
            :"BALANCED"
    };

  }catch(e){
    return{error:e.message};
  }
}

/* =========================================================
ORDER BOOK
========================================================= */

async function walls(category,symbol,price){

  try{

    const d=await bybit(
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

    const buyWall=
      buyLevels[0]||null;

    const sellWall=
      sellLevels[0]||null;

    const avgBuy=
      buyLevels.length
        ?avg(
          buyLevels.map(
            x=>x.notional
          )
        )
        :0;

    const avgSell=
      sellLevels.length
        ?avg(
          sellLevels.map(
            x=>x.notional
          )
        )
        :0;

    const buyStrength=
      buyWall&&avgBuy
        ?clamp(
          buyWall.notional/
          avgBuy*20,
          0,
          100
        )
        :0;

    const sellStrength=
      sellWall&&avgSell
        ?clamp(
          sellWall.notional/
          avgSell*20,
          0,
          100
        )
        :0;

    return{

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
          ?buyLiquidity/
           totalLiquidity*100
          :0,

      sellShare:
        totalLiquidity
          ?sellLiquidity/
           totalLiquidity*100
          :0,

      buyStrength,
      sellStrength,

      buyNear:
        buyWall
          ?buyWall.distancePct<=1
          :false,

      sellNear:
        sellWall
          ?sellWall.distancePct<=1
          :false,

      imbalance:
        totalLiquidity
          ?(
            buyLiquidity-
            sellLiquidity
          )/totalLiquidity*100
          :0
    };

  }catch(e){
    return{error:e.message};
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
    (a,b)=>
      a.distancePct-b.distancePct
  );

  resistances.sort(
    (a,b)=>
      a.distancePct-b.distancePct
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

  return{
    nearestSupport,
    nearestResistance,
    strongestSupport,
    strongestResistance,
    supports:supports.slice(0,10),
    resistances:resistances.slice(0,10)
  };
}

/* =========================================================
TICKER / OI
========================================================= */

async function ticker(category,symbol){

  const d=await bybit(
    "/v5/market/tickers",
    {
      category,
      symbol
    }
  );

  return d?.result?.list?.[0]||{};
}

async function oiHistory(
  symbol,
  intervalTime="5min",
  limit=50
){

  try{

    const d=await bybit(
      "/v5/market/open-interest",
      {
        category:"linear",
        symbol,
        intervalTime,
        limit
      }
    );

    return(d?.result?.list||[])
      .map(x=>({
        timestamp:n(x.timestamp),
        openInterest:n(x.openInterest)
      }))
      .reverse();

  }catch(e){
    return[];
  }
}

async function oiFunding(symbol){

  try{

    const t=
      await ticker(
        "linear",
        symbol
      );

    const history=
      await oiHistory(
        symbol,
        "5min",
        50
      );

    const currentOI=
      n(t.openInterest);

    let oiChange=0;

    if(history.length>=2){

      const old=
        history[0].openInterest;

      const latest=
        history.at(-1).openInterest;

      if(old){
        oiChange=
          (latest-old)/old*100;
      }
    }

    return{
      openInterest:currentOI,
      openInterestChange:oiChange,
      fundingRate:n(t.fundingRate),
      turnover24h:n(t.turnover24h),
      priceChange24h:
        n(t.price24hPcnt)*100,
      markPrice:n(t.markPrice),
      indexPrice:n(t.indexPrice),
      oiHistory:history.slice(-20)
    };

  }catch(e){
    return{error:e.message};
  }
}

/* =========================================================
SCORING
========================================================= */

function score(tf,converted){

  let L=0;
  let S=0;

  const longReasons=[];
  const shortReasons=[];

  const addedEvidence={
    L:new Set(),
    S:new Set()
  };

  const add=(dir,v,text)=>{

    if(dir==="L"){
      L+=v;
      longReasons.push(text);
    }

    if(dir==="S"){
      S+=v;
      shortReasons.push(text);
    }
  };

  const addUnique=(
    dir,
    v,
    text,
    key
  )=>{

    if(
      addedEvidence[dir].has(key)
    )return;

    addedEvidence[dir].add(key);

    add(
      dir,
      v,
      text
    );
  };

  for(const[k,x]of Object.entries(tf)){

    if(!x||x.error)continue;

    const w=
      k==="1"
        ?1.5
        :k==="60"
          ?1.3
          :1;

    if(
      x.market?.state==="RANGE"
    ){
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
        `MA20 تایم ${k}m: برخورد در جهت صعود`
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
        `MA20 تایم ${k}m: برخورد در جهت نزول`
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
        `MA7 تایم ${k}m: برخورد در جهت صعود`
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
        `MA7 تایم ${k}m: برخورد در جهت نزول`
      );
    }

    if(
      x.hunt?.confirmed&&
      x.hunt.side==="LONG"
    ){

      add(
        "L",
        10*w,
        "Hunt / Liquidity Sweep صعودی تأییدشده"
      );
    }

    if(
      x.hunt?.confirmed&&
      x.hunt.side==="SHORT"
    ){

      add(
        "S",
        10*w,
        "Hunt / Liquidity Sweep نزولی تأییدشده"
      );
    }

    if(x.bos==="BULLISH"){
      add("L",7*w,"BOS صعودی");
    }

    if(x.bos==="BEARISH"){
      add("S",7*w,"BOS نزولی");
    }

    if(x.choch==="BULLISH"){
      add("L",9*w,"CHoCH صعودی");
    }

    if(x.choch==="BEARISH"){
      add("S",9*w,"CHoCH نزولی");
    }

    if(x.fvg?.type==="BULLISH"){

      addUnique(
        "L",
        4*w,
        "FVG صعودی",
        "FVG_BULLISH"
      );
    }

    if(x.fvg?.type==="BEARISH"){

      addUnique(
        "S",
        4*w,
        "FVG نزولی",
        "FVG_BEARISH"
      );
    }

    if(
      x.orderBlock?.type==="BULLISH"
    ){

      addUnique(
        "L",
        4*w,
        "Order Block صعودی",
        "OB_BULLISH"
      );
    }

    if(
      x.orderBlock?.type==="BEARISH"
    ){

      addUnique(
        "S",
        4*w,
        "Order Block نزولی",
        "OB_BEARISH"
      );
    }

    if(x.volume?.spike){

      if(x.trend==="BULLISH"){

        add(
          "L",
          5*w,
          "افزایش حجم کوتاه‌مدت در جهت صعود"
        );
      }

      if(x.trend==="BEARISH"){

        add(
          "S",
          5*w,
          "افزایش حجم کوتاه‌مدت در جهت نزول"
        );
      }
    }
  }

  for(
    const e of converted?.confirmed||[]
  ){

    const w=
      e.source==="1h"
        ?1.5
        :e.source==="15m"
          ?1.3
          :e.source==="5m"
            ?1.15
            :1;

    if(
      e.confirmation===
      "CONFIRMED_LONG"
    ){

      add(
        "L",
        12*w,
        `${e.ma} ${e.source} → MA${e.period1m}: Trigger صعودی تأییدشده`
      );
    }

    if(
      e.confirmation===
      "CONFIRMED_SHORT"
    ){

      add(
        "S",
        12*w,
        `${e.ma} ${e.source} → MA${e.period1m}: Trigger نزولی تأییدشده`
      );
    }
  }

  return{
    L,
    S,
    longScore:clamp(L,0,100),
    shortScore:clamp(S,0,100),
    longReasons,
    shortReasons
  };
}

/* =========================================================
MOVEMENT
========================================================= */

function movementAnalysis(
  c,
  market,
  tf,
  wall,
  sr
){

  const price=
    c.at(-1)?.close||0;

  const p15=
    c.length>=15
      ?c.at(-15).close
      :price;

  const p30=
    c.length>=30
      ?c.at(-30).close
      :price;

  const change15=pct(
    price,
    p15
  );

  const change30=pct(
    price,
    p30
  );

  const vol20=sma(
    c.slice(-21,-1)
      .map(x=>x.volume),
    20
  );

  const currentVol=
    c.at(-1)?.volume||0;

  const volumeRatio=
    vol20
      ?currentVol/vol20
      :0;

  const h=hunt(c);

  const structure=
    detectStructure(c);

  const candle=
    candleAnalysis(c);

  const fvg=
    detectFVG(c);

  const distMA20=
    tf?.["1"]?.ma20
      ?absPct(
        price,
        tf["1"].ma20
      )
      :0;

  let pump=0;
  let dump=0;

  const pumpReasons=[];
  const dumpReasons=[];

  if(change15>=3){

    pump+=20;

    pumpReasons.push(
      `رشد کوتاه‌مدت ${change15.toFixed(2)}%`
    );
  }

  if(change30>=5){
    pump+=10;
  }

  if(change15<=-3){

    dump+=20;

    dumpReasons.push(
      `افت کوتاه‌مدت ${change15.toFixed(2)}%`
    );
  }

  if(change30<=-5){
    dump+=10;
  }

  if(volumeRatio>=1.5){

    pump+=10;
    dump+=10;

    pumpReasons.push(
      "Volume Spike"
    );

    dumpReasons.push(
      "Volume Spike"
    );
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

    pump+=10;

    pumpReasons.push(
      "Sell-side Liquidity Sweep"
    );
  }

  if(
    h.confirmed&&
    h.side==="SHORT"
  ){

    dump+=10;

    dumpReasons.push(
      "Buy-side Liquidity Sweep"
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

  if(
    wall?.buyNear&&
    wall.buyStrength>=60
  ){

    pump+=8;

    pumpReasons.push(
      "Buy Wall قوی نزدیک قیمت"
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
        "Buy-side Liquidity Sweep + Reclaim"
      );
    }

    if(
      candle.type==="SHOOTING_STAR"
    ){

      pumpReversal+=10;

      pumpReversalReasons.push(
        "کندل رد قیمت در سقف"
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
  }

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
        "Sell-side Liquidity Sweep + Reclaim"
      );
    }

    if(candle.type==="HAMMER"){

      dumpReversal+=10;

      dumpReversalReasons.push(
        "کندل جذب فروش"
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
  }

  return{

    change15m:change15,
    change30m:change30,

    volumeRatio,

    distanceFromMA20:distMA20,

    pumpScore:
      Math.round(
        clamp(pump,0,100)
      ),

    dumpScore:
      Math.round(
        clamp(dump,0,100)
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

    if(one.fvg?.type!=="NONE"){
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

  if(converted?.confirmed?.length){
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

  return{

    SMC:
      Math.round(
        clamp(smc,0,100)
      ),

    ICT:
      Math.round(
        clamp(ict,0,100)
      ),

    MA:
      Math.round(
        clamp(ma,0,100)
      ),

    Volume:
      Math.round(
        clamp(volume,0,100)
      ),

    Candles:
      Math.round(
        clamp(candle,0,100)
      ),

    OrderFlow:
      Math.round(
        clamp(orderFlow,0,100)
      ),

    Liquidity:
      Math.round(
        clamp(liquidity,0,100)
      ),

    summary:{
      SMC:
        smc>=75
          ?"SETUP"
          :"NEUTRAL",

      ICT:
        ict>=75
          ?"SETUP"
          :"NEUTRAL",

      MA:
        ma>=75
          ?"CONFIRMED"
          :"WEAK",

      Volume:
        volume>=75
          ?"CONFIRMED"
          :"NORMAL"
    }
  };
}

/* =========================================================
STRICT SIGNAL FILTER
========================================================= */

function strictSignalFilter(
  direction,
  longScore,
  shortScore,
  tf,
  converted,
  fp,
  wall,
  strictness
){

  const cfg=
    getStrictConfig(strictness);

  const one=
    tf?.["1"]||{};

  const score=
    direction==="LONG"
      ?longScore
      :direction==="SHORT"
        ?shortScore
        :0;

  if(
    direction!=="LONG"&&
    direction!=="SHORT"
  ){
    return{
      accepted:false,
      reason:"WAIT",
      evidence:0,
      config:cfg
    };
  }

  const evidence=[];

  const maOK=
    direction==="LONG"
      ?(
        one.touchMA20||
        one.touchMA7||
        converted?.confirmed?.some(
          x=>x.confirmation===
            "CONFIRMED_LONG"
        )
      )
      :(
        one.touchMA20||
        one.touchMA7||
        converted?.confirmed?.some(
          x=>x.confirmation===
            "CONFIRMED_SHORT"
        )
      );

  const volumeOK=
    Boolean(
      one.volume?.spike||
      fp&&!fp.error&&
      (
        direction==="LONG"
          ?fp.deltaPercent>=8
          :fp.deltaPercent<=-8
      )
    );

  const structureOK=
    direction==="LONG"
      ?(
        one.bos==="BULLISH"||
        one.choch==="BULLISH"||
        one.hunt?.side==="LONG"&&
        one.hunt?.confirmed
      )
      :(
        one.bos==="BEARISH"||
        one.choch==="BEARISH"||
        one.hunt?.side==="SHORT"&&
        one.hunt?.confirmed
      );

  const orderFlowOK=
    fp&&!fp.error
      ?direction==="LONG"
        ?fp.deltaPercent>=5
        :fp.deltaPercent<=-5
      :false;

  const wallOK=
    wall&&!wall.error
      ?direction==="LONG"
        ?(
          wall.buyNear||
          wall.imbalance>=10
        )
        :(
          wall.sellNear||
          wall.imbalance<=-10
        )
      :false;

  const convertedOK=
    converted?.confirmed?.some(
      x=>
        direction==="LONG"
          ?x.confirmation===
            "CONFIRMED_LONG"
          :x.confirmation===
            "CONFIRMED_SHORT"
    );

  if(maOK)evidence.push("MA");
  if(volumeOK)evidence.push("VOLUME");
  if(structureOK)evidence.push("STRUCTURE");
  if(orderFlowOK)evidence.push("ORDER_FLOW");
  if(wallOK)evidence.push("WALL");
  if(convertedOK)evidence.push("CONVERTED_MA");

  const evidenceCount=
    evidence.length;

  const gap=
    Math.abs(
      longScore-shortScore
    );

  const requirements=[];

  if(cfg.requireMA&&!maOK){
    requirements.push("MA");
  }

  if(
    cfg.requireVolume&&
    !volumeOK
  ){
    requirements.push("VOLUME");
  }

  if(
    cfg.requireStructure&&
    !structureOK
  ){
    requirements.push("STRUCTURE");
  }

  if(
    cfg.requireConfirm&&
    !convertedOK
  ){
    requirements.push("MA_CONFIRM");
  }

  const accepted=
    score>=cfg.minScore&&
    gap>=cfg.minGap&&
    evidenceCount>=cfg.minEvidence&&
    requirements.length===0;

  return{
    accepted,
    score,
    gap,
    evidence:evidenceCount,
    evidenceList:evidence,
    requirements,
    reason:
      accepted
        ?"CONFIRMED"
        :"FILTERED_BY_STRICTNESS",
    config:cfg
  };
}

/* =========================================================
ENTRY / SL / TP
========================================================= */

function calculateTradePlan(
  direction,
  price,
  tf,
  wall,
  sr,
  fp
){

  if(
    !direction||
    direction==="WAIT"||
    !price
  ){

    return{
      available:false,
      reason:
        "سیگنال قطعی وجود ندارد."
    };
  }

  const one=
    tf?.["1"]||{};

  const atrValue=
    n(
      one.market?.atr||
      one.atr
    );

  const minRisk=
    price*0.0015;

  const volatilityRisk=
    atrValue>0
      ?atrValue*0.8
      :minRisk;

  const riskDistance=
    Math.max(
      minRisk,
      volatilityRisk
    );

  let entry=price;
  let sl;
  let tp1;
  let tp2;
  let tp3;

  if(direction==="LONG"){

    const support=
      sr?.nearestSupport?.price||
      null;

    if(
      support&&
      support<price&&
      absPct(
        support,
        price
      )<=1.5
    ){

      sl=Math.min(
        support-riskDistance*0.15,
        price-riskDistance
      );

    }else{

      sl=
        price-riskDistance;
    }

    const risk=Math.max(
      entry-sl,
      minRisk
    );

    const resistance=
      sr?.nearestResistance?.price||
      null;

    if(
      resistance&&
      resistance>entry&&
      resistance-entry>=risk*0.8
    ){

      tp1=resistance;

    }else{

      tp1=
        entry+risk*1.2;
    }

    tp2=
      entry+risk*2;

    tp3=
      entry+risk*3;

  }else{

    const resistance=
      sr?.nearestResistance?.price||
      null;

    if(
      resistance&&
      resistance>price&&
      absPct(
        resistance,
        price
      )<=1.5
    ){

      sl=Math.max(
        resistance+riskDistance*0.15,
        price+riskDistance
      );

    }else{

      sl=
        price+riskDistance;
    }

    const risk=Math.max(
      sl-entry,
      minRisk
    );

    const support=
      sr?.nearestSupport?.price||
      null;

    if(
      support&&
      support<entry&&
      entry-support>=risk*0.8
    ){

      tp1=support;

    }else{

      tp1=
        entry-risk*1.2;
    }

    tp2=
      entry-risk*2;

    tp3=
      entry-risk*3;
  }

  const riskAmount=
    Math.abs(
      entry-sl
    );

  return{

    available:true,
    direction,
    entry,
    sl,
    tp1,
    tp2,
    tp3,

    riskDistance:riskAmount,

    riskPercent:
      entry
        ?riskAmount/entry*100
        :0,

    rr1:
      riskAmount
        ?Math.abs(tp1-entry)/
         riskAmount
        :0,

    rr2:
      riskAmount
        ?Math.abs(tp2-entry)/
         riskAmount
        :0,

    rr3:
      riskAmount
        ?Math.abs(tp3-entry)/
         riskAmount
        :0,

    basis:{
      atr:atrValue,
      nearestSupport:
        sr?.nearestSupport||null,
      nearestResistance:
        sr?.nearestResistance||null,
      buyWall:
        wall?.buy||null,
      sellWall:
        wall?.sell||null,
      footprintDelta:
        fp?.deltaPercent??null
    }
  };
}

/* =========================================================
DEEP ANALYSIS
========================================================= */

async function deepAnalyze(
  category,
  symbol,
  strictness=3
){

  const strict=
    getStrictConfig(
      strictness
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
      ?convertedMAEvents(
        oneMinute
      )
      :{
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
      ?valid[0].price
      :0;

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
      ?await oiFunding(symbol)
      :{
        openInterest:null,
        openInterestChange:null,
        fundingRate:null,
        turnover24h:null,
        priceChange24h:null,
        markPrice:null,
        indexPrice:null,
        oiHistory:[]
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
      converted
    );

  if(fp&&!fp.error){

    if(fp.deltaPercent>=8){

      sc.L+=10;

      sc.longReasons.push(
        `Footprint Delta صعودی ${fp.deltaPercent.toFixed(1)}%`
      );
    }

    if(fp.deltaPercent>=18){
      sc.L+=5;
    }

    if(fp.deltaPercent<=-8){

      sc.S+=10;

      sc.shortReasons.push(
        `Footprint Delta نزولی ${Math.abs(fp.deltaPercent).toFixed(1)}%`
      );
    }

    if(fp.deltaPercent<=-18){
      sc.S+=5;
    }
  }

  if(wall&&!wall.error){

    if(
      wall.buyNear&&
      wall.buyStrength>=60
    ){

      sc.L+=5;

      sc.longReasons.push(
        "Buy Wall قوی نزدیک قیمت"
      );
    }

    if(
      wall.sellNear&&
      wall.sellStrength>=60
    ){

      sc.S+=5;

      sc.shortReasons.push(
        "Sell Wall قوی نزدیک قیمت"
      );
    }
  }

  if(market&&!market.error){

    const oiChange=
      n(
        market.openInterestChange
      );

    const priceChange=
      n(
        market.priceChange24h
      );

    if(
      oiChange>=3&&
      priceChange>=2
    ){

      sc.L+=4;

      sc.longReasons.push(
        "افزایش OI همراه با رشد قیمت"
      );
    }

    if(
      oiChange>=3&&
      priceChange<=-2
    ){

      sc.S+=4;

      sc.shortReasons.push(
        "افزایش OI همراه با افت قیمت"
      );
    }

    if(
      oiChange<=-3&&
      priceChange>=3
    ){

      sc.L+=3;

      sc.longReasons.push(
        "کاهش OI همراه با رشد قیمت"
      );
    }

    if(
      oiChange<=-3&&
      priceChange<=-3
    ){

      sc.S+=3;

      sc.shortReasons.push(
        "کاهش OI همراه با افت قیمت"
      );
    }
  }

  const longScore=
    clamp(
      sc.L,
      0,
      100
    );

  const shortScore=
    clamp(
      sc.S,
      0,
      100
    );

  /*
  ========================================================
  RAW DIRECTION
  ========================================================
  */

  let rawDirection="WAIT";

  if(
    longScore>shortScore&&
    longScore>=strict.minScore
  ){

    rawDirection="LONG";

  }else if(
    shortScore>longScore&&
    shortScore>=strict.minScore
  ){

    rawDirection="SHORT";
  }

  /*
  ========================================================
  STRICT FILTER
  ========================================================
  */

  const strictFilter=
    strictSignalFilter(
      rawDirection,
      longScore,
      shortScore,
      tf,
      converted,
      fp,
      wall,
      strict.level
    );

  let direction=
    strictFilter.accepted
      ?rawDirection
      :"WAIT";

  const finalScore=
    direction==="LONG"
      ?longScore
      :direction==="SHORT"
        ?shortScore
        :Math.max(
          longScore,
          shortScore
        );

  const movement=
    movementAnalysis(
      oneMinute,
      market,
      tf,
      wall,
      sr
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
    alert=
      "PUMP_REVERSAL_WATCH";
  }

  if(
    movement.dumpReversalScore>=75
  ){
    alert=
      "DUMP_REVERSAL_WATCH";
  }

  const confirmedPumpReversal=
    movement.pumpReversalScore>=85&&
    (
      tf["1"]?.choch==="BEARISH"||
      converted.confirmed.some(
        x=>
          x.confirmation===
          "CONFIRMED_SHORT"
      )
    );

  const confirmedDumpReversal=
    movement.dumpReversalScore>=85&&
    (
      tf["1"]?.choch==="BULLISH"||
      converted.confirmed.some(
        x=>
          x.confirmation===
          "CONFIRMED_LONG"
      )
    );

  if(confirmedPumpReversal){
    alert=
      "PUMP_REVERSAL_CONFIRMED";
  }

  if(confirmedDumpReversal){
    alert=
      "DUMP_REVERSAL_CONFIRMED";
  }

  const pumpDumpStatus=
    movement.pumpScore>=75
      ?"PUMP"
      :movement.dumpScore>=75
        ?"DUMP"
        :"NORMAL";

  const tradePlan=
    calculateTradePlan(
      direction,
      price,
      tf,
      wall,
      sr,
      fp
    );

  /*
  ========================================================
  SIGNAL LEVEL
  ========================================================
  */

  let signalLevel="NONE";

  if(direction!=="WAIT"){

    if(
      finalScore>=90
    ){
      signalLevel=
        "VERY_STRONG";

    }else if(
      finalScore>=strict.minScore
    ){
      signalLevel=
        "CONFIRMED";
    }

  }else if(
    finalScore>=strict.minScore
  ){

    signalLevel=
      finalScore>=strict.minScore+10
        ?"FILTERED_STRONG"
        :"WATCH";
  }

  return{

    symbol,
    category,
    price,

    direction,

    rawDirection,

    score:
      Math.round(finalScore),

    longScore:
      Math.round(longScore),

    shortScore:
      Math.round(shortScore),

    signalLevel,

    /*
    تنظیم سخت‌گیری
    */

    signalStrictness:{
      level:strict.level,

      minScore:
        strict.minScore,

      minGap:
        strict.minGap,

      minEvidence:
        strict.minEvidence,

      accepted:
        strictFilter.accepted,

      evidence:
        strictFilter.evidence,

      evidenceList:
        strictFilter.evidenceList,

      requirements:
        strictFilter.requirements,

      reason:
        strictFilter.reason
    },

    tradePlan,

    timeframes:tf,

    convertedMA1m:converted,

    footprint:fp,

    walls:wall,

    supportResistance:sr,

    market,

    movement,

    styles,

    pumpScore:
      movement.pumpScore,

    dumpScore:
      movement.dumpScore,

    pumpDumpStatus,

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
      direction==="LONG"
        ?sc.longReasons
        :direction==="SHORT"
          ?sc.shortReasons
          :[
            ...sc.longReasons,
            ...sc.shortReasons
          ],

    generatedAt:Date.now(),

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

  const all=[];
  let cursor="";

  for(let page=0;page<10;page++){

    const params={
      category,
      limit:1000
    };

    if(cursor){
      params.cursor=cursor;
    }

    const d=
      await bybit(
        "/v5/market/instruments-info",
        params
      );

    const list=
      d?.result?.list||[];

    all.push(...list);

    cursor=
      d?.result?.nextPageCursor||"";

    if(
      !cursor||
      !list.length
    ){
      break;
    }
  }

  return all;
}

function validFutures(list){

  return list.filter(
    x=>
      x.status==="Trading"&&
      String(
        x.quoteCoin||""
      ).toUpperCase()==="USDT"&&
      (
        x.contractType===
        "LinearPerpetual"||
        x.contractType===
        "InversePerpetual"
      )
  );
}

/* =========================================================
MANUAL SEARCH
========================================================= */

async function findSymbol(input){

  const raw=
    String(input||"")
      .trim()
      .toUpperCase();

  if(!raw){

    return{
      input:"",
      normalized:"",
      futures:null,
      spot:null,
      found:false
    };
  }

  const normalized=
    raw.replace(
      /[-_/:\s]/g,
      ""
    );

  let base=normalized;

  if(base.endsWith("USDT")){
    base=
      base.slice(
        0,
        -4
      );
  }

  const wanted=
    base+"USDT";

  const[
    linearList,
    spotList
  ]=await Promise.all([
    instruments("linear"),
    instruments("spot")
  ]);

  const futuresList=
    validFutures(
      linearList
    );

  const futures=
    futuresList.find(
      x=>{

        const symbol=
          String(
            x.symbol||""
          ).toUpperCase();

        const baseCoin=
          String(
            x.baseCoin||""
          ).toUpperCase();

        const quoteCoin=
          String(
            x.quoteCoin||""
          ).toUpperCase();

        return(
          symbol===normalized||
          symbol===wanted||
          (
            baseCoin===base&&
            quoteCoin==="USDT"
          )
        );
      }
    )||null;

  const spotCandidates=
    spotList.filter(
      x=>
        x.status==="Trading"&&
        String(
          x.quoteCoin||""
        ).toUpperCase()==="USDT"
    );

  const spot=
    spotCandidates.find(
      x=>{

        const symbol=
          String(
            x.symbol||""
          ).toUpperCase();

        const baseCoin=
          String(
            x.baseCoin||""
          ).toUpperCase();

        const quoteCoin=
          String(
            x.quoteCoin||""
          ).toUpperCase();

        return(
          symbol===normalized||
          symbol===wanted||
          (
            baseCoin===base&&
            quoteCoin==="USDT"
          )
        );
      }
    )||null;

  return{

    input:raw,

    normalized:base,

    futures:
      futures
        ?{
          symbol:futures.symbol,
          status:futures.status,
          baseCoin:futures.baseCoin,
          quoteCoin:futures.quoteCoin,
          contractType:futures.contractType,
          category:"linear"
        }
        :null,

    spot:
      spot
        ?{
          symbol:spot.symbol,
          status:spot.status,
          baseCoin:spot.baseCoin,
          quoteCoin:spot.quoteCoin,
          category:"spot"
        }
        :null,

    found:Boolean(
      futures||spot
    )
  };
}

/* =========================================================
ROTATING SCAN
========================================================= */

async function scan(
  offset=0,
  strictness=3
){

  const strict=
    getStrictConfig(
      strictness
    );

  const ms=
    validFutures(
      await instruments(
        "linear"
      )
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

    return{
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

      if(c.error)continue;

      let activity=0;

      if(c.touchMA20){
        activity+=20;
      }

      if(c.touchMA7){
        activity+=10;
      }

      if(c.volume.spike){
        activity+=20;
      }

      if(
        c.market.state==="ACTIVE"
      ){
        activity+=15;
      }

      if(c.hunt.confirmed){
        activity+=20;
      }

      if(c.bos!=="NONE"){
        activity+=10;
      }

      if(c.choch!=="NONE"){
        activity+=15;
      }

      if(c.maSlope!=="FLAT"){
        activity+=5;
      }

      light.push({
        symbol:m.symbol,
        activity,
        tf1:c
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
        .slice(
          0,
          DEEP_LIMIT
        )
        .map(
          x=>
            deepAnalyze(
              "linear",
              x.symbol,
              strict.level
            )
        )
    );

  deep.sort(
    (a,b)=>
      b.score-a.score
  );

  const next=
    (
      safeOffset+
      SCAN_BATCH
    )%list.length;

  return{

    ok:true,

    strictness:{
      level:strict.level,
      minScore:strict.minScore,
      minGap:strict.minGap,
      minEvidence:strict.minEvidence
    },

    totalMarkets:list.length,

    offset:safeOffset,

    batchSize:batch.length,

    nextOffset:next,

    results:deep,

    scannedSymbols:
      batch.map(
        x=>x.symbol
      ),

    note:
      "اسکن چرخشی بازار فعال است."
  };
}

/* =========================================================
RADAR
========================================================= */

async function radar(
  offset=0,
  strictness=3
){

  const strict=
    getStrictConfig(
      strictness
    );

  const ms=
    validFutures(
      await instruments(
        "linear"
      )
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

    return{
      ok:false,
      error:
        "بازار Futures پیدا نشد."
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

      if(c.length<30)continue;

      const price=
        c.at(-1).close;

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
          ?volume/avgVol
          :0;

      const h=hunt(c);

      const structure=
        detectStructure(c);

      const activity=
        Math.abs(change15)*4+
        Math.abs(change30)*2+
        Math.min(
          volumeRatio*10,
          30
        )+
        (h.confirmed?20:0)+
        (
          structure.choch!=="NONE"
            ?15
            :0
        );

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
        .slice(
          0,
          RADAR_LIMIT
        )
        .map(
          x=>
            deepAnalyze(
              "linear",
              x.symbol,
              strict.level
            )
        )
    );

  const pump=
    deep
      .filter(
        x=>x.pumpScore>=50
      )
      .sort(
        (a,b)=>
          b.pumpScore-
          a.pumpScore
      );

  const dump=
    deep
      .filter(
        x=>x.dumpScore>=50
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
      );

  return{

    ok:true,

    strictness:{
      level:strict.level,
      minScore:strict.minScore,
      minGap:strict.minGap,
      minEvidence:strict.minEvidence
    },

    totalMarkets:list.length,

    offset:safeOffset,

    nextOffset:
      (
        safeOffset+
        SCAN_BATCH
      )%list.length,

    scannedSymbols:
      batch.map(
        x=>x.symbol
      ),

    pump,
    dump,
    reversal,
    results:deep,

    note:
      "Radar بر اساس حرکت، حجم، ساختار، Hunt، MA، Order Book و جریان سفارش عمل می‌کند."
  };
}

/* =========================================================
ROUTER
========================================================= */

export default{

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

    if(
      request.method==="OPTIONS"
    ){

      return new Response(
        null,
        {
          headers:{
            "access-control-allow-origin":"*",
            "access-control-allow-methods":
              "GET,POST,OPTIONS",
            "access-control-allow-headers":"*"
          }
        }
      );
    }

    try{

      /* =====================================================
      SEARCH
      ===================================================== */

      if(p==="/api/search"){

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

        return json({
          ok:true,
          ...await findSymbol(q)
        });
      }

      /* =====================================================
      ANALYZE
      ===================================================== */

      if(p==="/api/analyze"){

        const symbol=
          u.searchParams.get(
            "symbol"
          );

        const category=
          (
            u.searchParams.get(
              "category"
            )||
            "linear"
          )==="spot"
            ?"spot"
            :"linear";

        /*
        تنظیم سخت‌گیری از HTML
        /api/analyze?symbol=BTCUSDT&category=linear&strictness=5
        */

        const strictness=
          getStrictness(
            u.searchParams.get(
              "strictness"
            )
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

        const chosen=
          category==="spot"
            ?found.spot
            :found.futures;

        if(!chosen){

          return json(
            {
              ok:false,

              error:
                `${category==="spot"?"Spot":"Futures"} برای ${symbol} در Bybit پیدا نشد.`,

              search:found
            },
            404
          );
        }

        return json({

          ok:true,

          ...await deepAnalyze(
            category,
            chosen.symbol,
            strictness
          ),

          search:found
        });
      }

      /* =====================================================
      SCAN
      ===================================================== */

      if(p==="/api/scan"){

        const offset=
          n(
            u.searchParams.get(
              "offset"
            ),
            0
          );

        const strictness=
          getStrictness(
            u.searchParams.get(
              "strictness"
            )
          );

        return json(
          await scan(
            offset,
            strictness
          )
        );
      }

      /* =====================================================
      RADAR
      ===================================================== */

      if(p==="/api/radar"){

        const offset=
          n(
            u.searchParams.get(
              "offset"
            ),
            0
          );

        const strictness=
          getStrictness(
            u.searchParams.get(
              "strictness"
            )
          );

        return json(
          await radar(
            offset,
            strictness
          )
        );
      }

      /* =====================================================
      HEALTH
      ===================================================== */

      if(p==="/api/health"){

        return json({

          ok:true,

          service:
            "Bybit Smart Money MA Radar",

          version:"V11",

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

          signalStrictness:{
            min:1,
            max:6,
            default:3,
            levels:STRICTNESS
          },

          convertedMA:
            CONVERTED_MAS,

          search:{
            futures:true,
            spot:true,
            pagination:true,

            formats:[
              "BTC",
              "BTCUSDT",
              "BTC/USDT",
              "BTC-USDT",
              "BTC USDT"
            ]
          },

          features:[

            "MA20 Signal Strictness",

            "MA Trigger",
            "Strict MA Confirmation",
            "MA Slope",
            "MA Touch Time",

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

            "Open Interest",
            "OI History",
            "Funding",

            "Footprint",
            "Buy Volume",
            "Sell Volume",
            "Delta",
            "Delta Percent",
            "Large Trade",

            "Pump Radar",
            "Dump Radar",
            "Reversal Radar",

            "SMC",
            "ICT",

            "Entry",
            "Stop Loss",
            "Take Profit",
            "Risk Reward"
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
