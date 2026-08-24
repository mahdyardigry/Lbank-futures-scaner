const BYBIT = "https://api.bybit.com";

const SCAN_BATCH = 20;
const DEEP_LIMIT = 3;
const MIN_SIGNAL_SCORE = 45;
const WATCH_SCORE = 35;
const DEFAULT_STRICTNESS = 3;

const TIMEFRAMES = ["1", "3", "5", "15", "60"];

const SIGNAL_METHODS = [
  "MA","MACD","RSI","ICHIMOKU","DIVERGENCE",
  "HUNT","FVG","BOS","CHOCH","ORDER_BLOCK",
  "VOLUME","FOOTPRINT","WALLS"
];

const CONVERTED_MAS = {
  "1m": [
    {source:"3m",period:7},
    {source:"3m",period:20},
    {source:"5m",period:7},
    {source:"5m",period:20},
    {source:"15m",period:7},
    {source:"15m",period:20},
    {source:"1h",period:20}
  ]
};

const STABLES = new Set([
  "USDT","USDC","DAI","BUSD","TUSD","WBTC","STETH"
]);

const json = (data,status=200) =>
  new Response(
    JSON.stringify(data),
    {
      status,
      headers:{
        "content-type":"application/json;charset=UTF-8",
        "cache-control":"no-store"
      }
    }
  );

async function bybit(path, params={}){

  const qs = new URLSearchParams();

  for(const [k,v] of Object.entries(params)){
    if(v !== undefined && v !== null && v !== "")
      qs.set(k,String(v));
  }

  const r = await fetch(
    `${BYBIT}${path}?${qs}`,
    {
      headers:{
        "accept":"application/json"
      },
      cf:{
        cacheTtl:0,
        cacheEverything:false
      }
    }
  );

  const d = await r.json();

  if(!r.ok || d.retCode !== 0)
    throw new Error(
      d.retMsg ||
      `Bybit HTTP ${r.status}`
    );

  return d.result;
}

async function getSpotSymbols(){

  const r = await bybit(
    "/v5/market/instruments-info",
    {
      category:"spot",
      limit:1000
    }
  );

  return r.list || [];
}

async function getLinearSymbols(){

  const r = await bybit(
    "/v5/market/instruments-info",
    {
      category:"linear",
      settleCoin:"USDT",
      limit:1000
    }
  );

  return r.list || [];
}

async function findSymbol(input){

  const symbol = String(input || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g,"");

  if(!symbol)
    throw new Error("نام ارز وارد نشده است.");

  const [spot,linear] =
    await Promise.all([
      getSpotSymbols(),
      getLinearSymbols()
    ]);

  const futures =
    linear.find(
      x =>
        x.symbol === symbol &&
        x.status === "Trading"
    ) || null;

  const spotItem =
    spot.find(
      x =>
        x.symbol === symbol &&
        x.status === "Trading"
    ) || null;

  if(!futures && !spotItem){

    throw new Error(
      `${symbol} در Spot یا Futures Bybit پیدا نشد.`
    );
  }

  return {
    input:symbol,
    selected:futures ? "LINEAR" : "SPOT",
    futures:futures
      ? {
          symbol:futures.symbol,
          status:futures.status,
          baseCoin:futures.baseCoin,
          quoteCoin:futures.quoteCoin
        }
      : null,
    spot:spotItem
      ? {
          symbol:spotItem.symbol,
          status:spotItem.status,
          baseCoin:spotItem.baseCoin,
          quoteCoin:spotItem.quoteCoin
        }
      : null
  };
}

async function resolveCategory(input,category){

  const symbol =
    String(input || "")
      .trim()
      .toUpperCase();

  const requested =
    String(category || "auto")
      .toLowerCase();

  const [spot,linear] =
    await Promise.all([
      getSpotSymbols(),
      getLinearSymbols()
    ]);

  const s =
    spot.find(
      x =>
        x.symbol === symbol &&
        x.status === "Trading"
    ) || null;

  const f =
    linear.find(
      x =>
        x.symbol === symbol &&
        x.status === "Trading"
    ) || null;

  if(requested === "spot"){

    if(!s)
      throw new Error(
        `${symbol} در Spot Bybit پیدا نشد.`
      );

    return {
      category:"spot",
      symbol,
      item:s
    };
  }

  if(requested === "linear"){

    if(!f)
      throw new Error(
        `${symbol} در Futures Bybit پیدا نشد.`
      );

    return {
      category:"linear",
      symbol,
      item:f
    };
  }

  if(f){

    return {
      category:"linear",
      symbol,
      item:f
    };
  }

  if(s){

    return {
      category:"spot",
      symbol,
      item:s
    };
  }

  throw new Error(
    `${symbol} در Spot یا Futures Bybit پیدا نشد.`
  );
}

async function ticker(category,symbol){

  const r = await bybit(
    "/v5/market/tickers",
    {
      category,
      symbol
    }
  );

  return r.list?.[0] || {};
}

async function klines(
  category,
  symbol,
  interval,
  limit=120
){

  const r = await bybit(
    "/v5/market/kline",
    {
      category,
      symbol,
      interval,
      limit
    }
  );

  return (r.list || [])
    .reverse()
    .map(x => ({
      time:Number(x[0]),
      open:Number(x[1]),
      high:Number(x[2]),
      low:Number(x[3]),
      close:Number(x[4]),
      volume:Number(x[5]),
      turnover:Number(x[6])
    }));
}

function sma(a,n){

  if(a.length < n)
    return null;

  let s=0;

  for(
    let i=a.length-n;
    i<a.length;
    i++
  )
    s += Number(a[i] || 0);

  return s/n;
}

function ema(a,n){

  if(a.length < n)
    return null;

  let e=sma(a.slice(0,n),n);
  const k=2/(n+1);

  for(let i=n;i<a.length;i++)
    e =
      a[i]*k +
      e*(1-k);

  return e;
}

function rsi(values,n=14){

  if(values.length < n+1)
    return 50;

  let gain=0;
  let loss=0;

  for(
    let i=values.length-n;
    i<values.length;
    i++
  ){

    const d=
      values[i]-
      values[i-1];

    if(d>=0)
      gain += d;
    else
      loss -= d;
  }

  const ag=gain/n;
  const al=loss/n;

  if(al===0)
    return 100;

  const rs=ag/al;

  return 100-(100/(1+rs));
}

function macd(values){

  const m12=ema(values,12);
  const m26=ema(values,26);

  if(m12==null || m26==null){

    return {
      macd:0,
      signal:0,
      histogram:0,
      direction:"NONE"
    };
  }

  const macds=[];

  for(
    let i=26;
    i<=values.length;
    i++
  ){

    const p=
      values.slice(0,i);

    const a=ema(p,12);
    const b=ema(p,26);

    if(a!=null && b!=null)
      macds.push(a-b);
  }

  const signal=
    ema(macds,9) ?? 0;

  const value=
    macds[macds.length-1] ?? 0;

  const hist=
    value-signal;

  return {
    macd:value,
    signal,
    histogram:hist,
    direction:
      hist>0
        ? "LONG"
        : hist<0
          ? "SHORT"
          : "NONE"
  };
}

function adx(candles,n=14){

  if(candles.length < n+2)
    return 0;

  let tr=0;
  let plus=0;
  let minus=0;

  for(
    let i=candles.length-n;
    i<candles.length;
    i++
  ){

    const c=candles[i];
    const p=candles[i-1];

    const range=Math.max(
      c.high-c.low,
      Math.abs(c.high-p.close),
      Math.abs(c.low-p.close)
    );

    tr += range;

    const up=c.high-p.high;
    const down=p.low-c.low;

    if(up>down && up>0)
      plus+=up;

    if(down>up && down>0)
      minus+=down;
  }

  if(tr===0)
    return 0;

  const pdi=100*plus/tr;
  const mdi=100*minus/tr;

  if(pdi+mdi===0)
    return 0;

  return 100*
    Math.abs(pdi-mdi)/
    (pdi+mdi);
}

function atr(candles,n=14){

  if(candles.length<n+1)
    return 0;

  let s=0;

  for(
    let i=candles.length-n;
    i<candles.length;
    i++
  ){

    const c=candles[i];
    const p=candles[i-1];

    s += Math.max(
      c.high-c.low,
      Math.abs(c.high-p.close),
      Math.abs(c.low-p.close)
    );
  }

  return s/n;
}

function bollingerWidth(values,n=20){

  if(values.length<n)
    return 0;

  const a=
    values.slice(-n);

  const m=
    a.reduce(
      (s,x)=>s+x,
      0
    )/n;

  let v=0;

  for(const x of a)
    v += Math.pow(x-m,2);

  const sd=
    Math.sqrt(v/n);

  if(m===0)
    return 0;

  return ((sd*4)/m)*100;
}

function ichimoku(c){

  if(c.length<52){

    return {
      tenkan:0,
      kijun:0,
      spanA:0,
      spanB:0,
      direction:"NONE"
    };
  }

  const mid=arr=>{
    const h=Math.max(...arr.map(x=>x.high));
    const l=Math.min(...arr.map(x=>x.low));
    return (h+l)/2;
  };

  const tenkan=
    mid(c.slice(-9));

  const kijun=
    mid(c.slice(-26));

  const spanA=
    (tenkan+kijun)/2;

  const spanB=
    mid(c.slice(-52));

  const price=
    c[c.length-1].close;

  let direction="NONE";

  if(
    price>spanA &&
    price>spanB &&
    tenkan>kijun
  )
    direction="LONG";

  else if(
    price<spanA &&
    price<spanB &&
    tenkan<kijun
  )
    direction="SHORT";

  return {
    tenkan,
    kijun,
    spanA,
    spanB,
    direction
  };
}

function divergence(values){

  if(values.length<20)
    return {
      type:"NONE",
      side:"NONE"
    };

  const a=values.slice(-20);

  const first=Math.min(...a.slice(0,10));
  const second=Math.min(...a.slice(10));

  const firstH=Math.max(...a.slice(0,10));
  const secondH=Math.max(...a.slice(10));

  const r1=rsi(a.slice(0,10).concat([a[9]]));
  const r2=rsi(a.slice(10));

  if(
    second<first &&
    r2>r1
  )
    return {
      type:"BULLISH_DIVERGENCE",
      side:"LONG"
    };

  if(
    secondH>firstH &&
    r2<r1
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

function volumeInfo(c){

  const volumes=
    c.map(x=>x.volume);

  const current=
    volumes[volumes.length-1] || 0;

  const prev=
    volumes.slice(
      Math.max(0,volumes.length-21),
      -1
    );

  const average=
    prev.length
      ? prev.reduce(
          (s,x)=>s+x,
          0
        )/prev.length
      : current;

  const ratio=
    average
      ? current/average
      : 0;

  return {
    current,
    average,
    ratio,
    spike:ratio>=1.5,
    state:
      ratio>=1.5
        ? "SPIKE"
        : "NORMAL"
  };
}

function structure(c){

  if(c.length<5)
    return {
      bos:"NONE",
      choch:"NONE"
    };

  const a=c[c.length-1];
  const p=c[c.length-2];

  const highs=
    c.slice(-10,-1)
      .map(x=>x.high);

  const lows=
    c.slice(-10,-1)
      .map(x=>x.low);

  const hi=Math.max(...highs);
  const lo=Math.min(...lows);

  let bos="NONE";
  let choch="NONE";

  if(a.close>hi)
    bos="LONG";

  else if(a.close<lo)
    bos="SHORT";

  if(
    p.close<=hi &&
    a.close>hi
  )
    choch="LONG";

  if(
    p.close>=lo &&
    a.close<lo
  )
    choch="SHORT";

  return {
    bos,
    choch
  };
}

function hunt(c){

  if(c.length<5)
    return {
      side:"NONE",
      confirmed:false,
      sweepPrice:0,
      strength:0
    };

  const a=c[c.length-1];
  const p=c[c.length-2];

  const priorHigh=
    Math.max(
      ...c.slice(-10,-1)
        .map(x=>x.high)
    );

  const priorLow=
    Math.min(
      ...c.slice(-10,-1)
        .map(x=>x.low)
    );

  if(
    a.high>priorHigh &&
    a.close<a.open
  ){

    return {
      side:"SHORT",
      confirmed:true,
      sweepPrice:a.high,
      strength:75
    };
  }

  if(
    a.low<priorLow &&
    a.close>a.open
  ){

    return {
      side:"LONG",
      confirmed:true,
      sweepPrice:a.low,
      strength:75
    };
  }

  return {
    side:"NONE",
    confirmed:false,
    sweepPrice:0,
    strength:0
  };
}

function fvg(c){

  if(c.length<3)
    return {
      type:"NONE",
      top:0,
      bottom:0,
      sizePct:0
    };

  const a=c[c.length-3];
  const b=c[c.length-2];
  const d=c[c.length-1];

  if(
    d.low>a.high
  ){

    const bottom=a.high;
    const top=d.low;

    return {
      type:"LONG",
      top,
      bottom,
      sizePct:
        ((top-bottom)/d.close)*100
    };
  }

  if(
    d.high<a.low
  ){

    const top=a.low;
    const bottom=d.high;

    return {
      type:"SHORT",
      top,
      bottom,
      sizePct:
        ((top-bottom)/d.close)*100
    };
  }

  return {
    type:"NONE",
    top:0,
    bottom:0,
    sizePct:0
  };
}

function orderBlock(c){

  if(c.length<5)
    return {
      type:"NONE",
      price:0,
      strength:0
    };

  const a=c[c.length-2];
  const b=c[c.length-1];

  if(
    a.close<a.open &&
    b.close>b.open &&
    b.close>a.high
  )
    return {
      type:"LONG",
      price:a.low,
      strength:70
    };

  if(
    a.close>a.open &&
    b.close<b.open &&
    b.close<a.low
  )
    return {
      type:"SHORT",
      price:a.high,
      strength:70
    };

  return {
    type:"NONE",
    price:0,
    strength:0
  };
}

function candleInfo(c){

  const a=c[c.length-1];

  const range=
    Math.max(
      a.high-a.low,
      Number.EPSILON
    );

  const body=
    Math.abs(a.close-a.open);

  return {
    type:
      body/range>=0.6
        ? "STRONG"
        : "NORMAL",

    direction:
      a.close>a.open
        ? "LONG"
        : a.close<a.open
          ? "SHORT"
          : "NONE",

    strength:
      Math.min(
        100,
        body/range*100
      )
  };
}

function supportResistance(c){

  if(!c.length)
    return {
      support:0,
      resistance:0
    };

  const lows=
    c.slice(-30)
      .map(x=>x.low);

  const highs=
    c.slice(-30)
      .map(x=>x.high);

  return {
    support:Math.min(...lows),
    resistance:Math.max(...highs)
  };
}

function analyzeCandles(c){

  const closes=
    c.map(x=>x.close);

  const price=
    closes[closes.length-1];

  const ma7=sma(closes,7);
  const ma20=sma(closes,20);

  const prev7=
    sma(closes.slice(0,-1),7);

  const slope=
    ma7==null || prev7==null
      ? "NONE"
      : ma7>prev7
        ? "UP"
        : ma7<prev7
          ? "DOWN"
          : "FLAT";

  let trend="RANGE";

  if(
    ma7!=null &&
    ma20!=null
  ){

    if(
      ma7>ma20 &&
      price>=ma20
    )
      trend="BULLISH";

    else if(
      ma7<ma20 &&
      price<=ma20
    )
      trend="BEARISH";
  }

  const macdData=
    macd(closes);

  const rsiValue=
    rsi(closes);

  const ichi=
    ichimoku(c);

  const div=
    divergence(closes);

  const volume=
    volumeInfo(c);

  const st=
    structure(c);

  const h=
    hunt(c);

  const fv=
    fvg(c);

  const ob=
    orderBlock(c);

  const atrValue=
    atr(c);

  const adxValue=
    adx(c);

  const bb=
    bollingerWidth(closes);

  const sr=
    supportResistance(c);

  const candle=
    candleInfo(c);

  let long=0;
  let short=0;

  if(
    ma7!=null &&
    ma20!=null
  ){

    if(ma7>ma20)
      long+=15;

    if(ma7<ma20)
      short+=15;

    if(slope==="UP")
      long+=8;

    if(slope==="DOWN")
      short+=8;
  }

  if(macdData.direction==="LONG")
    long+=12;

  if(macdData.direction==="SHORT")
    short+=12;

  if(rsiValue>55)
    long+=6;

  if(rsiValue<45)
    short+=6;

  if(ichi.direction==="LONG")
    long+=10;

  if(ichi.direction==="SHORT")
    short+=10;

  if(div.side==="LONG")
    long+=12;

  if(div.side==="SHORT")
    short+=12;

  if(h.side==="LONG")
    long+=14;

  if(h.side==="SHORT")
    short+=14;

  if(fv.type==="LONG")
    long+=8;

  if(fv.type==="SHORT")
    short+=8;

  if(st.bos==="LONG")
    long+=10;

  if(st.bos==="SHORT")
    short+=10;

  if(st.choch==="LONG")
    long+=10;

  if(st.choch==="SHORT")
    short+=10;

  if(ob.type==="LONG")
    long+=8;

  if(ob.type==="SHORT")
    short+=8;

  if(volume.spike){

    if(candle.direction==="LONG")
      long+=8;

    if(candle.direction==="SHORT")
      short+=8;
  }

  long=Math.min(100,long);
  short=Math.min(100,short);

  const direction=
    long>short
      ? "LONG"
      : short>long
        ? "SHORT"
        : "WAIT";

  return {
    price,
    ma7,
    ma20,
    trend,
    maSlope:slope,
    touchMA7:
      ma7
        ? Math.abs(price-ma7)/price*100<0.35
        : false,
    touchMA20:
      ma20
        ? Math.abs(price-ma20)/price*100<0.35
        : false,
    volume,
    hunt:h,
    bos:st.bos,
    choch:st.choch,
    candle,
    fvg:fv,
    orderBlock:ob,
    support:sr.support,
    resistance:sr.resistance,
    rsi:rsiValue,
    macd:macdData,
    ichimoku:ichi,
    divergence:div,
    atr:
      price
        ? atrValue/price*100
        : 0,
    adx:adxValue,
    bollingerWidth:bb,
    market:{
      state:
        adxValue>=25
          ? "ACTIVE"
          : "NORMAL"
    },
    extra:{
      MACD:macdData,
      RSI:{
        value:rsiValue,
        direction:
          rsiValue>55
            ? "LONG"
            : rsiValue<45
              ? "SHORT"
              : "NONE"
      },
      ICHIMOKU:ichi,
      DIVERGENCE:div
    },
    longScore:long,
    shortScore:short,
    direction
  };
}

function convertedMA(
  oneMinute,
  tfData
){

  const events=[];

  const price=
    oneMinute.price;

  const list=[
    ["3m",7],
    ["3m",20],
    ["5m",7],
    ["5m",20],
    ["15m",7]
  ];

  for(const [source,period] of list){

    const x=tfData[source];

    if(!x)
      continue;

    const value=
      period===7
        ? x.ma7
        : x.ma20;

    if(!value)
      continue;

    const distance=
      Math.abs(
        price-value
      )/price*100;

    const slope=
      x.maSlope;

    let confirmation="NONE";

    if(
      distance<0.35 &&
      slope==="UP"
    )
      confirmation="CONFIRMED_LONG";

    if(
      distance<0.35 &&
      slope==="DOWN"
    )
      confirmation="CONFIRMED_SHORT";

    events.push({
      type:"TOUCH",
      source,
      period1m:
        period,
      ma:
        `MA${period}`,
      value,
      distancePct:
        distance,
      slope,
      confirmation
    });
  }

  return {events};
}

async function footprint(
  category,
  symbol
){

  try{

    const r=
      await bybit(
        "/v5/market/recent-trade",
        {
          category,
          symbol,
          limit:1000
        }
      );

    const trades=r.list||[];

    let buyVolume=0;
    let sellVolume=0;
    let buyNotional=0;
    let sellNotional=0;

    for(const t of trades){

      const size=
        Number(t.size||0);

      const price=
        Number(t.price||0);

      const notional=
        size*price;

      if(t.side==="Buy"){

        buyVolume+=size;
        buyNotional+=notional;

      }else{

        sellVolume+=size;
        sellNotional+=notional;
      }
    }

    const delta=
      buyVolume-sellVolume;

    const total=
      buyVolume+sellVolume;

    return {
      buyVolume,
      sellVolume,
      delta,
      deltaPercent:
        total
          ? delta/total*100
          : 0,
      buyNotional,
      sellNotional,
      buyNotionalShare:
        buyNotional+sellNotional
          ? buyNotional/
            (buyNotional+sellNotional)*100
          : 0,
      sellNotionalShare:
        buyNotional+sellNotional
          ? sellNotional/
            (buyNotional+sellNotional)*100
          : 0,
      trades:trades.length,
      largeTradeNotional:
        trades.length
          ? Math.max(
              ...trades.map(
                x =>
                  Number(x.price||0)*
                  Number(x.size||0)
              )
            )
          : 0,
      pressure:
        delta>0
          ? "BUY"
          : delta<0
            ? "SELL"
            : "NEUTRAL"
    };

  }catch(e){

    return {
      error:e.message
    };
  }
}

async function walls(
  category,
  symbol
){

  try{

    const r=
      await bybit(
        "/v5/market/orderbook",
        {
          category,
          symbol,
          limit:50
        }
      );

    const bids=
      (r.b||[]).map(
        x=>[
          Number(x[0]),
          Number(x[1])
        ]
      );

    const asks=
      (r.a||[]).map(
        x=>[
          Number(x[0]),
          Number(x[1])
        ]
      );

    const t=
      await ticker(
        category,
        symbol
      );

    const price=
      Number(t.lastPrice||0);

    const makeLevels=
      arr =>
        arr
          .map(
            ([p,s])=>({
              price:p,
              size:s,
              notional:p*s,
              distancePct:
                price
                  ? Math.abs(p-price)/
                    price*100
                  : 0
            })
          )
          .sort(
            (a,b)=>
              b.notional-a.notional
          )
          .slice(0,10);

    const buyLevels=
      makeLevels(bids);

    const sellLevels=
      makeLevels(asks);

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

    const buy=
      buyLevels[0]||{
        price:0,
        size:0,
        notional:0,
        distancePct:0
      };

    const sell=
      sellLevels[0]||{
        price:0,
        size:0,
        notional:0,
        distancePct:0
      };

    const total=
      buyLiquidity+
      sellLiquidity;

    return {
      buy,
      sell,
      buyLevels,
      sellLevels,
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
      buyStrength:
        Math.min(
          100,
          total
            ? buyLiquidity/total*200
            : 0
        ),
      sellStrength:
        Math.min(
          100,
          total
            ? sellLiquidity/total*200
            : 0
        ),
      buyNear:
        buy.distancePct<1,
      sellNear:
        sell.distancePct<1
    };

  }catch(e){

    return {
      error:e.message
    };
  }
}

async function marketData(
  category,
  symbol
){

  if(category!=="linear"){

    return {
      available:false,
      message:
        "OI و Funding برای Spot کاربرد ندارند."
    };
  }

  try{

    const t=
      await ticker(
        "linear",
        symbol
      );

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

    const oiList=
      oi.list||[];

    const current=
      Number(
        oiList[0]?.openInterest||0
      );

    const previous=
      Number(
        oiList[1]?.openInterest||current
      );

    const funding=
      Number(
        t.fundingRate||0
      );

    return {
      openInterest:current,
      openInterestPrevious:previous,
      openInterestChange:
        previous
          ? (current-previous)/
            previous*100
          : 0,
      fundingRate:funding,
      fundingPrevious:
        Number(
          t.nextFundingTime
            ? funding
            : funding
        ),
      fundingChange:0,
      change24h:
        Number(
          t.price24hPcnt||0
        )*100
    };

  }catch(e){

    return {
      error:e.message
    };
  }
}

function reasonsFor(
  tf,
  key
){

  const r=[];

  if(tf.touchMA20)
    r.push({
      side:
        tf.trend==="BULLISH"
          ? "LONG"
          : "SHORT",
      text:
        `برخورد MA20 در ${key}m`
    });

  if(tf.touchMA7)
    r.push({
      side:
        tf.trend==="BULLISH"
          ? "LONG"
          : "SHORT",
      text:
        `برخورد MA7 در ${key}m`
    });

  if(tf.maSlope==="UP")
    r.push({
      side:"LONG",
      text:
        `شیب MA صعودی ${key}m`
    });

  if(tf.maSlope==="DOWN")
    r.push({
      side:"SHORT",
      text:
        `شیب MA نزولی ${key}m`
    });

  if(tf.volume.spike)
    r.push({
      side:
        tf.candle.direction==="LONG"
          ? "LONG"
          : "SHORT",
      text:
        `افزایش غیرعادی حجم کوتاه‌مدت`
    });

  if(tf.macd.direction==="LONG")
    r.push({
      side:"LONG",
      text:
        `MACD صعودی ${key}m`
    });

  if(tf.macd.direction==="SHORT")
    r.push({
      side:"SHORT",
      text:
        `MACD نزولی ${key}m`
    });

  if(tf.rsi>55)
    r.push({
      side:"LONG",
      text:
        `RSI صعودی ${key}m`
    });

  if(tf.rsi<45)
    r.push({
      side:"SHORT",
      text:
        `RSI نزولی ${key}m`
    });

  if(tf.ichimoku.direction==="LONG")
    r.push({
      side:"LONG",
      text:
        `Ichimoku صعودی ${key}m`
    });

  if(tf.ichimoku.direction==="SHORT")
    r.push({
      side:"SHORT",
      text:
        `Ichimoku نزولی ${key}m`
    });

  if(tf.divergence.side==="LONG")
    r.push({
      side:"LONG",
      text:
        `واگرایی صعودی ${key}m`
    });

  if(tf.divergence.side==="SHORT")
    r.push({
      side:"SHORT",
      text:
        `واگرایی نزولی ${key}m`
    });

  if(tf.hunt.side!=="NONE")
    r.push({
      side:tf.hunt.side,
      text:
        `Liquidity Hunt ${key}m`
    });

  if(tf.bos!=="NONE")
    r.push({
      side:tf.bos,
      text:
        `BOS ${key}m`
    });

  if(tf.choch!=="NONE")
    r.push({
      side:tf.choch,
      text:
        `CHoCH ${key}m`
    });

  if(tf.fvg.type!=="NONE")
    r.push({
      side:tf.fvg.type,
      text:
        `FVG ${key}m`
    });

  if(tf.orderBlock.type!=="NONE")
    r.push({
      side:tf.orderBlock.type,
      text:
        `Order Block ${key}m`
    });

  return r;
}

async function analyze(
  symbol,
  requestedCategory="auto"
){

  const resolved=
    await resolveCategory(
      symbol,
      requestedCategory
    );

  const {
    category
  }=resolved;

  const finalSymbol=
    resolved.symbol;

  const t=
    await ticker(
      category,
      finalSymbol
    );

  const price=
    Number(t.lastPrice||0);

  const tfData={};
  let allReasons=[];

  for(const tf of TIMEFRAMES){

    const c=
      await klines(
        category,
        finalSymbol,
        tf,
        130
      );

    const a=
      analyzeCandles(c);

    tfData[tf]=a;

    allReasons.push(
      ...reasonsFor(a,tf)
    );
  }

  const one=
    tfData["1"];

  const converted=
    convertedMA(
      one,
      tfData
    );

  for(const e of converted.events){

    if(
      e.confirmation===
      "CONFIRMED_LONG"
    ){

      allReasons.push({
        side:"LONG",
        text:
          `${e.ma} ${e.source} → ${e.ma} روی 1m: برخورد و تأیید صعودی`
      });
    }

    if(
      e.confirmation===
      "CONFIRMED_SHORT"
    ){

      allReasons.push({
        side:"SHORT",
        text:
          `${e.ma} ${e.source} → ${e.ma} روی 1m: برخورد و تأیید نزولی`
      });
    }
  }

  const longScores=
    TIMEFRAMES.map(
      x=>tfData[x].longScore
    );

  const shortScores=
    TIMEFRAMES.map(
      x=>tfData[x].shortScore
    );

  const long=
    Math.round(
      longScores.reduce(
        (s,x)=>s+x,
        0
      )/TIMEFRAMES.length
    );

  const short=
    Math.round(
      shortScores.reduce(
        (s,x)=>s+x,
        0
      )/TIMEFRAMES.length
    );

  const longBonus=
    converted.events.filter(
      x =>
        x.confirmation===
        "CONFIRMED_LONG"
    ).length*3;

  const shortBonus=
    converted.events.filter(
      x =>
        x.confirmation===
        "CONFIRMED_SHORT"
    ).length*3;

  const finalLong=
    Math.min(
      100,
      long+longBonus
    );

  const finalShort=
    Math.min(
      100,
      short+shortBonus
    );

  const direction=
    finalLong>finalShort
      ? "LONG"
      : finalShort>finalLong
        ? "SHORT"
        : "WAIT";

  const score=
    Math.max(
      finalLong,
      finalShort
    );

  const fp=
    await footprint(
      category,
      finalSymbol
    );

  const wall=
    await walls(
      category,
      finalSymbol
    );

  const market=
    await marketData(
      category,
      finalSymbol
    );

  let pumpScore=0;
  let dumpScore=0;

  if(
    one.volume?.spike &&
    price>0
  ){

    pumpScore=
      one.candle.direction==="LONG"
        ? 80
        : 35;

    dumpScore=
      one.candle.direction==="SHORT"
        ? 80
        : 35;
  }

  if(
    direction==="LONG"
  )
    pumpScore=
      Math.max(
        pumpScore,
        score
      );

  if(
    direction==="SHORT"
  )
    dumpScore=
      Math.max(
        dumpScore,
        score
      );

  return {
    ok:true,
    symbol:finalSymbol,
    category,
    price,
    direction,
    score,
    longScore:finalLong,
    shortScore:finalShort,
    pumpScore,
    dumpScore,
    timeframes:tfData,
    convertedMA1m:converted,
    footprint:fp,
    walls:wall,
    market,
    reasons:allReasons.slice(0,40),
    generatedAt:Date.now(),
    liquidation:{
      available:false,
      message:
        "داده لیکوئیدیشن تجمیعی از REST عمومی Bybit برای این اسکنر در دسترس نیست."
    },
    search:await findSymbol(finalSymbol)
  };
}

async function scanMarkets(){

  const linear=
    await getLinearSymbols();

  const list=
    linear.filter(
      x =>
        x.status==="Trading" &&
        x.quoteCoin==="USDT" &&
        !STABLES.has(
          String(x.baseCoin||"")
            .toUpperCase()
        )
    );

  return list;
}

async function scan(offset=0){

  const markets=
    await scanMarkets();

  if(!markets.length)
    return {
      ok:true,
      batchSize:0,
      totalMarkets:0,
      results:[],
      nextOffset:0
    };

  const start=
    offset % markets.length;

  const selected=[];

  for(
    let i=0;
    i<Math.min(
      SCAN_BATCH,
      markets.length
    );
    i++
  ){

    selected.push(
      markets[
        (start+i)%
        markets.length
      ]
    );
  }

  const results=[];

  for(const m of selected){

    try{

      const d=
        await analyze(
          m.symbol,
          "linear"
        );

      results.push({
        symbol:d.symbol,
        direction:d.direction,
        score:d.score,
        longScore:d.longScore,
        shortScore:d.shortScore,
        pumpScore:d.pumpScore,
        dumpScore:d.dumpScore
      });

    }catch(e){

      results.push({
        symbol:m.symbol,
        direction:"WAIT",
        score:0,
        longScore:0,
        shortScore:0,
        error:e.message
      });
    }
  }

  results.sort(
    (a,b)=>
      b.score-a.score
  );

  return {
    ok:true,
    batchSize:selected.length,
    totalMarkets:markets.length,
    results,
    nextOffset:
      (start+selected.length)%
      markets.length
  };
}

function cors(r){

  const h=
    new Headers(
      r.headers
    );

  h.set(
    "access-control-allow-origin",
    "*"
  );

  h.set(
    "access-control-allow-methods",
    "GET,OPTIONS"
  );

  h.set(
    "access-control-allow-headers",
    "Content-Type"
  );

  return new Response(
    r.body,
    {
      status:r.status,
      headers:h
    }
  );
}

export default {

  async fetch(request,env){

    const url=
      new URL(request.url);

    if(
      request.method==="OPTIONS"
    )
      return cors(
        new Response(null,{status:204})
      );

    try{

      if(
        url.pathname===
        "/api/health"
      ){

        return cors(
          json({
            ok:true,
            service:
              "Bybit Smart Money Scanner",
            version:"V10",
            timeframes:
              TIMEFRAMES,
            scanBatch:
              SCAN_BATCH,
            deepLimit:
              DEEP_LIMIT,
            minimumSignalScore:
              MIN_SIGNAL_SCORE,
            watchScore:
              WATCH_SCORE,
            defaultStrictness:
              DEFAULT_STRICTNESS,
            signalMethods:
              SIGNAL_METHODS,
            convertedMA:
              CONVERTED_MAS,
            features:[
              "MA",
              "MACD",
              "RSI",
              "Ichimoku",
              "Divergence",
              "Liquidity Hunt",
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
              "OI Current/Previous/Change",
              "Funding Current/Previous/Change",
              "Footprint",
              "Delta"
            ]
          })
        );
      }

      if(
        url.pathname===
        "/api/analyze"
      ){

        const symbol=
          url.searchParams.get(
            "symbol"
          );

        const category=
          url.searchParams.get(
            "category"
          ) || "auto";

        if(!symbol)
          return cors(
            json({
              ok:false,
              error:
                "symbol required"
            },400)
          );

        const d=
          await analyze(
            symbol,
            category
          );

        return cors(
          json(d)
        );
      }

      if(
        url.pathname===
        "/api/scan"
      ){

        const offset=
          Number(
            url.searchParams.get(
              "offset"
            ) || 0
          );

        const d=
          await scan(offset);

        return cors(
          json(d)
        );
      }

      if(
        env &&
        env.ASSETS
      ){

        return env.ASSETS.fetch(
          request
        );
      }

      return cors(
        new Response(
          "Not Found",
          {
            status:404
          }
        )
      );

    }catch(e){

      return cors(
        json({
          ok:false,
          error:e.message ||
            "Internal Worker Error"
        },500)
      );
    }
  }
};
