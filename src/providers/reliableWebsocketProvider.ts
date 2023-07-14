import BlockManager from "../blockManager";
import ReliableProvider from "./reliableProvider";
import {
  ReliableWebSocket,
  ReliableWebsocketOptions,
} from "./reliableWebsocket";
import { JsonRPC } from "./jsonRpc";
import logger from "../util/logging/logger";

const NO_BLOCK_FACTOR = 10;

const newHeadsMsg = `{"id": 1, "method": "eth_subscribe", "params": ["newHeads"]}`;

// eslint-disable-next-line @typescript-eslint/no-namespace
namespace ReliableWebsocketProvider {
  export type Options = Omit<
    ReliableWebsocketOptions,
    "msgHandler" | "initMessages"
  > & {
    estimatedBlockTimeMs: number;
  };
}


/**
  * ReliableWebsocketProvider is an implementation of ReliableProvider. It use websocket
  * subscription to "newHeads" to get new block.
  */
class ReliableWebsocketProvider extends ReliableProvider {
  private reliableWebSocket: ReliableWebSocket;

  private blockTimeout?: NodeJS.Timeout;

  private blockTimeoutMs: number;

  constructor(
    options: ReliableProvider.Options,
    private wsOptions: ReliableWebsocketProvider.Options
  ) {
    super(options);
    this.reliableWebSocket = new ReliableWebSocket({
      msgHandler: this.handleMessage.bind(this),
      initMessages: [newHeadsMsg],
      ...wsOptions,
    });

    this.blockTimeoutMs = this.wsOptions.estimatedBlockTimeMs * NO_BLOCK_FACTOR;
  }

  async _initialize(): Promise<void> {
    await this.reliableWebSocket.initialize();
    this.blockTimeout = setTimeout(this.noBlockCallback.bind(this), this.blockTimeoutMs);
  }

  stop(): void {
    clearTimeout(this.blockTimeout);
    this.blockTimeout = undefined;

    this.reliableWebSocket.stop();
  }

  private handleMessage(msg: string) {
    const decodedMsg = JsonRPC.decodeJSONAndCast<JsonRPC.Msg<any>>(msg);
    if (decodedMsg.error) {
      return;
    }

    if (decodedMsg.ok.method !== "eth_subscription" || !decodedMsg.ok) {
      return;
    }

    clearTimeout(this.blockTimeout);
    this.blockTimeout = setTimeout(this.noBlockCallback.bind(this), this.blockTimeoutMs);
    const blockHeader: JsonRPC.BlockHeader = decodedMsg.ok.params.result;

    const block: BlockManager.Block = {
      parentHash: blockHeader.parentHash,
      hash: blockHeader.hash,
      number: parseInt(blockHeader.number, 16),
    };

    this.addBlockToQueue(block);
  }

  private async noBlockCallback() {
    logger.warn(`[ReliableWebsocketProvider] no block for ${this.blockTimeoutMs}ms restart websocket`);

    this.reliableWebSocket.restart();
    this.blockTimeout = setTimeout(this.noBlockCallback.bind(this), this.blockTimeoutMs);
  }
}

export default ReliableWebsocketProvider;
