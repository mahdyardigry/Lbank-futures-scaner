const TIMEFRAMES = [
  { value: "1", label: "1 دقیقه" },
  { value: "3", label: "3 دقیقه" },
  { value: "5", label: "5 دقیقه" },
  { value: "15", label: "15 دقیقه" },
  { value: "30", label: "30 دقیقه" },
  { value: "60", label: "1 ساعت" },
  { value: "120", label: "2 ساعت" },
  { value: "240", label: "4 ساعت" },
  { value: "D", label: "1 روز" }
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: cors
      });
    }

    try {

      // ================================
      // HOME
      // ================================

      if (url.pathname === "/") {
        return new Response(HTML, {
          headers: {
            "Content-Type": "text/html; charset=UTF-8",
            ...cors
          }
        });
      }


      // ================================
      // SEARCH SYMBOL
      // ================================

      if (
        url.pathname === "/api/search" &&
        request.method === "GET"
      ) {

        const symbol =
          String(
            url.searchParams.get("symbol") || ""
          )
          .trim()
          .toUpperCase();

        if (!symbol) {
          return json({
            ok: false,
            error: "symbol required"
          }, cors, 400);
        }

        const response = await fetch(
          "https://api.bybit.com/v5/market/instruments-info" +
          "?category=linear" +
          "&symbol=" +
          encodeURIComponent(symbol)
        );

        const data = await response.json();

        if (data.retCode !== 0) {
          return json({
            ok: false,
            error: data.retMsg || "Bybit error"
          }, cors, 500);
        }

        const list =
          data.result?.list || [];

        if (!list.length) {
          return json({
            ok: false,
            exists: false,
            symbol,
            error: "این ارز در Bybit Futures پیدا نشد"
          }, cors);
        }

        const item = list[0];

        return json({
          ok: true,
          exists: true,
          symbol: item.symbol,
          status: item.status,
          baseCoin: item.baseCoin,
          quoteCoin: item.quoteCoin,
          settleCoin: item.settleCoin,
          contractType: item.contractType,
          launchTime: item.launchTime,
          tickSize: item.priceFilter?.tickSize,
          minOrderQty: item.lotSizeFilter?.minOrderQty
        }, cors);
      }


      // ================================
      // KLINE
      // ================================

      if (
        url.pathname === "/api/kline" &&
        request.method === "GET"
      ) {

        const symbol =
          String(
            url.searchParams.get("symbol") || ""
          )
          .trim()
          .toUpperCase();

        const interval =
          String(
            url.searchParams.get("interval") || "15"
          );

        let limit =
          Number(
            url.searchParams.get("limit") || 100
          );

        if (!Number.isFinite(limit)) {
          limit = 100;
        }

        limit = Math.min(
          Math.max(limit, 20),
          1000
        );

        if (!symbol) {
          return json({
            ok: false,
            error: "symbol required"
          }, cors, 400);
        }

        const bybitUrl =
          "https://api.bybit.com/v5/market/kline" +
          "?category=linear" +
          "&symbol=" +
          encodeURIComponent(symbol) +
          "&interval=" +
          encodeURIComponent(interval) +
          "&limit=" +
          limit;

        const response =
          await fetch(bybitUrl);

        const data =
          await response.json();

        if (data.retCode !== 0) {
          return json({
            ok: false,
            error: data.retMsg || "Bybit error"
          }, cors, 500);
        }

        const rows =
          (data.result?.list || [])
          .reverse()
          .map(item => ({
            time: Number(item[0]),
            open: Number(item[1]),
            high: Number(item[2]),
            low: Number(item[3]),
            close: Number(item[4]),
            volume: Number(item[5])
          }));

        return json({
          ok: true,
          symbol,
          interval,
          rows
        }, cors);
      }


      // ================================
      // ANALYZE
      // ================================

      if (
        url.pathname === "/api/analyze" &&
        request.method === "GET"
      ) {

        const symbol =
          String(
            url.searchParams.get("symbol") || ""
          )
          .trim()
          .toUpperCase();

        if (!symbol) {
          return json({
            ok: false,
            error: "symbol required"
          }, cors, 400);
        }

        const result =
          await analyzeSymbol(symbol);

        return json(
          result,
          cors,
          result.ok ? 200 : 500
        );
      }


      // ================================
      // UNKNOWN
      // ================================

      return json({
        ok: false,
        error: "API endpoint not found",
        path: url.pathname
      }, cors, 404);


    } catch (error) {

      return json({
        ok: false,
        error: "Worker error",
        detail: error?.message || String(error)
      }, cors, 500);
    }
  }
};


// ======================================================
// ANALYZE SYMBOL
// ======================================================

async function analyzeSymbol(symbol) {

  const results = [];

  for (const tf of TIMEFRAMES) {

    try {

      const data =
        await getKlines(
          symbol,
          tf.value,
          100
        );

      if (!data.length) {
        continue;
      }

      results.push(
        analyzeTimeframe(
          symbol,
          tf,
          data
        )
      );

    } catch (error) {

      console.error(
        symbol,
        tf.value,
        error
      );

    }
  }

  if (!results.length) {

    return {
      ok: false,
      symbol,
      error:
        "هیچ داده‌ای برای این ارز در Bybit Futures پیدا نشد."
    };
  }


  const bearish =
    results.filter(
      x => x.trend === "BEARISH"
    ).length;

  const bullish =
    results.filter(
      x => x.trend === "BULLISH"
    ).length;


  let direction = "WAIT";

  if (bearish > bullish) {
    direction = "SHORT";
  }

  if (bullish > bearish) {
    direction = "LONG";
  }


  const best =
    [...results]
    .sort(
      (a, b) =>
        b.score -
        a.score
    )[0];


  return {
    ok: true,
    symbol,

    direction,

    bullish,
    bearish,

    bestTimeframe:
      best.timeframe,

    bestScore:
      best.score,

    timeframes:
      results
  };
}


// ======================================================
// GET KLINES
// ======================================================

async function getKlines(
  symbol,
  interval,
  limit = 100
) {

  const url =
    "https://api.bybit.com/v5/market/kline" +
    "?category=linear" +
    "&symbol=" +
    encodeURIComponent(symbol) +
    "&interval=" +
    encodeURIComponent(interval) +
    "&limit=" +
    limit;

  const response =
    await fetch(url);

  const data =
    await response.json();

  if (data.retCode !== 0) {
    throw new Error(
      data.retMsg ||
      "Bybit error"
    );
  }

  return (
    data.result?.list || []
  )
  .reverse()
  .map(item => ({
    time: Number(item[0]),
    open: Number(item[1]),
    high: Number(item[2]),
    low: Number(item[3]),
    close: Number(item[4]),
    volume: Number(item[5])
  }));
}


// ======================================================
// TIMEFRAME ANALYSIS
// ======================================================

function analyzeTimeframe(
  symbol,
  tf,
  rows
) {

  const closes =
    rows.map(
      x => x.close
    );

  const highs =
    rows.map(
      x => x.high
    );

  const lows =
    rows.map(
      x => x.low
    );

  const volumes =
    rows.map(
      x => x.volume
    );


  const price =
    closes.at(-1);

  const ma7 =
    sma(closes, 7);

  const ma20 =
    sma(closes, 20);

  const volume7 =
    sma(volumes, 7);

  const volume20 =
    sma(volumes, 20);


  let trend =
    "RANGE";

  if (ma7 > ma20) {
    trend = "BULLISH";
  }

  if (ma7 < ma20) {
    trend = "BEARISH";
  }


  const distance =
    Math.abs(ma7 - ma20) /
    ma20;


  const range =
    distance < 0.0015;


  const previous =
    closes.at(-2);


  let pullback =
    false;


  if (
    trend === "BULLISH" &&
    previous <= ma7 &&
    price > ma7
  ) {
    pullback = true;
  }


  if (
    trend === "BEARISH" &&
    previous >= ma7 &&
    price < ma7
  ) {
    pullback = true;
  }


  // ================================
  // STRUCTURE
  // ================================

  const lastHigh =
    Math.max(
      ...highs.slice(-10, -1)
    );

  const lastLow =
    Math.min(
      ...lows.slice(-10, -1)
    );


  const bosUp =
    price > lastHigh;

  const bosDown =
    price < lastLow;


  let structure =
    "RANGE";

  if (bosUp) {
    structure = "BULLISH";
  }

  if (bosDown) {
    structure = "BEARISH";
  }


  // ================================
  // FVG
  // ================================

  let fvg =
    null;

  if (rows.length >= 3) {

    const a =
      rows.at(-3);

    const c =
      rows.at(-1);


    if (c.low > a.high) {

      fvg = {
        type: "BULLISH",
        bottom: a.high,
        top: c.low
      };

    }

    if (c.high < a.low) {

      fvg = {
        type: "BEARISH",
        bottom: c.high,
        top: a.low
      };

    }
  }


  // ================================
  // VOLUME
  // ================================

  const currentVolume =
    volumes.at(-1);

  const volumeSpike =
    currentVolume >
    volume20 * 1.5;


  // ================================
  // SCORE
  // ================================

  let score = 50;


  if (trend === "BULLISH") {
    score += 10;
  }

  if (trend === "BEARISH") {
    score += 10;
  }


  if (pullback) {
    score += 10;
  }


  if (volumeSpike) {
    score += 10;
  }


  if (
    bosUp ||
    bosDown
  ) {
    score += 10;
  }


  if (range) {
    score -= 15;
  }


  score =
    Math.max(
      0,
      Math.min(
        100,
        score
      )
    );


  return {

    timeframe:
      tf.label,

    interval:
      tf.value,

    price,

    ma7,

    ma20,

    trend,

    range,

    pullback,

    structure,

    bos:
      bosUp
        ? "BULLISH"
        : bosDown
        ? "BEARISH"
        : "NONE",

    fvg,

    volume:
      currentVolume,

    volume7,

    volume20,

    volumeSpike,

    score
  };
}


// ======================================================
// SMA
// ======================================================

function sma(data, period) {

  if (
    !data ||
    data.length < period
  ) {
    return null;
  }

  const part =
    data.slice(
      -period
    );

  return (
    part.reduce(
      (sum, value) =>
        sum + value,
      0
    ) / period
  );
}


// ======================================================
// JSON
// ======================================================

function json(
  data,
  corsHeaders,
  status = 200
) {

  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type":
          "application/json; charset=UTF-8",
        ...corsHeaders
      }
    }
  );
}


// ======================================================
// HTML
// ======================================================

const HTML = `
<!DOCTYPE html>

<html lang="fa" dir="rtl">

<head>

<meta charset="UTF-8">

<meta
name="viewport"
content="width=device-width, initial-scale=1.0">

<title>Crypto Scanner V5</title>

<style>

*{
box-sizing:border-box;
}

body{
margin:0;
background:#080c12;
color:#fff;
font-family:Arial,Tahoma,sans-serif;
}

.container{
max-width:800px;
margin:auto;
padding:15px;
}

.card{
background:#141a22;
border:1px solid #293241;
border-radius:15px;
padding:15px;
margin-bottom:12px;
}

h1{
font-size:21px;
margin:5px 0 15px;
}

.row{
display:flex;
gap:8px;
flex-wrap:wrap;
}

input,button{
min-height:46px;
border-radius:10px;
border:1px solid #394555;
padding:10px 13px;
font-size:15px;
}

input{
flex:1;
min-width:180px;
background:#080c12;
color:white;
direction:ltr;
}

button{
background:#238636;
color:white;
border:0;
font-weight:bold;
cursor:pointer;
}

button:active{
transform:scale(.98);
}

.grid{
display:grid;
grid-template-columns:1fr 1fr;
gap:8px;
}

.box{
background:#080c12;
border-radius:10px;
padding:12px;
text-align:center;
}

.label{
font-size:12px;
color:#8b949e;
margin-bottom:6px;
}

.value{
font-size:16px;
font-weight:bold;
}

.signal{
margin-top:12px;
padding:18px;
background:#080c12;
border-radius:12px;
text-align:center;
font-size:22px;
font-weight:bold;
}

.info{
color:#8b949e;
font-size:13px;
line-height:1.8;
}

.tf{
display:flex;
justify-content:space-between;
padding:10px;
margin-top:5px;
background:#080c12;
border-radius:9px;
}

.good{
color:#3fb950;
}

.bad{
color:#ff5252;
}

.wait{
color:#f2cc60;
}

</style>

</head>

<body>

<div class="container">

<h1>📊 Crypto Scanner V5</h1>

<div class="card">

<div class="row">

<input
id="symbol"
value="BTCUSDT"
placeholder="BTCUSDT">

<button
onclick="scan()">
🔍 اسکن
</button>

</div>

<p
id="status"
class="info">
نام ارز را وارد کن و اسکن را بزن.
</p>

</div>


<div
id="result"
style="display:none">

<div class="card">

<div class="grid">

<div class="box">
<div class="label">قیمت</div>
<div id="price" class="value">-</div>
</div>

<div class="box">
<div class="label">جهت کلی</div>
<div id="direction" class="value">-</div>
</div>

<div class="box">
<div class="label">تایم‌فریم صعودی</div>
<div id="bullish" class="value">-</div>
</div>

<div class="box">
<div class="label">تایم‌فریم نزولی</div>
<div id="bearish" class="value">-</div>
</div>

</div>

<div
id="signal"
class="signal">
WAIT
</div>

</div>


<div class="card">

<h3>🎯 بهترین تایم‌فریم</h3>

<div class="grid">

<div class="box">
<div class="label">تایم‌فریم</div>
<div id="bestTf" class="value">-</div>
</div>

<div class="box">
<div class="label">امتیاز</div>
<div id="bestScore" class="value">-</div>
</div>

</div>

</div>


<div class="card">

<h3>🌐 تأیید چندتایم‌فریمی</h3>

<div id="timeframes"></div>

</div>

</div>

</div>


<script>

function fmt(value){

if(
value === null ||
value === undefined
){
return "-";
}

return Number(value)
.toLocaleString(
"en-US",
{
maximumFractionDigits:8
}
);

}


async function scan(){

const input =
document.getElementById(
"symbol"
);

const symbol =
input.value
.trim()
.toUpperCase();

const status =
document.getElementById(
"status"
);

if(!symbol){

status.textContent =
"❌ نماد را وارد کن.";

return;
}

status.textContent =
"⏳ در حال اسکن Bybit Futures...";

document.getElementById(
"result"
).style.display="none";


try{

const search =
await fetch(
"/api/search?symbol="+
encodeURIComponent(symbol)
);

const searchData =
await search.json();

if(
!searchData.ok ||
!searchData.exists
){

throw new Error(
"❌ این ارز در Bybit Futures موجود نیست."
);

}


const response =
await fetch(
"/api/analyze?symbol="+
encodeURIComponent(symbol)
);

const data =
await response.json();

if(!data.ok){

throw new Error(
data.error ||
"خطای اسکن"
);

}


const last =
data.timeframes[
data.timeframes.length-1
];

document.getElementById(
"price"
).textContent =
fmt(last.price);

document.getElementById(
"direction"
).textContent =
data.direction;

document.getElementById(
"bullish"
).textContent =
data.bullish;

document.getElementById(
"bearish"
).textContent =
data.bearish;

document.getElementById(
"bestTf"
).textContent =
data.bestTimeframe;

document.getElementById(
"bestScore"
).textContent =
data.bestScore+
" / 100";


let signal =
"🟡 WAIT";

if(
data.direction === "LONG"
){
signal =
"🟢 LONG";
}

if(
data.direction === "SHORT"
){
signal =
"🔴 SHORT";
}

document.getElementById(
"signal"
).textContent =
signal;


const box =
document.getElementById(
"timeframes"
);

box.innerHTML="";


data.timeframes.forEach(
tf => {

let icon="🟡";

if(
tf.trend === "BULLISH"
){
icon="🟢";
}

if(
tf.trend === "BEARISH"
){
icon="🔴";
}

box.innerHTML +=
'<div class="tf">'+
'<span>'+
icon+" "+
tf.timeframe+
'</span>'+
'<span>'+
tf.trend+
" | "+
tf.score+
"/100"+
'</span>'+
'</div>';

});


document.getElementById(
"result"
).style.display="block";

status.textContent =
"✅ اسکن کامل شد.";

}
catch(error){

status.textContent =
error.message;

}

}

</script>

</body>

</html>
`;
