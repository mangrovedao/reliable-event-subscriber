import * as dotenv from 'dotenv'; 
dotenv.config();

import { JsonRpcProvider } from "@ethersproject/providers";
import { BlockManager, LogSubscriber, ReliableHttpProvider, enableLogging } from "../src";
import { sleep } from "@mangrovedao/commonlib.js";
import { Log } from "@ethersproject/providers";

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
    estimatedBlockTimeMs: 2000,
    onError: (error: any) => {
      console.error(error);
      return false;
    }
  }
);

class Subscriber extends LogSubscriber<any> {

  /**
   * initialize subscriber at block `block`.
   */
  public async initialize(
    block: BlockManager.BlockWithoutParentHash
  ): Promise<LogSubscriber.InitializeErrorOrBlock> {
    return undefined;
  }

  /**
   * handle log
   */
  async handleLog(log: Log): Promise<void> {
    try {
    } catch(e){
      console.error(e);
    }
  }

  /**
   * rollback subscriber to block `block`
   */
  rollback(block: BlockManager.Block): void {

  }
}

const main = async() => {
  console.log('initialize', rpcHttpUrl);

  const block = await provider.getBlock('latest');

  const sub = new Subscriber();

  await reliableProvider.initialize({
    parentHash: block.parentHash,
    hash: block.hash,
    number: block.number,
  });
  await reliableProvider.blockManager.subscribeToLogs({
    address: '0x823701dD29451766d5B9eF6b54ef42642F545cd7',
    topics: [],
  }, sub);

  await sleep(1000000000);
}

main();
