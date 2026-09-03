import CDP from "chrome-remote-interface";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import type { BrowserRuntimeMetadata, BrowserSessionConfig } from "../sessionStore.js";
import {
  waitForAssistantResponse,
  captureAssistantMarkdown,
  navigateToChatGPT,
  ensureNotBlocked,
  ensureLoggedIn,
  ensurePromptReady,
  waitForResumedConversationHydration,
} from "./pageActions.js";
import type { BrowserLogger, ChromeClient } from "./types.js";
import {
  launchChrome,
  connectWithNewTab,
  positionChromeWindowOffscreen,
  connectToRemoteChromeTarget,
  listRemoteChromeTargets,
} from "./chromeLifecycle.js";
import { resolveBrowserConfig } from "./config.js";
import { clearStaleChatGptConversationCookies, syncCookies } from "./cookies.js";
import { CHATGPT_URL } from "./constants.js";
import { buildConversationTurnListExpression } from "./conversationTurns.js";
import { acquireProfileRunLock } from "./profileState.js";
import { readDevToolsActivePortInfo } from "./detect.js";
import {
  pickTarget,
  extractConversationIdFromUrl,
  buildConversationUrl,
  withTimeout,
  openConversationFromSidebar,
  openConversationFromSidebarWithRetry,
  waitForLocationChange,
  readConversationTurnIndex,
  buildPromptEchoMatcher,
  recoverPromptEcho,
  alignPromptEchoMarkdown,
  type TargetInfoLite,
} from "./reattachHelpers.js";
import { waitForDeepResearchCompletion } from "./actions/deepResearch.js";
import { resumeOpenCliBrowserSession } from "./opencliTransport.js";
import { ensureDedicatedBrowserProfileDirectory } from "./manualLoginProfile.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import {
  assertProResponseTimingReceiptChain,
  hasProResponseTimingReceiptMarker,
  verifyStoredProResponseWorkloadTiming,
} from "./proResponseTiming.js";
import {
  acquireBrowserTabLease,
  hasOtherActiveBrowserTabLeases,
  type BrowserTabLease,
} from "./tabLeaseRegistry.js";
import { reconcileBrowserTargets } from "./lifecycleReconciler.js";
import {
  acquireDedicatedChromeForRun,
  drainDedicatedChromeIfIdle,
  recordDedicatedChromeHold,
} from "./dedicatedChromeSupervisor.js";

export interface ReattachDeps {
  listTargets?: () => Promise<TargetInfoLite[]>;
  connect?: (options?: unknown) => Promise<ChromeClient>;
  waitForAssistantResponse?: typeof waitForAssistantResponse;
  captureAssistantMarkdown?: typeof captureAssistantMarkdown;
  waitForDeepResearchCompletion?: typeof waitForDeepResearchCompletion;
  waitForConversationHydration?: typeof waitForResumedConversationHydration;
  recoverSession?: (
    runtime: BrowserRuntimeMetadata,
    config: BrowserSessionConfig | undefined,
  ) => Promise<ReattachResult>;
  promptPreview?: string;
  sessionId?: string;
  persistRuntime?: (runtime: BrowserRuntimeMetadata) => Promise<void>;
}

export interface ReattachResult {
  answerText: string;
  answerMarkdown: string;
  runtime?: BrowserRuntimeMetadata;
}

export async function resumeBrowserSession(
  runtime: BrowserRuntimeMetadata,
  config: BrowserSessionConfig | undefined,
  logger: BrowserLogger,
  deps: ReattachDeps = {},
): Promise<ReattachResult> {
  if (runtime.browserTransport === "opencli") {
    return resumeOpenCliBrowserSession(runtime, config, logger);
  }
  const recoverSession =
    deps.recoverSession ??
    (async (runtimeMeta, configMeta) =>
      resumeBrowserSessionViaNewChrome(runtimeMeta, configMeta, logger, deps));
  let closeAttachedConnection: (() => Promise<void>) | null = null;
  const closeAttached = async (): Promise<void> => {
    const close = closeAttachedConnection;
    closeAttachedConnection = null;
    await close?.().catch(() => undefined);
  };

  if (!runtime.chromePort && !runtime.chromeBrowserWSEndpoint) {
    if (requiresExactRecoveryTarget(runtime)) {
      throwExactRecoveryTargetUnavailable(runtime);
    }
    logger("No running Chrome detected; reopening browser to locate the session.");
    return recoverSession(runtime, config);
  }

  try {
    const liveRuntime = (await refreshAttachRuntime(runtime).catch(() => runtime)) ?? runtime;
    const host = liveRuntime.chromeHost ?? "127.0.0.1";
    const port =
      liveRuntime.chromePort ?? inferPortFromBrowserWSEndpoint(liveRuntime.chromeBrowserWSEndpoint);
    const browserWSEndpoint = liveRuntime.chromeBrowserWSEndpoint ?? undefined;
    const listTargets =
      deps.listTargets ??
      (async () =>
        (await listRemoteChromeTargets({
          host,
          port: port ?? 9222,
          browserWSEndpoint,
        })) as TargetInfoLite[]);
    const targetList = (await listTargets()) as TargetInfoLite[];
    const target = pickTarget(targetList, liveRuntime);
    if (
      requiresExactRecoveryTarget(liveRuntime) &&
      (!liveRuntime.chromeTargetId ||
        (target?.targetId ?? target?.id) !== liveRuntime.chromeTargetId)
    ) {
      throwExactRecoveryTargetUnavailable(liveRuntime);
    }
    const connection =
      browserWSEndpoint && !deps.connect
        ? await connectToRemoteChromeTarget(host, port ?? 9222, logger, {
            browserWSEndpoint,
            targetId: target?.targetId ?? target?.id,
            closeTargetOnDispose: false,
          })
        : await (async () => {
            const client = (await (
              deps.connect ?? ((options?: unknown) => CDP(options as CDP.Options))
            )(
              browserWSEndpoint
                ? {
                    target: browserWSEndpoint,
                    local: true,
                    targetId: target?.targetId ?? target?.id,
                  }
                : {
                    host,
                    port,
                    target: target?.targetId ?? target?.id,
                  },
            )) as unknown as ChromeClient;
            return { client, close: () => client.close() };
          })();
    closeAttachedConnection = () => connection.close();

    const client: ChromeClient = connection.client;
    const { Runtime, DOM, Page } = client;
    if (Runtime?.enable) {
      await Runtime.enable();
    }
    if (DOM && typeof DOM.enable === "function") {
      await DOM.enable();
    }
    if (Page && typeof Page.enable === "function") {
      await Page.enable();
    }

    const ensureConversationOpen = async () => {
      const { result } = await Runtime.evaluate({
        expression: "location.href",
        returnByValue: true,
      });
      const href = typeof result?.value === "string" ? result.value : "";
      if (href.includes("/c/")) {
        const currentId = extractConversationIdFromUrl(href);
        if (!runtime.conversationId || (currentId && currentId === runtime.conversationId)) {
          return;
        }
      }
      const opened = await openConversationFromSidebarWithRetry(
        Runtime,
        {
          conversationId:
            runtime.conversationId ?? extractConversationIdFromUrl(runtime.tabUrl ?? ""),
          preferProjects: true,
          promptPreview: deps.promptPreview,
        },
        15_000,
      );
      if (!opened) {
        throw new Error("Unable to locate prior ChatGPT conversation in sidebar.");
      }
      await waitForLocationChange(Runtime, 15_000);
    };

    const waitForResponse = deps.waitForAssistantResponse ?? waitForAssistantResponse;
    const captureMarkdown = deps.captureAssistantMarkdown ?? captureAssistantMarkdown;
    const timeoutMs = config?.timeoutMs ?? 120_000;
    const pingTimeoutMs = Math.min(5_000, Math.max(1_500, Math.floor(timeoutMs * 0.05)));
    await withTimeout(
      Runtime.evaluate({ expression: "1+1", returnByValue: true }),
      pingTimeoutMs,
      "Reattach target did not respond",
    );
    assertResponseCaptureRecoveryKind(liveRuntime);
    await ensureConversationOpen();
    const waitForHydration =
      deps.waitForConversationHydration ?? waitForResumedConversationHydration;
    const expectedConversationUrl = buildConversationUrl(
      runtime,
      resolveBrowserConfig(config ?? {}).url,
    );
    await waitForHydration(Runtime, timeoutMs, logger, {
      requirePriorTurns: true,
      requirePromptReady: false,
      expectedConversationUrl: expectedConversationUrl ?? undefined,
    });
    const reconciledPrompt = await reconcileBrowserPromptIdentity(Runtime, liveRuntime);
    if (reconciledPrompt.runtime !== liveRuntime) {
      await deps.persistRuntime?.(reconciledPrompt.runtime);
    }
    const verifiedProTurnIndex = await verifyCommittedProTurnIdentity(
      Runtime,
      reconciledPrompt.runtime,
    );
    const minTurnIndex =
      verifiedProTurnIndex ??
      reconciledPrompt.turnIndex ??
      (await readPromptPreviewTurnIndex(Runtime, deps.promptPreview)) ??
      (deps.promptPreview ? null : await readConversationTurnIndex(Runtime, logger));
    if (config?.researchMode === "deep") {
      const waitForDeepResearch =
        deps.waitForDeepResearchCompletion ?? waitForDeepResearchCompletion;
      const researchResult = await withTimeout(
        waitForDeepResearch(Runtime, logger, timeoutMs, minTurnIndex ?? undefined, Page, client, {
          requireScopedTargetOwner: true,
        }),
        timeoutMs + 5_000,
        "Reattach Deep Research response timed out",
      );
      const responseRuntime = {
        ...verifyStoredProResponseWorkloadTiming({
          answer: researchResult.text,
          runtime: reconciledPrompt.runtime,
          capturedAt: new Date(),
        }),
        browserDisposition: "completed" as const,
        recoveryKind: undefined,
        recoveryExpiresAt: undefined,
      };
      await closeAttached();
      return {
        answerText: researchResult.text,
        answerMarkdown: researchResult.text,
        runtime: responseRuntime,
      };
    }
    const promptEcho = buildPromptEchoMatcher(deps.promptPreview);
    const answer = await withTimeout(
      waitForResponse(Runtime, timeoutMs, logger, minTurnIndex ?? undefined),
      timeoutMs + 5_000,
      "Reattach response timed out",
    );
    const recovered = await recoverPromptEcho(
      Runtime,
      answer,
      promptEcho,
      logger,
      minTurnIndex,
      timeoutMs,
    );
    const markdown =
      (await withTimeout(
        captureMarkdown(Runtime, recovered.meta, logger),
        15_000,
        "Reattach markdown capture timed out",
      )) ?? recovered.text;
    const aligned = alignPromptEchoMarkdown(recovered.text, markdown, promptEcho, logger);
    const responseRuntime = {
      ...verifyStoredProResponseWorkloadTiming({
        answer: aligned.answerText,
        runtime: reconciledPrompt.runtime,
        capturedAt: new Date(),
      }),
      browserDisposition: "completed" as const,
      recoveryKind: undefined,
      recoveryExpiresAt: undefined,
    };
    await closeAttached();
    return {
      answerText: aligned.answerText,
      answerMarkdown: aligned.answerMarkdown,
      runtime: responseRuntime,
    };
  } catch (error) {
    await closeAttached();
    if (
      isResponseTimingError(error) ||
      isPromptIdentityError(error) ||
      requiresExactRecoveryTarget(runtime)
    ) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    logger(
      `Existing Chrome reattach failed (${message}); reopening browser to locate the session.`,
    );
    return recoverSession(runtime, config);
  }
}

async function refreshAttachRuntime(
  runtime: BrowserRuntimeMetadata,
): Promise<BrowserRuntimeMetadata | null> {
  if (!runtime.chromeProfileRoot) {
    return runtime;
  }
  const host = runtime.chromeHost ?? "127.0.0.1";
  const activePort = await readDevToolsActivePortInfo(runtime.chromeProfileRoot, {
    host,
  });
  if (!activePort) {
    return runtime;
  }
  return {
    ...runtime,
    chromeHost: host,
    chromePort: activePort.port,
    chromeBrowserWSEndpoint: activePort.browserWSEndpoint,
  };
}

function inferPortFromBrowserWSEndpoint(browserWSEndpoint?: string): number | undefined {
  if (!browserWSEndpoint) {
    return undefined;
  }
  try {
    const parsed = new URL(browserWSEndpoint);
    const port = Number.parseInt(parsed.port, 10);
    if (Number.isFinite(port) && port > 0) {
      return port;
    }
  } catch {
    // ignore malformed ws endpoints and fall back to caller defaults
  }
  return undefined;
}

async function resumeBrowserSessionViaNewChrome(
  runtime: BrowserRuntimeMetadata,
  config: BrowserSessionConfig | undefined,
  logger: BrowserLogger,
  deps: ReattachDeps,
): Promise<ReattachResult> {
  const resolved = resolveBrowserConfig(config ?? {});
  const manualLogin = Boolean(resolved.manualLogin);
  const userDataDir = manualLogin
    ? (resolved.manualLoginProfileDir ?? path.join(os.homedir(), ".oracle", "browser-profile"))
    : await mkdtemp(path.join(os.tmpdir(), "oracle-reattach-"));
  if (manualLogin) {
    await ensureDedicatedBrowserProfileDirectory(userDataDir);
  }
  let tabLease: BrowserTabLease | null = await acquireBrowserTabLease(userDataDir, {
    maxConcurrentTabs: resolved.maxConcurrentTabs,
    timeoutMs: resolved.timeoutMs,
    logger,
    sessionId: deps.sessionId,
    ownerKind: "recovery",
    purpose: "session-reattach",
  });
  let chrome: Awaited<ReturnType<typeof launchChrome>>;
  try {
    chrome = manualLogin
      ? (
          await acquireDedicatedChromeForRun({
            profileDir: userDataDir,
            config: resolved,
            logger,
            sessionId: deps.sessionId,
            currentLeaseId: tabLease?.id,
          })
        ).chrome
      : await launchChrome(resolved, userDataDir, logger);
  } catch (error) {
    const handle = tabLease;
    tabLease = null;
    await handle?.release();
    throw error;
  }
  const chromeHost = (chrome as unknown as { host?: string }).host ?? "127.0.0.1";
  const startupReceipt = await reconcileBrowserTargets({
    profileDir: userDataDir,
    host: chromeHost,
    port: chrome.port,
    logger,
    apply: true,
    ensureSentinel: true,
  });
  if (startupReceipt.status !== "complete") {
    logger(
      `[browser] Reattach startup reconciliation ${startupReceipt.status}; retry receipt is durable.`,
    );
  }
  const connection = await connectWithNewTab(chrome.port, logger, "about:blank", chromeHost, {
    fallbackToDefault: false,
    retries: 6,
    retryDelayMs: 500,
    preserveWindowFocus: manualLogin,
  });
  const client = connection.client;
  const ownedTargetId = connection.targetId;
  let currentUrl = "about:blank";
  if (ownedTargetId) {
    await tabLease.update({
      chromeHost,
      chromePort: chrome.port,
      chromeTargetId: ownedTargetId,
      tabUrl: currentUrl,
      ownsTarget: true,
    });
  }
  const buildRuntime = (
    disposition: NonNullable<BrowserRuntimeMetadata["browserDisposition"]>,
    reconcileNeeded = false,
    baseRuntime: BrowserRuntimeMetadata = runtime,
  ): BrowserRuntimeMetadata => ({
    ...baseRuntime,
    browserTransport: "cdp",
    chromePid: chrome.pid,
    chromePort: chrome.port,
    chromeHost,
    userDataDir,
    chromeTargetId: ownedTargetId,
    tabUrl: currentUrl,
    conversationId: extractConversationIdFromUrl(currentUrl) ?? runtime.conversationId,
    browserDisposition: disposition,
    recoveryKind: disposition === "recoverable" ? "awaiting-response" : undefined,
    recoveryExpiresAt:
      disposition === "recoverable"
        ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
        : undefined,
    reconcileNeeded: reconcileNeeded || undefined,
    controllerPid: process.pid,
  });
  await deps.persistRuntime?.(buildRuntime("active", startupReceipt.status !== "complete"));
  const { Network, Page, Runtime, DOM, Target } = client;
  let cleaned = false;
  const cleanup = async (
    disposition: "completed" | "recoverable",
    baseRuntime: BrowserRuntimeMetadata = runtime,
  ) => {
    if (cleaned) return;
    cleaned = true;
    await client.close().catch(() => undefined);
    const recoveryExpiresAt =
      disposition === "recoverable"
        ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
        : undefined;
    await tabLease?.setTargetDisposition(disposition === "completed" ? "terminal" : "recoverable", {
      tabUrl: currentUrl,
      recoveryKind: disposition === "recoverable" ? "awaiting-response" : undefined,
      recoveryExpiresAt,
    });
    let reconciliationFailed = false;
    let dedicatedChromeDrained = false;
    const handle = tabLease;
    tabLease = null;
    let releaseError: unknown;
    try {
      await handle?.release({
        onRelease: async ({ isLastLease }) => {
          const receipt = await reconcileBrowserTargets({
            profileDir: userDataDir,
            host: chromeHost,
            port: chrome.port,
            logger,
            apply: true,
            ensureSentinel: Boolean(resolved.keepBrowser || disposition === "recoverable"),
          });
          reconciliationFailed = reconciliationFailed || receipt.status !== "complete";
          if (!manualLogin || reconciliationFailed) return;
          const protectedState =
            disposition === "recoverable" ||
            Boolean(resolved.keepBrowser) ||
            !isLastLease ||
            receipt.protectedTargetIds.length > 0 ||
            receipt.unknownBlockingTargetIds.length > 0;
          if (protectedState) {
            await recordDedicatedChromeHold(
              userDataDir,
              disposition === "recoverable"
                ? "The reattached consultation remains recoverable."
                : "Another lease or meaningful target prevents reattach drain.",
              recoveryExpiresAt,
            ).catch(() => undefined);
            return;
          }
          const lockTimeoutMs = Math.max(0, resolved.profileLockTimeoutMs ?? 0);
          if (lockTimeoutMs === 0) {
            reconciliationFailed = true;
            await recordDedicatedChromeHold(
              userDataDir,
              "Profile locking is disabled; reattach browser drain was deferred.",
            ).catch(() => undefined);
            return;
          }
          const profileLock = await acquireProfileRunLock(userDataDir, {
            timeoutMs: lockTimeoutMs,
            logger: logger.verbose ? logger : undefined,
            sessionId: deps.sessionId,
          }).catch(() => null);
          if (!profileLock) {
            reconciliationFailed = true;
            return;
          }
          try {
            const activeLeaseAppeared = handle
              ? await hasOtherActiveBrowserTabLeases(userDataDir, handle.id).catch(() => true)
              : true;
            if (activeLeaseAppeared) {
              await recordDedicatedChromeHold(
                userDataDir,
                "A new browser lease appeared during reattach drain.",
              ).catch(() => undefined);
              return;
            }
            const maintenance = await drainDedicatedChromeIfIdle({
              profileDir: userDataDir,
              chromePath: resolved.chromePath,
              logger,
              protectedState: false,
              lockHeld: true,
            });
            dedicatedChromeDrained =
              maintenance.action !== "block-human-action" &&
              maintenance.action !== "preserve-protected" &&
              maintenance.termination?.status !== "blocked" &&
              maintenance.termination?.status !== "failed";
            reconciliationFailed = reconciliationFailed || !dedicatedChromeDrained;
          } finally {
            await profileLock?.release().catch(() => undefined);
          }
        },
      });
    } catch (error) {
      reconciliationFailed = true;
      releaseError = error;
    }
    await deps.persistRuntime?.(
      buildRuntime(
        disposition,
        reconciliationFailed || startupReceipt.status !== "complete",
        baseRuntime,
      ),
    );
    if (releaseError) throw releaseError;
    if (disposition === "completed" && !resolved.keepBrowser && !reconciliationFailed) {
      if (!manualLogin || !dedicatedChromeDrained) {
        await Promise.resolve(chrome.kill());
      }
      if (!manualLogin) {
        await rm(userDataDir, { recursive: true, force: true });
      }
    }
  };

  try {
    if (Runtime?.enable) await Runtime.enable();
    if (DOM && typeof DOM.enable === "function") await DOM.enable();
    if (!resolved.headless && resolved.hideWindow) {
      await positionChromeWindowOffscreen(client, logger);
    }
    let appliedCookies = 0;
    if (!manualLogin && resolved.cookieSync) {
      appliedCookies = await syncCookies(Network, resolved.url, resolved.chromeProfile, logger, {
        allowErrors: resolved.allowCookieErrors,
        filterNames: resolved.cookieNames ?? undefined,
        inlineCookies: resolved.inlineCookies ?? undefined,
        cookiePath: resolved.chromeCookiePath ?? undefined,
        waitMs: resolved.cookieSyncWaitMs ?? 0,
      });
    }
    await clearStaleChatGptConversationCookies(Network, Target, logger, {
      preserveConversationIds: [
        runtime.conversationId,
        extractConversationIdFromUrl(runtime.tabUrl ?? ""),
        extractConversationIdFromUrl(resolved.url),
      ],
    });
    await navigateToChatGPT(Page, Runtime, CHATGPT_URL, logger);
    currentUrl = CHATGPT_URL;
    await ensureNotBlocked(Runtime, resolved.headless, logger);
    await ensureLoggedIn(Runtime, logger, { appliedCookies });
    if (resolved.url !== CHATGPT_URL) {
      await navigateToChatGPT(Page, Runtime, resolved.url, logger);
      currentUrl = resolved.url;
      await ensureNotBlocked(Runtime, resolved.headless, logger);
    }
    await ensurePromptReady(Runtime, resolved.inputTimeoutMs, logger);

    const conversationUrl = buildConversationUrl(runtime, resolved.url);
    if (conversationUrl) {
      logger(`Reopening conversation at ${conversationUrl}`);
      await navigateToChatGPT(Page, Runtime, conversationUrl, logger);
      currentUrl = conversationUrl;
      await ensureNotBlocked(Runtime, resolved.headless, logger);
      await ensurePromptReady(Runtime, resolved.inputTimeoutMs, logger);
    } else {
      const opened = await openConversationFromSidebarWithRetry(
        Runtime,
        {
          conversationId:
            runtime.conversationId ?? extractConversationIdFromUrl(runtime.tabUrl ?? ""),
          preferProjects:
            resolved.url !== CHATGPT_URL ||
            Boolean(
              runtime.tabUrl &&
              (/\/g\//.test(runtime.tabUrl) || runtime.tabUrl.includes("/project")),
            ),
          promptPreview: deps.promptPreview,
        },
        15_000,
      );
      if (!opened) throw new Error("Unable to locate prior ChatGPT conversation in sidebar.");
      await waitForLocationChange(Runtime, 15_000);
      const locationResult = await Runtime.evaluate({
        expression: "location.href",
        returnByValue: true,
      });
      if (typeof locationResult.result?.value === "string") {
        currentUrl = locationResult.result.value;
      }
    }
    await tabLease?.update({ tabUrl: currentUrl });
    await deps.persistRuntime?.(buildRuntime("active", startupReceipt.status !== "complete"));

    const waitForHydration =
      deps.waitForConversationHydration ?? waitForResumedConversationHydration;
    await waitForHydration(Runtime, resolved.inputTimeoutMs, logger, {
      requirePriorTurns: true,
      requirePromptReady: false,
      expectedConversationUrl: conversationUrl ?? undefined,
    });
    assertResponseCaptureRecoveryKind(runtime);
    const waitForResponse = deps.waitForAssistantResponse ?? waitForAssistantResponse;
    const captureMarkdown = deps.captureAssistantMarkdown ?? captureAssistantMarkdown;
    const timeoutMs = resolved.timeoutMs ?? 120_000;
    const reconciledPrompt = await reconcileBrowserPromptIdentity(Runtime, runtime);
    if (reconciledPrompt.runtime !== runtime) {
      await deps.persistRuntime?.(
        buildRuntime("active", startupReceipt.status !== "complete", reconciledPrompt.runtime),
      );
    }
    const verifiedProTurnIndex = await verifyCommittedProTurnIdentity(
      Runtime,
      reconciledPrompt.runtime,
    );
    const minTurnIndex =
      verifiedProTurnIndex ??
      reconciledPrompt.turnIndex ??
      (await readPromptPreviewTurnIndex(Runtime, deps.promptPreview)) ??
      (deps.promptPreview ? null : await readConversationTurnIndex(Runtime, logger));
    if (resolved.researchMode === "deep") {
      const waitForDeepResearch =
        deps.waitForDeepResearchCompletion ?? waitForDeepResearchCompletion;
      const researchResult = await waitForDeepResearch(
        Runtime,
        logger,
        timeoutMs,
        minTurnIndex ?? undefined,
        Page,
        client,
        { requireScopedTargetOwner: true },
      );
      const responseRuntime = buildRuntime(
        "completed",
        false,
        verifyStoredProResponseWorkloadTiming({
          answer: researchResult.text,
          runtime: reconciledPrompt.runtime,
          capturedAt: new Date(),
        }),
      );
      await cleanup("completed", responseRuntime);
      return {
        answerText: researchResult.text,
        answerMarkdown: researchResult.text,
        runtime: responseRuntime,
      };
    }
    const promptEcho = buildPromptEchoMatcher(deps.promptPreview);
    const answer = await waitForResponse(Runtime, timeoutMs, logger, minTurnIndex ?? undefined);
    const recovered = await recoverPromptEcho(
      Runtime,
      answer,
      promptEcho,
      logger,
      minTurnIndex,
      timeoutMs,
    );
    const markdown = (await captureMarkdown(Runtime, recovered.meta, logger)) ?? recovered.text;
    const aligned = alignPromptEchoMarkdown(recovered.text, markdown, promptEcho, logger);
    const responseRuntime = buildRuntime(
      "completed",
      false,
      verifyStoredProResponseWorkloadTiming({
        answer: aligned.answerText,
        runtime: reconciledPrompt.runtime,
        capturedAt: new Date(),
      }),
    );
    await cleanup("completed", responseRuntime);
    return {
      answerText: aligned.answerText,
      answerMarkdown: aligned.answerMarkdown,
      runtime: responseRuntime,
    };
  } catch (error) {
    await cleanup("recoverable");
    throw error;
  }
}

function isResponseTimingError(error: unknown): boolean {
  return error instanceof BrowserAutomationError && error.details?.stage === "response-timing";
}

function isPromptIdentityError(error: unknown): boolean {
  return (
    error instanceof BrowserAutomationError &&
    ["browser-prompt-identity", "browser-manual-recovery"].includes(
      String(error.details?.stage ?? ""),
    )
  );
}

function isManualInspectionRecovery(runtime: BrowserRuntimeMetadata): boolean {
  return (
    runtime.recoveryKind === "draft-retained" || runtime.recoveryKind === "manual-intervention"
  );
}

function requiresExactRecoveryTarget(runtime: BrowserRuntimeMetadata): boolean {
  return (
    isManualInspectionRecovery(runtime) ||
    (runtime.recoveryKind === "awaiting-response" && runtime.promptSubmitted !== true)
  );
}

function throwExactRecoveryTargetUnavailable(runtime: BrowserRuntimeMetadata): never {
  const manualInspection = isManualInspectionRecovery(runtime);
  throw new BrowserAutomationError(
    manualInspection
      ? "Oracle could not reattach the exact browser target retained for manual inspection and will not open or inspect another tab."
      : "Oracle could not reattach the exact browser target retained after an indeterminate commit and will not open or inspect another tab.",
    {
      stage: manualInspection ? "browser-manual-recovery" : "browser-prompt-identity",
      code: manualInspection
        ? "browser-manual-target-unavailable"
        : "browser-exact-target-unavailable",
      runtime,
      retrySafe: false,
      recoverable: true,
    },
  );
}

function assertResponseCaptureRecoveryKind(runtime: BrowserRuntimeMetadata): void {
  if (!isManualInspectionRecovery(runtime)) {
    return;
  }
  throw new BrowserAutomationError(
    "Oracle reattached the exact browser target for manual inspection; this retained state is not eligible for automatic answer capture or submission.",
    {
      stage: "browser-manual-recovery",
      code: "browser-manual-intervention-required",
      runtime,
      retrySafe: false,
      recoverable: true,
    },
  );
}

async function reconcileBrowserPromptIdentity(
  Runtime: ChromeClient["Runtime"],
  runtime: BrowserRuntimeMetadata,
): Promise<{ runtime: BrowserRuntimeMetadata; turnIndex: number | null }> {
  const expectedSha256 = runtime.browserPromptSha256;
  if (typeof expectedSha256 !== "string") {
    if (runtime.proTurnCommitted === false) {
      throwUncommittedProTurn(runtime);
    }
    return { runtime, turnIndex: null };
  }
  if (!/^[a-f0-9]{64}$/u.test(expectedSha256)) {
    throw new BrowserAutomationError(
      "Oracle refused to reattach because the current browser prompt identity is invalid.",
      {
        stage: "browser-prompt-identity",
        code: "browser-prompt-identity-missing",
        runtime,
        retrySafe: false,
      },
    );
  }
  if (runtime.proPromptSha256 !== undefined && runtime.proPromptSha256 !== expectedSha256) {
    throw new BrowserAutomationError(
      "Oracle refused to reattach because the current browser and Pro prompt identities conflict.",
      {
        stage: "browser-prompt-identity",
        code: "browser-prompt-identity-mismatch",
        runtime,
        retrySafe: false,
      },
    );
  }

  const baselineTurns =
    typeof runtime.browserPromptBaselineTurns === "number" &&
    Number.isSafeInteger(runtime.browserPromptBaselineTurns) &&
    runtime.browserPromptBaselineTurns >= 0
      ? runtime.browserPromptBaselineTurns
      : null;
  const recordedTurnIndex =
    typeof runtime.browserPromptCommittedTurnIndex === "number" &&
    Number.isSafeInteger(runtime.browserPromptCommittedTurnIndex) &&
    runtime.browserPromptCommittedTurnIndex >= 0
      ? runtime.browserPromptCommittedTurnIndex
      : null;
  if (baselineTurns === null && recordedTurnIndex === null) {
    throw new BrowserAutomationError(
      "Oracle refused to reattach because the current browser prompt has neither a pre-dispatch baseline nor an exact committed turn index.",
      {
        stage: "browser-prompt-identity",
        code: "browser-prompt-baseline-missing",
        runtime,
        retrySafe: false,
        recoverable: true,
      },
    );
  }
  if (baselineTurns !== null && recordedTurnIndex !== null && recordedTurnIndex < baselineTurns) {
    throw new BrowserAutomationError(
      "Oracle refused to reattach because the committed browser prompt index precedes its pre-dispatch baseline.",
      {
        stage: "browser-prompt-identity",
        code: "browser-prompt-identity-mismatch",
        runtime,
        retrySafe: false,
        recoverable: true,
      },
    );
  }
  const { result } = await Runtime.evaluate({
    expression: `(async () => {
      const EXPECTED_PROMPT_SHA256 = ${JSON.stringify(expectedSha256)};
      const BASELINE_TURNS = ${baselineTurns === null ? "null" : baselineTurns};
      const RECORDED_TURN_INDEX = ${recordedTurnIndex === null ? "null" : recordedTurnIndex};
      const normalize = (value) => {
        let text = String(value || '').toLowerCase();
        text = text.replace(/\`\`\`[^\\n]*\\n([\\s\\S]*?)\`\`\`/g, ' $1 ');
        text = text.replace(/\`\`\`/g, ' ');
        text = text.replace(/\`([^\`]*)\`/g, '$1');
        return text.replace(/\\s+/g, ' ').trim();
      };
      const turns = ${buildConversationTurnListExpression()};
      const matches = [];
      for (const [index, node] of turns.entries()) {
        if (RECORDED_TURN_INDEX !== null) {
          if (index !== RECORDED_TURN_INDEX) continue;
        } else if (BASELINE_TURNS !== null && index < BASELINE_TURNS) {
          continue;
        }
        const role = String(
          node.getAttribute?.('data-message-author-role') ||
          node.getAttribute?.('data-turn') ||
          node.dataset?.turn ||
          '',
        ).toLowerCase();
        const roleNode = role === 'user'
          ? node
          : node.querySelector?.('[data-message-author-role="user"], [data-turn="user"]');
        if (!roleNode) continue;
        const messageNode = roleNode.querySelector?.('.whitespace-pre-wrap') || roleNode;
        const normalized = normalize(messageNode.innerText || messageNode.textContent || '');
        if (!normalized) continue;
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
        const actualSha256 = Array.from(new Uint8Array(digest))
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join('');
        if (actualSha256 === EXPECTED_PROMPT_SHA256) matches.push(index);
      }
      return matches;
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  const matches = Array.isArray(result?.value)
    ? result.value.filter(
        (value): value is number =>
          typeof value === "number" &&
          Number.isSafeInteger(value) &&
          value >= 0 &&
          (recordedTurnIndex === null || value === recordedTurnIndex) &&
          (baselineTurns === null || value >= baselineTurns),
      )
    : [];
  if (matches.length === 0) {
    throw new BrowserAutomationError(
      "Oracle has not yet observed the exact current prompt as a committed user turn in the retained tab.",
      {
        stage: "browser-prompt-identity",
        code: "browser-prompt-not-observed",
        runtime,
        retrySafe: false,
        recoverable: true,
        baselineTurns,
      },
    );
  }
  if (matches.length !== 1 || (recordedTurnIndex !== null && matches[0] !== recordedTurnIndex)) {
    throw new BrowserAutomationError(
      "Oracle refused to capture a response because the current prompt identity did not resolve to one exact user turn.",
      {
        stage: "browser-prompt-identity",
        code: "browser-prompt-identity-ambiguous",
        runtime,
        retrySafe: false,
        recoverable: true,
        baselineTurns,
        matchingTurnIndices: matches,
        recordedTurnIndex,
      },
    );
  }

  const turnIndex = matches[0] as number;
  const reconciledRuntime: BrowserRuntimeMetadata = {
    ...runtime,
    browserPromptCommittedTurnIndex: turnIndex,
    ...(runtime.proTurnCommitted === false
      ? { proTurnCommitted: true, proCommittedTurnIndex: turnIndex }
      : {}),
  };
  return {
    runtime:
      reconciledRuntime.browserPromptCommittedTurnIndex ===
        runtime.browserPromptCommittedTurnIndex &&
      reconciledRuntime.proTurnCommitted === runtime.proTurnCommitted &&
      reconciledRuntime.proCommittedTurnIndex === runtime.proCommittedTurnIndex
        ? runtime
        : reconciledRuntime,
    turnIndex,
  };
}

async function verifyCommittedProTurnIdentity(
  Runtime: ChromeClient["Runtime"],
  runtime: BrowserRuntimeMetadata,
): Promise<number | null> {
  if (!hasProResponseTimingReceiptMarker(runtime)) {
    return null;
  }
  assertProResponseTimingReceiptChain(runtime);
  if (runtime.proTurnCommitted !== true) {
    throwUncommittedProTurn(runtime);
  }

  const committedTurnIndex = runtime.proCommittedTurnIndex;
  const expectedSha256 = runtime.proPromptSha256;
  if (
    !Number.isSafeInteger(runtime.proTurnIndex) ||
    (runtime.proTurnIndex as number) < 0 ||
    !Number.isSafeInteger(committedTurnIndex) ||
    (committedTurnIndex as number) < 0 ||
    typeof expectedSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(expectedSha256)
  ) {
    throw new BrowserAutomationError(
      "Oracle refused to reattach because the committed Pro turn identity is incomplete.",
      {
        stage: "response-timing",
        code: "pro-turn-identity-missing",
        runtime,
      },
    );
  }

  const expectedTurns = (runtime.proResponseTimingReceipts ?? [])
    .filter((receipt) => receipt.commitVerification === "verified")
    .map((receipt) => ({
      turnIndex: receipt.turnIndex,
      committedUserTurnIndex: receipt.committedUserTurnIndex as number,
      promptSha256: receipt.promptSha256 as string,
    }));
  if (!expectedTurns.some((entry) => entry.turnIndex === runtime.proTurnIndex)) {
    expectedTurns.push({
      turnIndex: runtime.proTurnIndex as number,
      committedUserTurnIndex: committedTurnIndex as number,
      promptSha256: expectedSha256,
    });
  }

  const { result } = await Runtime.evaluate({
    expression: `(async () => {
      const expectedTurns = ${JSON.stringify(expectedTurns)};
      const normalize = (value) => {
        let text = String(value || '').toLowerCase();
        text = text.replace(/\`\`\`[^\\n]*\\n([\\s\\S]*?)\`\`\`/g, ' $1 ');
        text = text.replace(/\`\`\`/g, ' ');
        text = text.replace(/\`([^\`]*)\`/g, '$1');
        return text.replace(/\\s+/g, ' ').trim();
      };
      const turns = ${buildConversationTurnListExpression()};
      for (const expected of expectedTurns) {
        const node = turns[expected.committedUserTurnIndex];
        if (!node) return false;
        const role = String(
          node.getAttribute?.('data-message-author-role') ||
          node.getAttribute?.('data-turn') ||
          node.dataset?.turn ||
          '',
        ).toLowerCase();
        const roleNode = role === 'user'
          ? node
          : node.querySelector?.('[data-message-author-role="user"], [data-turn="user"]');
        if (!roleNode) return false;
        const messageNode = roleNode.querySelector?.('.whitespace-pre-wrap') || roleNode;
        const normalized = normalize(messageNode.innerText || messageNode.textContent || '');
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
        const actualSha256 = Array.from(new Uint8Array(digest))
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join('');
        if (actualSha256 !== expected.promptSha256) return false;
      }
      return true;
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result?.value !== true) {
    throw new BrowserAutomationError(
      "Oracle refused to reattach because the stored Pro prompt identity did not match the committed browser turn.",
      {
        stage: "response-timing",
        code: "pro-turn-identity-mismatch",
        runtime,
        committedTurnIndex,
        promptSha256: expectedSha256,
        verifiedReceiptTurnIndices: expectedTurns.map((entry) => entry.turnIndex),
      },
    );
  }
  return committedTurnIndex as number;
}

function throwUncommittedProTurn(runtime: BrowserRuntimeMetadata): never {
  throw new BrowserAutomationError(
    "Oracle refused to reattach because the active Pro prompt was not verified as committed.",
    {
      stage: "response-timing",
      code: "pro-turn-not-committed",
      runtime,
    },
  );
}

async function readPromptPreviewTurnIndex(
  Runtime: ChromeClient["Runtime"],
  promptPreview?: string | null,
): Promise<number | null> {
  const preview = promptPreview?.trim();
  if (!preview) {
    return null;
  }
  const { result } = await Runtime.evaluate({
    expression: `(() => {
      const needle = ${JSON.stringify(preview.toLowerCase().replace(/\s+/g, " ").slice(0, 120))};
      if (!needle) return null;
      const normalize = (value) => String(value || '').toLowerCase().replace(/\\s+/g, ' ').trim();
      const turns = ${buildConversationTurnListExpression()};
      let matched = null;
      for (const [index, node] of turns.entries()) {
        const attr = (node.getAttribute('data-message-author-role') || node.getAttribute('data-turn') || node.dataset?.turn || '').toLowerCase();
        const isUser = attr === 'user' || Boolean(node.querySelector('[data-message-author-role="user"]'));
        if (!isUser) continue;
        const text = normalize(node.innerText || node.textContent || '');
        if (text.length > 0 && (text.includes(needle) || needle.includes(text.slice(0, needle.length)))) {
          matched = index;
        }
      }
      return matched;
    })()`,
    returnByValue: true,
  });
  return typeof result?.value === "number" ? result.value : null;
}

// biome-ignore lint/style/useNamingConvention: test-only export used in vitest suite
export const __test__ = {
  pickTarget,
  extractConversationIdFromUrl,
  buildConversationUrl,
  openConversationFromSidebar,
  readPromptPreviewTurnIndex,
  reconcileBrowserPromptIdentity,
  verifyCommittedProTurnIdentity,
};
