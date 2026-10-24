import { build } from 'esbuild'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

type ScratchWorkerFault = 'replay-commit' | 'replay-item' | 'remove-once' | 'replay-block'
export async function buildScratchWorkerFixture(input: {
  directory: string
  fault?: ScratchWorkerFault
}) {
  const workerPath = join(input.directory, `scratch-worker-${input.fault ?? 'normal'}.cjs`)
  const tracePath = `${workerPath}.jsonl`
  await build({
    stdin: {
      contents: `
        const fs = require('node:fs');
        const Database = require('./src/main/sqlite/sync-database').default;
        const { ConversationReducerDiskItems } = require('./src/main/native-chat/conversations/conversation-reducer-disk-map');
        const { ConversationScratchOwner } = require('./src/main/native-chat/conversations/conversation-scratch-owner');
        const trace = value => fs.appendFileSync(${JSON.stringify(tracePath)}, JSON.stringify(value) + '\\n');
        const fault = ${JSON.stringify(input.fault ?? null)};
        let commits = 0;
        let blocked = false;
        const connections = new Set();
        const exec = Database.prototype.exec;
        Database.prototype.exec = function(sql) {
          connections.add(this);
          if (sql === 'COMMIT' && fault === 'replay-block' && !blocked) {
            blocked = true;
            const { BroadcastChannel } = require('node:worker_threads');
            const channel = new BroadcastChannel(${JSON.stringify(`${workerPath}.control`)});
            const buffer = new SharedArrayBuffer(4);
            channel.postMessage({ buffer, transactionOpen: this.isTransaction });
            Atomics.wait(new Int32Array(buffer), 0, 0);
            channel.close();
          }
          if (sql === 'COMMIT' && fault === 'replay-commit' && ++commits === 2) {
            trace({ kind: 'fault', operation: 'commit' });
            throw new Error('failed-scratch-commit');
          }
          const result = exec.call(this, sql);
          if (sql === 'COMMIT') trace({ kind: 'commit', idle: !this.isTransaction });
          return result;
        };
        const closeDatabase = Database.prototype.close;
        Database.prototype.close = function() {
          const result = closeDatabase.call(this);
          connections.delete(this);
          return result;
        };
        const set = ConversationReducerDiskItems.prototype.set;
        ConversationReducerDiskItems.prototype.set = function(key, value) {
          const result = set.call(this, key, value);
          if (fault === 'replay-item' && key === 'item-20') {
            trace({ kind: 'fault', operation: 'item' });
            throw new Error('batch-scratch-failed');
          }
          return result;
        };
        let removalFailed = false;
        const remove = fs.rmSync;
        fs.rmSync = function(...args) {
          if (fault === 'remove-once' && !removalFailed) {
            removalFailed = true;
            trace({ kind: 'fault', operation: 'remove' });
            throw new Error('temporary removal failed');
          }
          const result = remove.apply(this, args);
          trace({ kind: 'removed' });
          return result;
        };
        for (const operation of ['appendReplay', 'appendHistory']) {
          const original = ConversationScratchOwner.prototype[operation];
          ConversationScratchOwner.prototype[operation] = function(entries) {
            const result = original.call(this, entries);
            trace({ kind: operation, count: entries.length, bytes: Buffer.byteLength(JSON.stringify(entries)) });
            return result;
          };
        }
        const openReplay = ConversationScratchOwner.prototype.openReplay;
        ConversationScratchOwner.prototype.openReplay = function(pin) {
          const result = openReplay.call(this, pin);
          trace({ kind: 'openReplay', idle: [...connections].every(db => !db.isTransaction) });
          return result;
        };
        require('./src/main/native-chat/conversations/conversation-scratch-worker-entry');
      `,
      resolveDir: resolve('.'),
      loader: 'ts'
    },
    outfile: workerPath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    logLevel: 'silent'
  })
  return {
    workerPath,
    clearTrace: () => writeFileSync(tracePath, ''),
    trace: (): {
      kind: string
      count?: number
      bytes?: number
      idle?: boolean
      operation?: string
    }[] =>
      readFileSync(tracePath, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
  }
}
