const BYBIT = "https://api.bybit.com";

const DEFAULT_STRICTNESS = 50;

const DEFAULT_METHODS = [
  "MA","MACD","RSI","ICHIMOKU","DIVERGENCE",
  "SMC","ICT","HUNT","FVG","BOS_CHOCH",
  "ORDER_BLOCK","VOLUME","FOOTPRINT","ORDERBOOK"
];

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
  {key:"1",label:"1 دقیقه",interval:"1"},
  {key:"3",label:"3 دقیقه",interval:"3"},
  {key:"5",label:"5 دقیقه",interval:"5"},
  {key:"15",label:"15 دقیقه",interval:"15"},
  {key:"60",label:"1 ساعت",interval:"60"},
  {key:"240",label:"4 ساعت",interval:"240"},
  {key:"D",label:"1 روز",interval:"D"}
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
  return !b?0:(a-b)/b*100;
}

function absPct(a,b){
  return !b?999:Math.abs((a-b)/b)*100;
}

async function bybit(path,params={}){
  const u=new URL(BYBIT+path);

  for(const [k,v] of Object.entries(params)){
    if(v!==undefined&&v!==null)
      u.searchParams.set(k,String(v));
  }

  const r=await fetch(u,{headers:{accept:"application/json"}});

  if(!r.ok)
    throw new Error(`Bybit HTTP ${r.status}`);

  const d=await r.json();

  if(d.retCode!==0)
    throw new Error(d.retMsg||`Bybit ${d.retCode}`);

  return d;
}

async function klines(category,symbol,interval,limit=100){
  const d=await bybit(
    "/v5/market/kline",
    {category,symbol,interval,limit}
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
  if(!a.length)return 0;
  return a.length<p?avg(a):avg(a.slice(-p));
}

function ema(a,p){
  if(!a.length)return 0;

  const k=2/(p+1);
  let x=a[0];

  for(let i=1;i<a.length;i++)
    x=a[i]*k+x*(1-k);

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

  const trs=[],plus=[],minus=[];

  for(let i=1;i<c.length;i++){
    const x=c[i],q=c[i-1];

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

    out.push(
      (diP+diM)
      ?100*Math.abs(diP-diM)/(diP+diM)
      :0
    );
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

  return m?(4*sd/m)*100:0;
}

function rangeState(c,ma7,ma20,slope,volSpike){
  if(!c.length)
    return {
      state:"UNKNOWN",
      adx:0,
      atr:0,
      atrPct:0,
      bollWidth:0,
      maGap:0
    };

  const price=c.at(-1).close;
  const a=atr(c);
  const atrPct=price?a/price*100:0;
  const adxV=adx(c);
  const bw=bollWidth(c);

  const maGap=ma20
    ?Math.abs(ma7-ma20)/ma20*100
    :0;

  const isRange=
    adxV<18 &&
    bw<1.8 &&
    Math.abs(slope)<0.0007;

  const waking=
    !isRange &&
    (adxV>=18||bw>=1.8||volSpike);

  return {
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

function swingLevels(c,lookback=3){
  const highs=[],lows=[];

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
      )high=false;

      if(
        c[i].low>=c[i-j].low ||
        c[i].low>c[i+j].low
      )low=false;
    }

    if(high)
      highs.push({
        price:c[i].high,
        time:c[i].time,
        index:i
      });

    if(low)
      lows.push({
        price:c[i].low,
        time:c[i].time,
        index:i
      });
  }

  return {highs,lows};
}

function hunt(c){
  if(c.length<25)
    return {
      type:"NONE",
      side:"NONE",
      confirmed:false
    };

  const x=c.at(-1);
  const prev=c.slice(-21,-1);

  const hi=Math.max(...prev.map(z=>z.high));
  const lo=Math.min(...prev.map(z=>z.low));

  const range=x.high-x.low||1;

  const lower=
    Math.min(x.open,x.close)-x.low;

  const upper=
    x.high-Math.max(x.open,x.close);

  const volAvg=sma(
    prev.map(z=>z.volume),
    20
  );

  const volumeConfirm=
    volAvg>0 &&
    x.volume>=volAvg*1.15;

  const longSweep=
    x.low<lo &&
    x.close>lo &&
    lower/range>=.25;

  const shortSweep=
    x.high>hi &&
    x.close<hi &&
    upper/range>=.25;

  if(longSweep)
    return {
      type:"LIQUIDITY_SWEEP",
      side:"LONG",
      level:lo,
      wickPct:lower/range*100,
      volumeConfirmed:volumeConfirm,
      confirmed:
        volumeConfirm ||
        lower/range>=.4
    };

  if(shortSweep)
    return {
      type:"LIQUIDITY_SWEEP",
      side:"SHORT",
      level:hi,
      wickPct:upper/range*100,
      volumeConfirmed:volumeConfirm,
      confirmed:
        volumeConfirm ||
        upper/range>=.4
    };

  return {
    type:"NONE",
    side:"NONE",
    confirmed:false
  };
}

function detectFVG(c){
  if(c.length<3)
    return {
      type:"NONE",
      low:null,
      high:null
    };

  const a=c.at(-3);
  const b=c.at(-2);
  const x=c.at(-1);

  if(x.low>a.high)
    return {
      type:"BULLISH",
      low:a.high,
      high:x.low,
      size:x.low-a.high,
      candle:b.time
    };

  if(x.high<a.low)
    return {
      type:"BEARISH",
      low:x.high,
      high:a.low,
      size:a.low-x.high,
      candle:b.time
    };

  return {
    type:"NONE",
    low:null,
    high:null
  };
}

function detectStructure(c){
  if(c.length<15)
    return {
      bos:"NONE",
      choch:"NONE",
      swingHigh:null,
      swingLow:null
    };

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

  if(lastHigh&&price>lastHigh)
    bos="BULLISH";

  if(lastLow&&price<lastLow)
    bos="BEARISH";

  if(
    prevHigh &&
    prevLow &&
    lastLow &&
    lastHigh &&
    lastLow>prevLow &&
    lastHigh>prevHigh &&
    price<lastLow
  )
    choch="BEARISH";

  if(
    prevHigh &&
    prevLow &&
    lastLow &&
    lastHigh &&
    lastLow<prevLow &&
    lastHigh<prevHigh &&
    price>lastHigh
  )
    choch="BULLISH";

  return {
    bos,
    choch,
    swingHigh:lastHigh,
    swingLow:lastLow,
    previousSwingHigh:prevHigh,
    previousSwingLow:prevLow
  };
}

function detectOrderBlock(c){
  if(c.length<8)
    return {type:"NONE"};

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
    )
      return {
        type:"BULLISH",
        low:z.low,
        high:z.high,
        time:z.time
      };

    if(
      z.close>z.open &&
      x.close<z.low
    )
      return {
        type:"BEARISH",
        low:z.low,
        high:z.high,
        time:z.time
      };
  }

  return {type:"NONE"};
}

function candleAnalysis(c){
  if(c.length<3)
    return {
      type:"NONE",
      bullish:false,
      bearish:false
    };

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
  )
    type="HAMMER";

  if(
    upper>body*2 &&
    upper/range>.45
  )
    type="SHOOTING_STAR";

  if(
    x.close>p.open &&
    x.open<p.close &&
    x.close>=p.close &&
    x.open<=p.open
  )
    type="BULLISH_ENGULFING";

  if(
    x.close<p.open &&
    x.open>p.close &&
    x.close<=p.close &&
    x.open>=p.open
  )
    type="BEARISH_ENGULFING";

  if(bodyRatio<.15)
    type="DOJI";

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

function rsi(c,p=14){
  if(c.length<p+2)return 50;

  let gain=0;
  let loss=0;

  for(
    let i=c.length-p;
    i<c.length;
    i++
  ){
    const d=c[i].close-c[i-1].close;

    if(d>=0)gain+=d;
    else loss-=d;
  }

  if(loss===0)return 100;

  const rs=
    (gain/p)/(loss/p);

  return 100-(100/(1+rs));
}

function macd(c){
  const closes=c.map(x=>x.close);

  if(closes.length<35)
    return {
      macd:0,
      signal:0,
      hist:0,
      direction:"NONE"
    };

  const fast=ema(closes,12);
  const slow=ema(closes,26);
  const m=fast-slow;

  const signal=ema(
    closes.slice(-9).map((_,i)=>{
      const end=closes.length-9+i+1;
      const arr=closes.slice(0,end);
      return ema(arr,12)-ema(arr,26);
    }),
    9
  );

  const hist=m-signal;

  return {
    macd:m,
    signal,
    hist,
    direction:
      hist>0
      ?"LONG"
      :hist<0
      ?"SHORT"
      :"NONE"
  };
}

function ichimoku(c){
  if(c.length<52)
    return {
      direction:"NONE"
    };

  const h=(p)=>Math.max(
    ...c.slice(-p).map(x=>x.high)
  );

  const l=(p)=>Math.min(
    ...c.slice(-p).map(x=>x.low)
  );

  const tenkan=(h(9)+l(9))/2;
  const kijun=(h(26)+l(26))/2;

  const senkouA=(tenkan+kijun)/2;

  const senkouB=(h(52)+l(52))/2;

  const price=c.at(-1).close;

  return {
    tenkan,
    kijun,
    senkouA,
    senkouB,
    price,
    direction:
      price>Math.max(senkouA,senkouB)&&
      tenkan>kijun
      ?"LONG"
      :price<Math.min(senkouA,senkouB)&&
       tenkan<kijun
      ?"SHORT"
      :"NONE"
  };
}

function divergence(c){
  if(c.length<40)
    return {
      type:"NONE",
      side:"NONE"
    };

  const price=c.at(-1).close;
  const r=rsi(c);

  const old=c.slice(-20,-5);

  const oldPrice=
    old.length?old.at(-1).close:price;

  const oldR=
    rsi(c.slice(0,-15));

  if(
    price<oldPrice &&
    r>oldR+3
  )
    return {
      type:"BULLISH_DIVERGENCE",
      side:"LONG"
    };

  if(
    price>oldPrice &&
    r<oldR-3
  )
    return {
      type:"BEARISH_DIVERGENCE",
      side:"SHORT"
    };

  return {
    type:"NONE",
    side:"NONE"
  };
}

function extraSignals(c){
  const m=macd(c);
  const rs=rsi(c);
  const ic=ichimoku(c);
  const dv=divergence(c);

  return {
    MACD:m,
    RSI:{
      value:rs,
      direction:
        rs>55
        ?"LONG"
        :rs<45
        ?"SHORT"
        :"NONE"
    },
    ICHIMOKU:ic,
    DIVERGENCE:dv
  };
}

function analyzeCandles(c){
  if(c.length<25)
    return {
      error:"کندل کافی نیست"
    };

  const close=c.map(x=>x.close);
  const vol=c.map(x=>x.volume);

  const price=close.at(-1);

  const ma7=sma(close,7);
  const ma20=sma(close,20);

  const prev20=
    sma(close.slice(0,-1),20);

  const slope=
    prev20
    ?(ma20-prev20)/prev20
    :0;

  const prevPrice=close.at(-2);

  const high=c.at(-1).high;
  const low=c.at(-1).low;

  const touch20=
    Math.abs(price-ma20)/ma20<=.0015 ||
    low<=ma20&&high>=ma20 ||
    (prevPrice-ma20)*(price-ma20)<=0;

  const touch7=
    Math.abs(price-ma7)/ma7<=.0015 ||
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
    ?"BULLISH"
    :price<ma20&&ma7<ma20
    ?"BEARISH"
    :"RANGE";

  return {
    price,
    ma7,
    ma20,

    maSlope:
      slope>.00007
      ?"UP"
      :slope<-.00007
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

    market,

    hunt:hunt(c),

    candle:candleAnalysis(c).type,

    candleDetails:candleAnalysis(c),

    fvg:detectFVG(c),

    ...detectStructure(c),

    orderBlock:detectOrderBlock(c),

    timestamp:c.at(-1).time
  };
}

function maValueSeries(c,p,type="SMA"){
  const out=[];

  for(let i=0;i<c.length;i++){
    const a=c
      .slice(
        Math.max(0,i-p+1),
        i+1
      )
      .map(x=>x.close);

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

    let confirmation="NONE";

    if(
      prevDist<0 &&
      dist>=0 &&
      lower/range>.25
    )
      confirmation="LONG";

    if(
      prevDist>0 &&
      dist<=0 &&
      upper/range>.25
    )
      confirmation="SHORT";

    events.push({
      source:m.source,
      ma:m.ma,
      period:m.period,
      value:ma,
      slopePct,
      confirmation
    });
  }

  const confirmed=
    events.filter(
      x=>x.confirmation!=="NONE"
    );

  return {
    events,
    recent:events.slice(-10),
    confirmed,
    latest:events.at(-1)||null
  };
}

/* FOOTPRINT */

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
      const no=q*p;

      largest=Math.max(
        largest,
        no
      );

      if(
        String(x.side)
          .toLowerCase()==="buy"
      ){
        buy+=q;
        buyNotional+=no;
      }else{
        sell+=q;
        sellNotional+=no;
      }
    }

    const total=buy+sell;
    const delta=buy-sell;

    const totalNotional=
      buyNotional+sellNotional;

    return {
      buyVolume:buy,
      sellVolume:sell,
      delta,

      deltaPercent:
        total
        ?delta/total*100
        :0,

      buyNotional,
      sellNotional,

      buyNotionalShare:
        totalNotional
        ?buyNotional/totalNotional*100
        :0,

      sellNotionalShare:
        totalNotional
        ?sellNotional/totalNotional*100
        :0,

      trades:t.length,

      largeTradeNotional:largest,

      pressure:
        Math.abs(
          delta/Math.max(total,1)
        )*100>=8
        ?delta>0
          ?"BUY"
          :"SELL"
        :"NEUTRAL"
    };

  }catch(e){
    return {
      error:e.message
    };
  }
}

/* ORDER BOOK */

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
      const distance=absPct(
        p,
        price
      );

      if(distance<=3)
        buyLevels.push({
          price:p,
          size:sz,
          notional,
          distancePct:distance
        });
    }

    for(const q of asks){
      const p=n(q[0]);
      const sz=n(q[1]);

      if(p<=0||sz<=0)continue;

      const notional=p*sz;
      const distance=absPct(
        p,
        price
      );

      if(distance<=3)
        sellLevels.push({
          price:p,
          size:sz,
          notional,
          distancePct:distance
        });
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
        ?buyLiquidity/totalLiquidity*100
        :0,

      sellShare:
        totalLiquidity
        ?sellLiquidity/totalLiquidity*100
        :0,

      buyStrength,
      sellStrength,

      buyNear:
        !!buyWall &&
        buyWall.distancePct<=1,

      sellNear:
        !!sellWall &&
        sellWall.distancePct<=1,

      note:
        "Order Book نقدینگی لحظه‌ای است."
    };

  }catch(e){
    return {
      error:e.message
    };
  }
}

function supportResistance(c,wall,price){
  const s=swingLevels(c,3);

  const supports=[];
  const resistances=[];

  for(const x of s.lows)
    if(x.price<price)
      supports.push({
        price:x.price,
        type:"SWING_SUPPORT",
        distancePct:
          absPct(x.price,price)
      });

  for(const x of s.highs)
    if(x.price>price)
      resistances.push({
        price:x.price,
        type:"SWING_RESISTANCE",
        distancePct:
          absPct(x.price,price)
      });

  for(const x of wall?.buyLevels||[])
    if(x.price<price)
      supports.push({
        price:x.price,
        type:"BUY_WALL",
        liquidity:x.notional,
        distancePct:x.distancePct
      });

  for(const x of wall?.sellLevels||[])
    if(x.price>price)
      resistances.push({
        price:x.price,
        type:"SELL_WALL",
        liquidity:x.notional,
        distancePct:x.distancePct
      });

  supports.sort(
    (a,b)=>a.distancePct-b.distancePct
  );

  resistances.sort(
    (a,b)=>a.distancePct-b.distancePct
  );

  const liquid=a=>
    a
      .filter(x=>x.liquidity)
      .sort(
        (x,y)=>
          (y.liquidity||0)-
          (x.liquidity||0)
      )[0];

  return {
    nearestSupport:
      supports[0]||null,

    nearestResistance:
      resistances[0]||null,

    strongestSupport:
      liquid(supports)||
      supports[0]||
      null,

    strongestResistance:
      liquid(resistances)||
      resistances[0]||
      null,

    supports:
      supports.slice(0,10),

    resistances:
      resistances.slice(0,10)
  };
}

/* TICKER / OI / FUNDING / BID ASK */

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

async function oiFunding(symbol,category="linear"){
  try{
    const t=
      await ticker(
        category,
        symbol
      );

    let oiHistory=[];
    let fundHistory=[];

    if(category==="linear"){
      try{
        const oi=
          await bybit(
            "/v5/market/open-interest",
            {
              category:"linear",
              symbol,
              intervalTime:"5min",
              limit:2
            }
          );

        oiHistory=
          oi?.result?.list||[];
      }catch(_){}

      try{
        const fr=
          await bybit(
            "/v5/market/funding/history",
            {
              category:"linear",
              symbol,
              limit:2
            }
          );

        fundHistory=
          fr?.result?.list||[];
      }catch(_){}
    }

    const oiNow=
      n(t.openInterest);

    const bidPrice=
      n(t.bid1Price);

    const askPrice=
      n(t.ask1Price);

    const bidSize=
      n(t.bid1Size);

    const askSize=
      n(t.ask1Size);

    const oiPrev=
      oiHistory.length>1
      ?n(
        oiHistory[
          oiHistory.length-2
        ].openInterest
      )
      :oiHistory.length===1
      ?n(
        oiHistory[0].openInterest
      )
      :0;

    const fundingNow=
      n(t.fundingRate);

    const fundingPrev=
      fundHistory.length>1
      ?n(
        fundHistory[
          fundHistory.length-2
        ].fundingRate
      )
      :fundHistory.length===1
      ?n(
        fundHistory[0].fundingRate
      )
      :0;

    return {
      openInterest:
        category==="linear"
        ?oiNow
        :null,

      openInterestPrevious:
        oiPrev||null,

      openInterestChange:
        oiPrev
        ?pct(oiNow,oiPrev)
        :null,

      fundingRate:
        category==="linear"
        ?fundingNow
        :null,

      fundingRatePrevious:
        fundingPrev||null,

      fundingRateChange:
        fundingPrev!==0
        ?pct(
          fundingNow,
          fundingPrev
        )
        :null,

      turnover24h:
        n(t.turnover24h),

      change24h:
        n(t.price24hPcnt)*100,

      markPrice:
        n(t.markPrice),

      indexPrice:
        n(t.indexPrice),

      bidPrice,
      askPrice,
      bidSize,
      askSize,

      spread:
        bidPrice&&askPrice
        ?askPrice-bidPrice
        :null,

      spreadPct:
        bidPrice&&askPrice
        ?(askPrice-bidPrice)/
          bidPrice*100
        :null,

      historyAvailable:
        !!(
          oiPrev||
          fundHistory.length
        )
    };

  }catch(e){
    return {
      error:e.message
    };
  }
}

/* SIGNAL */

function normalizeMethods(methods){
  if(
    !Array.isArray(methods)||
    !methods.length
  )
    return DEFAULT_METHODS.slice();

  return [
    ...new Set(
      methods
        .map(x=>String(x).toUpperCase())
        .filter(
          x=>DEFAULT_METHODS.includes(x)
        )
    )
  ];
}

function requiredConfirmations(
  strictness,
  methods
){
  const s=clamp(
    n(
      strictness,
      DEFAULT_STRICTNESS
    ),
    0,
    100
  );

  const count=methods.length;

  if(!count)return 0;

  if(s<25)return 1;

  if(s<50)
    return Math.min(2,count);

  if(s<75)
    return Math.min(3,count);

  return Math.min(4,count);
}

function collectSignalEvidence(
  tf,
  converted,
  extra,
  fp,
  wall,
  methods
){
  const x=
    tf?.["1"]||
    tf?.["3"]||
    tf?.["5"]||
    tf?.["15"]||
    tf?.["60"]||
    tf?.["240"]||
    tf?.["D"];

  const ev=[];

  const add=(
    method,
    side,
    score,
    text
  )=>{
    if(methods.includes(method))
      ev.push({
        method,
        side,
        score,
        text
      });
  };

  if(x){
    if(
      x.touchMA20 &&
      x.maSlope==="UP" &&
      x.trend==="BULLISH"
    )
      add(
        "MA",
        "LONG",
        15,
        "MA20 صعودی"
      );

    if(
      x.touchMA20 &&
      x.maSlope==="DOWN" &&
      x.trend==="BEARISH"
    )
      add(
        "MA",
        "SHORT",
        15,
        "MA20 نزولی"
      );

    if(
      x.touchMA7 &&
      x.maSlope==="UP" &&
      x.trend==="BULLISH"
    )
      add(
        "MA",
        "LONG",
        10,
        "MA7 صعودی"
      );

    if(
      x.touchMA7 &&
      x.maSlope==="DOWN" &&
      x.trend==="BEARISH"
    )
      add(
        "MA",
        "SHORT",
        10,
        "MA7 نزولی"
      );

    if(x.hunt?.confirmed)
      add(
        "HUNT",
        x.hunt.side,
        18,
        "Liquidity Sweep تأییدشده"
      );

    if(x.fvg?.type==="BULLISH")
      add(
        "FVG",
        "LONG",
        10,
        "FVG صعودی"
      );

    if(x.fvg?.type==="BEARISH")
      add(
        "FVG",
        "SHORT",
        10,
        "FVG نزولی"
      );

    if(x.bos==="BULLISH")
      add(
        "BOS_CHOCH",
        "LONG",
        15,
        "BOS صعودی"
      );

    if(x.bos==="BEARISH")
      add(
        "BOS_CHOCH",
        "SHORT",
        15,
        "BOS نزولی"
      );

    if(x.choch==="BULLISH")
      add(
        "BOS_CHOCH",
        "LONG",
        18,
        "CHoCH صعودی"
      );

    if(x.choch==="BEARISH")
      add(
        "BOS_CHOCH",
        "SHORT",
        18,
        "CHoCH نزولی"
      );

    if(
      x.orderBlock?.type==="BULLISH"
    )
      add(
        "ORDER_BLOCK",
        "LONG",
        10,
        "Order Block صعودی"
      );

    if(
      x.orderBlock?.type==="BEARISH"
    )
      add(
        "ORDER_BLOCK",
        "SHORT",
        10,
        "Order Block نزولی"
      );

    if(
      x.volume?.spike &&
      x.trend==="BULLISH"
    )
      add(
        "VOLUME",
        "LONG",
        10,
        "Volume Spike صعودی"
      );

    if(
      x.volume?.spike &&
      x.trend==="BEARISH"
    )
      add(
        "VOLUME",
        "SHORT",
        10,
        "Volume Spike نزولی"
      );
  }

  if(converted?.confirmed?.length){
    const e=
      converted.confirmed.at(-1);

    add(
      "MA",
      e.confirmation==="LONG"
      ?"LONG"
      :"SHORT",
      20,
      `${e.ma} ${e.source} Trigger`
    );
  }

  if(
    extra?.MACD?.direction!=="NONE"
  )
    add(
      "MACD",
      extra.MACD.direction,
      15,
      "MACD"
    );

  if(
    extra?.RSI?.direction!=="NONE"
  )
    add(
      "RSI",
      extra.RSI.direction,
      10,
      `RSI ${extra.RSI.value.toFixed(1)}`
    );

  if(
    extra?.ICHIMOKU?.direction!=="NONE"
  )
    add(
      "ICHIMOKU",
      extra.ICHIMOKU.direction,
      15,
      "Ichimoku"
    );

  if(
    extra?.DIVERGENCE?.side!=="NONE"
  )
    add(
      "DIVERGENCE",
      extra.DIVERGENCE.side,
      20,
      extra.DIVERGENCE.type
    );

  if(
    fp &&
    !fp.error &&
    Math.abs(fp.deltaPercent)>=8
  )
    add(
      "FOOTPRINT",
      fp.delta>0?"LONG":"SHORT",
      18,
      `Delta ${fp.deltaPercent.toFixed(1)}%`
    );

  if(
    wall &&
    !wall.error
  ){
    if(
      wall.buyNear &&
      wall.buyStrength>=60
    )
      add(
        "ORDERBOOK",
        "LONG",
        12,
        "Buy Wall"
      );

    if(
      wall.sellNear &&
      wall.sellStrength>=60
    )
      add(
        "ORDERBOOK",
        "SHORT",
        12,
        "Sell Wall"
      );
  }

  if(
    x &&
    x.bos==="BULLISH"
  )
    add(
      "SMC",
      "LONG",
      12,
      "SMC BOS"
    );

  if(
    x &&
    x.bos==="BEARISH"
  )
    add(
      "SMC",
      "SHORT",
      12,
      "SMC BOS"
    );

  if(
    x &&
    x.fvg?.type==="BULLISH"
  )
    add(
      "ICT",
      "LONG",
      8,
      "ICT FVG"
    );

  if(
    x &&
    x.fvg?.type==="BEARISH"
  )
    add(
      "ICT",
      "SHORT",
      8,
      "ICT FVG"
    );

  return ev;
}

function signalScore(
  tf,
  converted,
  extra,
  fp,
  wall,
  strictness,
  methods
){
  methods=normalizeMethods(methods);

  const ev=
    collectSignalEvidence(
      tf,
      converted,
      extra,
      fp,
      wall,
      methods
    );

  let L=50;
  let S=50;

  for(const e of ev){
    if(e.side==="LONG")
      L+=e.score;

    if(e.side==="SHORT")
      S+=e.score;
  }

  const threshold=
    55+
    clamp(
      n(strictness,50)*.4,
      0,
      40
    );

  const long=
    ev.filter(
      x=>x.side==="LONG"
    );

  const short=
    ev.filter(
      x=>x.side==="SHORT"
    );

  const lc=
    new Set(
      long.map(x=>x.method)
    ).size;

  const sc=
    new Set(
      short.map(x=>x.method)
    ).size;

  const need=
    requiredConfirmations(
      strictness,
      methods
    );

  const longOK=
    L>=threshold &&
    lc>=need;

  const shortOK=
    S>=threshold &&
    sc>=need;

  const direction=
    longOK&&L>S
    ?"LONG"
    :shortOK&&S>L
    ?"SHORT"
    :"WAIT";

  const final=
    Math.round(
      clamp(
        Math.max(L,S),
        0,
        100
      )
    );

  return {
    longScore:
      Math.round(
        clamp(L,0,100)
      ),

    shortScore:
      Math.round(
        clamp(S,0,100)
      ),

    direction,

    score:final,

    threshold,

    requiredMethods:need,

    confirmedMethods:
      direction==="LONG"
      ?[...new Set(
        long.map(x=>x.method)
      )]
      :direction==="SHORT"
      ?[...new Set(
        short.map(x=>x.method)
      )]
      :[],

    evidence:ev,

    selectedMethods:methods,

    strictness
  };
}

/* STYLES */

function directionFromParts(parts){
  const score=
    parts.reduce(
      (a,x)=>a+x.score,
      0
    );

  const max=
    parts.length*100||1;

  const pctScore=
    score/max*100;

  const long=
    parts.filter(
      x=>x.side==="LONG"
    ).length;

  const short=
    parts.filter(
      x=>x.side==="SHORT"
    ).length;

  return {
    direction:
      long>short
      ?"BULLISH"
      :short>long
      ?"BEARISH"
      :"RANGE",

    score:
      Math.round(pctScore)
  };
}

function styleSnapshot(
  c,
  base,
  extra,
  fp,
  wall,
  sr
){
  const side=d=>
    d==="LONG"
    ?"BULLISH"
    :d==="SHORT"
    ?"BEARISH"
    :"RANGE";

  const items=[];

  const add=(
    name,
    dir,
    score,
    details
  )=>{
    items.push({
      name,
      direction:side(dir),
      score:
        Math.round(
          clamp(score,0,100)
        ),
      details
    });
  };

  const maDir=
    base.trend==="BULLISH"
    ?"LONG"
    :base.trend==="BEARISH"
    ?"SHORT"
    :"NONE";

  add(
    "MA",
    maDir,
    base.trend==="RANGE"
      ?50
      :75,
    {
      ma7:base.ma7,
      ma20:base.ma20,
      slope:base.maSlope
    }
  );

  add(
    "MACD",
    extra.MACD?.direction,
    extra.MACD?.direction==="NONE"
      ?50
      :72,
    extra.MACD
  );

  add(
    "RSI",
    extra.RSI?.direction,
    extra.RSI?.direction==="NONE"
      ?50
      :68,
    extra.RSI
  );

  add(
    "ICHIMOKU",
    extra.ICHIMOKU?.direction,
    extra.ICHIMOKU?.direction==="NONE"
      ?50
      :74,
    extra.ICHIMOKU
  );

  add(
    "DIVERGENCE",
    extra.DIVERGENCE?.side,
    extra.DIVERGENCE?.side==="NONE"
      ?50
      :80,
    extra.DIVERGENCE
  );

  const smcDir=
    base.choch==="BULLISH"||
    base.bos==="BULLISH"
    ?"LONG"
    :base.choch==="BEARISH"||
     base.bos==="BEARISH"
    ?"SHORT"
    :"NONE";

  add(
    "SMC",
    smcDir,
    smcDir==="NONE"
      ?50
      :82,
    {
      BOS:base.bos,
      CHoCH:base.choch,
      orderBlock:base.orderBlock
    }
  );

  const ictDir=
    base.fvg?.type==="BULLISH"
    ?"LONG"
    :base.fvg?.type==="BEARISH"
    ?"SHORT"
    :base.hunt?.side==="SHORT"
    ?"LONG"
    :base.hunt?.side==="LONG"
    ?"SHORT"
    :"NONE";

  add(
    "ICT",
    ictDir,
    ictDir==="NONE"
      ?50
      :78,
    {
      FVG:base.fvg,
      Hunt:base.hunt
    }
  );

  const huntDir=
    base.hunt?.side==="SHORT"
    ?"LONG"
    :base.hunt?.side==="LONG"
    ?"SHORT"
    :"NONE";

  add(
    "HUNT",
    huntDir,
    base.hunt?.confirmed
      ?84
      :50,
    base.hunt
  );

  add(
    "FVG",
    base.fvg?.type==="BULLISH"
      ?"LONG"
      :base.fvg?.type==="BEARISH"
      ?"SHORT"
      :"NONE",
    base.fvg?.type==="NONE"
      ?50
      :75,
    base.fvg
  );

  add(
    "BOS_CHOCH",
    smcDir,
    smcDir==="NONE"
      ?50
      :80,
    {
      BOS:base.bos,
      CHoCH:base.choch
    }
  );

  const obDir=
    base.orderBlock?.type==="BULLISH"
    ?"LONG"
    :base.orderBlock?.type==="BEARISH"
    ?"SHORT"
    :"NONE";

  add(
    "ORDER_BLOCK",
    obDir,
    obDir==="NONE"
      ?50
      :74,
    base.orderBlock
  );

  add(
    "VOLUME",
    base.volume?.spike
      ?base.candleDetails?.bullish
        ?"LONG"
        :"SHORT"
      :"NONE",
    base.volume?.spike
      ?76
      :50,
    base.volume
  );

  const flowDir=
    fp?.pressure==="BUY"
    ?"LONG"
    :fp?.pressure==="SELL"
    ?"SHORT"
    :"NONE";

  add(
    "FOOTPRINT",
    flowDir,
    fp?.pressure==="NEUTRAL"
      ?50
      :82,
    fp
  );

  const bookDir=
    (wall?.buyStrength||0)>
    (wall?.sellStrength||0)+5
    ?"LONG"
    :(wall?.sellStrength||0)>
     (wall?.buyStrength||0)+5
    ?"SHORT"
    :"NONE";

  add(
    "ORDERBOOK",
    bookDir,
    bookDir==="NONE"
      ?50
      :78,
    {
      buyStrength:wall?.buyStrength,
      sellStrength:wall?.sellStrength,
      buy:wall?.buy,
      sell:wall?.sell
    }
  );

  const overall=
    directionFromParts(
      items.map(x=>({
        side:
          x.direction==="BULLISH"
          ?"LONG"
          :x.direction==="BEARISH"
          ?"SHORT"
          :"NONE",
        score:x.score
      }))
    );

  return {
    overall,
    items
  };
}

async function footprintForWindow(
  category,
  symbol,
  windowMinutes
){
  try{
    const d=
      await bybit(
        "/v5/market/recent-trade",
        {
          category,
          symbol,
          limit:1000
        }
      );

    const all=
      d?.result?.list||[];

    const now=Date.now();

    const cutoff=
      now-
      windowMinutes*
      60*
      1000;

    const t=
      all.filter(
        x=>
          !x.time||
          n(x.time)>=cutoff
      );

    let buy=0;
    let sell=0;

    let buyNotional=0;
    let sellNotional=0;

    let largest=0;

    for(const x of t){
      const q=n(x.size);
      const pr=n(x.price);
      const no=q*pr;

      largest=
        Math.max(
          largest,
          no
        );

      if(
        String(x.side)
          .toLowerCase()==="buy"
      ){
        buy+=q;
        buyNotional+=no;
      }else{
        sell+=q;
        sellNotional+=no;
      }
    }

    const total=buy+sell;

    const delta=buy-sell;

    const totalNotional=
      buyNotional+sellNotional;

    return {
      windowMinutes,
      availableTrades:t.length,

      buyVolume:buy,
      sellVolume:sell,

      delta,

      deltaPercent:
        total
        ?delta/total*100
        :0,

      buyNotional,
      sellNotional,

      buyNotionalShare:
        totalNotional
        ?buyNotional/
          totalNotional*100
        :0,

      sellNotionalShare:
        totalNotional
        ?sellNotional/
          totalNotional*100
        :0,

      largeTradeNotional:largest,

      pressure:
        Math.abs(
          delta/
          Math.max(total,1)
        )*100>=8
        ?delta>0
          ?"BUY"
          :"SELL"
        :"NEUTRAL",

      note:
        "Footprint بر اساس معاملات واقعی اخیر Bybit است."
    };

  }catch(e){
    return {
      error:e.message,
      windowMinutes
    };
  }
}

function timeframeMinutes(key){
  return key==="1"
    ?1
    :key==="3"
    ?3
    :key==="5"
    ?5
    :key==="15"
    ?15
    :key==="60"
    ?60
    :key==="240"
    ?240
    :1440;
}

/* DEEP ANALYSIS */

async function deepAnalyze(
  category,
  symbol,
  settings={},
  mode="commercial"
){
  const activeTF=
    mode==="personal"
    ?TF.filter(
      x=>
        x.key==="1"||
        x.key==="15"
    )
    :TF.filter(
      x=>x.key!=="1"
    );

  const tf={};
  const raw={};

  for(const x of activeTF){
    try{
      const limit=
        x.key==="1"
        ?1000
        :120;

      raw[x.key]=
        await klines(
          category,
          symbol,
          x.interval,
          limit
        );

      tf[x.key]=
        analyzeCandles(
          raw[x.key].slice(-200)
        );

      tf[x.key].extra=
        extraSignals(
          raw[x.key].slice(-200)
        );

    }catch(e){
      tf[x.key]={
        error:e.message
      };
    }
  }

  const oneMinute=
    raw["1"]||[];

  const converted=
    oneMinute.length
    ?convertedMAEvents(oneMinute)
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
    valid[0]?.price||0;

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

  const sr=
    supportResistance(
      oneMinute.length
      ?oneMinute
      :raw["15"]||[],
      wall,
      price
    );

  const market=
    await oiFunding(
      symbol,
      category
    );

  const perTf={};

  for(const x of activeTF){
    if(tf[x.key]?.error)
      continue;

    const c=
      raw[x.key]||[];

    const fpw=
      await footprintForWindow(
        category,
        symbol,
        timeframeMinutes(x.key)
      );

    const w=
      await walls(
        category,
        symbol,
        tf[x.key].price||price
      );

    const s=
      supportResistance(
        c,
        w,
        tf[x.key].price||price
      );

    perTf[x.key]={
      label:x.label,
      analysis:tf[x.key],
      indicators:tf[x.key].extra,
      footprint:fpw,
      orderBook:w,
      supportResistance:s,

      style:
        styleSnapshot(
          c,
          tf[x.key],
          tf[x.key].extra,
          fpw,
          w,
          s
        )
    };
  }

  const signal=
    signalScore(
      tf,
      converted,
      extraSignals(
        oneMinute.length
        ?oneMinute
        :(
          raw["15"]||
          raw["3"]||
          []
        )
      ),
      fp,
      wall,
      settings.strictness,
      settings.methods
    );

  const styles=
    Object.fromEntries(
      Object.entries(perTf)
        .map(
          ([k,v])=>
            [k,v.style]
        )
    );

  return {
    symbol,
    category,
    price,

    direction:
      signal.direction,

    marketState:
      signal.direction==="WAIT"
      ?"RANGE"
      :signal.direction==="LONG"
      ?"BULLISH"
      :"BEARISH",

    score:
      signal.score,

    longScore:
      signal.longScore,

    shortScore:
      signal.shortScore,

    signalLevel:
      signal.direction!=="WAIT"
      ?signal.score>=85
        ?"VERY_STRONG"
        :signal.score>=75
        ?"CONFIRMED"
        :"WATCH"
      :signal.score>=60
        ?"WATCH"
        :"NONE",

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

    timeframes:tf,

    deepByTimeframe:
      perTf,

    convertedMA1m:
      converted,

    footprint:fp,

    walls:wall,

    supportResistance:sr,

    market,

    styles,

    generatedAt:
      Date.now(),

    liquidation:{
      available:false,
      message:
        "داده تجمیعی لیکوئیدیشن از REST عمومی Bybit برای این تحلیل در دسترس نیست و عدد ساختگی نمایش داده نمی‌شود."
    }
  };
}

/* INSTRUMENTS */

async function instruments(category){
  const all=[];
  let cursor="";

  for(let page=0;page<5;page++){
    const d=
      await bybit(
        "/v5/market/instruments-info",
        {
          category,
          limit:1000,
          ...(cursor
            ?{cursor}
            :{})
        }
      );

    all.push(
      ...(d?.result?.list||[])
    );

    cursor=
      d?.result?.nextPageCursor||"";

    if(!cursor)
      break;
  }

  return all;
}

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
      ?"FUTURES"
      :s
      ?"SPOT"
      :null,

    futures:
      l
      ?{
        symbol:l.symbol,
        status:l.status,
        baseCoin:l.baseCoin,
        quoteCoin:l.quoteCoin
      }
      :null,

    spot:
      s
      ?{
        symbol:s.symbol,
        status:s.status,
        baseCoin:s.baseCoin,
        quoteCoin:s.quoteCoin
      }
      :null
  };
}

/* SETTINGS */

function parseSettings(params){
  const strictness=
    clamp(
      n(
        params.get("strictness"),
        DEFAULT_STRICTNESS
      ),
      0,
      100
    );

  let methods=
    DEFAULT_METHODS.slice();

  const raw=
    params.get("methods");

  if(raw){
    try{
      methods=
        normalizeMethods(
          JSON.parse(raw)
        );
    }catch{
      methods=
        normalizeMethods(
          raw
            .split(",")
            .map(x=>x.trim())
        );
    }
  }

  return {
    strictness,
    methods
  };
}

/* ROUTER */

export default {
  async fetch(request,env){
    const u=
      new URL(request.url);

    const p=u.pathname;

    try{
      const settings=
        parseSettings(
          u.searchParams
        );

      if(p==="/api/search"){
        const q=
          u.searchParams.get(
            "symbol"
          );

        if(!q)
          return json({
            ok:false,
            error:"نماد وارد نشده است."
          },400);

        const found=
          await findSymbol(q);

        return json({
          ok:true,
          ...found
        });
      }

      if(p==="/api/analyze"){
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

        const mode=
          (
            u.searchParams.get(
              "mode"
            )||"commercial"
          ).toLowerCase();

        if(!symbol)
          return json({
            ok:false,
            error:"نماد وارد نشده است."
          },400);

        const found=
          await findSymbol(symbol);

        const chosen=
          category==="spot"
          ?found.spot
          :category==="linear"
          ?found.futures
          :(found.futures||found.spot);

        if(!chosen)
          return json({
            ok:false,
            error:
              `${symbol} در Spot یا Futures Bybit پیدا نشد.`,
            search:found
          },404);

        const chosenCategory=
          chosen===found.futures
          ?"linear"
          :"spot";

        return json({
          ok:true,

          ...await deepAnalyze(
            chosenCategory,
            chosen.symbol,
            settings,
            mode==="personal"
            ?"personal"
            :"commercial"
          ),

          search:found
        });
      }

      if(p==="/api/health"){
        return json({
          ok:true,
          service:"Bybit Deep Analyzer",
          version:"V11-DUAL-PAGE-NO-RADAR",

          timeframesPersonal:[
            "1",
            "15"
          ],

          timeframesCommercial:[
            "3",
            "5",
            "15",
            "60",
            "240",
            "D"
          ],

          features:
            DEFAULT_METHODS
        });
      }

      return env.ASSETS.fetch(
        request
      );

    }catch(e){
      return json({
        ok:false,
        error:e.message,
        detail:
          String(
            e.stack||""
          ).slice(0,1500)
      },500);
    }
  }
};
