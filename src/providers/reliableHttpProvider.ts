import { Block } from "@ethersproject/providers";
import { Mutex } from "async-mutex";
import logger from "../util/logger";
import ReliableProvider from "./reliableProvider";
import MULIV2ABI from '../abi/multi-v2.abi.json';
import { Contract } from "ethers";
import BlockManager from "../blockManager";
import { sleep } from "@mangrovedao/commonlib.js";

namespace ReliableHttpProvider {
  export type Options = {
    estimatedBlockTimeMs: number;
    multiv2Address: string;
  };
}

/**
  * ReliableHttpProvider is an implementation of ReliableProvider. It use http polling to get new blocks 
  */
class ReliableHttpProvider extends ReliableProvider {
  private shouldStop: boolean = false;
  private mutex: Mutex = new Mutex();

  private lastKnownBlockNumber: number = -2; // -2 means that we are currently initializing so we should query block 'latest'
  private timeoutId: NodeJS.Timeout | undefined;

  private multiContract: Contract;

  constructor(
    options: ReliableProvider.Options,
    private httpOptions: ReliableHttpProvider.Options
  ) {
    super(options);
    this.multiContract = new Contract(httpOptions.multiv2Address, MULIV2ABI, options.provider);
  }

  async _initialize(): Promise<void> {
    this.shouldStop = false;
    await this.getLatestBlock();
  }

  /**
    * getBlockWithMultiCalls get blocks between from (not included) and to (not included)
    */
  private async getBlockWithMultiCalls(from: number, to: number) {
    logger.debug(`[ReliableHttpProvider] getBlockWithMultiCalls from: ${from}, to: ${to}`);
    const calls = [] as {
      target: string,
      callData: string,
      blockNumber: number,
    }[];

    for (let i = from ; i < to; ++i) {
      calls.push({
        target: this.multiContract.address,
        callData: this.multiContract.interface.encodeFunctionData('getBlockHash', [i]),
        blockNumber: i,
      });
    }

    const results = await this.multiContract.callStatic.aggregate(calls);

    const blocks: BlockManager.Block[] = results.returnData.map((res: any, index: number) => {
      if (index === 0) {
        return {
          parentHash: '',
          blockHash: '',
          number: 0,
        }
      }
      return {
        parentHash: results.returnData[index - 1],
        blockHash: this.multiContract.interface.decodeFunctionResult('getBlockHash', res).blockHash,
        number: calls[index].blockNumber,
      };
    });

    blocks.shift();
    return blocks;
  }

  async getLatestBlock(): Promise<void> {
    await this.mutex.runExclusive(async () => {
      if (this.timeoutId) {
        clearTimeout(this.timeoutId);
        this.timeoutId = undefined;
      }
      if (this.shouldStop) {
        return;
      }

      try {
        const blockHeader: Block = await this.options.provider.getBlock(
          "latest"
        ); 

        if (this.lastKnownBlockNumber !== -2) {
          /* if ReliableHttpProvider is already initialized then fetch all blocks between this.lastKnownBlockNumber and blockHeader.number */
          const blocks = await this.getBlockWithMultiCalls(this.lastKnownBlockNumber, blockHeader.number);

          for (const block of blocks) {
            this.addBlockToQueue({
              parentHash: block.parentHash,
              hash: block.hash,
              number: block.number,
            });
          }
        }

        this.lastKnownBlockNumber = blockHeader.number;

        this.addBlockToQueue({
          parentHash: blockHeader.parentHash,
          hash: blockHeader.hash,
          number: blockHeader.number,
        });
      } catch (e) {
        logger.error('failed handling block', e);
      }

      await sleep(10000);

      /* we could write a smarter algoritm which try to be as close as possible with blockChain block production rate */
      this.timeoutId = setTimeout(
        this.getLatestBlock.bind(this),
        this.httpOptions.estimatedBlockTimeMs
      );
    });
  }

  stop(): void {
    logger.debug("[ReliableHttpProvider] stop");
    this.shouldStop = true;
    clearTimeout(this.timeoutId);
    this.timeoutId = undefined;
    this.lastKnownBlockNumber = -2;
  }
}

export default ReliableHttpProvider;
