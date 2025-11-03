import { IBApi, SecType, Contract } from '@stoqey/ib';
import { DateTime } from 'luxon';
import * as readline from 'readline';
import * as fs from 'fs';

export class TradeSimuComponent {
  private symbols = [
    "AMZN", "ACN", "PANW", "NVDA", "CRM", "MSFT",
    "GOOGL", "AVGO", "MRVL", "ARM", "TEAM",
    "WDAY", "AAPL", "NFLX", "FTNT", "UBER", "CMCSA", "CTSH", "GOOG", "HPE", "IBM", "META", "NOW", "TSLA"
  ];

  constructor() {
    this.init();
  }

  async init() {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    const ask = (query: string): Promise<string> =>
      new Promise(resolve => rl.question(query, resolve));

    const inputSymbol = (await ask('Enter symbol (or "all" for batch): ')).trim().toUpperCase();
    const duration = (await ask('Enter duration (e.g. 1 M, 2 W, 3 D): ')).trim();
    const barSize = (await ask('Enter bar size (e.g. 1 min, 5 mins, 1 day): ')).trim();
    rl.close();

    let symbolsToFetch;
    if (inputSymbol === 'ALL') {
      symbolsToFetch = this.symbols;
    } else if (inputSymbol.startsWith('FROM ')) {
      const fromSymbol = inputSymbol.replace('FROM ', '').trim();
      const startIndex = this.symbols.indexOf(fromSymbol);
      if (startIndex === -1) {
        console.error(`❌ Symbol ${fromSymbol} not found in list.`);
        return;
      }
      symbolsToFetch = this.symbols.slice(startIndex);
    } else {
      if (!this.symbols.includes(inputSymbol)) {
        console.warn(`⚠️ Symbol ${inputSymbol} not in predefined list. Proceeding anyway.`);
      }
      symbolsToFetch = [inputSymbol];
    }
    for (const symbol of symbolsToFetch) {
      console.log(`🔄 Fetching data for ${symbol}...`);

      const ib = new IBApi({ host: '127.0.0.1', port: 7496, clientId: Math.floor(Math.random() * 10000) });
      ib.connect();

      const contract: Contract = {
        symbol,
        secType: 'STK' as SecType,
        exchange: 'SMART',
        currency: 'USD'
      };

      const symbolinfo: any[] = [];

      try {
        await new Promise<void>((resolve, reject) => {
          (ib as any).on('connected', () => {
            ib.reqHistoricalData(
              1001,
              contract,
              '', // now
              duration,
              barSize as any,
              'TRADES',
              1, // use RTH
              1, // string format
              false
            );
          });

          (ib as any).on('historicalData', (_reqId: any, time: string, open: any, high: any, low: any, close: any, volume: any, count: any, WAP: any, hasGaps: any) => {
            if (time && time.toString().startsWith('finished')) {
              resolve();
            } else {
              symbolinfo.push({
                timestamp: this.getTimestamp(time),
                gmtoffset: 0,
                datetime: time,
                open,
                high,
                low,
                close,
                volume
              });
            }
          });

          (ib as any).on('error', (err: any) => {
            console.error(`❌ Error for ${symbol}:`, err);
            reject(err);
          });

          setTimeout(() => reject(new Error(`Timeout fetching data for ${symbol}`)), 20000);
        });

        const filePath = `${process.cwd()}/stocks/${symbol}.json`;
        fs.writeFileSync(filePath, JSON.stringify(symbolinfo, null, 2));
        console.log(`✅ Saved ${symbol} data to ${filePath}`);
      } catch (error) {
        console.error(`❌ Failed to fetch data for ${symbol}:`, error);
      }

      ib.disconnect();
    }

    console.log('🎉 All data fetching complete!');
  }

  getTimestamp(input: string): number {
    // Split input into dateTime string and zone
    const parts = input.split(' ');
    const dateTimeStr = parts.slice(0, 2).join(' ');
    const zone = parts[2]; // Europe/Paris

    // Now parse correctly
    const dt = DateTime.fromFormat(dateTimeStr, 'yyyyMMdd HH:mm:ss', { zone });
    const timestamp = dt.toMillis();
    return Math.floor(timestamp / 1000);
  }
}
