import type { Browser } from "playwright-core";

export interface RestoredPageReconciliationOptions {
  quietMs?: number;
  timeoutMs?: number;
  pollMs?: number;
}

export async function closeRestoredBrowserPages(
  browser: Pick<Browser, "newBrowserCDPSession">,
  options: RestoredPageReconciliationOptions = {},
): Promise<number> {
  // Chrome on macOS can publish crash-restored targets several seconds after CDP attaches.
  const quietMs = options.quietMs ?? 5_000;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollMs = options.pollMs ?? 50;
  const startedAt = Date.now();
  let quietSince = startedAt;
  const closedTargetIds = new Set<string>();
  const session = await browser.newBrowserCDPSession();

  try {
    while (true) {
      const { targetInfos } = await session.send("Target.getTargets");
      const pageTargets = targetInfos.filter((target) => target.type === "page");
      if (pageTargets.length > 0) {
        quietSince = Date.now();
        for (const target of pageTargets) {
          try {
            const result = await session.send("Target.closeTarget", {
              targetId: target.targetId,
            });
            if (!result.success) {
              throw new Error(`CDP rejected Target.closeTarget for ${target.targetId}`);
            }
            closedTargetIds.add(target.targetId);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Could not close a restored Oracle browser target: ${message}`, {
              cause: error,
            });
          }
        }
      } else if (Date.now() - quietSince >= quietMs) {
        return closedTargetIds.size;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(
          `Oracle browser startup did not reach a restored-page quiet window after closing ${closedTargetIds.size} targets`,
        );
      }
      await delay(pollMs);
    }
  } finally {
    await session.detach().catch(() => undefined);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
