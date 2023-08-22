import { JsonRpcProvider, Log } from "@ethersproject/providers";
import BlockManager from "../blockManager";
import { hexStripZeros, hexlify, stripZeros } from "ethers/lib/utils";
import { Contract } from "ethers";
import MULIV2ABI from '../abi/multi-v2.abi.json';
import logger from "../util/logging/logger";

// eslint-disable-next-line @typescript-eslint/no-namespace
namespace ReliableProvider {
  export type Options = BlockManager.Options & {
    provider: JsonRpcProvider;
    multiv2Address: string;
    getLogsTimeout: number;
  };

  export type LogWithHexStringBlockNumber = Omit<Log, "blockNumber"> & {
    blockNumber: string;
  };
}

/**
  * ReliableProvider is an abstract handling block and logs fetching.
  *
  * The actual implementation needs to query new blocks and add them to the queue using 
  * addBlockToQueue function.   
  */
abstract class ReliableProvider {
  public blockManager: BlockManager;

  private queue: BlockManager.Block[] = [];

  private inProcess: boolean = false;
  private multiContract: Contract;

  protected lastReceivedBlock: BlockManager.Block | undefined;

  constructor(
    protected options: ReliableProvider.Options,
  ) {
    this.multiContract = new Contract(options.multiv2Address, MULIV2ABI, options.provider);
    this.blockManager = new BlockManager({
      maxBlockCached: options.maxBlockCached,
      getBlock: this.getBlock.bind(this),
      getBlocksBatch: this.getBlockWithMultiCalls.bind(this),
      getLogs: this.getLogs.bind(this),
      maxRetryGetBlock: options.maxRetryGetLogs,
      retryDelayGetBlockMs: options.maxRetryGetBlock,
      maxRetryGetLogs: options.maxRetryGetLogs,
      retryDelayGetLogsMs: options.retryDelayGetLogsMs,
      batchSize: options.batchSize,
    });
  }

  abstract _initialize(): Promise<void>;

  public async initialize(block: BlockManager.Block) {
    await this.blockManager.initialize(block);
    this.lastReceivedBlock = block;

    await this._initialize();

    logger.debug(`[ReliableProvider] successfully initialized`);
  }

  public abstract stop(): void;

  getLatestBlock?(): Promise<void>;

  public addBlockToQueue(block: BlockManager.Block) {
    this.lastReceivedBlock = block;
    this.queue.push(block);
    this.tick();

    logger.debug(`[ReliableProvider] addBlockToQueue`, {
      data: block,
    });
  }

  private async tick() {
    if (this.inProcess) {
      return;
    }

    this.inProcess = true;

    let until = this.queue.length;
    for (let i = 0; i < until; ++i) {
      const result = await this.blockManager.handleBlock(this.queue[i]); // blocks needs to be handle in order
      if (result.error) {
        logger.warn('[ReliableProvider] handle block', {
          data: {
            block: this.queue[i],
            result,
          }
        });
      }

      until = this.queue.length; // queue can grow during the async call
    }

    this.queue = [];
    this.inProcess = false;
  }

  protected async getBlock(number: number): Promise<BlockManager.ErrorOrBlock> {
    try {
      const block = await this.options.provider.getBlock(number);
      logger.debug(`[ReliableWebSocket] getBlock successful`, {
        data: block,
      });
      return {
        error: undefined,
        ok: {
          parentHash: block.parentHash,
          hash: block.hash,
          number: block.number,
        },
      };
    } catch (e) {
      return { error: "BlockNotFound", ok: undefined };
    }
  }

  /**
    * getBlockWithMultiCalls get blocks between from (included) and to (included)
    */
  protected async getBlockWithMultiCalls(from: number, to: number): Promise<BlockManager.ErrorOrBlocks> {
    if (from === to) {
      return { error: undefined, ok: []};
    }
    if (from < 1) {
      from = 1;
    }
    logger.debug(`[ReliableProvider] getBlockWithMultiCalls from: ${from}, to: ${to}`);
    const calls = [] as {
      target: string,
      callData: string,
      blockNumber: number,
    }[];

    for (let i = from - 1 ; i <= to; ++i) {
      calls.push({
        target: this.multiContract.address,
        callData: this.multiContract.interface.encodeFunctionData('getBlockHash', [i]),
        blockNumber: i,
      });
    }

    try {
      const results = await this.multiContract.callStatic.aggregate(calls,  (this.lastReceivedBlock!.number - this.options.batchSize) > to ?  { blockTag: to + 1 } : {}); // specify blockTag only if we are one batchSize away from lastBlock

      const blocks: BlockManager.Block[] = results.returnData.map((res: any, index: number) => {
        if (index === 0) {
          /**
            * Tricks: I fetched all blocks between from (included) and to (not included)
            * so that I can have the parentHash of from + 1 
            */
          return {
            parentHash: '',
            hash: '',
            number: 0,
          } as BlockManager.Block
        }
        return {
          parentHash: results.returnData[index - 1],
          hash: this.multiContract.interface.decodeFunctionResult('getBlockHash', res).blockHash,
          number: calls[index].blockNumber,
        } as BlockManager.Block;
      });

      blocks.shift(); // removing (from - 1) block
  
      logger.debug(`[ReliableWebSocket] getBlockWithMultiCalls successful. (blocks.length = ${blocks.length})`);
      return { 
        error: undefined, 
        ok: blocks, 
      };
    } catch (e) {
      logger.warn(`[ReliableProvider] ${e}`);
      return { error: "BlockNotFound", ok:undefined};
    }
  }

  protected async getLogs(
    from: number,
    to: number,
    addressesAndTopics: BlockManager.AddressAndTopics[]
  ): Promise<BlockManager.ErrorOrLogs> {
    return new Promise<BlockManager.ErrorOrLogs>(async(resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject({ error: "Timeout", ok: undefined });
      }, this.options.getLogsTimeout);
      try {
        if (addressesAndTopics.length === 0) {
          return { error: undefined, ok: [] };
        }
        if (from < 1) {
          from = 1;
        }

        const fromBlock = hexStripZeros(hexlify(from.valueOf()));
        const toBlock = hexStripZeros(hexlify(to.valueOf()));

        // cannot use provider.getLogs as it does not support multiplesAddress
        const logs: ReliableProvider.LogWithHexStringBlockNumber[] =
          await this.options.provider.send("eth_getLogs", [
            {
              fromBlock,
              toBlock,
              address: addressesAndTopics.map((addr) => addr.address),
            },
          ]);

        logger.debug(`[ReliableWebSocket] getLogs successful. (logs.length = ${logs.length})`);
        return resolve({
          error: undefined,
          ok: logs.map((log) => {
            return {
              blockNumber: parseInt(log.blockNumber, 16),
              blockHash: log.blockHash,
              transactionIndex: log.transactionIndex,

              removed: log.removed,

              address: log.address,
              data: log.data,

              topics: log.topics,

              transactionHash: log.transactionHash,
              logIndex: log.logIndex,
            };
          }),
        });
      } catch (e) {
        if (e instanceof Error) {
          return reject({ error: e.message, ok: undefined });
        } else {
          return reject({ error: "FailedFetchingLog", ok: undefined });
        }
      } finally {
        clearTimeout(timeoutId);
      } 
    }).catch((err: Error) => {
      return Promise.resolve({
        error: err.message,
        ok: undefined,
      });
    });
  }
}

export default ReliableProvider;
