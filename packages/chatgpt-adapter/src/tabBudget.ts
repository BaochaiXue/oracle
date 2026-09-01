export const MAX_OWNED_CHATGPT_TABS = 3 as const;

export type ReleaseOwnedTab = () => void;

interface PendingLease {
  resolve(release: ReleaseOwnedTab): void;
  reject(error: Error): void;
}

export class OwnedTabBudget {
  readonly limit: number;
  private activeCount = 0;
  private readonly waiters: PendingLease[] = [];
  private closedError?: Error;

  constructor(limit: number = MAX_OWNED_CHATGPT_TABS) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error("Owned ChatGPT tab capacity must be a positive integer");
    }
    if (limit > MAX_OWNED_CHATGPT_TABS) {
      throw new Error(`Oracle v2 may own at most ${MAX_OWNED_CHATGPT_TABS} ChatGPT tabs`);
    }
    this.limit = limit;
  }

  get active(): number {
    return this.activeCount;
  }

  get pending(): number {
    return this.waiters.length;
  }

  acquire(): Promise<ReleaseOwnedTab> {
    if (this.closedError) return Promise.reject(this.closedError);
    if (this.activeCount < this.limit) return Promise.resolve(this.grant());
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  close(error = new Error("Oracle v2 ChatGPT tab budget closed")): void {
    if (this.closedError) return;
    this.closedError = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  private grant(): ReleaseOwnedTab {
    this.activeCount += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeCount -= 1;
      if (this.closedError) return;
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(this.grant());
    };
  }
}
