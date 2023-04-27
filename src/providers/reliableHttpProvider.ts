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
          const blockPromises = [];

          for (let i = this.lastKnownBlockNumber; i < blockHeader.number; ++i) {
            blockPromises.push(this.options.provider.getBlock(i));
          }

          const blocks = await Promise.allSettled(blockPromises);

          for (const block of blocks) {
            if (block.status === "rejected") {
              continue;
            }
            this.addBlockToQueue({
              parentHash: block.value.parentHash,
              hash: block.value.hash,
              number: block.value.number,
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

      /* re-check that we should not stop before setting a new timeout, the async steps above could be interleaved with other code invoking stop. */
      if (this.shouldStop) {
        return;
      }
      /* we could write a smarter algorithm which try to be as close as possible with blockChain block production rate */
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
