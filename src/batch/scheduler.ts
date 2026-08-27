export interface BatchScheduleResult<T> {
  itemIndex: number;
  status: "fulfilled" | "rejected" | "skipped";
  value?: T;
  reason?: unknown;
}

export interface BoundedSchedulerOptions<TItem, TResult> {
  maxParallel: number;
  worker: (item: TItem, index: number) => Promise<TResult>;
  shouldStart?: (item: TItem, index: number) => boolean;
  onStart?: (item: TItem, index: number) => Promise<void> | void;
  onSettled?: (item: TItem, result: BatchScheduleResult<TResult>) => Promise<void> | void;
}

export async function runBoundedScheduler<TItem, TResult>(
  items: TItem[],
  options: BoundedSchedulerOptions<TItem, TResult>,
): Promise<Array<BatchScheduleResult<TResult>>> {
  if (!Number.isSafeInteger(options.maxParallel) || options.maxParallel < 1) {
    throw new Error("Batch scheduler maxParallel must be an integer >= 1.");
  }
  const results: Array<BatchScheduleResult<TResult> | undefined> = new Array(items.length);
  let nextIndex = 0;
  const runner = async (): Promise<void> => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      const item = items[index]!;
      if (options.shouldStart && !options.shouldStart(item, index)) {
        const result: BatchScheduleResult<TResult> = { itemIndex: index, status: "skipped" };
        results[index] = result;
        await options.onSettled?.(item, result);
        continue;
      }
      await options.onStart?.(item, index);
      let result: BatchScheduleResult<TResult>;
      try {
        result = {
          itemIndex: index,
          status: "fulfilled",
          value: await options.worker(item, index),
        };
      } catch (reason) {
        result = { itemIndex: index, status: "rejected", reason };
      }
      results[index] = result;
      await options.onSettled?.(item, result);
    }
  };
  const runnerCount = Math.min(options.maxParallel, items.length);
  await Promise.all(Array.from({ length: runnerCount }, () => runner()));
  return results.map((result, index) => result ?? { itemIndex: index, status: "skipped" as const });
}
