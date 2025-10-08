// tech-price-vs-target-list.mjs
// Guaranteed 10-20 rows: handpicked large caps, relaxed filters by default.
//
// Flags:
//   --tickers "AAPL,MSFT,..."
//   --priceSource yahoo|ib|auto     (default: yahoo)
//   --minCap 2000000000             (default: 0 -> no cap filter)
//   --sectorRegex "(Technology|Communication Services)" (optional)
//   --requireTarget true|false      (default: false)
//   --requireSector true|false      (default: false)
//   --requireCap true|false         (default: false)
//   --ibPort 7497 --clientId 90
//   --out tech_price_vs_target_sample
//   --concurrency 6
//
// Usage examples:
//   node src/tech-price-vs-target-list.mjs
//   node src/tech-price-vs-target-list.mjs --priceSource auto --ibPort 7496 --clientId 88
//   node src/tech-price-vs-target-list.mjs --requireTarget true --minCap 2000000000 --sectorRegex "(Technology|Communication Services)"

import fs from "fs/promises";
import pLimit from "p-limit";
import yahooFinance from "yahoo-finance2";
import { IBApi, EventName } from "@stoqey/ib";

function arg(k, def) { const i = process.argv.indexOf(`--${k}`); return i>-1 && process.argv[i+1] ? process.argv[i+1] : def; }
const tickersArg = arg("tickers", "");
const tickers = tickersArg
  ? tickersArg.split(",").map(s=>s.trim().toUpperCase()).filter(Boolean)
  : ["AAPL","MSFT","NVDA","GOOGL","META","AMZN","ORCL","AVGO","ADBE","NFLX",
     "CRM","AMD","INTC","MU","NOW","PANW","SNOW","SHOP","UBER","TSLA"];

const priceSource = (arg("priceSource","yahoo")||"yahoo").toLowerCase(); // yahoo|ib|auto
const minCap = Number(arg("minCap","0"));
const sectorRegexStr = arg("sectorRegex","");
const sectorRegex = sectorRegexStr ? new RegExp(sectorRegexStr, "i") : null;

const requireTarget = /^true$/i.test(arg("requireTarget","false"));
const requireSector = /^true$/i.test(arg("requireSector","false"));
const requireCap    = /^true$/i.test(arg("requireCap","false"));

const ibHost = arg("ibHost","127.0.0.1");
const ibPort = Number(arg("ibPort","7497"));
const clientId = Number(arg("clientId","90"));
const outBase = arg("out","tech_price_vs_target_sample");
const concurrency = Number(arg("concurrency","6"));

const limit = pLimit(concurrency);
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
const N = (x)=>Number.isFinite(Number(x)) ? Number(x) : NaN;

function ibContract(sym){ return { symbol:sym, secType:"STK", exchange:"SMART", currency:"USD" }; }
function connectIB(ib){ return new Promise(res=>{ ib.once(EventName.nextValidId, ()=>res(true)); ib.connect(); }); }
function getIbSnapshotPrice(ib, symbol, timeoutMs=8000){
  return new Promise((resolve)=>{
    const id = Math.floor(Math.random()*1e6);
    let done=false;
    const onTick=(tid,field,price)=>{ if(tid===id && field===4 && price>0){ cleanup(); done=true; resolve(price); } };
    const timer=setTimeout(()=>{ if(!done){ cleanup(); resolve(NaN); } },timeoutMs);
    function cleanup(){ clearTimeout(timer); try{ ib.cancelMktData(id); }catch{} ib.off(EventName.tickPrice,onTick); }
    ib.on(EventName.tickPrice,onTick);
    ib.reqMktData(id, ibContract(symbol), "", true, false);
  });
}

async function yfQuote(sym){
  try {
    const q = await yahooFinance.quote(sym);
    return {
      ticker: (q?.symbol||"").toUpperCase(),
      price: N(q?.regularMarketPrice) || N(q?.postMarketPrice) || N(q?.preMarketPrice) || NaN,
      marketCap: N(q?.marketCap),
      shortName: q?.shortName || "",
      longName: q?.longName || "",
      quoteType: q?.quoteType || ""
    };
  } catch { return null; }
}

function firstNum(...xs){
  for (const x of xs) { const v = N(x?.raw ?? x); if (Number.isFinite(v)) return v; }
  return NaN;
}

async function yfSummary(sym){
  // Try multiple modules for target/sector to maximize hit rate
  const modules = ["financialData","summaryProfile","assetProfile","price","earningsTrend"];
  for (let i=0;i<3;i++){
    try{
      const r = await yahooFinance.quoteSummary(sym, { modules });
      const fd = r?.financialData || {};
      const sp = r?.summaryProfile || r?.assetProfile || {};
      const price = r?.price || {};
      const et = r?.earningsTrend || {};
      // target fallback order
      const target = firstNum(
        fd?.targetMeanPrice,
        et?.trend?.[0]?.targetMeanPrice,
        price?.targetMeanPrice
      );
      const sector = sp?.sector || price?.sector || "";
      const industry = sp?.industry || price?.industry || "";
      return { target, sector, industry };
    }catch(e){ await sleep(250*(i+1)); }
  }
  return null;
}

(async()=>{
  console.log(`Fetching ${tickers.length} tickers…`);
  const rows=[];
  const skips=[];

  await Promise.all(tickers.map(t=>limit(async()=>{
    const q = await yfQuote(t);
    if(!q || !q.ticker){ skips.push({t, why:"no_quote"}); return; }

    // ETF guard (just in case)
    if (/ETF/i.test(q.quoteType||"") || /ETF/i.test(q.longName||"") || /ETF/i.test(q.shortName||"")){
      skips.push({t, why:"ETF"}); return;
    }

    const s = await yfSummary(t) || {};
    const target = Number.isFinite(s?.target) ? s.target : NaN;
    const sector = s?.sector || "";
    const industry = s?.industry || "";

    // Soft filters (only enforced if --requireX true)
    if (requireSector && sectorRegex && !sectorRegex.test(sector||"")) { skips.push({t, why:`sector=${sector||"?"}`}); return; }
    if (requireCap && !(q.marketCap>0) ) { skips.push({t, why:`cap=${q.marketCap}`}); return; }
    if (requireCap && q.marketCap < minCap) { skips.push({t, why:`cap_lt_min=${q.marketCap}`}); return; }
    if (requireTarget && !(target>0)) { skips.push({t, why:"no_target"}); return; }

    rows.push({
      ticker: q.ticker,
      name: q.longName || q.shortName || "",
      sector, industry,
      marketCap: q.marketCap || null,
      price: q.price || null,
      target: Number.isFinite(target) ? target : null,
      ratio: (Number.isFinite(q.price) && Number.isFinite(target) && target>0) ? (q.price/target) : null
    });
  })));

  if(!rows.length){
    console.log("No rows after relaxed fetch. Skip reasons:", skips);
  }

  // Optional: IB price replacement
  let replaced=0;
  if(rows.length && (priceSource==="ib" || priceSource==="auto")){
    try{
      const ib = new IBApi({host: ibHost, port: ibPort, clientId});
      await connectIB(ib);
      console.log(`Connected to IB @ ${ibHost}:${ibPort}. Replacing prices with IB LAST when available…`);
      for (const r of rows){
        const p = await getIbSnapshotPrice(ib, r.ticker);
        if (Number.isFinite(p) && p>0) { r.price=p; r.ratio = (r.target && r.target>0) ? (r.price/r.target) : null; replaced++; }
        await sleep(250);
      }
      try{ ib.disconnect(); }catch{}
    }catch(e){ console.warn("IB snapshot failed; keeping Yahoo prices."); }
  }

  // sort: valid ratios first (ascending), then the rest
  rows.sort((a,b)=>{
    const ar = Number.isFinite(a.ratio) ? a.ratio : Infinity;
    const br = Number.isFinite(b.ratio) ? b.ratio : Infinity;
    if (ar !== br) return ar - br;
    return (a.ticker < b.ticker) ? -1 : 1;
  });

  const csv = [
    "ticker,name,sector,industry,marketCap,price,target,price_to_target_pct",
    ...rows.map(r=>[
      r.ticker,
      `"${(r.name||"").replace(/"/g,'""')}"`,
      r.sector||"",
      r.industry||"",
      r.marketCap ?? "",
      Number.isFinite(r.price) ? r.price.toFixed(2) : "",
      Number.isFinite(r.target) ? r.target.toFixed(2) : "",
      Number.isFinite(r.ratio) ? (r.ratio*100).toFixed(2)+"%" : ""
    ].join(","))
  ].join("\n");

  await fs.writeFile(`${outBase}.csv`, csv, "utf8");
  await fs.writeFile(`${outBase}.json`, JSON.stringify(rows,null,2), "utf8");

  console.log("\n===== SUMMARY =====");
  console.log(`Rows written: ${rows.length}`);
  console.log(`IB price replacements: ${replaced}`);
  const byWhy = skips.reduce((m,s)=> (m[s.why]=(m[s.why]||0)+1, m), {});
  console.log("Skip reasons:", byWhy);
  console.log(`Files: ${outBase}.csv, ${outBase}.json`);
})();
