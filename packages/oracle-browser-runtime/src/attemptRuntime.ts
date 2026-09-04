import path from "node:path";
import type { Page } from "playwright-core";
import { readAttemptSandbox, writeAttemptProcessReceipt } from "./attemptSandbox.js";
import { inspectOracleBrowserRuntime } from "./discovery.js";
import { launchManagedChromeForTesting } from "./managedBrowser.js";
import { ORACLE_BROWSER_RUNTIME_ID } from "./types.js";
import { writePrivateJson } from "./runtime.js";
import type {
  AttemptProcessReceipt,
  LaunchManagedBrowser,
  OracleAttemptBrowserRuntime,
  RuntimeInspectionOptions,
  RuntimeLaunchReceipt,
} from "./types.js";

const LAUNCH_RECEIPT = "browser-runtime-launch.json";

export async function launchAttemptBrowserRuntime(options: {
  sandboxDirectory: string;
  headless?: boolean;
  preserveWindowNames?: readonly string[];
  inspection?: RuntimeInspectionOptions;
  launchManagedBrowser?: LaunchManagedBrowser;
}): Promise<OracleAttemptBrowserRuntime> {
  if ((options.preserveWindowNames?.length ?? 0) > 1) {
    throw new Error("An attempt sandbox may preserve at most one exact recovery marker");
  }
  const sandbox = await readAttemptSandbox(options.sandboxDirectory);
  const inspection = inspectOracleBrowserRuntime(options.inspection);
  if (inspection.availability !== "available" || !inspection.executablePath) {
    throw new Error(`Managed Chrome for Testing runtime is unavailable: ${inspection.reason}`);
  }
  const launch = options.launchManagedBrowser ?? launchManagedChromeForTesting;
  let processReceipt: AttemptProcessReceipt | undefined;
  const launched = await launch({
    executablePath: inspection.executablePath,
    profileDir: sandbox.profileDir,
    headless: options.headless ?? false,
    captureProcessIdentity: true,
    ...(!options.launchManagedBrowser
      ? {
          onProcessIdentity: async (identity) => {
            processReceipt = await writeAttemptProcessReceipt(sandbox, identity);
          },
        }
      : {}),
    ...(options.preserveWindowNames?.length
      ? { preserveWindowNames: [...options.preserveWindowNames] }
      : {}),
  });
  if (!launched.processIdentity) {
    await launched.close().catch(() => undefined);
    throw new Error("Attempt runtime launch did not return an exact process identity");
  }
  try {
    processReceipt ??= await writeAttemptProcessReceipt(sandbox, launched.processIdentity);
  } catch (error) {
    await launched.close().catch(() => undefined);
    throw error;
  }
  const receipt: RuntimeLaunchReceipt = {
    schemaVersion: "oracle.browser-runtime-launch.v2",
    runtimeId: ORACLE_BROWSER_RUNTIME_ID,
    browserRuntimeId: `${ORACLE_BROWSER_RUNTIME_ID}:${launched.browserVersion}`,
    processOwner: "oracle-worker",
    transport: "direct-cdp",
    profileDir: sandbox.profileDir,
    executablePath: launched.executablePath,
    browserVersion: launched.browserVersion,
    restoredPageCount: launched.restoredPageCount,
    restartOrdinal: 1,
    automaticFallback: false,
    launchedAt: new Date().toISOString(),
  };
  try {
    writePrivateJson(path.join(sandbox.directory, LAUNCH_RECEIPT), receipt);
  } catch (error) {
    await launched.close().catch(() => undefined);
    throw error;
  }

  const initialPreservedPages = launched.preservedPages();
  if (initialPreservedPages.length > 1) {
    await launched.close().catch(() => undefined);
    throw new Error("An attempt sandbox restored more than one preserved recovery page");
  }
  let preservedPage = initialPreservedPages[0];
  let openedPage: Page | undefined;
  let browserClosed = false;
  let closeComplete = false;
  let closeAttempt: Promise<void> | undefined;
  return {
    context: launched.context,
    receipt,
    sandbox,
    processReceipt,
    async openPage(url) {
      if (openedPage) {
        throw new Error("An attempt sandbox may own only one page during its lifetime");
      }
      const preservedPages = launched.preservedPages();
      if (preservedPages.length > 1) {
        throw new Error("An attempt sandbox restored more than one preserved recovery page");
      }
      preservedPage ??= preservedPages[0];
      if (preservedPage) {
        if (preservedPage.isClosed()) {
          throw new Error(
            "The exact preserved recovery page closed; refusing to open an alternate page",
          );
        }
        openedPage = preservedPage;
        return openedPage;
      }
      openedPage = await launched.openPage(url);
      return openedPage;
    },
    async close() {
      if (closeComplete) return;
      if (closeAttempt) return closeAttempt;
      const attempt = (async () => {
        if (!browserClosed) {
          await launched.close();
          browserClosed = true;
        }
        receipt.closedAt ??= new Date().toISOString();
        writePrivateJson(path.join(sandbox.directory, LAUNCH_RECEIPT), receipt);
        closeComplete = true;
      })();
      closeAttempt = attempt;
      try {
        await attempt;
      } finally {
        if (closeAttempt === attempt) closeAttempt = undefined;
      }
    },
  };
}
