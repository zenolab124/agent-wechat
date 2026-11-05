import { mkdirSync, openSync, closeSync, writeFileSync, readFileSync, renameSync, rmSync, fsyncSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { recordResult, TOKEN_FIELDS } from './usage.mjs';

export class StateStore {
  constructor(directory, binding) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    this.lock = join(directory, 'worker.lock');
    const fd = openSync(this.lock, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify({ pid: process.pid })); closeSync(fd);
    try {
      this.file = join(directory, 'state.json');
      try { this.data = JSON.parse(readFileSync(this.file, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      this.data ??= { schema: 2, binding, cursor: '0', activatedAt: new Date().toISOString(), tasks: {}, lastReply: {}, usage: { since: new Date().toISOString(), groups: {} } };
      if (![1, 2].includes(this.data.schema) || JSON.stringify(this.data.binding) !== JSON.stringify(binding)
        || !/^\d+$/.test(this.data.cursor) || !this.data.tasks || !this.data.lastReply
        || !Number.isFinite(Date.parse(this.data.activatedAt))) throw Error('State/account binding is invalid; refusing to reset');
      if (this.data.schema === 1) {
        this.data.schema = 2;
        this.data.usage = { since: new Date().toISOString(), groups: {} };
      }
      if (!this.data.usage?.groups || Array.isArray(this.data.usage.groups) || typeof this.data.usage.groups !== 'object'
        || !Number.isFinite(Date.parse(this.data.usage.since))) throw Error('Invalid usage journal; refusing to reset limits');
      for (const group of Object.values(this.data.usage.groups)) {
        for (const key of ['observedMessages', 'mergedMessages', 'callsStarted', 'completedCalls', 'failedCalls', 'unknownCalls', 'silentCalls', 'reportedCalls', 'unreportedCalls', 'rateLimitedBatches', 'rateLimitedMessages', 'repliesAccepted']) {
          if (!Number.isSafeInteger(group[key]) || group[key] < 0) throw Error('Invalid usage counter');
        }
        if (!Array.isArray(group.callTimes) || group.callTimes.some(at => !Number.isSafeInteger(at) || at < 0)
          || group.lastCallAt !== null && (!Number.isSafeInteger(group.lastCallAt) || group.lastCallAt < 0)
          || !group.tokens || TOKEN_FIELDS.some(key => !Number.isSafeInteger(group.tokens[key]) || group.tokens[key] < 0)) throw Error('Invalid persisted rate limits or tokens');
        const settled = group.completedCalls + group.failedCalls + group.unknownCalls;
        if (settled > group.callsStarted || group.reportedCalls + group.unreportedCalls !== settled
          || group.callTimes.length > group.callsStarted || (group.callsStarted === 0) !== (group.lastCallAt === null)) throw Error('Inconsistent usage journal');
      }
      // A crash during inference never grants another model call for the same batch.
      for (const task of Object.values(this.data.tasks)) if (task.state === 'generating') {
        recordResult(this.data, task, null, 'unknown');
        task.state = 'generation-unknown';
      }
      this.save();
    } catch (error) { this.close(); throw error; }
  }
  save() {
    const temporary = join(this.directory, `.state-${randomUUID()}`);
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(this.data)); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(temporary, this.file);
    const parent = openSync(this.directory, 'r');
    try { fsyncSync(parent); } finally { closeSync(parent); }
  }
  close() { if (this.lock) { rmSync(this.lock); this.lock = null; } }
}
