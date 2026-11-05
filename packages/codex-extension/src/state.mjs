import { mkdirSync, openSync, closeSync, writeFileSync, readFileSync, renameSync, rmSync, fsyncSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

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
      this.data ??= { schema: 1, binding, cursor: '0', activatedAt: new Date().toISOString(), tasks: {}, lastReply: {} };
      if (this.data.schema !== 1 || JSON.stringify(this.data.binding) !== JSON.stringify(binding)
        || !/^\d+$/.test(this.data.cursor) || !this.data.tasks || !this.data.lastReply
        || !Number.isFinite(Date.parse(this.data.activatedAt))) throw Error('State/account binding is invalid; refusing to reset');
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
