import type { BrowserSessionConfig } from "../sessionStore.js";
import type { UserConfig } from "../config.js";
import { buildBrowserConfig } from "../cli/browserConfig.js";

export async function buildCanonicalBatchBrowserConfig(
  config: UserConfig,
): Promise<BrowserSessionConfig> {
  const browser = config.browser ?? {};
  if (
    (browser.transport && browser.transport !== "cdp") ||
    browser.manualLogin === false ||
    browser.attachRunning ||
    browser.remoteHost
  ) {
    throw new Error(
      "Batch Oracle v1 requires the canonical local dedicated-profile direct-CDP lane; OpenCLI, ephemeral cookie-copy, attach-running, and remote browser modes are unsupported.",
    );
  }
  return buildBrowserConfig({
    model: "gpt-5-pro",
    browserTransport: "cdp",
    browserChromeProfile: browser.chromeProfile ?? undefined,
    browserChromePath: browser.chromePath ?? undefined,
    browserCookiePath: browser.chromeCookiePath ?? undefined,
    browserAttachRunning: false,
    chatgptUrl: browser.chatgptUrl ?? browser.url,
    browserTimeout: numberString(browser.timeoutMs),
    browserInputTimeout: numberString(browser.inputTimeoutMs),
    browserAttachmentTimeout: numberString(browser.attachmentTimeoutMs),
    browserRecheckDelay: numberString(browser.assistantRecheckDelayMs),
    browserRecheckTimeout: numberString(browser.assistantRecheckTimeoutMs),
    browserReuseWait: numberString(browser.reuseChromeWaitMs),
    browserProfileLockTimeout: numberString(browser.profileLockTimeoutMs),
    browserMaxConcurrentTabs: numberString(browser.maxConcurrentTabs),
    browserAutoReattachDelay: numberString(browser.autoReattachDelayMs),
    browserAutoReattachInterval: numberString(browser.autoReattachIntervalMs),
    browserAutoReattachTimeout: numberString(browser.autoReattachTimeoutMs),
    browserCookieWait: numberString(browser.cookieSyncWaitMs),
    browserNoCookieSync: browser.manualLogin ? true : undefined,
    browserHideWindow: browser.hideWindow,
    browserUseMockKeychain: browser.useMockKeychain,
    browserLifetime: browser.browserLifetime,
    browserKeepBrowser: browser.keepBrowser,
    browserManualLogin: browser.manualLogin,
    browserManualLoginProfileDir: browser.manualLoginProfileDir,
    browserModelStrategy: "select",
    browserThinkingTime: "pro",
    browserResearch: "off",
  });
}

function numberString(value: number | undefined): string | undefined {
  return typeof value === "number" ? String(value) : undefined;
}
