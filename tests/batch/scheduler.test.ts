import { describe, expect, test, vi } from "vitest";
import { runBoundedScheduler } from "../../src/batch/scheduler.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("bounded batch scheduler", () => {
  test("starts the ready set concurrently and keeps results in manifest order", async () => {
    const gates = [deferred<string>(), deferred<string>(), deferred<string>()];
    const starts: string[] = [];
    const completions: string[] = [];
    const scheduled = runBoundedScheduler(["constitution", "cognition", "tribunal"], {
      maxParallel: 3,
      onStart: (item) => {
        starts.push(item);
      },
      worker: (_item, index) => gates[index]!.promise,
      onSettled: (item) => {
        completions.push(item);
      },
    });
    await vi.waitFor(() => expect(starts).toEqual(["constitution", "cognition", "tribunal"]));
    gates[2]!.resolve("tribunal answer");
    await vi.waitFor(() => expect(completions).toEqual(["tribunal"]));
    gates[0]!.resolve("constitution answer");
    gates[1]!.resolve("cognition answer");
    const results = await scheduled;
    expect(results.map((result) => result.value)).toEqual([
      "constitution answer",
      "cognition answer",
      "tribunal answer",
    ]);
  });

  test("obeys capacity and stops pending starts when the owner gate closes", async () => {
    let active = 0;
    let peak = 0;
    let allowStarts = true;
    const starts: number[] = [];
    const results = await runBoundedScheduler([0, 1, 2, 3], {
      maxParallel: 2,
      shouldStart: () => allowStarts,
      onStart: (item) => {
        starts.push(item);
      },
      worker: async (item) => {
        active += 1;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active -= 1;
        if (item === 0) allowStarts = false;
        return item;
      },
    });
    expect(peak).toBeLessThanOrEqual(2);
    expect(starts).toEqual([0, 1]);
    expect(results.slice(2).every((result) => result.status === "skipped")).toBe(true);
  });
});
