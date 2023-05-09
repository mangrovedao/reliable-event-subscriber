import * as dotenv from 'dotenv'; 
dotenv.config();

import { JsonRpcProvider } from "@ethersproject/providers";
import { ReliableHttpProvider, enableLogging } from "../src";
import { sleep } from "@mangrovedao/commonlib.js";

enableLogging();

const rpcHttpUrl = process.env.RPC_HTTP!;

const provider = new JsonRpcProvider(rpcHttpUrl);

const reliableProvider = new ReliableHttpProvider(
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
    estimatedBlockTimeMs: 200,
    onError: (error: any) => {
      console.error(error);
      return false;
    }
  }
);

const main = async() => {
  console.log('initialize', rpcHttpUrl);

  const block = await provider.getBlock('latest');

  await reliableProvider.initialize({
    parentHash: block.parentHash,
    hash: block.hash,
    number: block.number,
  });

  await sleep(1000000000);
}

main();
