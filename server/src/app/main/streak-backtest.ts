import * as fs from "fs";
import * as path from "path";

// ----- Types -----
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
  side: "LONG" | "SHORT"; // position direction
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
  side: "BUY" | "SELL" | "SHORT" | "COVER"; // transaction verb
  datetime: string;
  price: number;
  shares: number;
  profit: number;     // 0 on entries; realized P&L on exits
  newCapital: number; // equity after the transaction
  tradeIndex: number; // 1-based trade number (entry and exit share the same index)
  reason?: "RULE" | "EOD" | "STOP" | "TAKE";
  day?: string;       // YYYY-MM-DD in chosen timezone (present on SELL/COVER rows)
};

type BacktestResult = {
  trades: Trade[];
  txLog: TxRecord[];
  pnl: number;
  symbol: string;
  finalEquity: number;
  roi: number;
  totalDays: number;
  dayKeys: string[];
  x: number; // thresholds used for LONG and SHORT (symmetry)
  y: number;
};

// ----- Utils -----
function parseRange(s: string, defMin: number, defMax: number): { min: number; max: number } {
  if (!s) return { min: defMin, max: defMax };
  const m = s.match(/^\s*(\d+)\s*[-:]\s*(\d+)\s*$/);
  if (!m) return { min: defMin, max: defMax };
  const min = Math.min(parseInt(m[1], 10), parseInt(m[2], 10));
  const max = Math.max(parseInt(m[1], 10), parseInt(m[2], 10));
  return { min, max };
}

function parseBool(s: string | undefined, def: boolean): boolean {
  if (s === undefined) return def;
  const v = s.toLowerCase();
  if (v === "true" || v === "1" || v === "yes" || v === "y") return true;
  if (v === "false" || v === "0" || v === "no" || v === "n") return false;
  return def;
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch { return false; }
}

function listJsonFiles(inputPath: string, recursive: boolean): string[] {
  if (!isDirectory(inputPath)) return [inputPath];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (recursive) walk(full);
      } else if (entry.isFile() && /\.json$/i.test(entry.name)) {
        out.push(full);
      }
    }
  };
  walk(inputPath);
  return out;
}

export class Streakbacktest {
  // ----- IO -----
  readBars(filePath: string): { symbol: string; bars: Bar[] } {
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

  formatTime(b: Bar): string {
    if (b.datetime) return b.datetime;
    if (b.timestamp) return new Date(b.timestamp * 1000).toISOString();
    return "NA";
  }

  extractDateKey(b: Bar, timeZone: string): string {
    if (b.datetime && /^\d{4}-\d{2}-\d{2}/.test(b.datetime)) return b.datetime.slice(0, 10);
    if (b.datetime && /^\d{8}/.test(b.datetime)) {
      const y = b.datetime.slice(0, 4), m = b.datetime.slice(4, 6), d = b.datetime.slice(6, 8);
      return `${y}-${m}-${d}`;
    }
    const t = b.timestamp ? new Date(b.timestamp * 1000) : new Date(b.datetime ?? "");
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(t); // "YYYY-MM-DD"
  }

  // ----- Core backtest (OPEN-based; TAKE/STOP & optional EOD) with LONG & SHORT -----
  runBacktestOnBars(
    symbol: string,
    bars: Bar[],
    x: number,               // LONG entry on x down-opens; SHORT entry on x up-opens
    y: number,               // LONG exit on y up-opens if profitable; SHORT exit on y down-opens if profitable
    startingEquity: number,
    multiple: number,
    timeZone: string,
    eodClose: boolean,
    takePct?: number,        // NEW: take-profit % threshold
    stopPct?: number,
    enableLong: boolean = true,
    enableShort: boolean = true
  ): BacktestResult {
    let downStreak = 0;
    let upStreak = 0;

    let inPosition = false;
    let side: "LONG" | "SHORT" | null = null;
    let entryPrice = 0;
    let entryBar: Bar | null = null;
    let entryTradeIndex = 0;
    let stopLevel = Number.NEGATIVE_INFINITY;

    let equity = startingEquity;
    let shares = 0;

    const trades: Trade[] = [];
    const txLog: TxRecord[] = [];

    const barDay: string[] = bars.map((b) => this.extractDateKey(b, timeZone));

    let tradeCounter = 0;

    for (let i = 1; i < bars.length; i++) {
      const prev = bars[i - 1];
      const cur = bars[i];

      // Streaks based on OPEN prices
      if (cur.open < prev.open) { downStreak += 1; upStreak = 0; }
      else if (cur.open > prev.open) { upStreak += 1; downStreak = 0; }
      else { downStreak = 0; upStreak = 0; }

      // ===== ENTRY =====
      if (!inPosition) {
        // LONG entry after x down-opens
        if (enableLong && downStreak >= x) {
          const positionValue = equity * multiple;
          const tentativeShares = Math.floor(positionValue / cur.open);
          if (tentativeShares > 0) {
            inPosition = true; side = "LONG";
            entryPrice = cur.open; entryBar = cur; shares = tentativeShares;
            tradeCounter += 1; entryTradeIndex = tradeCounter;
            stopLevel = (stopPct && stopPct > 0) ? entryPrice * (1 - stopPct / 100) : Number.NEGATIVE_INFINITY;

            txLog.push({
              symbol, side: "BUY", datetime: this.formatTime(entryBar), price: entryPrice, shares,
              profit: 0, newCapital: equity, tradeIndex: entryTradeIndex, reason: "RULE",
            });
            downStreak = 0; upStreak = 0;
          } else { downStreak = 0; upStreak = 0; }
        }
        // SHORT entry after x up-opens
        else if (enableShort && upStreak >= x) {
          const positionValue = equity * multiple;
          const tentativeShares = Math.floor(positionValue / cur.open);
          if (tentativeShares > 0) {
            inPosition = true; side = "SHORT";
            entryPrice = cur.open; entryBar = cur; shares = tentativeShares;
            tradeCounter += 1; entryTradeIndex = tradeCounter;
            stopLevel = (stopPct && stopPct > 0) ? entryPrice * (1 + stopPct / 100) : Number.NEGATIVE_INFINITY;

            txLog.push({
              symbol, side: "SHORT", datetime: this.formatTime(entryBar), price: entryPrice, shares,
              profit: 0, newCapital: equity, tradeIndex: entryTradeIndex, reason: "RULE",
            });
            downStreak = 0; upStreak = 0;
          } else { downStreak = 0; upStreak = 0; }
        }
      }

      // ===== RULE-BASED EXIT at OPEN (only if profitable) =====
      if (inPosition && side === "LONG" && upStreak >= y && cur.open > entryPrice) {
        const exitPrice = cur.open;
        const profit = shares * (exitPrice - entryPrice);
        const eqBefore = equity; equity += profit;

        trades.push({
          symbol, side: "LONG", entryTime: this.formatTime(entryBar!), entryPrice,
          exitTime: this.formatTime(cur), exitPrice, profit, shares, multiple,
          positionValue: shares * entryPrice, equityBefore: eqBefore, equityAfter: equity,
        });

        txLog.push({
          symbol, side: "SELL", datetime: this.formatTime(cur), price: exitPrice, shares,
          profit, newCapital: equity, tradeIndex: entryTradeIndex, reason: "RULE", day: barDay[i],
        });

        inPosition = false; side = null; entryPrice = 0; entryBar = null; shares = 0; stopLevel = Number.NEGATIVE_INFINITY;
        upStreak = 0; downStreak = 0;
      }

      if (inPosition && side === "SHORT" && downStreak >= y && cur.open < entryPrice) {
        const exitPrice = cur.open;
        const profit = shares * (entryPrice - exitPrice);
        const eqBefore = equity; equity += profit;

        trades.push({
          symbol, side: "SHORT", entryTime: this.formatTime(entryBar!), entryPrice,
          exitTime: this.formatTime(cur), exitPrice, profit, shares, multiple,
          positionValue: shares * entryPrice, equityBefore: eqBefore, equityAfter: equity,
        });

        txLog.push({
          symbol, side: "COVER", datetime: this.formatTime(cur), price: exitPrice, shares,
          profit, newCapital: equity, tradeIndex: entryTradeIndex, reason: "RULE", day: barDay[i],
        });

        inPosition = false; side = null; entryPrice = 0; entryBar = null; shares = 0; stopLevel = Number.NEGATIVE_INFINITY;
        upStreak = 0; downStreak = 0;
      }

      // ===== TAKE-PROFIT (intra-bar using high/low; gap fills at OPEN) =====
      if (inPosition && takePct && takePct > 0) {
        if (side === "LONG") {
          const tpLevel = entryPrice * (1 + takePct / 100);
          if (cur.high >= tpLevel) {
            const exitPrice = (cur.open >= tpLevel) ? cur.open : tpLevel;
            const profit = shares * (exitPrice - entryPrice);
            const eqBefore = equity; equity += profit;

            trades.push({
              symbol, side: "LONG", entryTime: this.formatTime(entryBar!), entryPrice,
              exitTime: this.formatTime(cur), exitPrice, profit, shares, multiple,
              positionValue: shares * entryPrice, equityBefore: eqBefore, equityAfter: equity,
            });

            txLog.push({
              symbol, side: "SELL", datetime: this.formatTime(cur), price: exitPrice, shares,
              profit, newCapital: equity, tradeIndex: entryTradeIndex, reason: "TAKE", day: barDay[i],
            });

            inPosition = false; side = null; entryPrice = 0; entryBar = null; shares = 0;
            stopLevel = Number.NEGATIVE_INFINITY; upStreak = 0; downStreak = 0;
          }
        } else if (side === "SHORT") {
          const tpLevel = entryPrice * (1 - takePct / 100);
          if (cur.low <= tpLevel) {
            const exitPrice = (cur.open <= tpLevel) ? cur.open : tpLevel;
            const profit = shares * (entryPrice - exitPrice);
            const eqBefore = equity; equity += profit;

            trades.push({
              symbol, side: "SHORT", entryTime: this.formatTime(entryBar!), entryPrice,
              exitTime: this.formatTime(cur), exitPrice, profit, shares, multiple,
              positionValue: shares * entryPrice, equityBefore: eqBefore, equityAfter: equity,
            });

            txLog.push({
              symbol, side: "COVER", datetime: this.formatTime(cur), price: exitPrice, shares,
              profit, newCapital: equity, tradeIndex: entryTradeIndex, reason: "TAKE", day: barDay[i],
            });

            inPosition = false; side = null; entryPrice = 0; entryBar = null; shares = 0;
            stopLevel = Number.NEGATIVE_INFINITY; upStreak = 0; downStreak = 0;
          }
        }
      }

      // ===== STOP-LOSS (intra-bar) =====
      if (inPosition && stopPct && stopPct > 0) {
        if (side === "LONG" && cur.low <= stopLevel) {
          const exitPrice = cur.open <= stopLevel ? cur.open : stopLevel;
          const profit = shares * (exitPrice - entryPrice);
          const eqBefore = equity; equity += profit;

          trades.push({ symbol, side: "LONG", entryTime: this.formatTime(entryBar!), entryPrice, exitTime: this.formatTime(cur), exitPrice, profit, shares, multiple, positionValue: shares * entryPrice, equityBefore: eqBefore, equityAfter: equity });
          txLog.push({ symbol, side: "SELL", datetime: this.formatTime(cur), price: exitPrice, shares, profit, newCapital: equity, tradeIndex: entryTradeIndex, reason: "STOP", day: barDay[i] });

          inPosition = false; side = null; entryPrice = 0; entryBar = null; shares = 0; stopLevel = Number.NEGATIVE_INFINITY;
          upStreak = 0; downStreak = 0;
        }
        if (side === "SHORT" && cur.high >= stopLevel) {
          const exitPrice = cur.open >= stopLevel ? cur.open : stopLevel;
          const profit = shares * (entryPrice - exitPrice);
          const eqBefore = equity; equity += profit;

          trades.push({ symbol, side: "SHORT", entryTime: this.formatTime(entryBar!), entryPrice, exitTime: this.formatTime(cur), exitPrice, profit, shares, multiple, positionValue: shares * entryPrice, equityBefore: eqBefore, equityAfter: equity });
          txLog.push({ symbol, side: "COVER", datetime: this.formatTime(cur), price: exitPrice, shares, profit, newCapital: equity, tradeIndex: entryTradeIndex, reason: "STOP", day: barDay[i] });

          inPosition = false; side = null; entryPrice = 0; entryBar = null; shares = 0; stopLevel = Number.NEGATIVE_INFINITY;
          upStreak = 0; downStreak = 0;
        }
      }

      // ===== EOD liquidation at CLOSE =====
      const isEndOfDay = i === bars.length - 1 || barDay[i] !== barDay[i + 1];
      if (eodClose && isEndOfDay && inPosition) {
        const exitBar = cur;
        const exitPrice = exitBar.close;
        const profit = side === "LONG" ? shares * (exitPrice - entryPrice) : shares * (entryPrice - exitPrice);
        const eqBefore = equity; equity += profit;

        trades.push({ symbol, side: side!, entryTime: this.formatTime(entryBar!), entryPrice, exitTime: this.formatTime(exitBar), exitPrice, profit, shares, multiple, positionValue: shares * entryPrice, equityBefore: eqBefore, equityAfter: equity });
        txLog.push({ symbol, side: side === "LONG" ? "SELL" : "COVER", datetime: this.formatTime(exitBar), price: exitPrice, shares, profit, newCapital: equity, tradeIndex: entryTradeIndex, reason: "EOD", day: barDay[i] });

        inPosition = false; side = null; entryPrice = 0; entryBar = null; shares = 0; stopLevel = Number.NEGATIVE_INFINITY;
        upStreak = 0; downStreak = 0;
      }
    }

    const pnl = equity - startingEquity;
    const roi = startingEquity > 0 ? pnl / startingEquity : 0;
    const totalDays = new Set(barDay).size;

    return {
      trades,
      txLog,
      pnl,
      symbol,
      finalEquity: equity,
      roi,
      totalDays,
      dayKeys: Array.from(new Set(barDay)),
      x,
      y,
    };
  }

  backtestFile(
    filePath: string,
    x: number,
    y: number,
    capital: number,
    multiple: number,
    tz: string,
    eodClose: boolean,
    takePct?: number,
    stopPct?: number,
    enableLong: boolean = true,
    enableShort: boolean = true
  ): BacktestResult {
    const { symbol, bars } = this.readBars(filePath);
    return this.runBacktestOnBars(symbol, bars, x, y, capital, multiple, tz, eodClose, takePct, stopPct, enableLong, enableShort);
  }

  // ----- Optimization -----
  optimizeFile(
    filePath: string,
    xGiven: number | undefined,
    yGiven: number | undefined,
    xRange: { min: number; max: number },
    yRange: { min: number; max: number },
    capital: number,
    multiple: number,
    tz: string,
    eodClose: boolean,
    takePct?: number,
    stopPct?: number,
    enableLong: boolean = true,
    enableShort: boolean = true
  ): BacktestResult {
    const { symbol, bars } = this.readBars(filePath);

    const xMin = xGiven ?? xRange.min;
    const xMax = xGiven ?? xRange.max;
    const yMin = yGiven ?? yRange.min;
    const yMax = yGiven ?? yRange.max;

    let best: BacktestResult | null = null;

    for (let x = xMin; x <= xMax; x++) {
      for (let y = yMin; y <= yMax; y++) {
        const r = this.runBacktestOnBars(symbol, bars, x, y, capital, multiple, tz, eodClose, takePct, stopPct, enableLong, enableShort);

        if (!best) {
          best = r;
          continue;
        }
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

  // ----- CLI -----
  parseArgs() {
    // Key examples:
    //  - Optimize both: ts-node streak-backtest.ts --capital 10000 --multiple 1.5 --tz America/New_York data/NVDA.json
    //  - Fixed params : ts-node streak-backtest.ts --x 3 --y 2 --capital 10000 --multiple 1.5 data/NVDA.json
    //  - Disable EOD  : ts-node streak-backtest.ts --capital 10000 --eodClose false data/NVDA.json
    //  - Add stop     : ts-node streak-backtest.ts --capital 10000 --stopPct 3 data/NVDA.json
    //  - Add take     : ts-node streak-backtest.ts --capital 10000 --takePct 2 data/NVDA.json
    //  - Output dir   : ts-node streak-backtest.ts --txDir ./out data/NVDA.json
    //  - Directory    : ts-node streak-backtest.ts --capital 10000 ./daily_jsons/
    //  - Recursive    : ts-node streak-backtest.ts --capital 10000 --recursive ./root_of_jsons/
    //  - Shorts only  : ts-node streak-backtest.ts --mode short --capital 10000 ./data/
    //  - Long+Short   : ts-node streak-backtest.ts --mode both  --capital 10000 ./data/
    const argv = process.argv.slice(2);

    let x: number | undefined = undefined;
    let y: number | undefined = undefined;
    let xRangeStr = "1-5";
    let yRangeStr = "1-5";

    let capital = 10000;
    let multiple = 1;
    let tz = "America/New_York";
    let txDir = ".";
    let eodClose = true;
    let takePct: number | undefined = undefined; // NEW
    let stopPct: number | undefined = undefined;
    let recursive = false;
    let mode: "long" | "short" | "both" = "long"; // default preserves original behavior

    const inputs: string[] = [];

    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === "--x" || a === "-x") {
        x = parseInt(argv[++i], 10);
      } else if (a === "--y" || a === "-y") {
        y = parseInt(argv[++i], 10);
      } else if (a === "--xRange") {
        xRangeStr = String(argv[++i]);
      } else if (a === "--yRange") {
        yRangeStr = String(argv[++i]);
      } else if (a === "--capital" || a === "-c") {
        capital = Number(argv[++i]);
      } else if (a === "--multiple" || a === "--lev" || a === "-m") {
        multiple = Number(argv[++i]);
      } else if (a === "--tz") {
        tz = String(argv[++i]);
      } else if (a === "--txDir") {
        txDir = String(argv[++i]);
      } else if (a === "--eodClose") {
        eodClose = parseBool(String(argv[++i]), true);
      } else if (a === "--stopPct") {
        stopPct = Number(argv[++i]);
      } else if (a === "--takePct") {
        takePct = Number(argv[++i]);
      } else if (a === "--recursive" || a === "-r") {
        recursive = true;
      } else if (a === "--mode") {
        const v = String(argv[++i]).toLowerCase();
        if (v === "long" || v === "short" || v === "both") mode = v as any;
        else throw new Error("--mode must be one of long|short|both");
      } else if (a === "--help" || a === "-h") {
        console.log(
          `Usage: ts-node streak-backtest.ts [--x N] [--y N] [--xRange A-B] [--yRange C-D] ` +
          `--capital <equity> --multiple <1..2> --tz <IANA_TZ> [--txDir ./out] [--eodClose true|false] ` +
          `[--takePct Z] [--stopPct Z] [--mode long|short|both] [--recursive] <files_or_directories...>\n\n` +
          `If --x or --y omitted, they are optimized over their ranges (defaults 1-5).\n` +
          `Short simulation uses the same X and Y thresholds: entry on X consecutive up-opens; exit on Y consecutive down-opens if profitable at OPEN.\n` +
          `Stop-loss applies to both sides: LONG stop at entry*(1 - Z%), SHORT stop at entry*(1 + Z%). Gaps fill at OPEN.\n` +
          `Take-profit applies to both sides: LONG take at entry*(1 + Z%), SHORT take at entry*(1 - Z%). Gaps fill at OPEN.\n` +
          `Daily P&L aggregates SELL and COVER exits in the chosen timezone and includes end-of-day capital.`
        );
        process.exit(0);
      } else {
        inputs.push(a);
      }
    }

    if (inputs.length === 0) throw new Error("Please provide at least one JSON file or a directory containing JSON files.");
    if (!Number.isFinite(capital) || capital <= 0) throw new Error("--capital must be a positive number.");
    if (!Number.isFinite(multiple) || multiple < 1 || multiple > 2) throw new Error("--multiple must be within [1, 2].");
    if (x !== undefined && (!Number.isFinite(x) || x <= 0)) throw new Error("--x must be a positive integer.");
    if (y !== undefined && (!Number.isFinite(y) || y <= 0)) throw new Error("--y must be a positive integer.");
    if (stopPct !== undefined && (!Number.isFinite(stopPct) || stopPct <= 0 || stopPct >= 100)) {
      throw new Error("--stopPct must be in the range (0, 100).");
    }
    if (takePct !== undefined && (!Number.isFinite(takePct) || takePct <= 0 || takePct >= 100)) {
      throw new Error("--takePct must be in the range (0, 100).");
    }

    const xr = parseRange(xRangeStr, 1, 5);
    const yr = parseRange(yRangeStr, 1, 5);

    const enableLong = mode === "long" || mode === "both";
    const enableShort = mode === "short" || mode === "both";

    return { x, y, xr, yr, inputs, capital, multiple, tz, txDir, eodClose, takePct, stopPct, recursive, enableLong, enableShort };
  }

  // ----- Main -----
  async main() {
    const { x, y, xr, yr, inputs, capital, multiple, tz, txDir, eodClose, takePct, stopPct, recursive, enableLong, enableShort } = this.parseArgs() as any;

    if (!fs.existsSync(txDir)) fs.mkdirSync(txDir, { recursive: true });

    // Expand files from inputs (files and/or dirs)
    const fileSet = new Set<string>();
    for (const p of inputs) {
      const expanded = listJsonFiles(p, recursive);
      for (const f of expanded) fileSet.add(f);
    }
    const files = Array.from(fileSet).filter((f) => /\.json$/i.test(f));

    if (files.length === 0) throw new Error("No JSON files found in the provided inputs.");

    console.log(`Discovered ${files.length} JSON file(s).`);

    const results: BacktestResult[] = [];

    if (x !== undefined && y !== undefined) {
      for (const fp of files) results.push(this.backtestFile(fp, x, y, capital, multiple, tz, eodClose, takePct, stopPct, enableLong, enableShort));
    } else {
      for (const fp of files) results.push(this.optimizeFile(fp, x, y, xr, yr, capital, multiple, tz, eodClose, takePct, stopPct, enableLong, enableShort));
    }

    // Write per-symbol transaction JSON
    for (const r of results) {
      const outPath = path.join(txDir, `${r.symbol}_transactions.json`);
      fs.writeFileSync(outPath, JSON.stringify(r.txLog, null, 2), "utf8");
      console.log(`\nSaved transactions -> ${outPath}`);
    }

    // ----- Build & write per-day realized P&L WITH updated capital -----
    type Daily = { date: string; profit: number; capital: number };
    const combined: Array<{ symbol: string; date: string; profit: number; capital: number }> = [];

    for (const r of results) {
      // Accumulate sum(profit) and keep the capital from the LAST EXIT (SELL or COVER) of each day
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
        .map(([date, agg]) => ({ date, profit: agg.profit, capital: agg.capital }));

      const dailyPath = path.join(txDir, `${r.symbol}_daily_pnl.json`);
      fs.writeFileSync(dailyPath, JSON.stringify(rows, null, 2), "utf8");
      console.log(`Saved daily P&L -> ${dailyPath}`);

      rows.forEach((row) => combined.push({ symbol: r.symbol, date: row.date, profit: row.profit, capital: row.capital }));
    }

    combined.sort((a, b) =>
      a.symbol === b.symbol ? (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) : a.symbol < b.symbol ? -1 : 1
    );
    const allPath = path.join(txDir, `ALL_daily_pnl.json`);
    fs.writeFileSync(allPath, JSON.stringify(combined, null, 2), "utf8");
    console.log(`Saved combined daily P&L -> ${allPath}`);

    // ----- Console summary -----
    let totalPnl = 0;
    let totalStart = 0;
    let totalEnd = 0;
    let sumDays = 0;
    const globalUnique = new Set<string>();

    for (const r of results) {
      totalPnl += r.pnl;
      totalStart += capital;
      totalEnd += r.finalEquity;
      sumDays += r.totalDays;
      r.dayKeys.forEach((d) => globalUnique.add(`${r.symbol}:${d}`));

      console.log(`\n=== ${r.symbol} ===`);
      console.log(
        `Params used: X=${r.x} (down for LONG entry / up for SHORT entry), Y=${r.y} (up for LONG exit / down for SHORT exit) | ` +
        `Capital=${capital}, Multiple=${multiple}x, TZ=${tz}, EOD Close=${eodClose}, ` +
        `StopPct=${(this as any).stopPct ?? "see CLI"}, TakePct=${(this as any).takePct ?? "see CLI"}`
      );

      if (!r.trades.length) {
        console.log("No trades.");
      } else {
        r.trades.forEach((t, idx) => {
          console.log(
            `#${idx + 1} ${t.symbol} ${t.side} | ENTRY ${t.shares} @ ${t.entryPrice.toFixed(2)} on ${t.entryTime} -> ` +
              `EXIT @ ${t.exitPrice.toFixed(2)} on ${t.exitTime} | P&L: ${t.profit.toFixed(2)} | ` +
              `Equity: ${t.equityBefore.toFixed(2)} -> ${t.equityAfter.toFixed(2)}`
          );
        });
      }
      console.log(
        `P&L: ${r.pnl.toFixed(2)} | Final Equity: ${r.finalEquity.toFixed(2)} | ROI: ${(r.roi * 100).toFixed(2)}%`
      );
      console.log(`Number of days in file (tz=${tz}): ${r.totalDays}`);
    }

    console.log("\n========== BEST PARAMETERS PER FILE ==========");
    results.forEach((r) => console.log(`${r.symbol}: Best X=${r.x}, Best Y=${r.y}  -> ROI ${(r.roi * 100).toFixed(2)}%`));
    console.log("==============================================");

    const totalRoi = totalStart > 0 ? (totalEnd - totalStart) / totalStart : 0;

    console.log("\n=======================================");
    console.log(
      `TOTAL P&L: ${totalPnl.toFixed(2)} | Start: ${totalStart.toFixed(2)} -> End: ${totalEnd.toFixed(2)} | ROI: ${(totalRoi * 100).toFixed(2)}%`
    );
    console.log(`Sum of days per file: ${sumDays}`);
    console.log(`TOTAL UNIQUE (symbol, day) across files: ${globalUnique.size}`);
  }

  constructor() {
    this.main().catch((e) => {
      console.error(e);
      process.exit(1);
    });
  }
}

// If run directly
if (require.main === module) {
  new Streakbacktest();
}
