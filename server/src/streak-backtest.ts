// streak-backtest-simple.ts
import * as fs from "fs";
import * as path from "path";

/** ===== Types ===== */
type Bar = {
  timestamp?: number;
  gmtoffset?: number;
  datetime?: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};

type Trade = {
  symbol: string;
  side: "LONG" | "SHORT";
  entryTime: string;
  entryPrice: number;
  exitTime: string;
  exitPrice: number;
  profit: number;
  shares: number;
  multiple: number;
  positionValue: number;
  equityBefore: number;
  equityAfter: number;
};

type TxRecord = {
  symbol: string;
  side: "BUY" | "SELL" | "SHORT" | "COVER";
  datetime: string;
  price: number;
  shares: number;
  profit: number;          // 0 for entries
  newCapital: number;      // equity after this tx (entries = unchanged equity)
  tradeIndex: number;      // 1-based trade id (entry and exit share the same id)
  reason?: "RULE" | "EOD";
  day?: string;            // YYYY-MM-DD on exits
  // pretty fields (added only when saving files)
  profitUSD?: string;
  newCapitalUSD?: string;
};

type BacktestResult = {
  symbol: string;
  x: number;
  y: number;
  trades: Trade[];
  txLog: TxRecord[];
  pnl: number;
  finalEquity: number;
  roi: number;                // realized
  totalDays: number;
  dayKeys: string[];
  // forced-close metrics
  equityIfForcedClose: number;
  roiIfForcedClose: number;
  forcedWasOpen: boolean;
};

/** ===== Utils ===== */
function parseRange(s: string, defMin: number, defMax: number): { min: number; max: number } {
  if (!s) return { min: defMin, max: defMax };
  const m = s.match(/^\s*(\d+)\s*[-:]\s*(\d+)\s*$/);
  if (!m) return { min: defMin, max: defMax };
  const a = parseInt(m[1], 10);
  const b = parseInt(m[2], 10);
  return { min: Math.min(a, b), max: Math.max(a, b) };
}

function parseBool(s: string | undefined, def: boolean): boolean {
  if (s === undefined) return def;
  const v = s.toLowerCase();
  if (v === "true" || v === "1" || v === "yes" || v === "y") return true;
  if (v === "false" || v === "0" || v === "no" || v === "n") return false;
  return def;
}

function formatUSD(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(Number.isFinite(n) ? n : 0);
}

function isDirectory(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}
function listJsonFiles(inputPath: string, recursive: boolean): string[] {
  if (!isDirectory(inputPath)) return [inputPath];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (recursive) walk(full); }
      else if (entry.isFile() && /\.json$/i.test(entry.name)) out.push(full);
    }
  };
  walk(inputPath);
  return out;
}

function formatTime(b: Bar): string {
  if (b.datetime) return b.datetime;
  if (b.timestamp != null) return new Date(b.timestamp * 1000).toISOString();
  return "NA";
}

function extractDateKey(b: Bar, timeZone: string): string {
  if (b.datetime && /^\d{4}-\d{2}-\d{2}/.test(b.datetime)) return b.datetime.slice(0, 10);
  if (b.datetime && /^\d{8}/.test(b.datetime)) {
    const y = b.datetime.slice(0, 4), m = b.datetime.slice(4, 6), d = b.datetime.slice(6, 8);
    return `${y}-${m}-${d}`;
  }
  const t = b.timestamp ? new Date(b.timestamp * 1000) : new Date(b.datetime ?? "");
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(t);
}

function readBars(filePath: string): { symbol: string; bars: Bar[] } {
  const raw = fs.readFileSync(filePath, "utf8");
  const data: Bar[] = JSON.parse(raw);
  const symbol = path.basename(filePath, path.extname(filePath)).toUpperCase();
  const bars = [...data].sort((a, b) => {
    const ta = a.timestamp ?? new Date(a.datetime ?? "").getTime();
    const tb = b.timestamp ?? new Date(b.datetime ?? "").getTime();
    return ta - tb;
  });
  return { symbol, bars };
}

/** ===== Core backtest: only X, Y (no take/stop) =====
 * LONG:  enter after X consecutive down-opens; exit after Y consecutive up-opens (at next bar OPEN).
 * SHORT: enter after X consecutive up-opens;   exit after Y consecutive down-opens (at next bar OPEN).
 * Optional end-of-day liquidation at CLOSE.
 */
function runBacktestOnBars(
  symbol: string,
  bars: Bar[],
  x: number,
  y: number,
  startingEquity: number,
  multiple: number,
  timeZone: string,
  eodClose: boolean,
  enableLong: boolean,
  enableShort: boolean,
  allowUnprofitableRuleExit: boolean
): BacktestResult {
  let equity = startingEquity;

  let downStreak = 0;
  let upStreak = 0;

  let inPosition = false;
  let side: "LONG" | "SHORT" | null = null;
  let entryPrice = 0;
  let entryBar: Bar | null = null;
  let shares = 0;

  const trades: Trade[] = [];
  const txLog: TxRecord[] = [];
  const barDay: string[] = bars.map((b) => extractDateKey(b, timeZone));
  let tradeCounter = 0;
  let entryTradeIndex = 0;

  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1];
    const cur = bars[i];

    // Streaks on OPEN
    if (cur.open < prev.open) { downStreak += 1; upStreak = 0; }
    else if (cur.open > prev.open) { upStreak += 1; downStreak = 0; }
    else { downStreak = 0; upStreak = 0; }

    // ENTRY
    if (!inPosition) {
      // LONG after X down-opens
      if (enableLong && downStreak >= x) {
        const positionValue = equity * multiple;
        const tentativeShares = Math.floor(positionValue / cur.open);
        if (tentativeShares > 0) {
          inPosition = true; side = "LONG";
          entryPrice = cur.open; entryBar = cur; shares = tentativeShares;
          tradeCounter += 1; entryTradeIndex = tradeCounter;

          txLog.push({
            symbol,
            side: "BUY",
            datetime: formatTime(entryBar),
            price: entryPrice,
            shares,
            profit: 0,
            newCapital: equity,
            tradeIndex: entryTradeIndex,
            reason: "RULE"
          });
        }
        downStreak = 0; upStreak = 0;
      }
      // SHORT after X up-opens
      else if (enableShort && upStreak >= x) {
        const positionValue = equity * multiple;
        const tentativeShares = Math.floor(positionValue / cur.open);
        if (tentativeShares > 0) {
          inPosition = true; side = "SHORT";
          entryPrice = cur.open; entryBar = cur; shares = tentativeShares;
          tradeCounter += 1; entryTradeIndex = tradeCounter;

          txLog.push({
            symbol,
            side: "SHORT",
            datetime: formatTime(entryBar),
            price: entryPrice,
            shares,
            profit: 0,
            newCapital: equity,
            tradeIndex: entryTradeIndex,
            reason: "RULE"
          });
        }
        downStreak = 0; upStreak = 0;
      }
    }

    // RULE EXIT at OPEN
    if (inPosition && side === "LONG" && upStreak >= y) {
      if (allowUnprofitableRuleExit || cur.open > entryPrice) {
        const exitPrice = cur.open;
        const profit = shares * (exitPrice - entryPrice);
        const eqBefore = equity; equity += profit;

        trades.push({
          symbol, side: "LONG",
          entryTime: formatTime(entryBar!), entryPrice,
          exitTime: formatTime(cur), exitPrice,
          profit, shares, multiple,
          positionValue: shares * entryPrice,
          equityBefore: eqBefore, equityAfter: equity
        });

        txLog.push({
          symbol,
          side: "SELL",
          datetime: formatTime(cur),
          price: exitPrice,
          shares,
          profit,
          newCapital: equity,
          tradeIndex: entryTradeIndex,
          reason: "RULE",
          day: barDay[i]
        });

        inPosition = false; side = null; entryPrice = 0; entryBar = null; shares = 0;
        upStreak = 0; downStreak = 0;
      }
    }
    if (inPosition && side === "SHORT" && downStreak >= y) {
      if (allowUnprofitableRuleExit || cur.open < entryPrice) {
        const exitPrice = cur.open;
        const profit = shares * (entryPrice - exitPrice);
        const eqBefore = equity; equity += profit;

        trades.push({
          symbol, side: "SHORT",
          entryTime: formatTime(entryBar!), entryPrice,
          exitTime: formatTime(cur), exitPrice,
          profit, shares, multiple,
          positionValue: shares * entryPrice,
          equityBefore: eqBefore, equityAfter: equity
        });

        txLog.push({
          symbol,
          side: "COVER",
          datetime: formatTime(cur),
          price: exitPrice,
          shares,
          profit,
          newCapital: equity,
          tradeIndex: entryTradeIndex,
          reason: "RULE",
          day: barDay[i]
        });

        inPosition = false; side = null; entryPrice = 0; entryBar = null; shares = 0;
        upStreak = 0; downStreak = 0;
      }
    }

    // End-of-day close
    const isEndOfDay = i === bars.length - 1 || barDay[i] !== barDay[i + 1];
    if (eodClose && isEndOfDay && inPosition) {
      const exitBar = cur;
      const exitPrice = exitBar.close;
      const profit = side === "LONG" ? shares * (exitPrice - entryPrice) : shares * (entryPrice - exitPrice);
      const eqBefore = equity; equity += profit;

      trades.push({
        symbol, side: side!,
        entryTime: formatTime(entryBar!), entryPrice,
        exitTime: formatTime(exitBar), exitPrice,
        profit, shares, multiple,
        positionValue: shares * entryPrice,
        equityBefore: eqBefore, equityAfter: equity
      });

      txLog.push({
        symbol,
        side: side === "LONG" ? "SELL" : "COVER",
        datetime: formatTime(exitBar),
        price: exitPrice,
        shares,
        profit,
        newCapital: equity,
        tradeIndex: entryTradeIndex,
        reason: "EOD",
        day: barDay[i]
      });

      inPosition = false; side = null; entryPrice = 0; entryBar = null; shares = 0;
      upStreak = 0; downStreak = 0;
    }
  }

  // Realized performance
  const pnl = equity - startingEquity;
  const roi = startingEquity > 0 ? pnl / startingEquity : 0;
  const totalDays = new Set(barDay).size;

  // Forced close at final bar (if still in a position)
  let equityIfForcedClose = equity;
  let roiIfForcedClose = roi;
  let forcedWasOpen = false;

  if (bars.length > 0 && inPosition && side && shares !== 0) {
    const lastBar = bars[bars.length - 1];
    const forcedExitPrice = lastBar.close;
    const hypotheticalProfit = side === "LONG"
      ? shares * (forcedExitPrice - entryPrice)
      : shares * (entryPrice - forcedExitPrice);
    equityIfForcedClose = equity + hypotheticalProfit;
    roiIfForcedClose = startingEquity > 0 ? (equityIfForcedClose - startingEquity) / startingEquity : roi;
    forcedWasOpen = true;
  }

  return {
    symbol, x: -1, y: -1,
    trades, txLog,
    pnl, finalEquity: equity, roi, totalDays,
    dayKeys: Array.from(new Set(barDay)),
    equityIfForcedClose, roiIfForcedClose, forcedWasOpen
  };
}

/** Backtest for given x,y */
function backtestFile(
  filePath: string,
  x: number,
  y: number,
  capital: number,
  multiple: number,
  tz: string,
  eodClose: boolean,
  enableLong: boolean,
  enableShort: boolean,
  allowUnprofitableRuleExit: boolean
): BacktestResult {
  const { symbol, bars } = readBars(filePath);
  const r = runBacktestOnBars(
    symbol, bars, x, y, capital, multiple, tz, eodClose,
    enableLong, enableShort, allowUnprofitableRuleExit
  );
  r.x = x; r.y = y;
  return r;
}

/** Optimize x,y on a file */
function optimizeFile(
  filePath: string,
  xGiven: number | undefined,
  yGiven: number | undefined,
  xRange: { min: number; max: number },
  yRange: { min: number; max: number },
  capital: number,
  multiple: number,
  tz: string,
  eodClose: boolean,
  enableLong: boolean,
  enableShort: boolean,
  allowUnprofitableRuleExit: boolean
): BacktestResult {
  const { symbol, bars } = readBars(filePath);

  const xMin = xGiven ?? xRange.min;
  const xMax = xGiven ?? xRange.max;
  const yMin = yGiven ?? yRange.min;
  const yMax = yGiven ?? yRange.max;

  let best: BacktestResult | null = null;

  for (let X = xMin; X <= xMax; X++) {
    for (let Y = yMin; Y <= yMax; Y++) {
      const r = runBacktestOnBars(
        symbol, bars, X, Y, capital, multiple, tz, eodClose,
        enableLong, enableShort, allowUnprofitableRuleExit
      );
      r.x = X; r.y = Y;

      if (!best) { best = r; continue; }
      // Tie-breakers: ROI, then P&L, then fewer trades, then smaller X then Y
      if (
        r.roi > best.roi ||
        (r.roi === best.roi && r.pnl > best.pnl) ||
        (r.roi === best.roi && r.pnl === best.pnl && r.trades.length < best.trades.length) ||
        (r.roi === best.roi && r.pnl === best.pnl && r.trades.length === best.trades.length &&
          (r.x < best.x || (r.x === best.x && r.y < best.y)))
      ) {
        best = r;
      }
    }
  }
  return best!;
}

/** ===== CLI ===== */
function parseArgs() {
  const argv = process.argv.slice(2);

  let x: number | undefined = undefined;
  let y: number | undefined = undefined;
  let xRangeStr = "1-5";
  let yRangeStr = "1-5";

  let capital = 10000;
  let multiple = 1;
  let tz = "America/New_York";
  let eodClose = true;

  let txDir = "results";

  let recursive = false;
  let mode: "long" | "short" | "both" = "long";
  let allowUnprofitableRuleExit = false;

  const inputs: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--x" || a === "-x") x = parseInt(argv[++i], 10);
    else if (a === "--y" || a === "-y") y = parseInt(argv[++i], 10);
    else if (a === "--xRange") xRangeStr = String(argv[++i]);
    else if (a === "--yRange") yRangeStr = String(argv[++i]);
    else if (a === "--capital" || a === "-c") capital = Number(argv[++i]);
    else if (a === "--multiple" || a === "--lev" || a === "-m") multiple = Number(argv[++i]);
    else if (a === "--tz") tz = String(argv[++i]);
    else if (a === "--eodClose") eodClose = parseBool(String(argv[++i]), true);
    else if (a === "--txDir") txDir = String(argv[++i]);
    else if (a === "--recursive" || a === "-r") recursive = true;
    else if (a === "--mode") {
      const v = String(argv[++i]).toLowerCase();
      if (v === "long" || v === "short" || v === "both") mode = v as any;
      else throw new Error("--mode must be one of long|short|both");
    } else if (a === "--allowUnprofitableRuleExit") {
      allowUnprofitableRuleExit = true;
    } else if (a === "--help" || a === "-h") {
      console.log(
`Usage: ts-node streak-backtest-simple.ts [--x N] [--y N] [--xRange A-B] [--yRange C-D]
  --capital <equity> --multiple <1..2> [--tz America/New_York] [--eodClose true|false]
  [--txDir ./results] [--mode long|short|both] [--allowUnprofitableRuleExit] [--recursive]
  <files_or_directories...>

Description:
- Optimizes (X,Y) to maximize ROI, then P&L.
- Reports per-symbol summary: X, Y, ROI, trading days, Final Equity, Equity* (forced close).
- Writes transactions and per-day P&L JSON files with extra USD-formatted fields.
- LONG: entry after X consecutive down-opens; exit after Y consecutive up-opens.
- SHORT: entry after X consecutive up-opens; exit after Y consecutive down-opens.
- EOD: if --eodClose true, positions are liquidated at each day's close.

Examples:
  ts-node streak-backtest-simple.ts --capital 250000 ./stocks/AMZN.json
  ts-node streak-backtest-simple.ts --capital 250000 --recursive ./stocks/`
      );
      process.exit(0);
    } else {
      inputs.push(a);
    }
  }

  if (inputs.length === 0) throw new Error("Please provide a JSON file or a directory.");
  if (!Number.isFinite(capital) || capital <= 0) throw new Error("--capital must be > 0.");
  if (!Number.isFinite(multiple) || multiple < 1 || multiple > 2) throw new Error("--multiple in [1,2].");
  if (x !== undefined && (!Number.isFinite(x) || x <= 0)) throw new Error("--x must be a positive integer.");
  if (y !== undefined && (!Number.isFinite(y) || y <= 0)) throw new Error("--y must be a positive integer.");

  const xr = parseRange(xRangeStr, 1, 5);
  const yr = parseRange(yRangeStr, 1, 5);

  const enableLong = mode === "long" || mode === "both";
  const enableShort = mode === "short" || mode === "both";

  return {
    x, y, xr, yr, inputs, capital, multiple, tz, eodClose, txDir,
    recursive, enableLong, enableShort, allowUnprofitableRuleExit
  };
}

/** ===== Main ===== */
async function main() {
  const {
    x, y, xr, yr, inputs, capital, multiple, tz, eodClose, txDir,
    recursive, enableLong, enableShort, allowUnprofitableRuleExit
  } = parseArgs() as any;

  if (!fs.existsSync(txDir)) fs.mkdirSync(txDir, { recursive: true });

  // Expand files
  const fileSet = new Set<string>();
  for (const p of inputs) for (const f of listJsonFiles(p, recursive)) fileSet.add(f);
  const files = Array.from(fileSet).filter(f => /\.json$/i.test(f));
  if (files.length === 0) throw new Error("No JSON files found.");
  const multiFile = files.length > 1;

  console.log(`Discovered ${files.length} JSON file(s).`);

  const results: BacktestResult[] = [];
  if (x !== undefined && y !== undefined) {
    for (const fp of files) {
      results.push(
        backtestFile(fp, x, y, capital, multiple, tz, eodClose, enableLong, enableShort, allowUnprofitableRuleExit)
      );
    }
  } else {
    for (const fp of files) {
      results.push(
        optimizeFile(fp, x, y, xr, yr, capital, multiple, tz, eodClose, enableLong, enableShort, allowUnprofitableRuleExit)
      );
    }
  }

  // Write per-symbol files
  type Daily = { date: string; profit: number; capital: number; profitUSD?: string; capitalUSD?: string };
  const combined: Array<{ symbol: string; date: string; profit: number; capital: number; profitUSD?: string; capitalUSD?: string }> = [];

  for (const r of results) {
    // 1) Transactions with USD formatted fields
    const txPath = path.join(txDir, `${r.symbol}_transactions.json`);
    const txOut = r.txLog.map(tx => ({
      ...tx,
      profitUSD: formatUSD(tx.profit || 0),
      newCapitalUSD: formatUSD(tx.newCapital || 0)
    }));
    fs.writeFileSync(txPath, JSON.stringify(txOut, null, 2), "utf8");
    console.log(`Saved transactions -> ${txPath}`);

    // 2) Per-day realized P&L (sum of exit profits) + last equity of the day
    const byDay = new Map<string, { profit: number; capital: number; lastTs: number }>();
    for (const tx of r.txLog) {
      if (!(tx.side === "SELL" || tx.side === "COVER")) continue;
      const day = tx.day ?? "0000-00-00";
      const ts = Date.parse(tx.datetime);
      const prev = byDay.get(day);
      const profit = (prev?.profit ?? 0) + (tx.profit || 0);

      let capitalForDay = tx.newCapital;
      let lastTs = Number.isFinite(ts) ? ts : (prev?.lastTs ?? 0);
      if (prev && Number.isFinite(ts)) {
        if (ts >= prev.lastTs) {
          capitalForDay = tx.newCapital;
          lastTs = ts;
        } else {
          capitalForDay = prev.capital;
          lastTs = prev.lastTs;
        }
      }
      byDay.set(day, { profit, capital: capitalForDay, lastTs });
    }

    const rows: Daily[] = Array.from(byDay.entries())
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([date, agg]) => ({
        date,
        profit: agg.profit,
        capital: agg.capital,
        profitUSD: formatUSD(agg.profit),
        capitalUSD: formatUSD(agg.capital)
      }));

    const dailyPath = path.join(txDir, `${r.symbol}_daily_pnl.json`);
    fs.writeFileSync(dailyPath, JSON.stringify(rows, null, 2), "utf8");
    console.log(`Saved daily P&L -> ${dailyPath}`);

    rows.forEach((row) =>
      combined.push({
        symbol: r.symbol,
        date: row.date,
        profit: row.profit,
        capital: row.capital,
        profitUSD: row.profitUSD,
        capitalUSD: row.capitalUSD
      })
    );
  }

  // Combined daily file
  combined.sort((a, b) =>
    a.symbol === b.symbol
      ? a.date < b.date ? -1 : a.date > b.date ? 1 : 0
      : a.symbol < b.symbol ? -1 : 1
  );
  const allPath = path.join(txDir, `ALL_daily_pnl.json`);
  fs.writeFileSync(allPath, JSON.stringify(combined, null, 2), "utf8");
  console.log(`Saved combined daily P&L -> ${allPath}`);

  // Console summary
  if (multiFile) {
    type Row = { symbol: string; X: number; Y: number; ROIpct: number; Days: number; Equity: number; EquityForced: number; };
    const rows: Row[] = results.map(r => ({
      symbol: r.symbol,
      X: r.x, Y: r.y,
      ROIpct: r.roi * 100,
      Days: r.totalDays,
      Equity: r.finalEquity,
      EquityForced: r.equityIfForcedClose
    }));
    // Rank by forced-close equity (safer comparison if last trade is still open)
    rows.sort((a,b)=> b.EquityForced - a.EquityForced);

    console.log("\n=== Summary per symbol ===");
    console.log("Symbol | X | Y | ROI% | Days | Equity | Equity* (forced)");
    for (const r of rows) {
      console.log(
        `${r.symbol} | ${r.X} | ${r.Y} | ${r.ROIpct.toFixed(2)} | ${r.Days} | ${r.Equity.toFixed(2)} | ${r.EquityForced.toFixed(2)}`
      );
    }
    const top = rows[0];
    console.log(`\n=== Portfolio Top by Equity* ===`);
    console.log(`${top.symbol}: X=${top.X}, Y=${top.Y}, ROI=${top.ROIpct.toFixed(2)}%, Equity=${top.Equity.toFixed(2)}, Equity*=${top.EquityForced.toFixed(2)}`);
  } else {
    const r = results[0];
    console.log(`\n=== ${r.symbol} ===`);
    console.log(`Best X=${r.x}, Y=${r.y} | Capital=${capital}, Leverage=${multiple}x, TZ=${tz}, EOD=${eodClose}`);
    console.log(`Days=${r.totalDays} | ROI=${(r.roi*100).toFixed(2)}% | Equity=${r.finalEquity.toFixed(2)} | Equity* (forced)=${r.equityIfForcedClose.toFixed(2)}${r.forcedWasOpen ? " (open pos forced at last bar)" : ""}`);
  }
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}
