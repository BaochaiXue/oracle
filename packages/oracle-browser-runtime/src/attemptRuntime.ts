import path from "node:path";
import type { Page } from "playwright-core";
import {
  readAttemptSandbox,
  withAttemptProcessLifecycleReservation,
  withAttemptProcessLaunchReservation,
  writeAttemptProcessReceipt,
} from "./attemptSandbox.js";
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
  writeLaunchReceipt?: (filePath: string, receipt: RuntimeLaunchReceipt) => void | Promise<void>;
}): Promise<OracleAttemptBrowserRuntime> {
  if ((options.preserveWindowNames?.length ?? 0) > 1) {
    throw new Error("An attempt sandbox may preserve at most one exact recovery marker");
  }
  const sandbox = await readAttemptSandbox(options.sandboxDirectory);
  const inspection = inspectOracleBrowserRuntime(options.inspection);
  if (inspection.availability !== "available" || !inspection.executablePath) {
    throw new Error(`Managed Chrome for Testing runtime is unavailable: ${inspection.reason}`);
  }
  const executablePath = inspection.executablePath;
  const launch = options.launchManagedBrowser ?? launchManagedChromeForTesting;
  return withAttemptProcessLaunchReservation(sandbox, async () => {
    let recordedProcessReceipt: AttemptProcessReceipt | undefined;
    const active = await launch({
      executablePath,
      profileDir: sandbox.profileDir,
      headless: options.headless ?? false,
      singlePageLifetime: true,
      captureProcessIdentity: true,
      ...(!options.launchManagedBrowser
        ? {
            onProcessIdentity: async (identity) => {
              recordedProcessReceipt = await writeAttemptProcessReceipt(sandbox, identity);
            },
          }
        : {}),
      ...(options.preserveWindowNames?.length
        ? { preserveWindowNames: [...options.preserveWindowNames] }
        : {}),
    });
    if (!active.processIdentity) {
      await active.close().catch(() => undefined);
      throw new Error("Attempt runtime launch did not return an exact process identity");
    }
    let processReceipt: AttemptProcessReceipt;
    try {
      processReceipt =
        recordedProcessReceipt ??
        (await writeAttemptProcessReceipt(sandbox, active.processIdentity));
    } catch (error) {
      await active.close().catch(() => undefined);
      throw error;
    }
    const launched = active;
    const receipt: RuntimeLaunchReceipt = {
      schemaVersion: "oracle.browser-runtime-launch.v2",
      runtimeId: ORACLE_BROWSER_RUNTIME_ID,
      browserRuntimeId: `${ORACLE_BROWSER_RUNTIME_ID}:${launched.browserVersion}`,
      processOwner: "oracle-worker",
      transport: "direct-cdp",
      profileDir: sandbox.profileDir,
      executablePath: launched.executablePath,
      browserVersion: launched.browserVersion,
      get restoredPageCount() {
        return launched.restoredPageCount;
      },
      restartOrdinal: 1,
      automaticFallback: false,
      launchedAt: new Date().toISOString(),
    };
    try {
      await (options.writeLaunchReceipt ?? writePrivateJson)(
        path.join(sandbox.directory, LAUNCH_RECEIPT),
        receipt,
      );
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
    let openAttempt: Promise<Page> | undefined;
    let browserClosed = false;
    let closeComplete = false;
    let closeAttempt: Promise<void> | undefined;
    return {
      context: launched.context,
      receipt,
      sandbox,
      processReceipt,
      async openPage(url) {
        if (openAttempt) {
          throw new Error("An attempt sandbox page open is already in progress");
        }
        const preservedPages = launched.preservedPages();
        if (preservedPages.length > 1) {
          throw new Error("An attempt sandbox restored more than one preserved recovery page");
        }
        const currentPreservedPage = preservedPages[0];
        if (openedPage) {
          if (
            openedPage.isClosed() &&
            currentPreservedPage &&
            currentPreservedPage !== openedPage &&
            !currentPreservedPage.isClosed()
          ) {
            preservedPage = currentPreservedPage;
            openedPage = currentPreservedPage;
            return openedPage;
          }
          throw new Error("An attempt sandbox may own only one page during its lifetime");
        }
        if (preservedPage?.isClosed() && currentPreservedPage && !currentPreservedPage.isClosed()) {
          preservedPage = currentPreservedPage;
        }
        preservedPage ??= currentPreservedPage;
        if (preservedPage) {
          if (preservedPage.isClosed()) {
            throw new Error(
              "The exact preserved recovery page closed; refusing to open an alternate page",
            );
          }
          openedPage = preservedPage;
          return openedPage;
        }
        const attempt = launched.openPage(url);
        openAttempt = attempt;
        try {
          openedPage = await attempt;
          return openedPage;
        } finally {
          if (openAttempt === attempt) openAttempt = undefined;
        }
      },
      async close() {
        if (closeComplete) return;
        if (closeAttempt) return closeAttempt;
        const attempt = withAttemptProcessLifecycleReservation(sandbox, async () => {
          if (!browserClosed) {
            await launched.close();
            browserClosed = true;
          }
          receipt.closedAt ??= new Date().toISOString();
          writePrivateJson(path.join(sandbox.directory, LAUNCH_RECEIPT), receipt);
          closeComplete = true;
        });
        closeAttempt = attempt;
        try {
          await attempt;
        } finally {
          if (closeAttempt === attempt) closeAttempt = undefined;
        }
      },
    };
  });
}
