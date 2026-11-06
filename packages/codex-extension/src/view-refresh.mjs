// A derived view never gates receiving, inference or delivery. One writer
// coalesces repeated group refreshes and catches errors independently.
export class ViewRefreshQueue {
  constructor({ refresh, report = () => {}, signal, delayMs = 100 }) {
    Object.assign(this, { refresh, report, signal, delayMs });
    this.pending = new Set();
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(this.timer);
        this.pending.clear();
      },
      { once: true }
    );
  }
  schedule(group) {
    if (!this.refresh || this.signal?.aborted) return;
    this.pending.add(group);
    if (!this.running && !this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.start();
      }, this.delayMs);
      this.timer.unref?.();
    }
  }
  start() {
    if (this.running) return this.running;
    this.running = (async () => {
      while (this.pending.size && !this.signal?.aborted) {
        const group = this.pending.values().next().value;
        this.pending.delete(group);
        try {
          await this.refresh(group);
        } catch {
          try {
            this.report({ event: "context.view-unavailable" });
          } catch {}
        }
      }
    })().finally(() => {
      this.running = null;
      if (this.pending.size && !this.signal?.aborted)
        this.schedule(this.pending.values().next().value);
    });
    return this.running;
  }
  async flush() {
    clearTimeout(this.timer);
    this.timer = null;
    await this.start();
    if (this.pending.size && !this.signal?.aborted) await this.flush();
  }
}
