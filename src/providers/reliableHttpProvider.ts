import { Block } from "@ethersproject/providers";
import { Mutex } from "async-mutex";
import logger from "../util/logger";
import ReliableProvider from "./reliableProvider";

namespace ReliableHttpProvider {
  export type Options = {
    estimatedBlockTimeMs: number;
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


  constructor(
    options: ReliableProvider.Options,
    private httpOptions: ReliableHttpProvider.Options
  ) {
    super(options);
  }

  async _initialize(): Promise<void> {
    this.shouldStop = false;
    await this.getLatestBlock();
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

          if (blocks.error) {
            throw new Error(blocks.error);
          }

          for (const block of blocks.ok) {
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
