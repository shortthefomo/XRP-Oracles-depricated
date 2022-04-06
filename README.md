# XRP-Oracles
Price Oracle pushing service

Persists the data fetched with [XRP-Price-Aggregator](https://github.com/lathanbritz/XRP-Price-Aggregator) on the XRP Ledger. 

This project takes from [XRPL-Persist-Price-Oracle](https://github.com/XRPL-Labs/XRPL-Persist-Price-Oracle) and extends it to allow price data of anything with a feed to be pushed.

Most of the configuration of the oracle is defined in the sources.json.

```javascript
{
  "basic" : {
    "config": {
      "type": "currency",
      "symbol": "USD",
      "call": 2,
      "delay": 1
    },
    "data": [
      {
        "name": "bitstamp",
        "url": "https://www.bitstamp.net/api/v2/ticker/xrpusd/",
        "selector": "data.last"
      },
      {
        "name": "binance",
        "url": "https://api.binance.com/api/v3/ticker/price?symbol=XRPUSDT",
        "selector": "data.price"
      },
      {
        "name": "bybit",
        "url": "https://api.bybit.com/spot/quote/v1/ticker/price?symbol=XRPUSDT",
        "selector": "data.result.price"
      },
      {
        "name": "kraken",
        "url": "https://api.kraken.com/0/public/Ticker?pair=XRPUSD",
        "selector": "data.result.XXRPZUSD.c[0]"
      } 
    ]
  }
}
```

## Logging

Logging is done with [winston](https://github.com/winstonjs/winston) and uses rolling logs. Change log level by setting `LOG_LEVEL`. Log files are created in subfolder /logs.

## RoadMap

- Quickly extensible oracle (delivered beta)
- Multiple pair price submissions (delivered beta)
- Frontend (POC in progress not released yet)
- Lib to find other Oracles on the XRPL
  - Hearbeat format and service
  - Ledger watching to find other services uploading the hearbeat
- Test Hook consuming a oracle price feed


## Theory
The basic non insentivized modle is leveraged here. Trust of oracles and their data provided, is one of the core issues with orcles, once many exist. Running an oracle service is not free, its pay to play. Rough cost is 60 * 24 * 30 * 10 / 1000000 = 0.432 XRP per month pushing 1 price feed every 1 min. 

TODO more writeup here.