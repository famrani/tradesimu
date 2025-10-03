//import readline from 'readline-sync';
import * as readline from 'readline/promises';
import { stdin as input, stdout as output } from 'node:process';

export interface Stocks {
  symbol: string;
  recommandedrateh: number;
  recommandedratel: number;
  finalinvestment: number;
  tradingdaynumbers: number;
  returnperday: number;
  returnperdays: string;
  daytrades: number;
  shares: number;
  lastprice: number;
  startbuy: number;
}

const FileSystem = require("fs");






export class TradeSimuComponent {
  private initialinvestment = 0;
  //  private rateh = 0.1;
  //  private ratel = 0.1;
  private symbol: string = '';
  private closepositonatcom = false;
  //  private result = [];
  //  private openpriceperperiod = 0;
  private trades = [];
  private tradeseod = [];
  private tradeseodbest = [];
  private stocks = [] as Stocks[];
  private symbols = [
    "AMZN", "ACN", "PANW", "NVDA", "CRM",
    "GOOGL", "AVGO", "MRVL", "ARM", "TEAM",
    "WDAY", "AAPL", "nflx", "FTNT"
  ];
  private bestinvestment = 0;
  private bestrateh = 0;
  private bestratel = 0;
  private bestshares = 0;
  private numberofdays = 0;
  private numbertradingperday = 0;
  private lastprice = 0;
//  private startbuy = 0;

  constructor() {
    this.main();
  }

  private async collectInputs() {
    const rl = readline.createInterface({ input, output });
    try {
      this.initialinvestment = parseInt(await rl.question('Enter the investment: '), 10) || 110000;

      if (this.initialinvestment > 0) {
        const symbol1 = await rl.question('Enter stock symbol (e.g., ACN): ');
        this.symbol = (symbol1 || 'ACN').toUpperCase();
      }

      const closeateom = await rl.question('Close position at market closure (Y/N): ');
      this.closepositonatcom = (closeateom || '').toUpperCase() === 'Y';
    } finally {
      rl.close(); // <- important!
    }
  }

  private async main() {
    while (true) {
      try {
        await this.collectInputs();
      } catch (e) {
        console.log('error collectInputs=', e);
      }
      // 
      if (this.symbol?.toUpperCase() === "ALL" || this.symbol?.toUpperCase().length === 0) {
        this.stocks = [];
        for (let s of this.symbols) {
          console.log('processing stock ', s);
          this.symbol = s;
          let result;
          let continueyahoo = true;
          try {
            result = await this.getStock(s);
          } catch (e) {
            console.log('yahoo finance error=', e);
            continueyahoo = false;
          }
          if (!result) {
            console.log('stock issue=', s);
          }
          if (continueyahoo && result) {
            let lowestprices = this.lowestOpenFirstTwoHours(result);
            for (let rh = 0.1; rh <= 2; rh = rh + 0.1) {
              for (let rl = 0.1; rl <= 2; rl = rl + 0.1) {
                this.calculTrade(result, Number(this.initialinvestment), rh, rl, lowestprices);
              }
            }

            let stock = {} as Stocks;
            stock.symbol = s;

            stock.recommandedrateh = Math.round(this.bestrateh * 100) / 100;
            stock.recommandedratel = Math.round(this.bestratel * 100) / 100;
            stock.daytrades = this.numberofdays;
            stock.finalinvestment = this.bestinvestment;
            stock.shares = this.bestshares;
            stock.tradingdaynumbers = this.numbertradingperday;
            stock.lastprice = this.lastprice;
//            stock.startbuy = this.startbuy;
            this.stocks.push(stock);

            this.bestinvestment = 0;
            this.bestrateh = 0;
            this.bestratel = 0;
          }
          this.stocks.sort(this.compareReturn2);
          let result2 = {
            input: {
              investment: this.initialinvestment,
            },
            result: this.stocks
          }
          let currentDir = process.cwd();
          FileSystem.writeFileSync(currentDir + '/stocks/result.json', JSON.stringify(result2), (error: any) => {
            if (error) throw error;
          });
        }
      } else {
        let result;
        let continueyahoo = true;
        try {
          result = await this.getStock(this.symbol);
        } catch (e) {
          console.log('yahoo finance error=', e);
          continueyahoo = false;
        }
        let lowestprices = this.lowestOpenFirstTwoHours(result);
        if (continueyahoo) {
          for (let rh = 0.1; rh <= 2; rh = rh + 0.1) {
            for (let rl = 0.1; rl <= 2; rl = rl + 0.1) {
              this.calculTrade(result, this.initialinvestment, rh, rl, lowestprices);
            }
          }
          console.log("Symbol:", this.symbol);
          console.log("actual final investment:", Math.round((this.bestinvestment) * 100) / 100);
          console.log("number of days:", this.numberofdays);
          console.log("number of shares:", this.bestshares);
//          console.log("trigger to buy:", this.startbuy);
          console.log("last price:", this.lastprice);
          console.log("best rate high:", Math.round(this.bestrateh * 100) / 100, ", best rate low:", Math.round(this.bestratel * 100) / 100);
          this.bestinvestment = 0;
          this.bestrateh = 0;
          this.bestratel = 0;
        }
      }
    }


  }

  getStock(symbol: string): Promise<any[]> {
    return new Promise((resolve, reject) => {
      let i = 0;
      let currentDir = process.cwd();
      let arr;
      try {
        //        arr = fs.readFileSync(currentDir + "/" + fileName);
        arr = require(currentDir + "/stocks/" + symbol + ".json");
        resolve(arr);
      }
      catch (e) {
        reject(e);
      }
    })

  }

  calculTrade(result: any, initialinvestment: number, rateh: number, ratel: number, s: any) {
    let newtradingday: boolean;
    let closingday: boolean;
    let currentday;
    let shares = 0;
    let sharesboughtat = 0;
    let numberofdays = 0;
    let investment = initialinvestment;
    let tradedone = false;
    let dayopenprice = 0;
    let trigertobuyindex = 0;
    let dayrevenue = 0;
    let numbertradingperday = 0;

    this.trades = [];
    this.tradeseod = [];
    this.numbertradingperday = 0;

    for (let i = 0; i < result.length; i++) {
      tradedone = false;
      const day = result[i]?.datetime?.slice(6, 8);
      if (currentday !== day) {
        currentday = day;
        newtradingday = true;
        numberofdays++;
        dayopenprice = result[i].open;
        dayrevenue = 0;
        numbertradingperday = 0;
        trigertobuyindex = 0;
      } else {
        trigertobuyindex++;
        newtradingday = false;
      }
      if (result[i + 1] !== undefined) {
        const day = result[i + 1]?.datetime?.slice(6, 8);
        if (currentday !== day) {
          closingday = true;
        } else {
          closingday = false;
        }
      } else {
        closingday = true;
      }
      if (i > 0) {
        let openprice = s[numberofdays-1].minOpen;
        let buyprice = openprice * (1 - ratel / 100);
        if (shares === 0 && trigertobuyindex > s[numberofdays-1].afterWindowIndex) {
          if (result[i].open <= buyprice && !tradedone) {
            shares = Math.floor(investment / result[i].open);
            investment = investment - shares * result[i].open;
            sharesboughtat = result[i].open;
            tradedone = true;
            numbertradingperday++;
            let trade = Object.assign({}, result[i]);
            trade.j = i;
            trade.type = 'buy';
            trade.revenue = 0;
            trade.shares = shares;
            trade.buyat = Math.round(result[i].open * 100) / 100;
            trade.initialinvestment = investment;
            trade.openprice = openprice;
            trade.ratel = ratel;
            trade.rateh = rateh;
            trade.symbol = this.symbol;
            this.trades.push(trade as never);

          }
        }
        if (shares > 0 && !tradedone) {
          if (result[i].open >= sharesboughtat * (1 + rateh / 100 + ratel / 100) && !tradedone) {
            let revenue = shares * result[i].open;
            dayrevenue = dayrevenue + revenue - shares * sharesboughtat;
            investment = investment + revenue;
            tradedone = true;
            shares = 0;
            let trade = Object.assign({}, result[i]);
            let sellingprice = result[i].open;
            trade.j = i;
            trade.initialinvestment = investment;
            initialinvestment = investment;
            trade.sellat = Math.round(sellingprice * 100) / 100;
            trade.ratel = ratel;
            trade.rateh = rateh;
            trade.type = 'sell at rp';
            this.trades.push(trade as never);
          }
        }
      }
      if (closingday && !tradedone && this.closepositonatcom && shares > 0) {
        let revenue = shares * result[i].open;
        investment = investment + revenue;
        dayrevenue = dayrevenue + revenue - shares * sharesboughtat;
        tradedone = true;
        shares = 0;
        let trade = Object.assign({}, result[i]);
        let sellingprice = result[i].open;
        trade.j = i;
        trade.initialinvestment = investment;
        trade.sellat = Math.round(sellingprice * 100) / 100;
        trade.ratel = ratel;
        trade.rateh = rateh;
        trade.type = 'sell at close day';
        this.trades.push(trade as never);
      }
      if (closingday) {
        let trade = Object.assign({}, result[i]);
        trade.ratel = this.bestratel;
        trade.rateh = this.bestrateh;
        trade.numberofdays = numberofdays;
        trade.numbertradingperday = numbertradingperday;
        this.numbertradingperday = numbertradingperday;
        trade.investment = investment;
        trade.symbol = this.symbol;
        trade.dayrevenue = dayrevenue;

        this.tradeseod.push(trade as never);
      }
    }
    if ((this.bestinvestment < investment && shares === 0) || this.bestinvestment < result[result.length - 1].open * shares + investment) {
      this.tradeseodbest = this.tradeseod.slice();
      this.bestinvestment = shares === 0 ? investment : result[result.length - 1].open * shares + investment;
      this.bestshares = shares;
      this.lastprice = result[result.length - 1].open;
      this.bestrateh = rateh !== 0 ? rateh : this.bestrateh;
      this.bestratel = ratel !== 0 ? ratel : this.bestratel;
      this.numberofdays = numberofdays;
//      this.startbuy = s;
      let currentDir = process.cwd();
      FileSystem.writeFileSync(currentDir + '/stocks/trades.json', JSON.stringify(this.trades), (error: any) => {
        if (error) throw error;
      });
      FileSystem.writeFileSync(currentDir + '/stocks/tradeseod.json', JSON.stringify(this.tradeseodbest), (error: any) => {
        if (error) throw error;
      });
    }

  }


  compareReturn2(a: Stocks, b: Stocks) {
    if (a.finalinvestment < b.finalinvestment) {
      return 1;
    }
    if (a.finalinvestment > b.finalinvestment) {
      return -1;
    }
    return 0;
  }

lowestOpenFirstTwoHours(bars: any, windowMinutes: number = 60) {
  // group by YYYYMMDD
  const byDate = new Map();
  for (const b of bars) {
    if (!b || !b.datetime) continue;
    const [yyyymmdd] = b.datetime.split(' ');
    if (!yyyymmdd) continue;
    const arr = byDate.get(yyyymmdd) || [];
    arr.push(b);
    byDate.set(yyyymmdd, arr);
  }

  const results: any[] = [];

  for (const [date, rows] of byDate.entries()) {
    rows.sort(
      (a: { timestamp: any; datetime: any }, b: { timestamp: any; datetime: any }) =>
        (a.timestamp ?? a.datetime).toString().localeCompare((b.timestamp ?? b.datetime).toString())
    );

    const toMinute = (dtStr: string) => {
      const parts = dtStr.split(' ');
      const [hh, mm] = (parts[1] || '').split(':').map(Number);
      return (hh || 0) * 60 + (mm || 0);
    };

    const targetMins = [14 * 60 + 30, 15 * 60 + 30]; // 14:30, 15:30
    let startIdx = -1;
    let startMinute: number | null = null;

    for (const want of targetMins) {
      startIdx = rows.findIndex((r: { datetime: any }) => toMinute(r.datetime) === want);
      if (startIdx >= 0) {
        startMinute = want;
        break;
      }
    }

    if (startIdx < 0) {
      const fallback = rows
        .map((r: { datetime: any }, i: any) => ({ i, m: toMinute(r.datetime) }))
        .filter((x: { m: number }) => x.m >= 14 * 60 + 30 && x.m < 16 * 60)
        .sort((a: { m: number }, b: { m: number }) => a.m - b.m)[0];
      if (fallback) {
        startIdx = fallback.i;
        startMinute = fallback.m;
      }
    }

    if (startIdx < 0 || startMinute === null) continue;

    const windowEndMinute = startMinute + windowMinutes; // 👈 use parameter
    let minOpen = Infinity;
    let endTimeStr: string | null = null;
    let afterWindowIndex: number | null = null;

    for (let i = startIdx; i < rows.length; i++) {
      const m = toMinute(rows[i].datetime);
      if (m >= windowEndMinute) {
        endTimeStr = rows[i - 1]?.datetime.split(' ')[1];
        afterWindowIndex = i; // index of first bar after the window
        break;
      }
      if (rows[i].open != null && rows[i].open < minOpen) {
        minOpen = rows[i].open;
      }
    }

    if (!endTimeStr) {
      const lastInWindow = rows.filter((r: { datetime: any }) => toMinute(r.datetime) < windowEndMinute).pop();
      endTimeStr = lastInWindow ? lastInWindow.datetime.split(' ')[1] : null;
    }

    results.push({
      date, // "YYYYMMDD"
      startTime: rows[startIdx].datetime.split(' ')[1],
      endTime: endTimeStr || null,
      minOpen: isFinite(minOpen) ? minOpen : null,
      afterWindowIndex, // index inside that day's rows
    });
  }

  results.sort((a, b) => a.date.localeCompare(b.date));
  return results;
}

}
