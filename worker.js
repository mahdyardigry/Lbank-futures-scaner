const EXCHANGE_API = "https://api.bybit.com";

const SCAN_BATCH = 20;
const DEEP_LIMIT = 3;
const RADAR_LIMIT = 5;
const DEEP_1M_LIMIT = 1300;

const DEFAULT_MIN_SCORE = 75;
const WATCH_SCORE = 60;

const TF = [
  {key:"1", label:"1m", interval:"1"},
  {key:"3", label:"3m", interval:"3"},
  {key:"5", label:"5m", interval:"5"},
  {key:"15", label:"15m", interval:"15"},
  {key:"60", label:"1h", interval:"60"}
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

const json = (data,status=200) =>
  new Response(JSON.stringify(data),{
    status,
    headers:{
      "content-type":"application/json; charset=utf-8",
      "cache-control":"no-store"
    }
  });

const num = (v,d=0) =>
  Number.isFinite(Number(v)) ? Number(v) : d;

const avg = a =>
  a.length ? a.reduce((x,y)=>x+y,0)/a.length : 0;

const clamp = (v,a=0,b=100) =>
  Math.max(a,Math.min(b,v));

function pct(a,b){
  return b ? (a-b)/b*100 : 0;
}

function absPct(a,b){
  return b ? Math.abs((a-b)/b*100) : 999;
}

async function api(path,params={}){

  const u = new URL(EXCHANGE_API + path);

  for(const [k,v] of Object.entries(params)){
    if(v!==undefined && v!==null)
      u.searchParams.set(k,String(v));
  }

  const r = await fetch(u,{
    headers:{accept:"application/json"}
  });

  if(!r.ok)
    throw new Error(`HTTP ${r.status}`);

  const d = await r.json();

  if(d.retCode!==0)
    throw new Error(d.retMsg || "API error");

  return d;
}

/* =========================
   MARKET DATA
========================= */

async function klines(category,symbol,interval,limit=100){

  const d = await api("/v5/market/kline",{
    category,
    symbol,
    interval,
    limit
  });

  return (d?.result?.list||[])
    .reverse()
    .map(k=>({
      time:num(k[0]),
      open:num(k[1]),
      high:num(k[2]),
      low:num(k[3]),
      close:num(k[4]),
      volume:num(k[5]),
      turnover:num(k[6])
    }));
}

async function instruments(category){

  const d = await api("/v5/market/instruments-info",{
    category,
    limit:1000
  });

  return d?.result?.list || [];
}

function futuresList(list){

  return list.filter(x =>
    x.status==="Trading" &&
    x.quoteCoin==="USDT" &&
    x.contractType==="LinearPerpetual"
  );
}

function spotList(list){

  return list.filter(x =>
    x.status==="Trading" &&
    x.quoteCoin==="USDT"
  );
}

/* =========================
   AUTOMATIC SYMBOL SEARCH
========================= */

function normalizeSymbol(x){

  return String(x||"")
    .trim()
    .toUpperCase()
    .replace(/[-_/:\s]/g,"")
    .replace(/USDT$/,"");
}

async function autoFindSymbol(input){

  const raw = String(input||"")
    .trim()
    .toUpperCase();

  const bare = normalizeSymbol(raw);

  const [f,s] = await Promise.all([
    instruments("linear"),
    instruments("spot")
  ]);

  const futures = futuresList(f);
  const spot = spotList(s);

  const future =
    futures.find(x =>
      String(x.symbol).toUpperCase()===raw ||
      String(x.symbol).toUpperCase()===bare+"USDT" ||
      String(x.baseCoin||"").toUpperCase()===bare
    );

  const spotItem =
    spot.find(x =>
      String(x.symbol).toUpperCase()===raw ||
      String(x.symbol).toUpperCase()===bare+"USDT" ||
      String(x.baseCoin||"").toUpperCase()===bare
    );

  if(future){

    return {
      found:true,
      market:"futures",
      category:"linear",
      symbol:future.symbol,
      baseCoin:future.baseCoin,
      quoteCoin:future.quoteCoin
    };
  }

  if(spotItem){

    return {
      found:true,
      market:"spot",
      category:"spot",
      symbol:spotItem.symbol,
      baseCoin:spotItem.baseCoin,
      quoteCoin:spotItem.quoteCoin
    };
  }

  return {
    found:false,
    market:null,
    category:null,
    symbol:null
  };
}

/* =========================
   INDICATORS
========================= */

function sma(a,p){

  if(!a.length) return 0;

  return avg(
    a.length<p ? a : a.slice(-p)
  );
}

function ema(a,p){

  if(!a.length) return 0;

  const k=2/(p+1);
  let e=a[0];

  for(let i=1;i<a.length;i++)
    e=a[i]*k+e*(1-k);

  return e;
}

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

function rsi(c,p=14){

  if(c.length<p+1) return 50;

  const changes=[];

  for(let i=1;i<c.length;i++)
    changes.push(c[i].close-c[i-1].close);

  const gains=changes.map(x=>x>0?x:0);
  const losses=changes.map(x=>x<0?-x:0);

  const g=sma(gains,p);
  const l=sma(losses,p);

  if(!l) return 100;

  return 100-(100/(1+g/l));
}

function macd(c){

  const close=c.map(x=>x.close);

  if(close.length<35)
    return {
      macd:0,
      signal:0,
      histogram:0,
      direction:"NONE"
    };

  const m12=ema(close,12);
  const m26=ema(close,26);
  const line=m12-m26;

  const arr=[];

  for(let i=26;i<close.length;i++){
    const a=close.slice(0,i+1);
    arr.push(
      ema(a,12)-ema(a,26)
    );
  }

  const signal=ema(arr,9);
  const histogram=line-signal;

  return {
    macd:line,
    signal,
    histogram,
    direction:
      histogram>0 ? "BULLISH" :
      histogram<0 ? "BEARISH" :
      "NONE"
  };
}

function bollinger(c,p=20){

  const a=c.slice(-p).map(x=>x.close);

  if(!a.length)
    return {
      middle:0,
      upper:0,
      lower:0,
      width:0
    };

  const m=avg(a);

  const sd=Math.sqrt(
    avg(a.map(x=>(x-m)**2))
  );

  return {
    middle:m,
    upper:m+2*sd,
    lower:m-2*sd,
    width:m ? sd*4/m*100 : 0
  };
}

/* =========================
   ICHIMOKU
========================= */

function ichimoku(c){

  if(c.length<52)
    return {
      direction:"NONE",
      tenkan:0,
      kijun:0,
      spanA:0,
      spanB:0
    };

  const mid=(arr)=>
    (Math.max(...arr.map(x=>x.high))+
     Math.min(...arr.map(x=>x.low)))/2;

  const tenkan=mid(c.slice(-9));
  const kijun=mid(c.slice(-26));
  const spanB=mid(c.slice(-52));
  const spanA=(tenkan+kijun)/2;
  const price=c.at(-1).close;

  let direction="NONE";

  if(
    price>spanA &&
    price>spanB &&
    tenkan>kijun
  )
    direction="BULLISH";

  if(
    price<spanA &&
    price<spanB &&
    tenkan<kijun
  )
    direction="BEARISH";

  return {
    direction,
    tenkan,
    kijun,
    spanA,
    spanB
  };
}

/* =========================
   STRUCTURE
========================= */

function swings(c,n=2){

  const highs=[];
  const lows=[];

  for(let i=n;i<c.length-n;i++){

    let h=true,l=true;

    for(let j=1;j<=n;j++){

      if(c[i].high<=c[i-j].high ||
         c[i].high<c[i+j].high)
        h=false;

      if(c[i].low>=c[i-j].low ||
         c[i].low>c[i+j].low)
        l=false;
    }

    if(h)
      highs.push({
        price:c[i].high,
        index:i,
        time:c[i].time
      });

    if(l)
      lows.push({
        price:c[i].low,
        index:i,
        time:c[i].time
      });
  }

  return {highs,lows};
}

function structure(c){

  const s=swings(c,2);

  const lh=s.highs.at(-1);
  const ph=s.highs.at(-2);
  const ll=s.lows.at(-1);
  const pl=s.lows.at(-2);

  const price=c.at(-1)?.close||0;

  let bos="NONE";
  let choch="NONE";

  if(lh && price>lh.price)
    bos="BULLISH";

  if(ll && price<ll.price)
    bos="BEARISH";

  if(
    ph&&pl&&lh&&ll &&
    lh.price>ph.price &&
    ll.price>pl.price &&
    price<ll.price
  )
    choch="BEARISH";

  if(
    ph&&pl&&lh&&ll &&
    lh.price<ph.price &&
    ll.price<pl.price &&
    price>lh.price
  )
    choch="BULLISH";

  return {
    bos,
    choch,
    swingHigh:lh?.price||null,
    swingLow:ll?.price||null
  };
}

/* =========================
   HUNT / FVG / OB
========================= */

function hunt(c){

  if(c.length<22)
    return {side:"NONE",confirmed:false};

  const x=c.at(-1);
  const p=c.slice(-21,-1);

  const hi=Math.max(...p.map(z=>z.high));
  const lo=Math.min(...p.map(z=>z.low));

  const range=x.high-x.low||1;

  const lower=
    Math.min(x.open,x.close)-x.low;

  const upper=
    x.high-Math.max(x.open,x.close);

  const va=sma(p.map(z=>z.volume),20);

  const volume=
    va>0&&x.volume>=va*1.15;

  if(x.low<lo&&x.close>lo&&lower/range>=.25){

    return {
      side:"LONG",
      type:"LIQUIDITY_SWEEP",
      level:lo,
      wickPct:lower/range*100,
      volumeConfirmed:volume,
      confirmed:volume||lower/range>=.4
    };
  }

  if(x.high>hi&&x.close<hi&&upper/range>=.25){

    return {
      side:"SHORT",
      type:"LIQUIDITY_SWEEP",
      level:hi,
      wickPct:upper/range*100,
      volumeConfirmed:volume,
      confirmed:volume||upper/range>=.4
    };
  }

  return {
    side:"NONE",
    type:"NONE",
    confirmed:false
  };
}

function fvg(c){

  if(c.length<3)
    return {type:"NONE"};

  const a=c.at(-3);
  const x=c.at(-1);

  if(x.low>a.high)
    return {
      type:"BULLISH",
      low:a.high,
      high:x.low,
      size:x.low-a.high
    };

  if(x.high<a.low)
    return {
      type:"BEARISH",
      low:x.high,
      high:a.low,
      size:a.low-x.high
    };

  return {type:"NONE"};
}

function orderBlock(c){

  if(c.length<10)
    return {type:"NONE"};

  const x=c.at(-1);

  for(
    let i=c.length-4;
    i>=Math.max(0,c.length-12);
    i--
  ){

    const z=c[i];

    if(z.close<z.open&&x.close>z.high)
      return {
        type:"BULLISH",
        low:z.low,
        high:z.high,
        time:z.time
      };

    if(z.close>z.open&&x.close<z.low)
      return {
        type:"BEARISH",
        low:z.low,
        high:z.high,
        time:z.time
      };
  }

  return {type:"NONE"};
}

/* =========================
   CANDLE
========================= */

function candle(c){

  const x=c.at(-1);
  const p=c.at(-2);

  if(!x||!p)
    return {type:"NONE"};

  const range=x.high-x.low||1;
  const body=Math.abs(x.close-x.open);

  const upper=x.high-Math.max(x.open,x.close);
  const lower=Math.min(x.open,x.close)-x.low;

  let type="NORMAL";

  if(body/range<.15)
    type="DOJI";

  if(lower>body*2&&lower/range>.45)
    type="HAMMER";

  if(upper>body*2&&upper/range>.45)
    type="SHOOTING_STAR";

  if(
    x.close>p.open&&
    x.open<p.close&&
    x.close>=p.close&&
    x.open<=p.open
  )
    type="BULLISH_ENGULFING";

  if(
    x.close<p.open&&
    x.open>p.close&&
    x.close<=p.close&&
    x.open>=p.open
  )
    type="BEARISH_ENGULFING";

  return {
    type,
    bullish:x.close>x.open,
    bearish:x.close<x.open,
    body,
    range,
    upperWick:upper,
    lowerWick:lower
  };
}

/* =========================
   TIMEFRAME ANALYSIS
========================= */

function analyze(c){

  if(c.length<25)
    return {error:"INSUFFICIENT_DATA"};

  const close=c.map(x=>x.close);
  const volume=c.map(x=>x.volume);

  const price=close.at(-1);

  const ma7=sma(close,7);
  const ma20=sma(close,20);

  const oldMA=sma(close.slice(0,-1),20);

  const slope=
    oldMA ? (ma20-oldMA)/oldMA : 0;

  const prev=close.at(-2);

  const last=c.at(-1);

  const touch7=
    Math.abs(price-ma7)/ma7<=.0015||
    (last.low<=ma7&&last.high>=ma7)||
    (prev-ma7)*(price-ma7)<=0;

  const touch20=
    Math.abs(price-ma20)/ma20<=.0015||
    (last.low<=ma20&&last.high>=ma20)||
    (prev-ma20)*(price-ma20)<=0;

  const vol7=sma(volume,7);
  const vol20=sma(volume,20);

  const spike=
    vol20>0&&(
      last.volume>vol20*1.5||
      last.volume>vol7*1.8
    );

  const trend=
    price>ma20&&ma7>ma20
      ? "BULLISH"
      : price<ma20&&ma7<ma20
        ? "BEARISH"
        : "RANGE";

  const adxValue=adx(c);
  const bb=bollinger(c);

  return {
    price,
    ma7,
    ma20,

    maSlope:
      slope>.00007?"UP":
      slope<-.00007?"DOWN":"FLAT",

    slopePct:slope*100,

    touchMA7:touch7,
    touchMA20:touch20,

    trend,

    rsi:rsi(c),
    macd:macd(c),
    ichimoku:ichimoku(c),

    volume:{
      current:last.volume,
      ma7:vol7,
      ma20:vol20,
      spike,
      ratio20:vol20?last.volume/vol20:0
    },

    atr:atr(c),
    bollinger:bb,

    marketState:
      adxValue<18&&bb.width<1.8
        ? "RANGE"
        : "ACTIVE",

    adx:adxValue,

    hunt:hunt(c),
    fvg:fvg(c),
    orderBlock:orderBlock(c),
    structure:structure(c),
    bos:structure(c).bos,
    choch:structure(c).choch,
    candle:candle(c),

    timestamp:last.time
  };
}

function adx(c,p=14){

  if(c.length<p*2)
    return 0;

  const tr=[];
  const plus=[];
  const minus=[];

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

    const up=x.high-q.high;
    const dn=q.low-x.low;

    plus.push(up>dn&&up>0?up:0);
    minus.push(dn>up&&dn>0?dn:0);
  }

  const dx=[];

  for(let i=p;i<tr.length;i++){

    const t=avg(tr.slice(i-p,i))||1;
    const pp=100*avg(plus.slice(i-p,i))/t;
    const mm=100*avg(minus.slice(i-p,i))/t;

    dx.push(
      pp+mm
        ? 100*Math.abs(pp-mm)/(pp+mm)
        : 0
    );
  }

  return avg(dx.slice(-p));
}

/* =========================
   CONVERTED MA
========================= */

function convertedMA(c){

  const result=[];

  for(const m of CONVERTED_MAS){

    if(c.length<m.period+2)
      continue;

    const closes=c.map(x=>x.close);

    const ma=sma(closes,m.period);
    const prev=sma(
      closes.slice(0,-1),
      m.period
    );

    const price=closes.at(-1);

    const x=c.at(-1);

    const touch=
      Math.abs(price-ma)/ma<=.0015||
      (x.low<=ma&&x.high>=ma);

    const crossUp=
      closes.at(-2)<=prev&&price>ma;

    const crossDown=
      closes.at(-2)>=prev&&price<ma;

    const lower=
      Math.min(x.open,x.close)-x.low;

    const upper=
      x.high-Math.max(x.open,x.close);

    const range=x.high-x.low||1;

    const bullReject=
      x.low<=ma&&
      x.close>ma&&
      x.close>x.open&&
      lower/range>=.25;

    const bearReject=
      x.high>=ma&&
      x.close<ma&&
      x.close<x.open&&
      upper/range>=.25;

    const volumeAvg=
      sma(
        c.slice(-21,-1).map(z=>z.volume),
        20
      );

    const volumeConfirm=
      volumeAvg>0&&
      x.volume>=volumeAvg*1.15;

    const direction=
      bullReject||crossUp
        ?"LONG":
      bearReject||crossDown
        ?"SHORT":
        "NONE";

    const slopePct=
      prev ? (ma-prev)/prev*100 : 0;

    const slope=
      Math.abs(slopePct)<.003
        ?"FLAT":
      slopePct>0
        ?"UP":"DOWN";

    const confirmed=
      touch&&
      slope!=="FLAT"&&
      volumeConfirm&&
      (
        bullReject||
        bearReject||
        crossUp||
        crossDown
      )&&
      (
        direction==="LONG"
          ? price>ma
          : price<ma
      );

    result.push({
      source:m.source,
      ma:`MA${m.ma}`,
      period1m:m.period,
      price,
      maValue:ma,
      direction,
      touch,
      crossUp,
      crossDown,
      bullishRejection:bullReject,
      bearishRejection:bearReject,
      slope,
      slopePct,
      volumeConfirmed:volumeConfirm,
      confirmation:
        confirmed
          ? direction==="LONG"
            ?"CONFIRMED_LONG"
            :"CONFIRMED_SHORT"
          :"WAIT",
      distancePct:(price-ma)/ma*100
    });
  }

  return {
    events:result,
    recent:result.filter(x=>x.touch),
    confirmed:result.filter(
      x=>x.confirmation!=="WAIT"
    )
  };
}

/* =========================
   ORDER FLOW
========================= */

async function footprint(category,symbol){

  try{

    const d=await api(
      "/v5/market/recent-trade",
      {
        category,
        symbol,
        limit:200
      }
    );

    let buy=0;
    let sell=0;
    let largest=0;

    for(const x of d?.result?.list||[]){

      const q=num(x.size);
      const p=num(x.price);
      const value=q*p;

      largest=Math.max(largest,value);

      if(
        String(x.side).toLowerCase()==="buy"
      )
        buy+=q;
      else
        sell+=q;
    }

    const total=buy+sell;

    return {
      buyVolume:buy,
      sellVolume:sell,
      delta:buy-sell,
      deltaPercent:
        total?(buy-sell)/total*100:0,
      trades:
        d?.result?.list?.length||0,
      largestTradeNotional:largest
    };

  }catch(e){

    return {
      error:e.message
    };
  }
}

/* =========================
   ORDER BOOK
========================= */

async function walls(category,symbol,price){

  try{

    const d=await api(
      "/v5/market/orderbook",
      {
        category,
        symbol,
        limit:50
      }
    );

    const bids=d?.result?.b||[];
    const asks=d?.result?.a||[];

    const buys=bids
      .map(x=>({
        price:num(x[0]),
        size:num(x[1])
      }))
      .filter(x=>x.price>0&&x.size>0)
      .map(x=>({
        ...x,
        notional:x.price*x.size,
        distancePct:absPct(x.price,price)
      }))
      .filter(x=>x.distancePct<=3)
      .sort((a,b)=>b.notional-a.notional);

    const sells=asks
      .map(x=>({
        price:num(x[0]),
        size:num(x[1])
      }))
      .filter(x=>x.price>0&&x.size>0)
      .map(x=>({
        ...x,
        notional:x.price*x.size,
        distancePct:absPct(x.price,price)
      }))
      .filter(x=>x.distancePct<=3)
      .sort((a,b)=>b.notional-a.notional);

    const avgBuy=avg(buys.map(x=>x.notional));
    const avgSell=avg(sells.map(x=>x.notional));

    const buy=buys[0]||null;
    const sell=sells[0]||null;

    return {
      buy,
      sell,

      buyLevels:buys.slice(0,10),
      sellLevels:sells.slice(0,10),

      buyStrength:
        buy&&avgBuy
          ? clamp(buy.notional/avgBuy*20)
          : 0,

      sellStrength:
        sell&&avgSell
          ? clamp(sell.notional/avgSell*20)
          : 0,

      buyNear:
        !!buy&&buy.distancePct<=1,

      sellNear:
        !!sell&&sell.distancePct<=1
    };

  }catch(e){

    return {error:e.message};
  }
}

/* =========================
   OI / FUNDING
========================= */

async function marketData(category,symbol){

  if(category!=="linear"){

    return {
      openInterest:null,
      fundingRate:null,
      turnover24h:null,
      change24h:null,
      markPrice:null,
      indexPrice:null
    };
  }

  try{

    const d=await api(
      "/v5/market/tickers",
      {
        category,
        symbol
      }
    );

    const x=d?.result?.list?.[0]||{};

    return {
      openInterest:num(x.openInterest,null),
      fundingRate:num(x.fundingRate,null),
      turnover24h:num(x.turnover24h,null),
      change24h:num(x.price24hPcnt)*100,
      markPrice:num(x.markPrice,null),
      indexPrice:num(x.indexPrice,null)
    };

  }catch(e){

    return {error:e.message};
  }
}

/* =========================
   SUPPORT / RESISTANCE
========================= */

function supportResistance(c,w,price){

  const s=swings(c,3);

  const supports=[];
  const resistances=[];

  for(const x of s.lows){

    if(x.price<price)
      supports.push({
        price:x.price,
        type:"SWING",
        distancePct:absPct(x.price,price)
      });
  }

  for(const x of s.highs){

    if(x.price>price)
      resistances.push({
        price:x.price,
        type:"SWING",
        distancePct:absPct(x.price,price)
      });
  }

  for(const x of w?.buyLevels||[]){

    if(x.price<price)
      supports.push({
        price:x.price,
        type:"BUY_WALL",
        liquidity:x.notional,
        distancePct:x.distancePct
      });
  }

  for(const x of w?.sellLevels||[]){

    if(x.price>price)
      resistances.push({
        price:x.price,
        type:"SELL_WALL",
        liquidity:x.notional,
        distancePct:x.distancePct
      });
  }

  supports.sort((a,b)=>a.distancePct-b.distancePct);
  resistances.sort((a,b)=>a.distancePct-b.distancePct);

  return {
    nearestSupport:supports[0]||null,
    nearestResistance:resistances[0]||null,
    supports:supports.slice(0,10),
    resistances:resistances.slice(0,10)
  };
}

/* =========================
   SCORING
========================= */

const METHOD_NAMES=[
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

function parseMethods(value){

  if(!value)
    return METHOD_NAMES;

  try{

    const a=JSON.parse(value);

    if(Array.isArray(a)&&a.length)
      return a.filter(x=>METHOD_NAMES.includes(x));

  }catch{}

  return METHOD_NAMES;
}

function score(tf,converted,fp,w,market,methods){

  let L=0;
  let S=0;

  const LR=[];
  const SR=[];

  const add=(side,v,text)=>{

    if(side==="L"){
      L+=v;
      LR.push(text);
    }

    if(side==="S"){
      S+=v;
      SR.push(text);
    }
  };

  for(const x of Object.values(tf)){

    if(x.error) continue;

    const weight=
      x===tf["1"] ? 1.4 :
      x===tf["60"] ? 1.25 : 1;

    if(
      methods.includes("MA")&&
      x.maSlope==="UP"&&
      x.touchMA20&&
      x.trend==="BULLISH"
    )
      add("L",8*weight,"مووینگ: برخورد MA20 در روند صعودی");

    if(
      methods.includes("MA")&&
      x.maSlope==="DOWN"&&
      x.touchMA20&&
      x.trend==="BEARISH"
    )
      add("S",8*weight,"مووینگ: برخورد MA20 در روند نزولی");

    if(
      methods.includes("SMC")&&
      x.hunt?.confirmed
    )
      add(
        x.hunt.side==="LONG"?"L":"S",
        10*weight,
        "اسمارت مانی: شکار نقدینگی تأییدشده"
      );

    if(
      methods.includes("ICT")&&
      x.fvg?.type==="BULLISH"
    )
      add("L",5*weight,"ICT: FVG صعودی");

    if(
      methods.includes("ICT")&&
      x.fvg?.type==="BEARISH"
    )
      add("S",5*weight,"ICT: FVG نزولی");

    if(
      methods.includes("FVG")&&
      x.fvg?.type==="BULLISH"
    )
      add("L",5*weight,"FVG صعودی");

    if(
      methods.includes("FVG")&&
      x.fvg?.type==="BEARISH"
    )
      add("S",5*weight,"FVG نزولی");

    if(
      methods.includes("BOS")&&
      x.bos==="BULLISH"
    )
      add("L",8*weight,"BOS صعودی / شکست ساختار");

    if(
      methods.includes("BOS")&&
      x.bos==="BEARISH"
    )
      add("S",8*weight,"BOS نزولی / شکست ساختار");

    if(
      methods.includes("CHOCH")&&
      x.choch==="BULLISH"
    )
      add("L",10*weight,"CHoCH صعودی / تغییر شخصیت");

    if(
      methods.includes("CHOCH")&&
      x.choch==="BEARISH"
    )
      add("S",10*weight,"CHoCH نزولی / تغییر شخصیت");

    if(
      methods.includes("ORDERBLOCK")&&
      x.orderBlock?.type==="BULLISH"
    )
      add("L",5*weight,"Order Block صعودی");

    if(
      methods.includes("ORDERBLOCK")&&
      x.orderBlock?.type==="BEARISH"
    )
      add("S",5*weight,"Order Block نزولی");

    if(
      methods.includes("VOLUME")&&
      x.volume?.spike
    ){

      if(x.trend==="BULLISH")
        add("L",6*weight,"حجم: افزایش حجم در روند صعودی");

      if(x.trend==="BEARISH")
        add("S",6*weight,"حجم: افزایش حجم در روند نزولی");
    }

    if(
      methods.includes("MACD")
    ){

      if(x.macd?.direction==="BULLISH")
        add("L",5*weight,"MACD صعودی");

      if(x.macd?.direction==="BEARISH")
        add("S",5*weight,"MACD نزولی");
    }

    if(
      methods.includes("RSI")
    ){

      if(x.rsi<=30)
        add("L",6*weight,`RSI اشباع فروش ${x.rsi.toFixed(1)}`);

      if(x.rsi>=70)
        add("S",6*weight,`RSI اشباع خرید ${x.rsi.toFixed(1)}`);
    }

    if(
      methods.includes("ICHIMOKU")
    ){

      if(x.ichimoku?.direction==="BULLISH")
        add("L",6*weight,"ایچیموکو صعودی");

      if(x.ichimoku?.direction==="BEARISH")
        add("S",6*weight,"ایچیموکو نزولی");
    }
  }

  for(const e of converted?.confirmed||[]){

    if(!methods.includes("MA"))
      continue;

    const v=e.source==="1h"?12:
            e.source==="15m"?10:
            e.source==="5m"?9:7;

    if(e.confirmation==="CONFIRMED_LONG")
      add("L",v,`MA تبدیل‌شده: ${e.ma} ${e.source} Trigger صعودی`);

    if(e.confirmation==="CONFIRMED_SHORT")
      add("S",v,`MA تبدیل‌شده: ${e.ma} ${e.source} Trigger نزولی`);
  }

  if(
    methods.includes("ORDERFLOW")&&
    !fp.error
  ){

    if(fp.deltaPercent>=8)
      add("L",10,"جریان سفارش: Delta خرید قوی");

    if(fp.deltaPercent<=-8)
      add("S",10,"جریان سفارش: Delta فروش قوی");
  }

  if(
    methods.includes("LIQUIDITY")&&
    !w.error
  ){

    if(w.buyNear&&w.buyStrength>=60)
      add("L",7,"نقدینگی: Buy Wall قوی نزدیک قیمت");

    if(w.sellNear&&w.sellStrength>=60)
      add("S",7,"نقدینگی: Sell Wall قوی نزدیک قیمت");
  }

  if(methods.includes("SR")){

    if(w.buyNear)
      add("L",4,"حمایت: Buy Wall نزدیک قیمت");

    if(w.sellNear)
      add("S",4,"مقاومت: Sell Wall نزدیک قیمت");
  }

  if(
    methods.includes("OI")&&
    market.openInterest!==null
  ){

    if(market.change24h>0)
      add("L",3,"OI/Futures: بازار در جهت صعودی فعال است");

    if(market.change24h<0)
      add("S",3,"OI/Futures: بازار در جهت نزولی فعال است");
  }

  if(
    methods.includes("FUNDING")&&
    market.fundingRate!==null
  ){

    if(market.fundingRate<0)
      add("L",3,"Funding منفی");

    if(market.fundingRate>0)
      add("S",3,"Funding مثبت");
  }

  return {
    longScore:clamp(L),
    shortScore:clamp(S),
    longReasons:LR,
    shortReasons:SR,
    rawLong:L,
    rawShort:S
  };
}

/* =========================
   DEEP ANALYSIS
========================= */

async function deepAnalyze(
  category,
  symbol,
  minScore=DEFAULT_MIN_SCORE,
  methods=METHOD_NAMES
){

  const tf={};
  let one=[];

  try{
    one=await klines(
      category,
      symbol,
      "1",
      DEEP_1M_LIMIT
    );

    tf["1"]=analyze(one.slice(-300));

  }catch(e){
    tf["1"]={error:e.message};
  }

  for(const t of TF.slice(1)){

    try{

      const c=await klines(
        category,
        symbol,
        t.interval,
        150
      );

      tf[t.key]=analyze(c);

    }catch(e){
      tf[t.key]={error:e.message};
    }
  }

  const price=
    tf["1"]?.price||
    Object.values(tf).find(x=>!x.error)?.price||
    0;

  const converted=
    one.length
      ? convertedMA(one)
      : {events:[],recent:[],confirmed:[]};

  const fp=
    await footprint(category,symbol);

  const w=
    await walls(category,symbol,price);

  const market=
    await marketData(category,symbol);

  const sr=
    supportResistance(one,w,price);

  const sc=
    score(
      tf,
      converted,
      fp,
      w,
      market,
      methods
    );

  const longScore=Math.round(sc.longScore);
  const shortScore=Math.round(sc.shortScore);

  let direction="WAIT";
  let finalScore=Math.max(
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

  if(
    shortScore>=minScore&&
    shortScore>longScore
  ){
    direction="SHORT";
    finalScore=shortScore;
  }

  const m15=
    one.length>=15
      ? pct(price,one.at(-15).close)
      : 0;

  const m30=
    one.length>=30
      ? pct(price,one.at(-30).close)
      : 0;

  const volAvg=
    sma(
      one.slice(-21,-1).map(x=>x.volume),
      20
    );

  const volumeRatio=
    volAvg
      ? one.at(-1).volume/volAvg
      : 0;

  const pumpScore=Math.round(
    clamp(
      (m15>=3?25:0)+
      (m30>=5?15:0)+
      (volumeRatio>=1.5?15:0)+
      (tf["1"]?.maSlope==="UP"?10:0)+
      (tf["1"]?.bos==="BULLISH"?10:0)+
      (tf["1"]?.hunt?.side==="SHORT"?10:0)+
      (w.sellNear?5:0)
    )
  );

  const dumpScore=Math.round(
    clamp(
      (m15<=-3?25:0)+
      (m30<=-5?15:0)+
      (volumeRatio>=1.5?15:0)+
      (tf["1"]?.maSlope==="DOWN"?10:0)+
      (tf["1"]?.bos==="BEARISH"?10:0)+
      (tf["1"]?.hunt?.side==="LONG"?10:0)+
      (w.buyNear?5:0)
    )
  );

  const styles={
    MA:methods.includes("MA")?
      (longScore>shortScore?longScore:shortScore):0,

    SMC:methods.includes("SMC")?
      tf["1"]?.hunt?.confirmed?80:30:0,

    ICT:methods.includes("ICT")?
      tf["1"]?.fvg?.type!=="NONE"?75:30:0,

    MACD:methods.includes("MACD")?
      Math.round(
        tf["1"]?.macd?.direction==="NONE"
          ?50
          :75
      ):0,

    RSI:methods.includes("RSI")?
      Math.round(
        tf["1"]?.rsi<=30||
        tf["1"]?.rsi>=70
          ?80:50
      ):0,

    DIVERGENCE:methods.includes("DIVERGENCE")?0:0,

    ICHIMOKU:methods.includes("ICHIMOKU")?
      tf["1"]?.ichimoku?.direction!=="NONE"?75:50:0,

    VOLUME:methods.includes("VOLUME")?
      tf["1"]?.volume?.spike?80:45:0,

    ORDERFLOW:methods.includes("ORDERFLOW")?
      Math.abs(fp?.deltaPercent||0)>=8?80:50:0,

    LIQUIDITY:methods.includes("LIQUIDITY")?
      w?.buyNear||w?.sellNear?80:45:0
  };

  return {
    ok:true,
    symbol,
    marketType:
      category==="linear"
        ?"futures"
        :"spot",

    price,

    direction,
    score:Math.round(finalScore),

    longScore,
    shortScore,

    signalLevel:
      finalScore>=90?"VERY_STRONG":
      finalScore>=minScore?"CONFIRMED":
      finalScore>=WATCH_SCORE?"WATCH":
      "NONE",

    minimumScore:minScore,
    selectedMethods:methods,

    timeframes:tf,
    convertedMA1m:converted,

    footprint:fp,
    walls:w,
    supportResistance:sr,
    market,

    styles,

    movement:{
      change15m:m15,
      change30m:m30,
      volumeRatio,
      pumpScore,
      dumpScore
    },

    structure:{
      bos:tf["1"]?.bos||"NONE",
      choch:tf["1"]?.choch||"NONE",
      hunt:tf["1"]?.hunt||{confirmed:false},
      fvg:tf["1"]?.fvg||{type:"NONE"},
      orderBlock:tf["1"]?.orderBlock||{type:"NONE"}
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

    liquidation:{
      available:false,
      value:null
    },

    generatedAt:Date.now()
  };
}

/* =========================
   SCAN
========================= */

async function scan(offset=0,minScore=DEFAULT_MIN_SCORE,methods=METHOD_NAMES){

  const list=futuresList(
    await instruments("linear")
  ).sort(
    (a,b)=>a.symbol.localeCompare(b.symbol)
  );

  if(!list.length)
    return {
      ok:false,
      error:"بازار در دسترس نیست."
    };

  const start=Math.max(
    0,
    Math.min(offset,list.length-1)
  );

  const batch=list.slice(
    start,
    start+SCAN_BATCH
  );

  const candidates=[];

  for(const m of batch){

    try{

      const c=await klines(
        "linear",
        m.symbol,
        "1",
        80
      );

      const a=analyze(c);

      if(a.error) continue;

      let activity=0;

      if(a.touchMA20) activity+=20;
      if(a.touchMA7) activity+=10;
      if(a.volume.spike) activity+=20;
      if(a.hunt.confirmed) activity+=20;
      if(a.bos!=="NONE") activity+=10;
      if(a.choch!=="NONE") activity+=15;

      candidates.push({
        symbol:m.symbol,
        activity
      });

    }catch{}
  }

  candidates.sort(
    (a,b)=>b.activity-a.activity
  );

  const results=[];

  for(
    const x of candidates.slice(0,DEEP_LIMIT)
  ){

    try{

      const a=await deepAnalyze(
        "linear",
        x.symbol,
        minScore,
        methods
      );

      if(a.score>=minScore)
        results.push(a);

    }catch{}
  }

  results.sort(
    (a,b)=>b.score-a.score
  );

  return {
    ok:true,
    totalMarkets:list.length,
    offset:start,
    nextOffset:
      (start+SCAN_BATCH)%list.length,
    results,
    scannedSymbols:batch.map(x=>x.symbol)
  };
}

/* =========================
   RADAR
========================= */

async function radar(offset=0,minScore=DEFAULT_MIN_SCORE,methods=METHOD_NAMES){

  const list=futuresList(
    await instruments("linear")
  ).sort(
    (a,b)=>a.symbol.localeCompare(b.symbol)
  );

  if(!list.length)
    return {
      ok:false,
      error:"بازار در دسترس نیست."
    };

  const start=Math.max(
    0,
    Math.min(offset,list.length-1)
  );

  const batch=list.slice(
    start,
    start+SCAN_BATCH
  );

  const candidates=[];

  for(const m of batch){

    try{

      const c=await klines(
        "linear",
        m.symbol,
        "1",
        80
      );

      if(c.length<30) continue;

      const price=c.at(-1).close;

      const change=pct(
        price,
        c.at(-15).close
      );

      const va=sma(
        c.slice(-21,-1).map(x=>x.volume),
        20
      );

      const vr=va
        ?c.at(-1).volume/va
        :0;

      candidates.push({
        symbol:m.symbol,
        activity:
          Math.abs(change)*5+
          Math.min(vr*10,30)
      });

    }catch{}
  }

  candidates.sort(
    (a,b)=>b.activity-a.activity
  );

  const deep=[];

  for(
    const x of candidates.slice(0,RADAR_LIMIT)
  ){

    try{

      deep.push(
        await deepAnalyze(
          "linear",
          x.symbol,
          minScore,
          methods
        )
      );

    }catch{}
  }

  return {
    ok:true,
    totalMarkets:list.length,
    offset:start,
    nextOffset:
      (start+SCAN_BATCH)%list.length,

    pump:deep
      .filter(x=>x.movement.pumpScore>=50)
      .sort((a,b)=>b.movement.pumpScore-a.movement.pumpScore),

    dump:deep
      .filter(x=>x.movement.dumpScore>=50)
      .sort((a,b)=>b.movement.dumpScore-a.movement.dumpScore),

    reversal:deep
      .filter(x=>
        x.structure.choch!=="NONE" ||
        x.structure.hunt.confirmed
      ),

    results:deep
  };
}

/* =========================
   ROUTER
========================= */

export default {

  async fetch(request,env){

    const u=new URL(request.url);
    const p=u.pathname;

    try{

      /* SEARCH */

      if(p==="/api/search"){

        const q=u.searchParams.get("symbol");

        if(!q)
          return json({
            ok:false,
            error:"نام ارز وارد نشده است."
          },400);

        const found=await autoFindSymbol(q);

        if(!found.found)
          return json({
            ok:false,
            error:"این ارز در بازار پیدا نشد."
          },404);

        return json({
          ok:true,
          ...found
        });
      }

      /* ANALYZE */

      if(p==="/api/analyze"){

        const q=u.searchParams.get("symbol");

        if(!q)
          return json({
            ok:false,
            error:"نام ارز وارد نشده است."
          },400);

        const minScore=clamp(
          num(
            u.searchParams.get("minScore"),
            DEFAULT_MIN_SCORE
          ),
          1,
          100
        );

        const methods=parseMethods(
          u.searchParams.get("methods")
        );

        const found=await autoFindSymbol(q);

        if(!found.found)
          return json({
            ok:false,
            error:"این ارز پیدا نشد."
          },404);

        const data=await deepAnalyze(
          found.category,
          found.symbol,
          minScore,
          methods
        );

        return json({
          ...data,
          found
        });
      }

      /* SCAN */

      if(p==="/api/scan"){

        const minScore=clamp(
          num(
            u.searchParams.get("minScore"),
            DEFAULT_MIN_SCORE
          ),
          1,
          100
        );

        const methods=parseMethods(
          u.searchParams.get("methods")
        );

        return json(
          await scan(
            num(u.searchParams.get("offset"),0),
            minScore,
            methods
          )
        );
      }

      /* RADAR */

      if(p==="/api/radar"){

        const minScore=clamp(
          num(
            u.searchParams.get("minScore"),
            DEFAULT_MIN_SCORE
          ),
          1,
          100
        );

        const methods=parseMethods(
          u.searchParams.get("methods")
        );

        return json(
          await radar(
            num(u.searchParams.get("offset"),0),
            minScore,
            methods
          )
        );
      }

      /* HEALTH */

      if(p==="/api/health"){

        return json({
          ok:true,
          service:"Smart Market Scanner",
          version:"V9",
          minimumScore:DEFAULT_MIN_SCORE,
          timeframes:TF.map(x=>x.interval),
          features:[
            "Automatic Market Detection",
            "Futures",
            "Spot",
            "MA",
            "SMC",
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
            "OI",
            "Funding",
            "Pump Radar",
            "Dump Radar",
            "Reversal Radar"
          ]
        });
      }

      /* STATIC FILES */

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
            "content-type":"text/plain;charset=utf-8"
          }
        }
      );

    }catch(e){

      return json({
        ok:false,
        error:e.message||"خطای نامشخص"
      },500);
    }
  }
};
