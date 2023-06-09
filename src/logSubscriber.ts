import { Log } from "@ethersproject/providers";
import { Result } from "./util/types";
import BlockManager from "./blockManager";

namespace LogSubscriber {
  export type Error =
    | "CouldNotInitializeReorged"
    | "FailedInitialize"
    | "FailedHandleLog";

  export type InitializeErrorOrBlock = Error | undefined;

  export type ErrorOrState<T> = Result<
    T,
    Error
  >;
}
/**
 * LogSubscriber class define the interface that needs to be supported to subscribeToLogs
 * through BlockManager.
 */
abstract class LogSubscriber<ParsedEvent> {
  public initializedAt?: BlockManager.BlockWithoutParentHash; // block which the subscriber initialized at.
  public lastSeenEventBlock?: BlockManager.BlockWithoutParentHash; // last log block number handled

  /**
   * initialize subscriber at block `block`.
   */
  abstract initialize(
    block: BlockManager.BlockWithoutParentHash
  ): Promise<LogSubscriber.InitializeErrorOrBlock>;
  /**
   * handle log
   */
  abstract handleLog(log: Log, event?: ParsedEvent): Promise<void>;
  /**
   * rollback subscriber to block `block`
   */
  abstract rollback(block: BlockManager.Block): void;
}

export default LogSubscriber;
