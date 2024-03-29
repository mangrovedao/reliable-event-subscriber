import { Log } from "@ethersproject/providers";
import { sleep } from "./util/sleep";
import { getAddress } from "ethers/lib/utils";
import logger from "./util/logger";
import LogSubscriber from "./logSubscriber";
import { Result } from "./util/types";
import { Mutex } from "async-mutex";

const ZERO_ADDRESS =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

// eslint-disable-next-line @typescript-eslint/no-namespace
namespace BlockManager {
  export type BlockWithoutParentHash = {
    number: number;
    hash: string;
  };
  export type Block = BlockWithoutParentHash & {
    parentHash: string;
  };

  export type BlockError = "BlockNotFound";

  export type ErrorOrBlock = Result<Block, BlockError>;

  export type ErrorOrBlocks = Result<Block[], BlockError>;

  export type MaxRetryError = "MaxRetryReach";

  type CommonAncestorError = "NoCommonAncestorFoundInCache" | "FailedGetBlock";

  export type ErrorOrCommonAncestor = Result<Block, CommonAncestorError>;

  type CommonAncestorOrBlockError =
    | BlockError
    | CommonAncestorError
    | MaxRetryError;

  type ReInitializeBlockManagerError = "ReInitializeBlockManager";

  export type ErrorOrReorg = Result<
    Block,
    {
      error: CommonAncestorOrBlockError | ReInitializeBlockManagerError;
      reInitialize?: Block;
    }
  >;

  type ErrorLog = "FailedFetchingLog" | string;

  export type ErrorOrLogs = Result<Log[], ErrorLog>;

  export type ErrorOrLogsWithCommonAncestor = Result<
    {
      logs: Log[]; // if commonAncestor exists than it's returning logs from commonAncestor.number + 1 to newblock.number
      commonAncestor?: Block; // commonAncestor
    },
    {
      error:
        | ErrorLog
        | CommonAncestorOrBlockError
        | MaxRetryError
        | ReInitializeBlockManagerError;
      reInitialize?: Block;
    }
  >;

  export type HandleBlockResult = Result<
    {
      logs: Log[]; // if rollback exists than it's returning logs from rollback.number + 1 to newblock.number
      rollback?: Block; // if rollback, it's the last common ancestor
    },
    | ErrorLog
    | CommonAncestorOrBlockError
    | MaxRetryError
    | ReInitializeBlockManagerError
  >;

  /**
   * Options that control how the BlockManager cache behaves.
   */
  export type Options = {
    /**
     * The maximum number of blocks to store in the cache
     */
    maxBlockCached: number;
    /**
     * The count of retry before bailing out after a failing getBlock
     */
    maxRetryGetBlock: number;
    /**
     * Delay between every getBlock retry
     */
    retryDelayGetBlockMs: number;
    /**
     * The count of retry before bailing out after a failing getLogs
     */
    maxRetryGetLogs: number;
    /**
     * Delay between every getLogs retry
     */
    retryDelayGetLogsMs: number;
    /**
     * Batch block size
     */
    batchSize: number;
  };

  export type AddressAndTopics = {
    address: string;
    topics: string[];
  };

  export type CreateOptions = Options & {
    /**
     *  getBlock with `number` == block number. Return a block or and error
     */
    getBlock: (number: number) => Promise<ErrorOrBlock>;
    /**
     *  getBlocksBatch return blocks with blockNumber between `from` (included) and `to` (included)
     */
    getBlocksBatch: (from: number, to: number) => Promise<ErrorOrBlocks>;
    /**
     *  getLogs return emitted logs by `addresses` between from (included) and to (included),
     */
    getLogs: (
      from: number,
      to: number,
      addressAndTopics: AddressAndTopics[]
    ) => Promise<ErrorOrLogs>;
  };

  export type HandleBlockPostHookFunction = () => Promise<void>;
}

/*
 * The BlockManager class is a reliable way of handling chain reorganization.
 */
class BlockManager {
  private mutex: Mutex = new Mutex();

  private blocksByNumber: Record<number, BlockManager.Block> = {}; // blocks cache

  private lastBlock: BlockManager.Block | undefined = undefined; // latest block in cache

  private subscribersByAddress: Record<string, LogSubscriber<any>> = {};
  private subscribedAddresses: BlockManager.AddressAndTopics[] = [];

  private waitingToBeInitializedSet: Set<string> = new Set<string>();

  private countsBlocksCached: number = 0;

  private postHandleBlockFunctions: BlockManager.HandleBlockPostHookFunction[] =
    [];

  constructor(private options: BlockManager.CreateOptions) {
    if (options.maxBlockCached > this.options.batchSize) {
      throw new Error("options.batchSize is smaller than max block cached");
    }
  }

  private checkLastBlockExist() {
    if (!this.lastBlock) {
      throw new Error("BlockManager last block is undefined");
    }
  }

  public getLastBlock(): BlockManager.Block {
    this.checkLastBlockExist();
    return this.lastBlock!;
  }

  public async getBlock(
    blockNumber: number,
    exclusive: boolean = true
  ): Promise<BlockManager.Block | undefined> {
    if (!exclusive) {
      return this.blocksByNumber[blockNumber];
    }
    return this.mutex.runExclusive(() => {
      return this.blocksByNumber[blockNumber];
    });
  }

  public addHandleBlockPostHook(fn: BlockManager.HandleBlockPostHookFunction) {
    this.postHandleBlockFunctions.push(fn);
  }

  private async handleBlockPostHooks() {
    await Promise.allSettled(
      this.postHandleBlockFunctions.map((post) => post())
    );
    this.postHandleBlockFunctions = [];
  }

  /**
   * Initialize the BlockManager cache with block
   */
  public async initialize(block: BlockManager.Block) {
    logger.info("[BlockManager] initialize()", { data: { block } });
    this.lastBlock = block;

    this.blocksByNumber = {};
    this.blocksByNumber[block.number] = block;
    this.countsBlocksCached = 1;

    this.waitingToBeInitializedSet = new Set(
      this.subscribedAddresses.map((addrAndTopics) => addrAndTopics.address)
    );

    await this.handleSubscribersInitialize(this.lastBlock);
  }

  /* subscribeToLogs enables a subscription for all logs emitted for the contract at the address.
   * Only one subscription can exist by address. Calling a second time this function with the same
   * address will result in cancelling the previous subscription.
   * */
  public async subscribeToLogs(
    addressAndTopics: BlockManager.AddressAndTopics,
    subscriber: LogSubscriber<any>
  ) {
    this.checkLastBlockExist();

    const checksumAddress = getAddress(addressAndTopics.address);

    logger.debug(`[BlockManager] subscribeToLogs() ${checksumAddress}`);
    this.subscribersByAddress[checksumAddress] = subscriber;

    this.subscribedAddresses.push({
      address: checksumAddress,
      topics: addressAndTopics.topics,
    });
    this.waitingToBeInitializedSet.add(checksumAddress);

    await this.handleSubscribersInitialize(this.lastBlock!);
  }

  private setLastBlock(block: BlockManager.Block) {
    logger.debug(`[BlockManager] setLastBlock()`, { data: block });
    if (this.lastBlock) {
      if (this.lastBlock.hash !== block.parentHash) {
        throw new Error(`Hash in inconsitent ${JSON.stringify(block)}`);
      }
    }
    this.lastBlock = block;
    this.blocksByNumber[block.number] = block;
    this.countsBlocksCached++;

    if (this.countsBlocksCached > this.options.maxBlockCached) {
      delete this.blocksByNumber[
        this.lastBlock.number - this.options.maxBlockCached
      ];
      this.countsBlocksCached--;
    }
  }

  /**
   * Find commonAncestor between RPC is the local cache.
   * This methods compare blocks between cache and RPC until it finds a matching block.
   * It return the matching block
   * This methods compares blocks between cache and RPC until it finds a matching block.
   * It return the matching block.
   */
  private async findCommonAncestor(
    rec: number = 0
  ): Promise<BlockManager.ErrorOrCommonAncestor> {
    if (rec === this.options.maxRetryGetBlock) {
      return { error: "FailedGetBlock", ok: undefined };
    }

    if (this.countsBlocksCached == 1) {
      return {
        error: "NoCommonAncestorFoundInCache",
        ok: undefined,
      };
    }

    const rpcBlocks = await this.options.getBlocksBatch(
      this.lastBlock!.number - this.options.batchSize,
      this.lastBlock!.number
    );

    if (rpcBlocks.error) {
      await sleep(this.options.retryDelayGetBlockMs);
      return this.findCommonAncestor(rec + 1);
    }

    const blocks = rpcBlocks.ok!;
    for (let i = 0; i < this.countsBlocksCached; ++i) {
      const currentBlockNumber = this.lastBlock!.number - i;

      const fetchedBlock = blocks[blocks.length - 1 - i];

      const cachedBlock = this.blocksByNumber[currentBlockNumber];
      if (fetchedBlock.hash === cachedBlock.hash) {
        return {
          error: undefined,
          ok: cachedBlock,
        };
      }
    }

    return { error: "NoCommonAncestorFoundInCache", ok: undefined };
  }

  /**
   * Fetch the chain from this.lastBlock.number + 1 until newBlock.number.
   * Try to reconstruct a valid chain in cache.
   *
   * A valid chain is a chain where blocks are chained with their successor with parentHash.
   *
   * block1(parentHash: "0x0", hash: "0x1") => block2("0x1", hash: "0x2")
   */
  private async populateValidChainUntilBlock(
    newBlock: BlockManager.Block,
    rec: number = 0
  ): Promise<{
    error: BlockManager.MaxRetryError | BlockManager.BlockError | undefined;
  }> {
    if (rec > this.options.maxRetryGetBlock) {
      return { error: "MaxRetryReach" };
    }

    /* fetch all blocks between this.lastBlock excluded and newBlock included '*/
    const blocksPromises: Promise<BlockManager.ErrorOrBlock>[] = [];
    for (let i = this.lastBlock!.number + 1; i <= newBlock.number; ++i) {
      blocksPromises.push(this.options.getBlock(i));
    }

    const blocks = await this.options.getBlocksBatch(
      this.lastBlock!.number + 1,
      newBlock.number
    );

    if (blocks.error) {
      return this.populateValidChainUntilBlock(newBlock, rec + 1);
    }

    const _blocks = blocks.ok!;
    for (const block of _blocks) {
      /* check that queried block is chaining with lastBlock  */
      if (this.lastBlock!.hash != block.parentHash) {
        /* TODO: this.lastBlock.hash could have been reorg ? */

        /* the getBlock might fail for some reason, wait retryDelayGetBlockMs to let it catch up*/
        await sleep(this.options.retryDelayGetBlockMs);

        /* retry until rec === maxRetryGetBlock */
        return await this.populateValidChainUntilBlock(newBlock, rec + 1);
      } else {
        /* queried block is the successor of this.lastBlock add it to the cache */
        this.setLastBlock(block);
      }
    }

    return { error: undefined };
  }

  /**
   * Establish a valid chain with last block = newBlock.number.
   *
   * Returns found commonAncestor.   */
  private async handleReorg(
    newBlock: BlockManager.Block
  ): Promise<BlockManager.ErrorOrReorg> {
    let { error, ok: commonAncestor } = await this.findCommonAncestor();

    if (error) {
      logger.warn(`[BlockManager] handleReorg(): failure ${error}`);
      if (error === "NoCommonAncestorFoundInCache") {
        /* we didn't find matching ancestor between our cache and rpc. re-initialize with newBlock */
        await this.initialize(newBlock);
        return {
          error: {
            error: "ReInitializeBlockManager",
            reInitialize: newBlock,
          },
          ok: undefined,
        };
      }
      /* findCommonAncestor did not succeed, bail out */
      return {
        error: {
          error: "FailedGetBlock",
        },
        ok: undefined,
      };
    }

    logger.debug("[BlockManager] handleReorg(): commonAncestor", {
      data: {
        commonAncestor,
      },
    });

    /* remove all blocks that has been reorged from cache */
    for (let i = commonAncestor!.number + 1; i <= this.lastBlock!.number; ++i) {
      delete this.blocksByNumber[i];
      this.countsBlocksCached--;
    }

    /* commonAncestor is the new cache latest block */
    this.lastBlock = commonAncestor;

    await this.populateValidChainUntilBlock(newBlock);

    return { error: undefined, ok: commonAncestor! };
  }
  /**
   *
   * queryLogs function tries to get logs between fromBlock (excluded) to toBlock (included). This
   * function handles retry and reorg. The function expect that all blocks between fromBlock and toBlock
   * included are available in this.blocksByNumber.
   **/
  private async queryLogs(
    fromBlock: BlockManager.Block,
    toBlock: BlockManager.Block,
    rec = 0,
    commonAncestor?: BlockManager.Block,
    blocksMap?: Record<number, BlockManager.Block>
  ): Promise<BlockManager.ErrorOrLogsWithCommonAncestor> {
    logger.debug("[BlockManager] queryLogs()", {
      data: {
        fromBlock,
        toBlock,
      },
    });
    if (rec > this.options.maxRetryGetLogs) {
      return {
        error: {
          error: "MaxRetryReach",
        },
        ok: undefined,
      };
    }

    const { error, ok } = await this.options.getLogs(
      fromBlock.number + 1,
      toBlock.number,
      this.subscribedAddresses
    );

    /* if getLogs fail retry this.options.maxRetryGetLogs  */
    if (error) {
      /* the rpc might be a bit late, wait retryDelayGetLogsMs to let it catch up */
      await sleep(this.options.retryDelayGetLogsMs);

      if (
        !error.includes("not processed yet") &&
        !error.includes("cannot be found")
      ) {
        logger.error("[BlockManager] queryLogs(): failure", {
          data: {
            error,
            fromBlock,
            toBlock,
          },
        });
      }
      return this.queryLogs(fromBlock, toBlock, rec + 1);
    }

    let logs = ok!;
    if (!Array.isArray(logs)) {
      logs = [];
    }

    /* DIRTY: if we detected a reorg we already repopulate the chain until toBlock.number */
    if (!commonAncestor && !blocksMap) {
      this.setLastBlock(toBlock);
    }

    for (const log of logs) {
      const block = blocksMap
        ? blocksMap[log.blockNumber]
        : this.blocksByNumber[log.blockNumber]; // TODO: verify that block exists

      if (!block) {
        return {
          error: {
            error: "FailedFetchingLog",
          },
          ok: undefined,
        };
      }

      /* check if queried log comes from a known block in our cache */
      if (block.hash !== log.blockHash) {
        /* queried log comes from a block we don't know => we detected a reorg */
        const { error: reorgError, ok: _commonAncestor } =
          await this.handleReorg(toBlock);

        if (reorgError) {
          return {
            error: {
              error: reorgError.error,
            },
            ok: undefined,
          };
        }
        /** Our cache is consistent again we retry queryLogs,
         * we should retry with from = _commonAncestor, to get all rollbacked events.
         * */
        return this.queryLogs(
          _commonAncestor,
          toBlock,
          rec + 1,
          _commonAncestor
        );
      }
    }

    return {
      error: undefined,
      ok: {
        logs,
        commonAncestor: commonAncestor,
      },
    };
  }

  /**
   * Call initialize on all subscribers in waitingToBeInitializedSet.
   */
  private async handleSubscribersInitialize(
    block: BlockManager.BlockWithoutParentHash
  ): Promise<void> {
    if (
      this.waitingToBeInitializedSet.size === 0 // if there is nothing to do bail out
    ) {
      return;
    }

    const toInitialize = Array.from(this.waitingToBeInitializedSet);
    this.waitingToBeInitializedSet = new Set();

    const promises = toInitialize.map((address) =>
      this.subscribersByAddress[address].initialize(block)
    );

    const results = await Promise.all(promises);

    for (const [i, res] of Object.entries(results)) {
      const address = toInitialize[parseInt(i, 10)];
      if (res) {
        /* initialize call failed retry later by adding it back to the set */
        this.waitingToBeInitializedSet.add(address);
      } else {
        const subscriber = this.subscribersByAddress[address];
        subscriber.initializedAt = block;
        subscriber.lastSeenEventBlock = block;
        logger.debug("[BlockManager] subscriberInitialize()", {
          data: {
            address,
            block,
          },
        });
      }
    }
  }

  /**
   * For each logs find if there is a matching subscriber, then call handle log on the subscriber
   */
  private async applyLogs(logs: Log[]) {
    if (this.subscribedAddresses.length === 0) {
      return;
    }

    for (const log of logs) {
      const checksumAddress = getAddress(log.address);
      log.address = checksumAddress; // DIRTY: Maybe do it at the RPC level ?

      const subscriber = this.subscribersByAddress[checksumAddress];
      if (!subscriber) continue;
      await subscriber.handleLog(log); // await log one by one to insure consitent state between listener
      logger.debug(
        `[BlockManager] handleLog() ${log.address} (${log.blockHash}, ${log.blockNumber})`
      );
    }
  }

  /**
   * Call rollback subscriber on all subscriber with lastSeenEventBlockNumber > block.number,
   * schedule re-initialize for subscriber with initializedAt > block.number
   */
  private rollbackSubscribers(block: BlockManager.Block) {
    for (const [address, subscriber] of Object.entries(
      this.subscribersByAddress
    )) {
      if (subscriber.initializedAt!.number > block.number) {
        /* subscriber has been initialized at a block newer than block
         * it needs to be initialized again.
         **/
        this.waitingToBeInitializedSet.add(address);
        logger.info("[BlockManager] addToInitializeList()", {
          data: {
            initializedAt: subscriber.initializedAt,
            block,
          },
        });
      } else if (
        subscriber.lastSeenEventBlock &&
        subscriber.lastSeenEventBlock.number > block.number
      ) {
        subscriber.rollback(block);
        logger.info("[BlockManager] rollback()", {
          data: {
            address,
            block,
          },
        });
      }
    }
  }

  private async handleBatchBlock(
    newBlock: BlockManager.Block
  ): Promise<BlockManager.HandleBlockResult> {
    this.checkLastBlockExist();

    let from = this.lastBlock!.number + 1;
    logger.info(`[BlockManager] handleBatchBlock()`, { data: newBlock });

    const logs: Log[] = [];
    do {
      const countBlocksLeft = newBlock.number - from + 1; // from is included
      logger.debug(
        `[BlockManager] handleBatchBlock() still ${countBlocksLeft} blocks left to handle`
      );

      const to =
        this.options.batchSize >= countBlocksLeft
          ? newBlock.number
          : from + this.options.batchSize;

      /* fetch all blocks between from and to  */
      const blocksResult = await this.options.getBlocksBatch(from - 1, to);

      if (blocksResult.error) {
        return { error: blocksResult.error, ok: undefined };
      }

      const blocks =
        blocksResult.ok.slice(
          1
        ); /* extract blocks between from (included) and to (included) */

      /* build a block map number to block */
      const blocksMap = blocksResult.ok.reduce((acc, block) => {
        acc[block.number] = block;
        return acc;
      }, {} as Record<number, BlockManager.Block>);

      /* get block object for `to` and `from` block numbers */
      const toBlock = blocks[blocks.length - 1];
      const fromBlock = blocks[0];

      /**
       * when quering block with a multicall sometimes it return empty block hash for block latest
       * we can override it our self, because later we check that chain valid see ref:A.
       **/
      if (toBlock.hash === ZERO_ADDRESS) {
        if (toBlock.number === newBlock.number) {
          toBlock.hash = newBlock.hash; // repair problem with multi call
        }
      }

      logger.debug("[BlockManager] handleBatchBlock()", {
        data: {
          from: fromBlock,
          to: toBlock,
        },
      });

      /**
       * ref: A
       * Here we check if the batch of blocks we queried is consitent with the chain we have in cache
       * if not then we detected a reorg
       */
      if (this.lastBlock!.hash !== fromBlock.parentHash) {
        logger.warn(`[BlockManager] batch detected a reorg`, {
          data: {
            lastBlock: this.lastBlock,
            fromBlock,
          },
        });

        const { error: reorgError, ok: reorgAncestor } = await this.handleReorg(
          newBlock
        );

        if (reorgError) {
          if (reorgError.reInitialize) {
            return {
              error: undefined,
              ok: {
                logs: [],
                rollback: reorgError.reInitialize,
              },
            };
          }
          return { error: reorgError.error, ok: undefined };
        }

        /* query all logs from `reorgAncestor` to `toBlock` */
        const { error: queryLogsError, ok: okLogs } = await this.queryLogs(
          reorgAncestor,
          toBlock,
          0,
          undefined,
          blocksMap
        );

        if (queryLogsError) {
          return { error: "FailedFetchingLog", ok: undefined };
        }

        const queryLogsAncestor = okLogs.commonAncestor;

        const rollbackToBlock = queryLogsAncestor
          ? queryLogsAncestor
          : reorgAncestor;

        this.rollbackSubscribers(rollbackToBlock);

        logs.push(...okLogs.logs);

        await this.applyLogs(okLogs.logs);

        /* do it again as subscriber may have failed to initialize in case of reorg */
        await this.handleSubscribersInitialize(newBlock);

        await this.handleBlockPostHooks();
      } else {
        const blocksMap = blocks.reduce((acc, block) => {
          acc[block.number] = block;
          return acc;
        }, {} as Record<number, BlockManager.Block>);

        const { error: queryLogsError, ok: okLogs } = await this.queryLogs(
          this.lastBlock!,
          toBlock,
          0,
          undefined,
          blocksMap
        );

        if (queryLogsError) {
          return { error: "FailedFetchingLog", ok: undefined };
        }

        if (okLogs.commonAncestor) {
          this.rollbackSubscribers(okLogs.commonAncestor);
        } else {
          /* construct valid chain */
          for (const block of blocks) {
            this.setLastBlock(block);
          }
        }

        logs.push(...okLogs.logs);
        await this.applyLogs(okLogs.logs);
      }

      from = toBlock.number + 1;
      if (newBlock.number !== this.lastBlock!.number) {
        await sleep(this.options.retryDelayGetBlockMs);
      }
    } while (newBlock!.number !== this.lastBlock!.number);

    return {
      error: undefined,
      ok: {
        logs: logs,
      },
    };
  }

  async _handleBlock(
    newBlock: BlockManager.Block
  ): Promise<BlockManager.HandleBlockResult> {
    this.checkLastBlockExist();
    const cachedBlock = this.blocksByNumber[newBlock.number];
    if (cachedBlock && cachedBlock.hash === newBlock.hash) {
      /* newBlock is already stored in cache bail out*/
      logger.debug(
        "[BlockManager] handleBlock() block already in cache, ignoring...",
        { data: newBlock }
      );
      return { error: undefined, ok: { logs: [], rollback: undefined } };
    }

    if (newBlock.number - this.lastBlock!.number > 1) {
      return await this.handleBatchBlock(newBlock);
    }

    await this.handleSubscribersInitialize(newBlock);

    if (newBlock.parentHash !== this.lastBlock!.hash) {
      /* newBlock is not successor of this.lastBlock a reorg has been detected */
      logger.warn("[BlockManager] handleBlock() reorg", {
        data: {
          last: this.lastBlock,
          newBlock: newBlock,
        },
      });

      const { error: reorgError, ok: reorgAncestor } = await this.handleReorg(
        newBlock
      );

      if (reorgError) {
        if (reorgError.reInitialize) {
          return {
            error: undefined,
            ok: {
              logs: [],
              rollback: reorgError.reInitialize,
            },
          };
        }
        return { error: reorgError.error, ok: undefined };
      }

      const { error: queryLogsError, ok: okQueryLogs } = await this.queryLogs(
        reorgAncestor,
        newBlock,
        0,
        reorgAncestor
      );

      if (queryLogsError) {
        if (queryLogsError.error === "ReInitializeBlockManager") {
          return {
            error: undefined,
            ok: {
              logs: [],
              rollback: queryLogsError.reInitialize,
            },
          };
        }
        return {
          error: queryLogsError.error,
          ok: undefined,
        };
      }

      const queryLogsAncestor = okQueryLogs.commonAncestor;

      const rollbackToBlock = queryLogsAncestor
        ? queryLogsAncestor
        : reorgAncestor;

      this.rollbackSubscribers(rollbackToBlock);
      await this.applyLogs(okQueryLogs.logs);

      /* do it again as subscriber may have failed to initialize in case of reorg */
      await this.handleSubscribersInitialize(newBlock);

      await this.handleBlockPostHooks();
      return {
        error: undefined,
        ok: {
          logs: okQueryLogs.logs,
          rollback: rollbackToBlock,
        },
      };
    } else {
      logger.debug(`[BlockManager] handleBlock() normal`, { data: newBlock });
      const { error: queryLogsError, ok: okQueryLogs } = await this.queryLogs(
        this.lastBlock!,
        newBlock
      );

      if (queryLogsError) {
        if (queryLogsError.error === "ReInitializeBlockManager") {
          return {
            error: undefined,
            ok: {
              logs: [],
              rollback: queryLogsError.reInitialize,
            },
          };
        }
        return { error: queryLogsError.error, ok: undefined };
      }

      if (okQueryLogs.commonAncestor) {
        this.rollbackSubscribers(okQueryLogs.commonAncestor);
      }
      await this.applyLogs(okQueryLogs.logs);

      /* do it again as subscriber may have failed to initialize in case of reorg */
      await this.handleSubscribersInitialize(newBlock);

      await this.handleBlockPostHooks();
      return {
        error: undefined,
        ok: {
          logs: okQueryLogs.logs,
          rollback: okQueryLogs.commonAncestor,
        },
      };
    }
  }

  /**
   * Add new block in BlockManager cache, detect reorganization, and ensure that cache is consistent
   */
  async handleBlock(
    newBlock: BlockManager.Block
  ): Promise<BlockManager.HandleBlockResult> {
    return await this.mutex.runExclusive(async () => {
      return this._handleBlock(newBlock);
    });
  }
}

export default BlockManager;
