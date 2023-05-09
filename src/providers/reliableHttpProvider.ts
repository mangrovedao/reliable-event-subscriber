import { Block } from "@ethersproject/providers";
import { Mutex } from "async-mutex";
import logger from "../util/logger";
import ReliableProvider from "./reliableProvider";

namespace ReliableHttpProvider {
  export type Options = {
    estimatedBlockTimeMs: number;
    onError: (e: any) => boolean;
  };
}

/**
  * ReliableHttpProvider is an implementation of ReliableProvider. It use http polling to get new blocks 
  */
class ReliableHttpProvider extends ReliableProvider {
  private shouldStop: boolean = false;
  private mutex: Mutex = new Mutex();

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

        this.addBlockToQueue({
          parentHash: blockHeader.parentHash,
          hash: blockHeader.hash,
          number: blockHeader.number,
        });
      } catch (e) {
        logger.error('failed handling block', e);
        if (this.httpOptions.onError(e)) {
          this.stop();
        }
        return;
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
  }
}

export default ReliableHttpProvider;
