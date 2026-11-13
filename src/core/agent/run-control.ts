export class AgentRunControl {
  private readonly controller = new AbortController();
  private paused = false;
  private releasePause?: () => void;
  private clearAbortListener?: () => void;

  get signal() { return this.controller.signal; }
  pause() { if (!this.signal.aborted) this.paused = true; }
  resume() { this.paused = false; this.clearAbortListener?.(); this.clearAbortListener = undefined; this.releasePause?.(); this.releasePause = undefined; }
  stop() { if (!this.signal.aborted) this.controller.abort(new DOMException('Task stopped', 'AbortError')); this.resume(); }

  async checkpoint() {
    if (this.signal.aborted) throw new DOMException('Task stopped', 'AbortError');
    while (this.paused) {
      await new Promise<void>((resolve) => {
        const finish = () => {
          this.signal.removeEventListener('abort', finish);
          this.clearAbortListener = undefined;
          resolve();
        };
        this.releasePause = finish;
        this.clearAbortListener = () => this.signal.removeEventListener('abort', finish);
        this.signal.addEventListener('abort', finish, { once: true });
      });
      this.releasePause = undefined;
      if (this.signal.aborted) throw new DOMException('Task stopped', 'AbortError');
    }
  }
}
