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
}

const FileSystem = require("fs");






export class TradeSimuComponent {
  private initialinvestment = 0;
  private rateh = 0.1;
  private ratel = 0.1;
  private symbol: string | undefined;
  private closepositonatcom = false;
  private stoploss = false;
  private result = [];
  private openpriceperperiod = 0;
  private trades = [];
  private tradeseod = [];
  private tradeseodbest = [];
  private stocks = [];
  private symbols = [
    "AMZN", "ACN", "PANW", "NVDA", "CRM",
    "GOOGL", "AVGO", "MRVL", "ARM", "TEAM",
    "WDAY", "AAPL", "nflx", "FTNT"
  ];
  private bestinvestment = 0;
  private bestrateh = 0;
  private bestratel = 0;
  private numberofdays = 0;
  private numbertradingperday = 0;
  private openpricetype=false;

  constructor() {
    this.main();
  }

  private async main() {
    while (true) {
      try {
        await this.collectInputs();
      } catch (e) {
        console.log('error collectInputs=', e);
      }
      if (this.symbol?.toUpperCase() === "ALL" || this.symbol?.toUpperCase().length === 0) {
        this.stocks = [];
        for (let s of this.symbols) {
          console.log('processing stock ', s);
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
            for (let rh = 0.1; rh <= 2; rh = rh + 0.1) {
              for (let rl = 0.1; rl <= 2; rl = rl + 0.1) {
                this.calculTrade(result, Number(this.initialinvestment), rh, rl);
              }
            }
            let stock = {} as Stocks;
            stock.symbol = s;

            stock.recommandedrateh = Math.round(this.bestrateh * 100) / 100;
            stock.recommandedratel = Math.round(this.bestratel * 100) / 100;
            stock.tradingdaynumbers = this.numberofdays;
            stock.finalinvestment = this.bestinvestment;
            stock.daytrades = this.numbertradingperday;
            this.stocks.push(stock);

            this.bestinvestment = 0;
            this.bestrateh = 0;
            this.bestratel = 0;
          }
        }
        this.stocks.sort(this.compareReturn2);
        let result2 = {
          input: {
            investment: this.initialinvestment,
          },
          result: this.stocks
        }
        let currentDir = process.cwd();
        FileSystem.writeFileSync(currentDir + '/stocks/result.json', JSON.stringify(result2), (error) => {
          if (error) throw error;
        });
      } else {
        let result;
        let continueyahoo = true;
        try {
          result = await this.getStock(this.symbol);
        } catch (e) {
          console.log('yahoo finance error=', e);
          continueyahoo = false;
        }

        if (continueyahoo) {
          for (let rh = 0.1; rh <= 2; rh = rh + 0.1) {
            for (let rl = 0.1; rl <= 2; rl = rl + 0.1) {
              this.calculTrade(result, this.initialinvestment, rh, rl);
            }
          }
          console.log("Symbol:", this.symbol);
          console.log("actual final investment:", Math.round((this.bestinvestment) * 100) / 100);
          console.log("number of days:", this.numberofdays);
          console.log("best rate high:", Math.round(this.bestrateh * 100) / 100, ", best rate low:", Math.round(this.bestratel * 100) / 100);
          this.bestinvestment = 0;
          this.bestrateh = 0;
          this.bestratel = 0;
        }
      }
    }

  }

  private async collectInputs() {
    const rl = readline.createInterface({ input, output });
    try {
      this.initialinvestment = parseInt(await rl.question('Enter the investment: '), 10) || 110000;

      if (this.initialinvestment > 0) {
        const symbol1 = await rl.question('Enter stock symbol (e.g., ACN): ');
        this.symbol = (symbol1 || 'ACN').toUpperCase();
      }

      try {
        this.result = await this.getStock(this.symbol.toUpperCase());
      } catch (e) {
        console.log('error e=', e);
      }

      const closeateom = await rl.question('Close position at market closure (Y/N): ');
      this.closepositonatcom = (closeateom || '').toUpperCase() === 'Y';

      const stoploss = await rl.question('Stop loss intra-day (Y/N): ');
      this.stoploss = (stoploss || '').toUpperCase() === 'Y';

      const openpricetype = await rl.question('open price day (Y/N): ');
      this.openpricetype = (openpricetype || '').toUpperCase() === 'Y';
    } finally {
      rl.close(); // <- important!
    }
  }

  async getStock(symbol: string): Promise<any[]> {
    let result;
    let currentDir = process.cwd();

    if (FileSystem.existsSync(currentDir + "/stocks/" + symbol + ".json")) {
      result = await this.getTestgetStockOfflinefile(symbol);
      return result;
    } else {
      return [];
    }
  }

  getTestgetStockOfflinefile(symbol: string): Promise<any[]> {
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

  calculTrade(result, investment: number, rateh, ratel,) {
    let shares1;
    let firstshares = 0;
    let lastshares = 0;
    let buyingprice = 0;
    let sellingprice = 0;
    let averageprice = 0;
    let newtradingday = false;
    let numbertradingperday = 0;
    let numberofdays = 0;
    let openprice = 0;
    let dayopenprice = 0;
    let closeposition = false;
    let lastbuytrade: string;
    let lastselltrade: string;
    let lastprice: number;
    let rateh1 = rateh ? rateh / 100 : 0;
    let ratel1 = ratel ? ratel / 100 : 0;
    let firsttrade = true;
    let metratei = 0;
    let buyingday = 0;
    let sellingday = 0;

    let tradedone = false;

    let investmentstartofday = 0;
    let traderevenue = 0;

    let tradetype;

    let jj = 0;
    let k = 0;
    numbertradingperday = 0;
    this.tradeseod = [];
    this.trades = [];
    this.tradeseodbest = [];

    for (let i = 0; i < result.length; i++) {
      let j = i;
      let tempsod = false;
      let tempeod = false;
      tradedone = false;

      if (j === 0) {
        tempsod = true;
      }
      else if (j === result.length - 1) {
        tempeod = true;
      }
      else {
        let temp0 = new Date(result[j - 1].timestamp * 1000).getDay();
        let temp = new Date(result[j].timestamp * 1000).getDay();
        let temp1 = new Date(result[j + 1].timestamp * 1000).getDay();
        if (temp0 !== temp) {
          tempsod = true;
        }
        if (temp !== temp1) {
          tempeod = true;
        }
      }

      closeposition = tempeod;
      if (tempsod) {
        newtradingday = true;
        investmentstartofday = investment;
        openprice = result[j].open;
        dayopenprice = openprice;
        numberofdays++;
        averageprice = averageprice + result[j].open;
        k = 1;
      } else {
        newtradingday = false;
        k++;
      }

      if (this.openpriceperperiod) {
        openprice = result[j].open;
      }
      let previousopenprice = dayopenprice;
      if (j > 0) {
        previousopenprice = result[j - 1].open;
      }
      if (this.openpricetype) {
        previousopenprice = dayopenprice;
      }
      result[j].low1 = previousopenprice * (1 - ratel1);
      result[j].high1 = previousopenprice * (1 + rateh1);

      if (lastshares === 0 && !tradedone && !closeposition) {
        if (result[j].low1 <= openprice * (1 - ratel1) && result[j].low1 > 0 && result[j].low1 >= result[j].low) {
          buyingprice = result[j].low1;
          lastshares = Math.round(investment / buyingprice);
          shares1 = Math.round(investment / buyingprice);
          lastprice = result[j].low1;
          if (firsttrade) {
            firstshares = lastshares;
            firsttrade = false;
          }
          numbertradingperday++;
          lastbuytrade = result[j].datetime;
          buyingday++;
          let trade = Object.assign({}, result[j]);
          trade.j = j;
          trade.type = 'buy';
          tradetype = trade.type;
          trade.revenue = 0;
          trade.shares = lastshares;
          trade.buyat = Math.round(buyingprice * 100) / 100;
          trade.initialinvestment = investment;
          trade.openprice = openprice;
          trade.ratel = ratel;
          trade.rateh = rateh;
          this.trades.push(trade);
          tradedone = true;
        }
      }
      if (lastshares > 0 && !closeposition && !tradedone) {
        if (buyingprice <= result[j].high1 && result[j].high1 <= result[j].high && result[j].high1 >= result[j].low) {
          let trade = Object.assign({}, result[j]);
          sellingprice = result[j].high1;
          trade.j = j;
          trade.type = 'sell rp';
          tradetype = trade.type;
          trade.revenue = Math.round(lastshares * (sellingprice - buyingprice));
          investment = investment + trade.revenue;
          trade.initialinvestment = investment;
          trade.openprice = openprice;
          trade.shares = 0;
          lastshares = 0;
          lastselltrade = result[j].datetime;
          sellingday++;
          trade.sellat = Math.round(sellingprice * 100) / 100;
          trade.dayrevenue = investment - investmentstartofday;
          traderevenue = trade.dayrevenue;
          trade.ratel = ratel;
          trade.rateh = rateh;
          this.trades.push(trade);
          tradedone = true;
        } else if (!tradedone) {
          let d = traderevenue / result[j].open;
          if (buyingprice - d < result[j].high && !closeposition && this.stoploss) {
            sellingprice = Math.max(buyingprice - d, result[j].low);
            openprice = sellingprice;
            let revenue = Math.round(lastshares * (sellingprice - buyingprice));
            let trade = Object.assign({}, result[j]);
            trade.revenue = revenue;
            traderevenue = revenue;
            investment = investment + revenue;
            trade.j = j;
            trade.type = 'sell close2';
            tradetype = trade.type;
            lastshares = 0;
            trade.initialinvestment = investment;
            tradedone = true;
            trade.sellat = Math.round(sellingprice * 100) / 100;
            trade.dayrevenue = investment - investmentstartofday;
            traderevenue = trade.dayrevenue;
            trade.openprice = openprice;
            shares1 = Math.round(investment / sellingprice);
            trade.shares = shares1;
            trade.ratel = ratel;
            trade.rateh = rateh;
            this.trades.push(trade);
          }
        }
      }

      if (closeposition && !tradedone && this.closepositonatcom) {
        if (lastshares > 0) {
          sellingprice = result[j].open;
          let trade = Object.assign({}, result[j]);
          trade.revenue = lastshares * (sellingprice - buyingprice);
          investment = investment + trade.revenue;
          trade.j = j;
          trade.type = 'sell close';
          tradetype = trade.type;
          lastshares = 0;
          lastselltrade = result[j].datetime;
          trade.initialinvestment = investment;
          sellingday++;

          tradedone = true;
          trade.sellat = Math.round(result[j].open * 100) / 100;
          trade.dayrevenue = investment - investmentstartofday;
          trade.openprice = openprice;
          shares1 = Math.round(investment / sellingprice);
          trade.shares = shares1;
          this.trades.push(trade);
        }
      }
      if (closeposition) {
        let trade = Object.assign({}, result[j]);
        trade.j = jj;
        delete trade.revenue;
        trade.symbol = this.symbol;
        trade.type = tradetype;
        trade.sellat = Math.round(result[j].open * 100) / 100;
        trade.shares = Math.round((investment) / result[j].close);
        trade.initialinvestment = investment;
        trade.dayrevenue = investment - investmentstartofday;
        trade.numbertradingperday = numbertradingperday;
        trade.shares = 0;
        trade.ratel = ratel;
        trade.rateh = rateh;
        this.tradeseod.push(trade);
        jj++;
      }

    }

    if (this.bestinvestment < investment) {
      this.tradeseodbest = this.tradeseod.slice();
      this.bestinvestment = investment;
      this.bestrateh = rateh !== 0 ? rateh : this.bestrateh;
      this.bestratel = ratel !== 0 ? ratel : this.bestratel;
      this.numberofdays = numberofdays;
      this.numbertradingperday = numbertradingperday;
      let currentDir = process.cwd();
      FileSystem.writeFileSync(currentDir + '/stocks/trades.json', JSON.stringify(this.trades), (error) => {
        if (error) throw error;
      });
      FileSystem.writeFileSync(currentDir + '/stocks/tradeseod.json', JSON.stringify(this.tradeseodbest), (error) => {
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



}
