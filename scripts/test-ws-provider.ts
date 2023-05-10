import * as dotenv from 'dotenv'; 
dotenv.config();

import { WebSocketProvider } from "@ethersproject/providers";
import { ReliableWebsocketProvider, enableLogging } from "../src";
import { sleep } from "@mangrovedao/commonlib.js";

enableLogging();

const rpcWs = process.env.RPC_WS!;

const provider = new WebSocketProvider(rpcWs);

const reliableProvider = new ReliableWebsocketProvider(
  {
    maxBlockCached: 10,
    maxRetryGetBlock: 10,
    retryDelayGetBlockMs: 1000,
    maxRetryGetLogs: 10,
    retryDelayGetLogsMs: 1000,
    provider,
    batchSize: 25,
    multiv2Address: '0x275617327c958bD06b5D6b871E7f491D76113dd8', //polygon
  },
  {
    wsUrl: rpcWs,
    pingIntervalMs: 2000,
    pingTimeoutMs: 2000,
    estimatedBlockTimeMs: 2000,
  }

);

const main = async() => {
  console.log('initialize', rpcWs);

  const block = await provider.getBlock('latest');

  await reliableProvider.initialize({
    parentHash: block.parentHash,
    hash: block.hash,
    number: block.number,
  });

  await sleep(1000000000);
}

main();
