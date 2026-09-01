import type { BrowserContext, Page } from "playwright-core";

export interface RestoredPageReconciliationOptions {
  quietMs?: number;
  timeoutMs?: number;
  pollMs?: number;
  preserveWindowNames?: readonly string[];
}

export async function closeRestoredBrowserPages(
  context: Pick<BrowserContext, "newCDPSession" | "pages">,
  options: RestoredPageReconciliationOptions = {},
): Promise<number> {
  // Chrome on macOS can publish crash-restored targets several seconds after CDP attaches.
  const quietMs = options.quietMs ?? 5_000;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollMs = options.pollMs ?? 50;
  const preserveWindowNames = new Set(options.preserveWindowNames ?? []);
  const startedAt = Date.now();
  let quietSince = startedAt;
  const closedPages = new Set<Page>();

  while (true) {
    let closedThisPass = 0;
    for (const page of context.pages()) {
      if (page.isClosed() || closedPages.has(page)) continue;
      if (preserveWindowNames.has(await readRecoveryWindowName(context, page))) continue;
      try {
        await page.close({ runBeforeUnload: false });
        closedPages.add(page);
        closedThisPass += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Could not close a restored Oracle browser target: ${message}`, {
          cause: error,
        });
      }
    }
    if (closedThisPass > 0) {
      quietSince = Date.now();
    } else if (Date.now() - quietSince >= quietMs) {
      return closedPages.size;
    }
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(
        `Oracle browser startup did not reach a restored-page quiet window after closing ${closedPages.size} targets`,
      );
    }
    await delay(pollMs);
  }
}

export async function readRecoveryWindowName(
  context: Pick<BrowserContext, "newCDPSession">,
  page: Page,
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let session: Awaited<ReturnType<BrowserContext["newCDPSession"]>> | undefined;
    try {
      session = await context.newCDPSession(page);
      const response = await session.send("Runtime.evaluate", {
        expression: "window.name",
        returnByValue: true,
      });
      if (response.exceptionDetails || typeof response.result.value !== "string") {
        throw new Error("Runtime.evaluate did not return a string window.name value");
      }
      return response.result.value;
    } catch (error) {
      lastError = error;
      await delay(25);
    } finally {
      await session?.detach().catch(() => undefined);
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Could not inspect a restored Oracle browser recovery marker: ${detail}`, {
    cause: lastError,
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
