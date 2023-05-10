import * as dotenv from 'dotenv'; 
import ethers, { Contract } from 'ethers';
dotenv.config();

const rpcWsUrl = process.env.RPC_WS!;
const rpcHttpUrl = process.env.RPC_HTTP!;

import { PrismaClient } from '@prisma/client'
import { Log, JsonRpcProvider } from "@ethersproject/providers";
import { BlockManager, LogSubscriber, ReliableProvider, ReliableWebsocketProvider } from '../src';
import { LogDescription, hexlify } from 'ethers/lib/utils';
import ERC20ABI from './abi/erc20.abi.json';
import { sleep } from '../src/util/sleep';
import { Mutex } from 'async-mutex';
import { enableLogging } from '../src/util/logger';

enableLogging();

const prisma = new PrismaClient()

const provider = new JsonRpcProvider(rpcHttpUrl);

type TransferEvent = {
  from: string;
  to: string;
  value: ethers.BigNumber;
}

const USDCOptimism = '0x7f5c764cbc14f9669b88837ca1490cca17c31607';


class DbReliableProvider extends ReliableWebsocketProvider {

  private mutex = new Mutex();

  public async addBlockToQueue(block: BlockManager.Block) {
    this.mutex.runExclusive(async() => {
      super.addBlockToQueue(block);
      await prisma.blockStream.create({
        data: {
          block: JSON.stringify(block),
          parentHash: block.parentHash,
          hash: block.hash,
          number: block.number,
        }
      });
    });
  }


  protected async getBlock(number: number): Promise<BlockManager.ErrorOrBlock> {
    try {
      const res = await this.options.provider.getBlock(number);
      await prisma.getBlock.create({
        data: {
          wantedNumber: number,
          block: JSON.stringify(res),
        },
      });
      return { 
        ok: {
          parentHash: res.parentHash,
          hash: res.hash,
          number: res.number,
        },
        error: undefined,
      };
    } catch(e) {
      if (e instanceof Error) {
        await prisma.getBlock.create({
          data: {
            wantedNumber: number,
            error: e.message,
          },
        });
      }

      return {
        error: "BlockNotFound",
        ok: undefined,
      }
    }

  }

  protected async getLogs(
    from: number,
    to: number,
    addressesAndTopics: BlockManager.AddressAndTopics[]
  ): Promise<BlockManager.ErrorOrLogs> {
    try {
      if (addressesAndTopics.length === 0) {
        return { error: undefined, ok: [] };
      }
      const fromBlock = hexlify(from.valueOf());
      const toBlock = hexlify(to.valueOf());
      // cannot use provider.getLogs as it does not support multiplesAddress
      const logs: ReliableProvider.LogWithHexStringBlockNumber[] =
        await this.options.provider.send("eth_getLogs", [
          {
            fromBlock,
            toBlock,
            address: addressesAndTopics.map((addr) => addr.address),
          },
        ]);

      await prisma.getLogs.create({
        data: {
          from: from,
          to: to,
          logs: JSON.stringify(logs),
        },
      });
      return {
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
      };
    } catch (e) {
      if (e instanceof Error) {
        await prisma.getLogs.create({
          data: {
            from: from,
            to: to,
            error: e.message,
          },
        });
        return { error: e.message, ok: undefined };
      } else {
        return { error: "FailedFetchingLog", ok: undefined };
      }
    }
  }

}

const reliableProvider = new DbReliableProvider(
  {
    maxBlockCached: 10,
    maxRetryGetBlock: 10,
    retryDelayGetBlockMs: 200,
    maxRetryGetLogs: 10,
    retryDelayGetLogsMs: 200,
    provider,
    batchSize: 25,
  },
  {
    wsUrl: rpcWsUrl,
    pingTimeoutMs: 1000,
    pingIntervalMs: 5000,
  }
);

class DbStorer extends LogSubscriber<TransferEvent> {

  private erc20Contract = new Contract(USDCOptimism, ERC20ABI).connect(provider);

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
      const _event: LogDescription = this.erc20Contract.interface.parseLog(log);
      if (_event.name !== "Transfer") {
        return;
      }
      
      // const decodedEvent = _event.args as any as TransferEvent;
      //
      // const block = await reliableProvider.blockManager.getBlock(log.blockNumber, false);
      //
      // console.log(`${block?.hash} === ${log.blockHash}`)

      // console.log(this.erc20Contract.callStatic);
      // const currentBalanceFrom = await this.erc20Contract.callStatic.balanceOf(decodedEvent.from, { blockTag: log.blockHash });
      // const currentBalanceTo = await this.erc20Contract.callStatic.balanceOf(decodedEvent.to, { blockTag: log.blockHash });
      //
      // const currentBalanceFrom2 = await this.erc20Contract.callStatic.balanceOf(decodedEvent.from, { blockTag: log.blockNumber - 1 });
      // const currentBalanceTo2 = await this.erc20Contract.callStatic.balanceOf(decodedEvent.to, { blockTag: log.blockNumber -1 });

      // console.log('Before block from', currentBalanceFrom2.toString());
      // console.log('Before block to', currentBalanceTo2.toString())
      //
      // console.log(`${decodedEvent.from} -> ${decodedEvent.to} ${decodedEvent.value.toBigInt()}`);
      //
      // console.log('from', currentBalanceFrom.toString());
      // console.log('to', currentBalanceTo.toString());
      //
      // console.log('----')
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
  const block = await provider.getBlock('latest');
  const block1 = await provider.getBlock(block.number - 100);

  await reliableProvider.initialize(block1);

  const sub = new DbStorer();

  reliableProvider.blockManager.subscribeToLogs({
    address: USDCOptimism,
    topics: [],
  }, sub);

  await sleep(1000000000);
}


main()
  .then(async () => {
    await prisma.$disconnect()
  })
  .catch(async (e) => {
    console.error(e)
    await prisma.$disconnect()
    process.exit(1)
  });
