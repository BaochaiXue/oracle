import { mkdtemp, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { resolveBrowserConfig } from "./config.js";
import { copyChromeProfile } from "./profileCopy.js";
import type {
  BrowserRunOptions,
  BrowserRunResult,
  BrowserLogger,
  ChromeClient,
  BrowserAttachment,
  ResolvedBrowserConfig,
} from "./types.js";
import {
  launchChrome,
  registerTerminationHooks,
  positionChromeWindowOffscreen,
  positionChromeWindowOnscreen,
  connectToRemoteChrome,
  connectWithNewTab,
  closeTab,
  ensureChromePageTargetAfterClose,
} from "./chromeLifecycle.js";
import {
  clearStaleChatGptConversationCookies,
  shouldSkipStaleConversationCookieCleanup,
  syncCookies,
} from "./cookies.js";
import {
  navigateToChatGPT,
  navigateToPromptReadyWithFallback,
  ensureNotBlocked,
  ensureLoggedIn,
  ensurePromptReady,
  ensureChatMode,
  waitForResumedConversationHydration,
  installJavaScriptDialogAutoDismissal,
  ensureModelSelection,
  clearPromptComposer,
  waitForAssistantResponse,
  captureAssistantMarkdown,
  clearComposerAttachments,
  uploadAttachmentFile,
  waitForAttachmentCompletion,
  waitForUserTurnAttachments,
  readAssistantSnapshot,
} from "./pageActions.js";
import { INPUT_SELECTORS } from "./constants.js";
import { uploadAttachmentViaDataTransfer } from "./actions/remoteFileTransfer.js";
import { ensureThinkingTime } from "./actions/thinkingTime.js";
import { startThinkingStatusMonitor } from "./actions/thinkingStatus.js";
import {
  activateDeepResearch,
  captureDeepResearchTargetKeys,
  waitForDeepResearchCompletion,
  waitForResearchPlanAutoConfirm,
} from "./actions/deepResearch.js";
import { estimateTokenCount, withRetries, delay } from "./utils.js";
import { formatElapsed } from "../oracle/format.js";
import type { BrowserModelSelectionEvidence, BrowserRuntimeMetadata } from "../sessionStore.js";
import { CHATGPT_URL, DEFAULT_MODEL_STRATEGY } from "./constants.js";
import type { LaunchedChrome } from "chrome-launcher";
import { BrowserAutomationError } from "../oracle/errors.js";
import { alignPromptEchoPair, buildPromptEchoMatcher } from "./reattachHelpers.js";
import {
  buildConversationTurnCountExpression,
  readCommittedPromptIdentityStatus,
  type CommittedPromptIdentity,
} from "./conversationTurns.js";
import type { ProfileRunLock } from "./profileState.js";
import {
  cleanupStaleProfileState,
  acquireProfileRunLock,
  shouldCleanupManualLoginProfileState,
} from "./profileState.js";
import {
  connectionLostUserMessage,
  isRecoverableChromeDisconnect,
  probeChromeTargetLiveness,
} from "./cdpLiveness.js";
import {
  acquireBrowserTabLease,
  hasOtherActiveBrowserTabLeases,
  type BrowserTabLease,
} from "./tabLeaseRegistry.js";
import { reconcileOwnedBrowserTargets } from "./lifecycleReconciler.js";
import {
  appendArtifacts,
  saveBrowserTranscriptArtifact,
  saveDeepResearchReportArtifact,
} from "./artifacts.js";
import { collectGeneratedImageArtifacts } from "./chatgptImages.js";
import { collectChatGptFileArtifacts } from "./chatgptFiles.js";
import { runProviderSubmissionFlow } from "./providerDomFlow.js";
import { chatgptDomProvider } from "./providers/index.js";
import { resolveAttachRunningConnection } from "./attachRunning.js";
import { connectToExistingChatGptTab } from "./liveTabs.js";
import { captureBrowserDiagnostics } from "./domDebug.js";
import {
  assertManualLoginProfileReadyForRun,
  defaultManualLoginProfileDir,
  ensureDedicatedBrowserProfileDirectory,
  formatManualLoginSetupCommand,
  isManualLoginProfileInitialized,
  resolveManualLoginWaitMs,
} from "./manualLoginProfile.js";
import { describeBrowserControlPlan, formatBrowserControlPlan } from "./controlPlan.js";
import {
  acquireDedicatedChromeForRun,
  drainDedicatedChromeIfIdle,
  recordDedicatedChromeHold,
  type DedicatedChromeBootstrapOutcome,
} from "./dedicatedChromeSupervisor.js";
import {
  createConversationUrlMonitor,
  type ConversationUrlMonitor,
} from "./conversationUrlMonitor.js";
import {
  extractStableConversationIdFromUrl as extractConversationIdFromUrl,
  isStableConversationUrl as isConversationUrl,
} from "./conversationUrl.js";
import {
  beginProResponseTimingTurn,
  completeProResponseTimingTurn,
  hashProPromptIdentity,
  markProPromptCommitted,
  markProPromptDispatched,
  resolveProAttachmentBytes,
  requiresProResponseTiming,
} from "./proResponseTiming.js";

export type { BrowserAutomationConfig, BrowserRunOptions, BrowserRunResult } from "./types.js";
export { CHATGPT_URL, DEFAULT_MODEL_STRATEGY, DEFAULT_MODEL_TARGET } from "./constants.js";
export { parseDuration, delay, normalizeChatgptUrl, isTemporaryChatUrl } from "./utils.js";
export {
  formatThinkingLog,
  formatThinkingWaitingLog,
  buildThinkingStatusExpressionForTest,
  readThinkingStatusForTest,
  sanitizeThinkingText,
  startThinkingStatusMonitorForTest,
} from "./actions/thinkingStatus.js";

function redactBrowserConfigForDebugLog(config: Record<string, unknown>): Record<string, unknown> {
  const redacted = { ...config };
  if (Array.isArray(config.inlineCookies)) {
    redacted.inlineCookies = `[redacted:${config.inlineCookies.length} cookies]`;
    redacted.inlineCookieCount = config.inlineCookies.length;
  }
  return redacted;
}

export function redactBrowserConfigForDebugLogForTest(
  config: Record<string, unknown>,
): Record<string, unknown> {
  return redactBrowserConfigForDebugLog(config);
}

function pickProTimingRuntime(runtime: BrowserRuntimeMetadata): BrowserRuntimeMetadata {
  return {
    proDispatchAt: runtime.proDispatchAt,
    proResponseElapsedMs: runtime.proResponseElapsedMs,
    proInputTokens: runtime.proInputTokens,
    proAttachmentBytes: runtime.proAttachmentBytes,
    proTurnIndex: runtime.proTurnIndex,
    proTurnCommitted: runtime.proTurnCommitted,
    proPromptSha256: runtime.proPromptSha256,
    proCommittedTurnIndex: runtime.proCommittedTurnIndex,
    proResponseTimingReceipts: runtime.proResponseTimingReceipts,
    proResponseTimingProvenance: runtime.proResponseTimingProvenance,
  };
}

function isCloudflareChallengeError(error: unknown): error is BrowserAutomationError {
  if (!(error instanceof BrowserAutomationError)) return false;
  return (error.details as { stage?: string } | undefined)?.stage === "cloudflare-challenge";
}

function isReattachableCaptureError(error: unknown): error is BrowserAutomationError {
  if (!(error instanceof BrowserAutomationError)) return false;
  const stage = (error.details as { stage?: string } | undefined)?.stage;
  const code = (error.details as { code?: string } | undefined)?.code;
  return (
    stage === "assistant-timeout" ||
    stage === "assistant-recheck" ||
    stage === "conversation-identity" ||
    code === "prompt-commit-identity-unverified"
  );
}

function isRetainedDraftError(error: unknown): error is BrowserAutomationError {
  if (!(error instanceof BrowserAutomationError)) return false;
  const details = error.details as
    | { code?: string; submissionCommitted?: boolean; draftRetained?: boolean }
    | undefined;
  return (
    details?.code === "prompt-commit-timeout" &&
    details.submissionCommitted === false &&
    details.draftRetained === true
  );
}

type PreservedBrowserErrorKind = "cloudflare-challenge" | "reattachable-capture" | "draft-retained";

function recoveryExpiryFromNow(kind: NonNullable<BrowserRuntimeMetadata["recoveryKind"]>): string {
  const ttlMs =
    kind === "draft-retained"
      ? 2 * 60 * 60 * 1000
      : kind === "manual-intervention"
        ? 24 * 60 * 60 * 1000
        : 24 * 60 * 60 * 1000;
  return new Date(Date.now() + ttlMs).toISOString();
}

function classifyPreservedBrowserError(
  error: unknown,
  headless: boolean,
): PreservedBrowserErrorKind | null {
  if (headless) return null;
  if (isCloudflareChallengeError(error)) return "cloudflare-challenge";
  if (isReattachableCaptureError(error)) return "reattachable-capture";
  if (isRetainedDraftError(error)) return "draft-retained";
  return null;
}

function shouldPreserveBrowserOnError(error: unknown, headless: boolean): boolean {
  return classifyPreservedBrowserError(error, headless) !== null;
}

function normalizeAuthenticatedModelSelectionError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isMissingModelSelectorButton(error: unknown): boolean {
  return (
    error instanceof BrowserAutomationError &&
    error.details?.code === "model-selector-button-missing"
  );
}

async function ensureModelSelectionWithTargetRepair(options: {
  select: () => Promise<BrowserModelSelectionEvidence>;
  repair: () => Promise<void>;
  canRepair: boolean;
  logger: BrowserLogger;
}): Promise<BrowserModelSelectionEvidence> {
  try {
    return await options.select();
  } catch (error) {
    if (!options.canRepair || !isMissingModelSelectorButton(error)) {
      throw error;
    }
    options.logger(
      "[browser] Model selector was absent on the ready composer; reloading the same owned target once before submission.",
    );
    await options.repair();
    return await options.select();
  }
}

function shouldKeepLocalBrowserOpen(options: {
  effectiveKeepBrowser: boolean;
  preserveBrowserOnError: boolean;
  usingCopiedProfile: boolean;
}): boolean {
  if (options.usingCopiedProfile) return false;
  return options.effectiveKeepBrowser || options.preserveBrowserOnError;
}

export function shouldPreserveBrowserOnErrorForTest(error: unknown, headless: boolean): boolean {
  return shouldPreserveBrowserOnError(error, headless);
}

export function classifyPreservedBrowserErrorForTest(
  error: unknown,
  headless: boolean,
): PreservedBrowserErrorKind | null {
  return classifyPreservedBrowserError(error, headless);
}

// NOTE: Previously, shouldSkipThinkingTimeSelection() would skip the thinking
// time UI step when desiredModel was gpt-5.5-pro and thinkingTime was "extended",
// assuming that selecting "Pro Extended" in the old UI already implied Extended
// effort. This is wrong for lower-tier plans ($100/mo Pro) where selecting "Pro"
// defaults to Standard effort. ensureThinkingTime() already handles the
// "already-selected" case as a no-op, so always attempting it is safe.

type ChatGptUiWarningType = "rate_limit" | "temporary_unavailable" | "auth_or_challenge";

type ChatGptUiWarning = {
  type: ChatGptUiWarningType;
  message: string;
  source?: string | null;
  role?: string | null;
  ariaLive?: string | null;
  selector?: string | null;
};

const MAX_CHATGPT_UI_WARNING_CHARS = 300;
const MAX_CHATGPT_UI_WARNINGS = 3;

function classifyChatGptUiWarningText(text: string): ChatGptUiWarningType | null {
  const normalized = text.toLowerCase();
  if (
    /\btoo many requests\b/.test(normalized) ||
    /\bsending too many requests\b/.test(normalized) ||
    /\btoo quickly\b/.test(normalized) ||
    /\btemporarily limited access\b/.test(normalized) ||
    /\bplease wait a few minutes\b/.test(normalized) ||
    /\brate limit(?:ed)?\b/.test(normalized) ||
    /\bslow down\b/.test(normalized) ||
    /请求(?:过于|太)?频繁/u.test(normalized) ||
    /操作(?:过于|太)?频繁/u.test(normalized) ||
    /访问(?:过于|太)?频繁/u.test(normalized) ||
    /请求(?:次数)?过多/u.test(normalized)
  ) {
    return "rate_limit";
  }
  if (
    /\btemporarily unavailable\b/.test(normalized) ||
    /\bsomething went wrong\b/.test(normalized) ||
    /\bfailed to generate\b/.test(normalized) ||
    /\btry again later\b/.test(normalized)
  ) {
    return "temporary_unavailable";
  }
  if (
    /\bverify you are human\b/.test(normalized) ||
    /\bunusual activity\b/.test(normalized) ||
    /\bcloudflare\b/.test(normalized) ||
    /\bchallenge\b/.test(normalized) ||
    /\blogin required\b/.test(normalized) ||
    /\bsign in\b/.test(normalized)
  ) {
    return "auth_or_challenge";
  }
  return null;
}

function sanitizeChatGptUiWarningText(text: string): string {
  return text
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]")
    .replace(
      /\b((?:access|auth|session)[-_ ]?token|token)\s*[:=]\s*["']?[^\s"',;]+/gi,
      "$1=[redacted]",
    )
    .replace(/\b(?:sk-(?:ant-|or-)?|xai-)[A-Za-z0-9_-]{8,}\b/g, "[redacted-token]");
}

function normalizeUiWarningCandidate(value: unknown): {
  text: string;
  source?: string | null;
  role?: string | null;
  ariaLive?: string | null;
  selector?: string | null;
} | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const text =
    typeof candidate.text === "string"
      ? sanitizeChatGptUiWarningText(candidate.text.replace(/\s+/g, " ").trim())
      : "";
  if (!text) return null;
  return {
    text: text.slice(0, MAX_CHATGPT_UI_WARNING_CHARS),
    source: typeof candidate.source === "string" ? candidate.source : null,
    role: typeof candidate.role === "string" ? candidate.role : null,
    ariaLive: typeof candidate.ariaLive === "string" ? candidate.ariaLive : null,
    selector: typeof candidate.selector === "string" ? candidate.selector : null,
  };
}

async function collectChatGptUiWarnings(
  Runtime: ChromeClient["Runtime"],
): Promise<ChatGptUiWarning[]> {
  try {
    const { result } = await Runtime.evaluate({
      awaitPromise: true,
      returnByValue: true,
      expression: `(() => {
        const warningPattern = /too many requests|sending too many requests|too quickly|temporarily limited access|please wait a few minutes|rate limit|rate limited|slow down|请求(?:过于|太)?频繁|操作(?:过于|太)?频繁|访问(?:过于|太)?频繁|请求(?:次数)?过多|try again later|temporarily unavailable|something went wrong|failed to generate|verify you are human|unusual activity|cloudflare|challenge|login required|sign in/i;
        const selectors = [
          '[role="alert"]',
          '[role="status"]',
          '[role="dialog"]',
          '[aria-live]',
          '[data-testid*="toast" i]',
          '[data-testid*="banner" i]',
          '[data-testid*="error" i]',
          '[class*="toast" i]',
          '[class*="banner" i]'
        ];
        const isVisible = (element) => {
          if (!(element instanceof HTMLElement)) return false;
          let current = element;
          while (current) {
            const currentStyle = window.getComputedStyle(current);
            if (
              !currentStyle ||
              currentStyle.display === 'none' ||
              currentStyle.visibility === 'hidden' ||
              currentStyle.visibility === 'collapse' ||
              Number.parseFloat(currentStyle.opacity || '1') === 0
            ) {
              return false;
            }
            current = current.parentElement;
          }
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        const describe = (element, source, selector = null) => ({
          text: (element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 1000),
          source,
          selector,
          role: element.getAttribute('role'),
          ariaLive: element.getAttribute('aria-live')
        });
        const out = [];
        const seen = new Set();
        const warningContainers = [];
        const overlapsWarningContainer = (element) => warningContainers.some((container) => (
          container !== element && (container.contains(element) || element.contains(container))
        ));
        const add = (element, entry) => {
          if (!entry.text || !warningPattern.test(entry.text)) return;
          const key = entry.text + '|' + (entry.role || '') + '|' + (entry.ariaLive || '');
          if (seen.has(key)) return;
          seen.add(key);
          warningContainers.push(element);
          out.push(entry);
        };
        for (const selector of selectors) {
          if (out.length >= 5) break;
          let elements = [];
          try {
            elements = Array.from(document.querySelectorAll(selector));
          } catch {
            elements = [];
          }
          for (const element of elements) {
            if (out.length >= 5) break;
            if (overlapsWarningContainer(element)) continue;
            if (isVisible(element)) add(element, describe(element, 'selector', selector));
          }
        }
        return out.slice(0, 5);
      })()`,
    });
    const rawWarnings = Array.isArray(result?.value) ? result.value : [];
    const warnings: ChatGptUiWarning[] = [];
    const seen = new Set<string>();
    for (const raw of rawWarnings) {
      const candidate = normalizeUiWarningCandidate(raw);
      if (!candidate) continue;
      const type = classifyChatGptUiWarningText(candidate.text);
      if (!type) continue;
      const key = `${type}:${candidate.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      warnings.push({
        type,
        message: candidate.text,
        source: candidate.source,
        role: candidate.role,
        ariaLive: candidate.ariaLive,
        selector: candidate.selector,
      });
      if (warnings.length >= MAX_CHATGPT_UI_WARNINGS) break;
    }
    return warnings;
  } catch {
    return [];
  }
}

function formatChatGptUiWarningType(type: ChatGptUiWarningType): string {
  switch (type) {
    case "rate_limit":
      return "rate-limit";
    case "temporary_unavailable":
      return "temporary-unavailable";
    case "auth_or_challenge":
      return "authentication/challenge";
  }
}

async function createChatGptUiWarningError(params: {
  Runtime: ChromeClient["Runtime"];
  logger: BrowserLogger;
  runtime: unknown;
  stage: string;
  waitTarget: string;
  diagnostics?: unknown;
  cause?: unknown;
  submissionCommitted?: boolean;
  dispatchAttempted?: boolean;
}): Promise<BrowserAutomationError | null> {
  const [uiWarning] = await collectChatGptUiWarnings(params.Runtime);
  if (!uiWarning) return null;

  params.logger(`[browser] ChatGPT UI warning detected (${uiWarning.type}): ${uiWarning.message}`);
  const submissionBlocked = params.submissionCommitted === false;
  return new BrowserAutomationError(
    submissionBlocked
      ? `ChatGPT blocked the request before submission with a ${formatChatGptUiWarningType(uiWarning.type)} warning. No prompt was committed; retrying after the page gate clears is safe. Page warning: ${uiWarning.message}`
      : `ChatGPT displayed a ${formatChatGptUiWarningType(uiWarning.type)} warning while waiting for ${params.waitTarget}: ${uiWarning.message}`,
    {
      stage: params.stage,
      code: submissionBlocked ? "chatgpt-submission-gate" : "chatgpt-ui-warning",
      uiWarning,
      runtime: params.runtime,
      diagnostics: params.diagnostics,
      ...(submissionBlocked
        ? {
            submissionCommitted: false,
            dispatchAttempted: params.dispatchAttempted === true,
            retrySafe: true,
            retryGuidance: "wait-for-page-gate-to-clear",
          }
        : {}),
    },
    params.cause,
  );
}

async function throwChatGptUiWarningIfPresent(params: {
  Runtime: ChromeClient["Runtime"];
  logger: BrowserLogger;
  runtime: unknown;
  stage: string;
  waitTarget: string;
  diagnostics?: unknown;
  submissionCommitted?: boolean;
  dispatchAttempted?: boolean;
}): Promise<void> {
  const error = await createChatGptUiWarningError(params);
  if (error) throw error;
}

async function createAssistantTimeoutError(params: {
  Runtime: ChromeClient["Runtime"];
  logger: BrowserLogger;
  runtime: unknown;
  diagnostics?: unknown;
  cause: unknown;
}): Promise<BrowserAutomationError> {
  const warningError = await createChatGptUiWarningError({
    Runtime: params.Runtime,
    logger: params.logger,
    runtime: params.runtime,
    stage: "assistant-timeout",
    waitTarget: "the assistant",
    diagnostics: params.diagnostics,
    cause: params.cause,
  });
  if (!warningError) {
    return new BrowserAutomationError(
      "Assistant response timed out before completion; reattach later to capture the answer.",
      { stage: "assistant-timeout", runtime: params.runtime, diagnostics: params.diagnostics },
      params.cause,
    );
  }
  return warningError;
}

/**
 * Make the page behave like a focused foreground tab.
 *
 * The send button is activated with trusted CDP input events dispatched at
 * viewport coordinates. Chrome delivers those only to a window that is being
 * composited, so a hidden (`--browser-hide-window`), minimized, or occluded
 * window swallows the click while the automation still believes it clicked.
 * Soft-fails: focus emulation is an optimization, never a hard requirement.
 */
async function enableFocusEmulation(
  client: ChromeClient,
  logger: BrowserLogger,
  label: string,
): Promise<void> {
  try {
    await client.Emulation.setFocusEmulationEnabled({ enabled: true });
    logger(`[browser] Focus emulation enabled for ${label}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(`[browser] Focus emulation unavailable: ${message}`);
  }
}

function listIgnoredRemoteChromeFlags(config: {
  attachRunning?: ResolvedBrowserConfig["attachRunning"];
  headless?: ResolvedBrowserConfig["headless"];
  hideWindow?: ResolvedBrowserConfig["hideWindow"];
  useMockKeychain?: ResolvedBrowserConfig["useMockKeychain"];
  keepBrowser?: ResolvedBrowserConfig["keepBrowser"];
  chromePath?: ResolvedBrowserConfig["chromePath"];
}): string[] {
  return [
    config.headless ? "--browser-headless" : null,
    config.hideWindow ? "--browser-hide-window" : null,
    config.useMockKeychain ? "--browser-use-mock-keychain" : null,
    config.keepBrowser ? "--browser-keep-browser" : null,
    !config.attachRunning && config.chromePath ? "--browser-chrome-path" : null,
  ].filter((value): value is string => Boolean(value));
}

function hasBrowserErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof BrowserAutomationError &&
    (error.details as { code?: string } | undefined)?.code === code
  );
}

async function saveOptionalArtifact<T>(
  operation: () => Promise<T | null>,
  logger: BrowserLogger,
): Promise<T | null> {
  try {
    return await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(`[browser] Failed to save session artifact: ${message}`);
    return null;
  }
}

type AssistantAnswer = {
  text: string;
  html?: string;
  meta: { turnId?: string | null; messageId?: string | null };
};

async function waitForAssistantOrGeneratedImageResponse(params: {
  Runtime: ChromeClient["Runtime"];
  waitForText: () => Promise<AssistantAnswer>;
  timeoutMs: number;
  minTurnIndex?: number;
  expectedConversationId?: string;
  imageOutputRequested: boolean;
  logger: BrowserLogger;
}): Promise<AssistantAnswer> {
  if (!params.imageOutputRequested) {
    return params.waitForText();
  }

  params.logger("[browser] Waiting for ChatGPT generated image response.");
  const response = await pollGeneratedImageOrTextAssistantResponse(
    params.Runtime,
    params.timeoutMs,
    params.minTurnIndex,
    params.expectedConversationId,
  );
  if (response) {
    if (response.html?.includes("/backend-api/estuary/content?id=file_")) {
      params.logger("[browser] Captured generated image response before text appeared.");
    }
    return response;
  }

  throw new Error("assistant response timeout while waiting for generated image or text");
}

async function attemptAssistantRecheckOrRethrow(
  operation: () => Promise<AssistantAnswer | null>,
): Promise<AssistantAnswer | null> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof BrowserAutomationError) {
      throw error;
    }
    return null;
  }
}

async function pollGeneratedImageOrTextAssistantResponse(
  Runtime: ChromeClient["Runtime"],
  timeoutMs: number,
  minTurnIndex?: number,
  expectedConversationId?: string,
): Promise<AssistantAnswer | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let snapshot = await readAssistantSnapshot(Runtime, minTurnIndex, expectedConversationId).catch(
      () => null,
    );
    if (!snapshot && typeof minTurnIndex === "number" && Number.isFinite(minTurnIndex)) {
      const relaxedSnapshot = await readAssistantSnapshot(
        Runtime,
        undefined,
        expectedConversationId,
      ).catch(() => null);
      const relaxedHtml = typeof relaxedSnapshot?.html === "string" ? relaxedSnapshot.html : "";
      if (relaxedHtml.includes("/backend-api/estuary/content?id=file_")) {
        snapshot = relaxedSnapshot;
      }
    }
    const text = typeof snapshot?.text === "string" ? snapshot.text.trim() : "";
    const html = typeof snapshot?.html === "string" ? snapshot.html : "";
    const hasGeneratedImage = html.includes("/backend-api/estuary/content?id=file_");
    if (text && (hasGeneratedImage || !isImageOnlyUiChromeText(text))) {
      return {
        text,
        html,
        meta: {
          turnId: snapshot?.turnId ?? undefined,
          messageId: snapshot?.messageId ?? undefined,
        },
      };
    }
    await delay(750);
  }
  return null;
}

export function isImageOnlyUiChromeText(text: string): boolean {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  return (
    normalized.length === 0 ||
    normalized === "edit" ||
    normalized === "stopped thinking" ||
    normalized === "stopped thinking edit" ||
    /^(?:reasoning\s+|pro thinking\s+)?thought for \d+(?:\.\d+)?\s*(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)\s+edit$/.test(
      normalized,
    )
  );
}

export interface BrowserConversationTurn {
  label: string;
  prompt?: string;
  answerText: string;
  answerMarkdown: string;
}

function normalizeBrowserFollowUpPrompts(values: string[] | undefined): string[] {
  return (values ?? []).map((entry) => entry.trim()).filter(Boolean);
}

export function formatBrowserTurnTranscript(turns: BrowserConversationTurn[]): {
  answerText: string;
  answerMarkdown: string;
} {
  if (turns.length <= 1) {
    const turn = turns[0];
    return {
      answerText: turn?.answerText ?? "",
      answerMarkdown: turn?.answerMarkdown ?? turn?.answerText ?? "",
    };
  }

  const answerMarkdown = turns
    .map((turn, index) => {
      const label = turn.label.trim() || `Turn ${index + 1}`;
      const prompt = turn.prompt?.trim();
      const promptBlock = prompt ? `\n\n### Prompt\n\n${prompt}` : "";
      const answer = (turn.answerMarkdown || turn.answerText).trim() || "_No text captured._";
      return `## ${label}${promptBlock}\n\n### Answer\n\n${answer}`;
    })
    .join("\n\n")
    .trim();

  return {
    answerText: answerMarkdown,
    answerMarkdown,
  };
}

type BrowserSubmissionResult = {
  baselineTurns: number | null;
  baselineAssistantText: string | null;
  deepResearchTargetKeys?: string[];
  deepResearchTargetBaselineCaptured?: boolean;
};

async function captureDeepResearchTargetBaseline(
  client: ChromeClient,
  logger: BrowserLogger,
): Promise<{ targetKeys: string[]; captured: boolean }> {
  try {
    return { targetKeys: await captureDeepResearchTargetKeys(client), captured: true };
  } catch {
    logger(
      "[browser] Deep Research target baseline unavailable; retaining conversation-turn owner scoping.",
    );
    return { targetKeys: [], captured: false };
  }
}

type BrowserSubmissionFallback = {
  prompt: string;
  attachments: BrowserAttachment[];
};

async function runSubmissionWithRecovery({
  prompt,
  attachments,
  fallbackSubmission,
  submit,
  reloadPromptComposer,
  prepareFallbackSubmission,
  logger,
}: {
  prompt: string;
  attachments: BrowserAttachment[];
  fallbackSubmission?: BrowserSubmissionFallback;
  submit: (prompt: string, attachments: BrowserAttachment[]) => Promise<BrowserSubmissionResult>;
  reloadPromptComposer: () => Promise<void>;
  prepareFallbackSubmission: () => Promise<void>;
  logger: BrowserLogger;
}): Promise<BrowserSubmissionResult> {
  let currentPrompt = prompt;
  let currentAttachments = attachments;
  let retriedDeadComposer = false;
  let usedFallbackSubmission = false;

  while (true) {
    try {
      return await submit(currentPrompt, currentAttachments);
    } catch (error) {
      const isDeadComposer = hasBrowserErrorCode(error, "dead-composer");
      if (isDeadComposer && !retriedDeadComposer) {
        retriedDeadComposer = true;
        await reloadPromptComposer();
        continue;
      }

      const isPromptTooLarge = hasBrowserErrorCode(error, "prompt-too-large");
      if (fallbackSubmission && isPromptTooLarge && !usedFallbackSubmission) {
        usedFallbackSubmission = true;
        logger("[browser] Inline prompt too large; retrying with file uploads.");
        await prepareFallbackSubmission();
        currentPrompt = fallbackSubmission.prompt;
        currentAttachments = fallbackSubmission.attachments;
        continue;
      }

      throw error;
    }
  }
}

export async function runSubmissionWithRecoveryForTest(args: {
  prompt: string;
  attachments: BrowserAttachment[];
  fallbackSubmission?: BrowserSubmissionFallback;
  submit: (prompt: string, attachments: BrowserAttachment[]) => Promise<BrowserSubmissionResult>;
  reloadPromptComposer: () => Promise<void>;
  prepareFallbackSubmission: () => Promise<void>;
  logger: BrowserLogger;
}): Promise<BrowserSubmissionResult> {
  return runSubmissionWithRecovery(args);
}

function resolveRemoteTabLeaseProfileDir(
  config: ReturnType<typeof resolveBrowserConfig>,
): string | null {
  if (!config.remoteChrome || !config.manualLogin || !config.manualLoginProfileDir) {
    return null;
  }
  return path.resolve(config.manualLoginProfileDir);
}

export function resolveRemoteTabLeaseProfileDirForTest(
  config: ReturnType<typeof resolveBrowserConfig>,
): string | null {
  return resolveRemoteTabLeaseProfileDir(config);
}

function isLocalChromeHost(host: string): boolean {
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") {
    return true;
  }
  return net.isIPv4(normalized) && normalized.startsWith("127.");
}

export function isLocalChromeHostForTest(host: string): boolean {
  return isLocalChromeHost(host);
}

async function closeRemoteConnectionAfterRun(options: {
  connectionClosedUnexpectedly: boolean;
  connection: { close: () => Promise<void> } | null;
  client: Pick<ChromeClient, "close"> | null;
  runStatus: "attempted" | "complete";
}): Promise<void> {
  if (options.connectionClosedUnexpectedly) {
    return;
  }
  if (!options.connection) {
    await options.client?.close();
    return;
  }
  if (options.runStatus === "complete") {
    await options.connection.close();
  } else {
    await options.client?.close();
  }
}

function shouldCloseOwnedRunTargetAfterRun(options: {
  browserTurnState: "not-started" | "active" | "terminal";
  answerCaptured?: boolean;
  resultAdmitted?: boolean;
  ownsTarget: boolean;
  closeOwnedTabOnComplete?: boolean;
}): boolean {
  return (
    options.browserTurnState === "terminal" &&
    options.ownsTarget &&
    options.closeOwnedTabOnComplete !== false
  );
}

function buildSkippedModelSelectionEvidence(
  desiredModel: string | null | undefined,
  strategy: BrowserModelSelectionEvidence["strategy"],
): BrowserModelSelectionEvidence {
  return {
    requestedModel: desiredModel ?? null,
    resolvedLabel: null,
    strategy,
    status: "skipped",
    verified: false,
    source: "config",
    capturedAt: new Date().toISOString(),
  };
}

export async function runBrowserMode(options: BrowserRunOptions): Promise<BrowserRunResult> {
  const promptText = options.prompt?.trim();
  if (!promptText) {
    throw new Error("Prompt text is required when using browser mode.");
  }

  const attachments: BrowserAttachment[] = options.attachments ?? [];
  const fallbackSubmission = options.fallbackSubmission;

  let config = resolveBrowserConfig(options.config);
  const usingCopiedProfile = Boolean(config.copyProfileSource);
  if (usingCopiedProfile && (config.attachRunning || config.remoteChrome)) {
    throw new BrowserAutomationError(
      "--copy-profile requires a locally launched Chrome instance and cannot be combined with attach-running or remote Chrome.",
      { stage: "profile-config" },
    );
  }
  const isResumingConversation = Boolean(config.resumeConversationUrl);
  const followUpPrompts = normalizeBrowserFollowUpPrompts(options.followUpPrompts);
  if (config.researchMode === "deep" && followUpPrompts.length > 0) {
    throw new BrowserAutomationError(
      "Browser follow-ups are not supported with Deep Research mode. Put the full research plan into the initial prompt or run a normal browser consult for multi-turn review.",
      {
        stage: "browser-follow-ups",
        details: { researchMode: "deep", followUps: followUpPrompts.length },
      },
    );
  }
  const logger: BrowserLogger = options.log ?? ((_message: string) => {});
  if (logger.verbose === undefined) {
    logger.verbose = Boolean(config.debug);
  }
  if (logger.sessionLog === undefined && options.log?.sessionLog) {
    logger.sessionLog = options.log.sessionLog;
  }
  const runtimeHintCb = options.runtimeHintCb;
  let lastTargetId: string | undefined;
  let lastUrl: string | undefined;
  let promptSubmitted = false;
  let browserTurnState: "not-started" | "active" | "terminal" = "not-started";
  let answerCaptured = false;
  let browserDisposition: BrowserRuntimeMetadata["browserDisposition"] = "active";
  let recoveryKind: BrowserRuntimeMetadata["recoveryKind"];
  let recoveryExpiresAt: string | undefined;
  let reconcileNeeded = false;
  const proTimingRequired = requiresProResponseTiming(config);
  let proTimingRuntime: BrowserRuntimeMetadata = {};
  let dedicatedBootstrap: DedicatedChromeBootstrapOutcome | undefined;
  let modelSelectionEvidence: BrowserModelSelectionEvidence | undefined;
  let tabLease: BrowserTabLease | null = null;
  let conversationUrlMonitor: ConversationUrlMonitor | null = null;
  let committedPromptIdentity: CommittedPromptIdentity | null = null;
  const authoritativeConversationUrl = (): string | undefined =>
    conversationUrlMonitor?.boundConversationUrl() ??
    (isConversationUrl(config.resumeConversationUrl ?? "")
      ? (config.resumeConversationUrl ?? undefined)
      : lastUrl);
  const authoritativeConversationId = () =>
    conversationUrlMonitor?.boundConversationId() ??
    extractConversationIdFromUrl(authoritativeConversationUrl() ?? "");
  const emitRuntimeHint = async (strict = false): Promise<void> => {
    if (!chrome?.port) {
      return;
    }
    const conversationId = authoritativeConversationId();
    const hint = {
      browserTransport: "cdp" as const,
      chromePid: chrome.pid,
      chromePort: chrome.port,
      chromeHost,
      chromeTargetId: lastTargetId,
      tabUrl: authoritativeConversationUrl(),
      conversationId,
      promptSubmitted,
      browserDisposition,
      recoveryKind,
      recoveryExpiresAt,
      reconcileNeeded: reconcileNeeded || undefined,
      userDataDir,
      controllerPid: process.pid,
      browserRepairAttempted: dedicatedBootstrap?.repairAttempted || undefined,
      browserRepairOutcome: dedicatedBootstrap?.repairOutcome,
      browserRolloverPending: dedicatedBootstrap?.rolloverPending || undefined,
      ...proTimingRuntime,
    };
    try {
      await runtimeHintCb?.(hint, modelSelectionEvidence);
      await tabLease?.update({
        chromeHost,
        chromePort: chrome.port,
        chromeTargetId: lastTargetId,
        tabUrl: authoritativeConversationUrl(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger(`Failed to persist runtime hint: ${message}`);
      if (strict) throw error;
    }
  };
  const markPromptDispatched = async (): Promise<void> => {
    browserTurnState = "active";
    answerCaptured = false;
    if (proTimingRequired) {
      proTimingRuntime = markProPromptDispatched(proTimingRuntime);
    }
    await emitRuntimeHint();
  };
  const markPromptCommitted = async (
    _committedTurns: number | null,
    committedUserTurnIndex: number | null,
    committedPrompt: string,
  ): Promise<void> => {
    if (proTimingRequired) {
      proTimingRuntime = markProPromptCommitted(proTimingRuntime, committedUserTurnIndex);
    }
    const firstPrompt = !promptSubmitted;
    if (
      firstPrompt &&
      typeof committedUserTurnIndex === "number" &&
      Number.isSafeInteger(committedUserTurnIndex) &&
      committedUserTurnIndex >= 0
    ) {
      committedPromptIdentity = {
        committedUserTurnIndex,
        promptSha256: hashProPromptIdentity(committedPrompt),
      };
    }
    promptSubmitted = true;
    await emitRuntimeHint();
  };
  if (config.debug || process.env.CHATGPT_DEVTOOLS_TRACE === "1") {
    logger(
      `[browser-mode] config: ${JSON.stringify({
        ...redactBrowserConfigForDebugLog(config),
        promptLength: promptText.length,
      })}`,
    );
  }
  for (const line of formatBrowserControlPlan(describeBrowserControlPlan(config), "browser")) {
    logger(line);
  }

  if (config.attachRunning) {
    const attached = await resolveAttachRunningConnection(config, logger);
    config = {
      ...config,
      remoteChrome: { host: attached.host, port: attached.port },
      remoteChromeBrowserWSEndpoint: attached.browserWSEndpoint,
      remoteChromeProfileRoot: attached.profileRoot,
    };
  }

  if (!config.remoteChrome && !config.manualLogin) {
    const preferredPort = config.debugPort ?? DEFAULT_DEBUG_PORT;
    const availablePort = await pickAvailableDebugPort(preferredPort, logger);
    if (availablePort !== preferredPort) {
      logger(
        `DevTools port ${preferredPort} busy; using ${availablePort} to avoid attaching to stray Chrome.`,
      );
    }
    config = { ...config, debugPort: availablePort };
  }

  // Remote Chrome mode - connect to existing browser
  if (config.remoteChrome) {
    // Warn about ignored local-only options
    const ignoredFlags = listIgnoredRemoteChromeFlags(config);
    if (ignoredFlags.length > 0) {
      logger(`Note: --remote-chrome ignores local Chrome flags (${ignoredFlags.join(", ")}).`);
    }

    return runRemoteBrowserMode(promptText, attachments, config, logger, options);
  }

  const manualLogin = Boolean(config.manualLogin);
  if (manualLogin && usingCopiedProfile) {
    throw new BrowserAutomationError(
      "--copy-profile cannot be combined with --browser-manual-login: choose either a throwaway copied profile or the persistent dedicated profile.",
      { stage: "profile-config" },
    );
  }
  // Manual-login and copy-profile both start from an already-signed-in profile,
  // so neither clears nor syncs cookies.
  const profileIsPreSigned = manualLogin || usingCopiedProfile;
  const manualProfileDir = config.manualLoginProfileDir
    ? path.resolve(config.manualLoginProfileDir)
    : defaultManualLoginProfileDir();
  const userDataDir = manualLogin
    ? manualProfileDir
    : await mkdtemp(path.join(await resolveUserDataBaseDir(), "oracle-browser-"));
  const effectiveKeepBrowser = Boolean(config.keepBrowser);
  if (manualLogin) {
    // Learned: manual login reuses a persistent profile so cookies/SSO survive.
    await ensureDedicatedBrowserProfileDirectory(userDataDir);
    logger(`Manual login mode enabled; reusing persistent profile at ${userDataDir}`);
    await assertManualLoginProfileReadyForRun({
      userDataDir,
      keepBrowser: effectiveKeepBrowser,
    });
  } else if (config.copyProfileSource) {
    const copiedProfileDirectory = await copyChromeProfile(
      config.copyProfileSource,
      userDataDir,
      config.chromeProfile,
    );
    config = { ...config, chromeProfile: copiedProfileDirectory };
    logger(
      `Seeded temporary Chrome profile ${copiedProfileDirectory} from ${config.copyProfileSource} (copy-profile mode; signed-in session reused without manual login)`,
    );
  } else {
    logger(`Created temporary Chrome profile at ${userDataDir}`);
  }

  try {
    tabLease = await acquireBrowserTabLease(userDataDir, {
      maxConcurrentTabs: config.maxConcurrentTabs,
      timeoutMs: config.timeoutMs,
      logger,
      sessionId: options.sessionId,
      ownerKind: "chatgpt",
      purpose: "browser-run",
    });
  } catch (error) {
    if (!manualLogin) {
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
    }
    throw error;
  }

  let acquiredChrome: {
    chrome: BrowserChrome;
    reusedChrome: LaunchedChrome | null;
    bootstrap?: DedicatedChromeBootstrapOutcome;
  };
  try {
    acquiredChrome = manualLogin
      ? await acquireManualLoginChromeForRun(
          userDataDir,
          config,
          logger,
          options.sessionId,
          {},
          tabLease?.id,
        )
      : {
          chrome: await launchChrome(
            {
              ...config,
              remoteChrome: config.remoteChrome,
            },
            userDataDir,
            logger,
          ),
          reusedChrome: null,
        };
  } catch (error) {
    if (tabLease) {
      const handle = tabLease;
      tabLease = null;
      await handle.release().catch(() => undefined);
    }
    if (usingCopiedProfile) {
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
    }
    throw error;
  }
  dedicatedBootstrap = acquiredChrome.bootstrap;
  const { chrome } = acquiredChrome;
  const chromeHost = (chrome as unknown as { host?: string }).host ?? "127.0.0.1";
  if (manualLogin && chrome.port) {
    const startupReconciliation = await reconcileOwnedBrowserTargets({
      profileDir: userDataDir,
      host: chromeHost,
      port: chrome.port,
      logger,
      ensureSentinel: true,
    });
    reconcileNeeded = startupReconciliation.status !== "complete";
    if (reconcileNeeded) {
      logger(
        `[browser] Cold-start target reconciliation ${startupReconciliation.status}; retry receipt is durable.`,
      );
      await emitRuntimeHint();
    }
  }
  const recordResponseTiming = (answer: string, capturedAt = new Date()): void => {
    if (!proTimingRequired) return;
    const timedRuntime = completeProResponseTimingTurn({
      answer,
      runtime: {
        browserTransport: "cdp",
        chromePid: chrome.pid,
        chromePort: chrome.port,
        chromeHost,
        userDataDir,
        chromeTargetId: lastTargetId,
        tabUrl: authoritativeConversationUrl(),
        conversationId: authoritativeConversationId(),
        promptSubmitted,
        controllerPid: process.pid,
        ...proTimingRuntime,
      },
      capturedAt,
    });
    proTimingRuntime = pickProTimingRuntime(timedRuntime);
  };
  if (tabLease) {
    await tabLease.update({
      chromeHost,
      chromePort: chrome.port,
    });
  }
  let removeTerminationHooks: (() => void) | null = null;
  try {
    removeTerminationHooks = registerTerminationHooks(
      chrome,
      userDataDir,
      effectiveKeepBrowser,
      logger,
      {
        isInFlight: () => runStatus !== "complete",
        emitRuntimeHint,
        preserveUserDataDir: manualLogin,
        // copy-profile is a throwaway copy of a signed-in profile; never leave it on disk.
        forceProfileCleanup: usingCopiedProfile,
      },
    );
  } catch {
    // ignore failure; cleanup still happens below
  }

  let client: ChromeClient | null = null;
  let isolatedTargetId: string | null = null;
  let ownsTarget = true;
  const startedAt = Date.now();
  let answerText = "";
  let answerMarkdown = "";
  let answerHtml = "";
  let runStatus: "attempted" | "complete" = "attempted";
  let connectionClosedUnexpectedly = false;
  let stopThinkingMonitor: (() => void) | null = null;
  let removeDialogHandler: (() => void) | null = null;
  let appliedCookies = 0;
  let preserveBrowserOnError = false;

  try {
    try {
      if (config.browserTabRef) {
        const attached = await connectToExistingChatGptTab({
          host: chromeHost,
          port: chrome.port,
          ref: config.browserTabRef,
        });
        client = attached.client;
        isolatedTargetId = attached.targetId ?? null;
        lastTargetId = attached.targetId ?? undefined;
        lastUrl = attached.tab.url || lastUrl;
        ownsTarget = false;
        logger(
          `Attached to existing ChatGPT tab ${attached.targetId}${attached.tab.url ? ` (${attached.tab.url})` : ""}`,
        );
      } else {
        const strictTabIsolation = manualLogin;
        const devtoolsRetries = manualLogin ? 6 : 0;
        const connection = await connectWithNewTab(chrome.port, logger, "about:blank", chromeHost, {
          fallbackToDefault: !strictTabIsolation,
          retries: devtoolsRetries,
          retryDelayMs: 500,
          preserveWindowFocus: manualLogin,
        });
        client = connection.client;
        isolatedTargetId = connection.targetId ?? null;
        lastTargetId = connection.targetId ?? undefined;
        lastUrl = connection.targetId ? "about:blank" : lastUrl;
        ownsTarget = true;
      }
      if (tabLease && isolatedTargetId) {
        await tabLease.update({
          chromeHost,
          chromePort: chrome.port,
          chromeTargetId: isolatedTargetId,
          tabUrl: lastUrl,
          ownsTarget,
        });
        await emitRuntimeHint(true);
      }
    } catch (error) {
      const hint = describeDevtoolsFirewallHint(chromeHost, chrome.port);
      if (hint) {
        logger(hint);
      }
      throw error;
    }
    const disconnectPromise = new Promise<never>((_, reject) => {
      client?.on("disconnect", () => {
        connectionClosedUnexpectedly = true;
        void (async () => {
          const liveness = await probeChromeTargetLiveness({
            host: chromeHost,
            port: chrome.port,
            targetId: lastTargetId ?? isolatedTargetId,
          });
          const recoverable = isRecoverableChromeDisconnect(liveness);
          if (recoverable) {
            logger(
              "CDP client disconnected; Chrome/target still reachable. Leaving run recoverable for reattach.",
            );
          } else {
            logger("Chrome window closed; attempting to abort run.");
          }
          reject(
            new BrowserAutomationError(connectionLostUserMessage({ recoverable }), {
              stage: "connection-lost",
              recoverableDisconnect: recoverable,
              disconnectCause: recoverable ? "cdp-client-disconnect" : "chrome-closed",
              runtime: {
                browserTransport: "cdp",
                chromePid: chrome.pid,
                chromePort: chrome.port,
                chromeHost,
                userDataDir,
                chromeTargetId: lastTargetId ?? isolatedTargetId ?? undefined,
                tabUrl: authoritativeConversationUrl() ?? liveness.matchedUrl,
                conversationId:
                  authoritativeConversationId() ??
                  extractConversationIdFromUrl(liveness.matchedUrl ?? ""),
                promptSubmitted,
                controllerPid: process.pid,
                ...proTimingRuntime,
              },
            }),
          );
        })();
      });
    });
    const raceWithDisconnect = <T>(promise: Promise<T>): Promise<T> =>
      Promise.race([promise, disconnectPromise]);
    const { Network, Page, Runtime, Input, DOM, Target } = client;

    const domainEnablers = [Network.enable({}), Page.enable(), Runtime.enable()];
    if (DOM && typeof DOM.enable === "function") {
      domainEnablers.push(DOM.enable());
    }
    await Promise.all(domainEnablers);
    if (!config.headless && config.hideWindow) {
      await positionChromeWindowOffscreen(client, logger);
    } else if (!config.headless) {
      // A persistent profile can remember the previous off-screen window bounds.
      // Visible policy must actively restore the Oracle-owned CfT window to a
      // usable screen position instead of merely omitting the hide flag.
      await positionChromeWindowOnscreen(client, logger);
    }
    // The send button is clicked with trusted CDP input events at viewport
    // coordinates, which ChatGPT silently drops when the window is hidden or
    // occluded. Emulate focus so the page behaves like a foreground tab.
    await enableFocusEmulation(client, logger, "local target");
    removeDialogHandler = installJavaScriptDialogAutoDismissal(Page, logger);
    if (!profileIsPreSigned) {
      await Network.clearBrowserCookies();
    }

    const manualLoginCookieSync = manualLogin && Boolean(config.manualLoginCookieSync);
    const cookieSyncEnabled = config.cookieSync && (!profileIsPreSigned || manualLoginCookieSync);
    if (cookieSyncEnabled) {
      if (manualLoginCookieSync) {
        logger(
          "Manual login mode: seeding persistent profile with cookies from your Chrome profile.",
        );
      }
      if (!config.inlineCookies) {
        logger(
          "Heads-up: macOS may prompt for your Keychain password to read Chrome cookies; use --copy or --render for manual flow.",
        );
      } else {
        logger("Applying inline cookies (skipping Chrome profile read and Keychain prompt)");
      }
      // Learned: always sync cookies before the first navigation so /backend-api/me succeeds.
      const cookieCount = await syncCookies(Network, config.url, config.chromeProfile, logger, {
        allowErrors: config.allowCookieErrors ?? false,
        filterNames: config.cookieNames ?? undefined,
        inlineCookies: config.inlineCookies ?? undefined,
        cookiePath: config.chromeCookiePath ?? undefined,
        waitMs: config.cookieSyncWaitMs ?? 0,
      });
      appliedCookies = cookieCount;
      if (config.inlineCookies && cookieCount === 0) {
        throw new Error("No inline cookies were applied; aborting before navigation.");
      }
      logger(
        cookieCount > 0
          ? config.inlineCookies
            ? `Applied ${cookieCount} inline cookies`
            : `Copied ${cookieCount} cookies from Chrome profile ${config.chromeProfile ?? "Default"}`
          : config.inlineCookies
            ? "No inline cookies applied; continuing without session reuse"
            : "No Chrome cookies found; continuing without session reuse",
      );
    } else {
      logger(
        manualLogin
          ? "Skipping Chrome cookie sync (--browser-manual-login enabled); reuse the opened profile after signing in."
          : "Skipping Chrome cookie sync (--browser-no-cookie-sync)",
      );
    }
    const skipStaleCookieCleanup = await shouldSkipStaleConversationCookieCleanup(
      manualLogin && tabLease
        ? () => hasOtherActiveBrowserTabLeases(userDataDir, tabLease!.id)
        : null,
    );
    if (skipStaleCookieCleanup) {
      logger(
        "[cookies] Skipping stale ChatGPT conversation-cookie cleanup: another Oracle browser lease is active.",
      );
    } else {
      await clearStaleChatGptConversationCookies(Network, Target, logger, {
        preserveConversationIds: [
          extractConversationIdFromUrl(config.resumeConversationUrl ?? ""),
          extractConversationIdFromUrl(lastUrl ?? ""),
        ],
      });
    }

    if (cookieSyncEnabled && !manualLogin && (appliedCookies ?? 0) === 0 && !config.inlineCookies) {
      // Learned: if the profile has no ChatGPT cookies, browser mode will just bounce to login.
      // Fail early so the user knows to sign in.
      throw new BrowserAutomationError(
        "No ChatGPT cookies were applied from your Chrome profile; cannot proceed in browser mode. " +
          "Make sure ChatGPT is signed in in the selected profile, use --browser-manual-login / inline cookies, " +
          "or retry with --browser-cookie-wait 5s if Keychain prompts are slow.",
        {
          stage: "execute-browser",
          details: {
            profile: config.chromeProfile ?? "Default",
            cookiePath: config.chromeCookiePath ?? null,
            hint: "If macOS Keychain prompts or denies access, run oracle from a GUI session or use --copy/--render for the manual flow.",
          },
        },
      );
    }

    if (config.browserTabRef) {
      if (isResumingConversation) {
        await raceWithDisconnect(
          navigateToChatGPT(Page, Runtime, config.resumeConversationUrl as string, logger),
        );
      }
      await raceWithDisconnect(ensureNotBlocked(Runtime, config.headless, logger));
      await raceWithDisconnect(ensureLoggedIn(Runtime, logger));
      await raceWithDisconnect(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
      if (isResumingConversation) {
        await raceWithDisconnect(
          waitForResumedConversationHydration(Runtime, config.inputTimeoutMs, logger, {
            requirePriorTurns: true,
            expectedConversationUrl: config.resumeConversationUrl as string,
          }),
        );
      }
    } else {
      const baseUrl = CHATGPT_URL;
      // First load the base ChatGPT homepage to satisfy potential interstitials,
      // then hop to the requested URL if it differs.
      await raceWithDisconnect(navigateToChatGPT(Page, Runtime, baseUrl, logger));
      await raceWithDisconnect(ensureNotBlocked(Runtime, config.headless, logger));
      // Learned: login checks must happen on the base domain before jumping into project URLs.
      await raceWithDisconnect(
        waitForLogin({
          runtime: Runtime,
          logger,
          appliedCookies,
          manualLogin,
          timeoutMs: config.timeoutMs,
          profileDir: userDataDir,
          keepBrowser: effectiveKeepBrowser,
        }),
      );

      if (isResumingConversation) {
        await raceWithDisconnect(
          navigateToChatGPT(Page, Runtime, config.resumeConversationUrl as string, logger),
        );
        await raceWithDisconnect(ensureNotBlocked(Runtime, config.headless, logger));
        await raceWithDisconnect(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
      } else if (config.url !== baseUrl) {
        await raceWithDisconnect(
          navigateToPromptReadyWithFallback(Page, Runtime, {
            url: config.url,
            fallbackUrl: baseUrl,
            timeoutMs: config.inputTimeoutMs,
            headless: config.headless,
            logger,
          }),
        );
      } else {
        await raceWithDisconnect(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
      }
      if (isResumingConversation) {
        // A resumed thread loads its prior history after navigation; ChatGPT can reset the
        // composer mid-hydration and wipe a freshly-typed prompt. Wait for hydration to settle
        // and re-confirm the composer before the prompt is typed/submitted below. Wrapped in
        // raceWithDisconnect so a dropped client aborts immediately instead of polling to the
        // hydration deadline. Shared with the remote path via the same helper.
        await raceWithDisconnect(
          waitForResumedConversationHydration(Runtime, config.inputTimeoutMs, logger, {
            requirePriorTurns: true,
            expectedConversationUrl: config.resumeConversationUrl as string,
          }),
        );
      }
    }
    const chatMode = await raceWithDisconnect(
      ensureChatMode(Runtime, Input, config.inputTimeoutMs, logger, {
        assumeChatWhenUnresolved: isResumingConversation,
        resetWorkConversation:
          config.browserTabRef && !isResumingConversation
            ? async () => {
                await navigateToChatGPT(Page, Runtime, config.url, logger);
                await ensureNotBlocked(Runtime, config.headless, logger);
                await ensurePromptReady(Runtime, config.inputTimeoutMs, logger);
              }
            : undefined,
      }),
    );
    if (chatMode === "switched") {
      await raceWithDisconnect(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
    }
    logger(
      `Prompt textarea ready (initial focus, ${promptText.length.toLocaleString()} chars queued)`,
    );
    const captureRuntimeSnapshot = async () => {
      try {
        const { result } = await Runtime.evaluate({
          expression: "location.href",
          returnByValue: true,
        });
        if (typeof result?.value === "string") {
          const observedUrl = result.value;
          if (!promptSubmitted || !conversationUrlMonitor) {
            lastUrl = observedUrl;
          } else if (isConversationUrl(observedUrl)) {
            // Never let a later same-target navigation overwrite the committed
            // conversation authority. The identity monitor records the mismatch.
            await conversationUrlMonitor.update("runtime-snapshot", 1);
          }
        }
      } catch {
        // ignore
      }
      if (lastUrl) {
        logger(`[browser] url = ${lastUrl}`);
      }
      if (chrome?.port) {
        const suffix = lastTargetId ? ` target=${lastTargetId}` : "";
        if (lastUrl) {
          logger(
            `[reattach] chrome port=${chrome.port} host=${chromeHost} url=${lastUrl}${suffix}`,
          );
        } else {
          logger(`[reattach] chrome port=${chrome.port} host=${chromeHost}${suffix}`);
        }
        await emitRuntimeHint();
      }
    };
    const activeConversationUrlMonitor = createConversationUrlMonitor({
      readUrl: async () => {
        const { result } = await Runtime.evaluate({
          expression: "location.href",
          returnByValue: true,
        });
        return typeof result?.value === "string" ? result.value : null;
      },
      persistUrl: async (url) => {
        lastUrl = url;
        await emitRuntimeHint();
      },
      logger,
      initialConversationUrl:
        config.resumeConversationUrl && isConversationUrl(config.resumeConversationUrl)
          ? config.resumeConversationUrl
          : lastUrl && isConversationUrl(lastUrl)
            ? lastUrl
            : undefined,
      validateCandidate: async () =>
        committedPromptIdentity
          ? readCommittedPromptIdentityStatus(Runtime, committedPromptIdentity)
          : "pending",
      watchAfterBind: true,
    });
    conversationUrlMonitor = activeConversationUrlMonitor;
    const requireConversationIdentity = async (
      label: string,
      timeoutMs = 15_000,
    ): Promise<string> => {
      const verified = await activeConversationUrlMonitor.update(label, timeoutMs);
      const conversationId = activeConversationUrlMonitor.boundConversationId();
      if (!verified || !conversationId) {
        throw new BrowserAutomationError(
          "Oracle could not verify which ChatGPT conversation owns the submitted review. The review was sent; recover this session instead of submitting it again.",
          {
            stage: "conversation-identity",
            code: "conversation-id-unbound",
            promptSubmitted,
            // Distinguishes "the route never changed" from "it changed but the
            // committed turn stayed pending" from "the page could not be read".
            diagnostics: activeConversationUrlMonitor.snapshot(),
          },
        );
      }
      return conversationId;
    };
    await captureRuntimeSnapshot();
    const modelStrategy = config.modelStrategy ?? DEFAULT_MODEL_STRATEGY;
    if (config.desiredModel && modelStrategy !== "ignore" && !isResumingConversation) {
      modelSelectionEvidence = await raceWithDisconnect(
        ensureModelSelectionWithTargetRepair({
          select: () =>
            ensureModelSelection(Runtime, config.desiredModel as string, logger, modelStrategy),
          repair: async () => {
            await navigateToChatGPT(Page, Runtime, config.url, logger);
            await ensureNotBlocked(Runtime, config.headless, logger);
            await ensureLoggedIn(Runtime, logger);
            await ensurePromptReady(Runtime, config.inputTimeoutMs, logger);
          },
          canRepair: ownsTarget,
          logger,
        }),
      ).catch((error) => {
        // Login has already been verified above. Preserve the picker failure instead of
        // misdiagnosing an unavailable model as missing cookies.
        throw normalizeAuthenticatedModelSelectionError(error);
      });
      await raceWithDisconnect(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
      logger(
        `Prompt textarea ready (after model switch, ${promptText.length.toLocaleString()} chars queued)`,
      );
    } else if (modelStrategy === "ignore" || isResumingConversation) {
      modelSelectionEvidence = buildSkippedModelSelectionEvidence(
        config.desiredModel,
        modelStrategy,
      );
      logger(
        isResumingConversation
          ? "Model picker: skipped (resumed conversation)"
          : "Model picker: skipped (strategy=ignore)",
      );
    }
    const deepResearch = config.researchMode === "deep";
    // Handle thinking time selection if specified. Deep Research owns its own effort flow.
    const thinkingTime = config.thinkingTime;
    if (thinkingTime && !deepResearch) {
      const thinkingTargetModel = modelStrategy === "select" ? config.desiredModel : null;
      await raceWithDisconnect(
        withRetries(() => ensureThinkingTime(Runtime, thinkingTime, logger, thinkingTargetModel), {
          retries: 2,
          delayMs: 300,
          onRetry: (attempt, error) => {
            if (options.verbose) {
              logger(
                `[retry] Thinking time (${thinkingTime}) attempt ${attempt + 1}: ${error instanceof Error ? error.message : error}`,
              );
            }
          },
        }),
      );
    }
    const profileLockTimeoutMs = manualLogin ? (config.profileLockTimeoutMs ?? 0) : 0;
    let profileLock: ProfileRunLock | null = null;
    const acquireProfileLockIfNeeded = async () => {
      if (profileLockTimeoutMs <= 0) return;
      profileLock = await acquireProfileRunLock(userDataDir, {
        timeoutMs: profileLockTimeoutMs,
        logger,
      });
    };
    const releaseProfileLockIfHeld = async () => {
      if (!profileLock) return;
      const handle = profileLock;
      profileLock = null;
      await handle.release().catch(() => undefined);
    };
    const submitOnce = async (prompt: string, submissionAttachments: BrowserAttachment[]) => {
      if (proTimingRequired) {
        proTimingRuntime = beginProResponseTimingTurn(proTimingRuntime, {
          inputTokens: estimateTokenCount(prompt),
          attachmentBytes: await resolveProAttachmentBytes(submissionAttachments),
          prompt,
        });
      }
      const baselineSnapshot = await readAssistantSnapshot(Runtime).catch(() => null);
      const baselineAssistantText =
        typeof baselineSnapshot?.text === "string" ? baselineSnapshot.text.trim() : "";
      const attachmentNames = submissionAttachments.map((a) => path.basename(a.path));
      const attachmentExpectations = submissionAttachments.map((a) => ({
        name: path.basename(a.path),
        generatedBundle: a.generatedBundle === true,
      }));
      let inputOnlyAttachments = false;
      await raceWithDisconnect(clearPromptComposer(Runtime, logger));
      await raceWithDisconnect(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
      if (submissionAttachments.length > 0) {
        if (!DOM) {
          throw new Error("Chrome DOM domain unavailable while uploading attachments.");
        }
        await clearComposerAttachments(Runtime, 5_000, logger);
        for (
          let attachmentIndex = 0;
          attachmentIndex < submissionAttachments.length;
          attachmentIndex += 1
        ) {
          const attachment = submissionAttachments[attachmentIndex];
          logger(`Uploading attachment: ${attachment.displayPath}`);
          const uiConfirmed = await uploadAttachmentFile(
            { runtime: Runtime, dom: DOM, input: Input },
            attachment,
            logger,
            { expectedCount: attachmentIndex + 1 },
          );
          if (!uiConfirmed) {
            inputOnlyAttachments = true;
          }
          await delay(500);
        }
        // Scale timeout based on number of files: base 45s + 20s per additional file.
        const baseTimeout = config.inputTimeoutMs ?? 30_000;
        const perFileTimeout = 20_000;
        const waitBudget =
          Math.max(baseTimeout, 45_000) + (submissionAttachments.length - 1) * perFileTimeout;
        const attachmentWaitBudget = Math.max(config.attachmentTimeoutMs ?? 0, waitBudget);
        await waitForAttachmentCompletion(Runtime, attachmentWaitBudget, attachmentNames, logger);
        logger("All attachments uploaded");
      }
      if (deepResearch) {
        await raceWithDisconnect(
          withRetries(() => activateDeepResearch(Runtime, Input, logger), {
            retries: 2,
            delayMs: 500,
            onRetry: (attempt, error) => {
              if (options.verbose) {
                logger(
                  `[retry] Deep Research activation attempt ${attempt + 1}: ${error instanceof Error ? error.message : error}`,
                );
              }
            },
          }),
        );
        await raceWithDisconnect(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
        logger(
          `Prompt textarea ready (after Deep Research activation, ${prompt.length.toLocaleString()} chars queued)`,
        );
      }
      let baselineTurns = await readConversationTurnCount(Runtime, logger);
      const submissionTargetId = lastTargetId;
      const isSubmissionOwner = async (): Promise<boolean> => {
        if (!submissionTargetId || lastTargetId !== submissionTargetId) return false;
        const { targetInfo } = await Target.getTargetInfo({ targetId: submissionTargetId });
        return targetInfo.targetId === submissionTargetId && targetInfo.type === "page";
      };
      // Learned: return baselineTurns so assistant polling can ignore earlier content.
      const providerState: Record<string, unknown> = {
        runtime: Runtime,
        input: Input,
        logger,
        timeoutMs: config.timeoutMs,
        inputTimeoutMs: config.inputTimeoutMs ?? undefined,
        attachmentTimeoutMs: config.attachmentTimeoutMs ?? undefined,
        baselineTurns: baselineTurns ?? undefined,
        attachmentNames: attachmentExpectations,
        onPromptDispatched: markPromptDispatched,
        onPromptCommitted: (committedTurns: number | null, committedUserTurnIndex: number | null) =>
          markPromptCommitted(committedTurns, committedUserTurnIndex, prompt),
        onPromptCommitPending: () =>
          throwChatGptUiWarningIfPresent({
            Runtime,
            logger,
            runtime: {
              browserTransport: "cdp" as const,
              chromePid: chrome.pid,
              chromePort: chrome.port,
              chromeHost,
              userDataDir,
              chromeTargetId: lastTargetId,
              tabUrl: authoritativeConversationUrl(),
              conversationId: lastUrl ? extractConversationIdFromUrl(lastUrl) : undefined,
              promptSubmitted,
              controllerPid: process.pid,
              ...proTimingRuntime,
            },
            stage: "submit-prompt",
            waitTarget: "prompt commit",
            submissionCommitted: false,
            dispatchAttempted: true,
          }),
        isSubmissionOwner,
      };
      const deepResearchTargetBaseline =
        deepResearch && client
          ? await captureDeepResearchTargetBaseline(client, logger)
          : undefined;
      await throwChatGptUiWarningIfPresent({
        Runtime,
        logger,
        runtime: {
          browserTransport: "cdp" as const,
          chromePid: chrome.pid,
          chromePort: chrome.port,
          chromeHost,
          userDataDir,
          chromeTargetId: lastTargetId,
          tabUrl: lastUrl,
          conversationId: lastUrl ? extractConversationIdFromUrl(lastUrl) : undefined,
          promptSubmitted,
          controllerPid: process.pid,
          ...proTimingRuntime,
        },
        stage: "submit-prompt",
        waitTarget: "prompt dispatch",
        submissionCommitted: false,
        dispatchAttempted: false,
      });
      await runProviderSubmissionFlow(chatgptDomProvider, {
        prompt,
        evaluate: async () => undefined,
        delay,
        log: logger,
        state: providerState,
      });
      const providerBaselineTurns = providerState.baselineTurns;
      if (typeof providerBaselineTurns === "number" && Number.isFinite(providerBaselineTurns)) {
        baselineTurns = providerBaselineTurns;
      }
      if (attachmentNames.length > 0) {
        if (inputOnlyAttachments) {
          logger(
            "Attachment UI did not render before send; skipping user-turn attachment verification.",
          );
        } else {
          const verified = await waitForUserTurnAttachments(
            Runtime,
            attachmentNames,
            20_000,
            logger,
            {
              minTurnIndex: baselineTurns ?? undefined,
              expectedPrompt: prompt,
              expectedConversationId: lastUrl ? extractConversationIdFromUrl(lastUrl) : undefined,
            },
          );
          if (!verified) {
            logger(
              "Sent user message did not expose attachment UI; continuing after upload check.",
            );
          } else {
            logger("Verified attachments present on sent user message");
          }
        }
      }
      return {
        baselineTurns,
        baselineAssistantText,
        deepResearchTargetKeys: deepResearchTargetBaseline?.targetKeys,
        deepResearchTargetBaselineCaptured: deepResearchTargetBaseline?.captured,
      };
    };
    const reloadPromptComposer = async () => {
      logger("[browser] Composer became unresponsive; reloading page and retrying once.");
      await raceWithDisconnect(Page.reload({ ignoreCache: true }));
      await raceWithDisconnect(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
    };

    let baselineTurns: number | null = null;
    let baselineAssistantText: string | null = null;
    let deepResearchTargetKeys: string[] = [];
    let deepResearchTargetBaselineCaptured = false;
    await acquireProfileLockIfNeeded();
    try {
      const submission = await runSubmissionWithRecovery({
        prompt: promptText,
        attachments,
        fallbackSubmission,
        submit: (submissionPrompt, submissionAttachments) =>
          raceWithDisconnect(submitOnce(submissionPrompt, submissionAttachments)),
        reloadPromptComposer,
        prepareFallbackSubmission: async () => {
          await raceWithDisconnect(clearPromptComposer(Runtime, logger));
          await raceWithDisconnect(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
        },
        logger,
      });
      baselineTurns = submission.baselineTurns;
      baselineAssistantText = submission.baselineAssistantText;
      deepResearchTargetKeys = submission.deepResearchTargetKeys ?? [];
      deepResearchTargetBaselineCaptured = submission.deepResearchTargetBaselineCaptured ?? false;
    } finally {
      await releaseProfileLockIfHeld();
    }
    const imageArtifactMinTurnIndex = baselineTurns;
    if (deepResearch) {
      await requireConversationIdentity("deep-research-wait");
      await raceWithDisconnect(waitForResearchPlanAutoConfirm(Runtime, logger));
      const researchResult = await activeConversationUrlMonitor.guard(() =>
        raceWithDisconnect(
          waitForDeepResearchCompletion(
            Runtime,
            logger,
            config.timeoutMs,
            baselineTurns,
            Page,
            client!,
            {
              ignoredTargetKeys: deepResearchTargetKeys,
              targetBaselineCaptured: deepResearchTargetBaselineCaptured,
            },
          ),
        ),
      );
      browserTurnState = "terminal";
      answerCaptured = true;
      recordResponseTiming(researchResult.text);
      await emitRuntimeHint();
      await requireConversationIdentity("post-deep-research");
      runStatus = "complete";
      const durationMs = Date.now() - startedAt;
      const tokens = estimateTokenCount(researchResult.text);
      const reportArtifact = await saveOptionalArtifact(
        () =>
          saveDeepResearchReportArtifact({
            sessionId: options.sessionId,
            reportMarkdown: researchResult.text,
            conversationUrl: authoritativeConversationUrl(),
            logger,
          }),
        logger,
      );
      const transcriptArtifact = await saveOptionalArtifact(
        () =>
          saveBrowserTranscriptArtifact({
            sessionId: options.sessionId,
            prompt: promptText,
            answerMarkdown: researchResult.text,
            conversationUrl: authoritativeConversationUrl(),
            artifacts: appendArtifacts(undefined, [reportArtifact]),
            logger,
          }),
        logger,
      );
      const savedArtifacts = appendArtifacts(undefined, [reportArtifact, transcriptArtifact]);
      return {
        answerText: researchResult.text,
        answerMarkdown: researchResult.text,
        answerHtml: researchResult.html,
        artifacts: savedArtifacts,
        modelSelection: modelSelectionEvidence,
        tookMs: durationMs,
        answerTokens: tokens,
        answerChars: researchResult.text.length,
        browserTransport: "cdp",
        chromePid: chrome.pid,
        chromePort: chrome.port,
        chromeHost,
        userDataDir,
        chromeTargetId: lastTargetId,
        tabUrl: authoritativeConversationUrl(),
        conversationId: authoritativeConversationId(),
        promptSubmitted,
        controllerPid: process.pid,
        ...proTimingRuntime,
      };
    }
    // Helper to normalize text for echo detection (collapse whitespace, lowercase)
    const normalizeForComparison = (text: string): string =>
      text.toLowerCase().replace(/\s+/g, " ").trim();
    const expectedConversationId = authoritativeConversationId;
    const waitForFreshAssistantResponse = async (baselineNormalized: string, timeoutMs: number) => {
      const baselinePrefix =
        baselineNormalized.length >= 80
          ? baselineNormalized.slice(0, Math.min(200, baselineNormalized.length))
          : "";
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const snapshot = await readAssistantSnapshot(
          Runtime,
          baselineTurns ?? undefined,
          expectedConversationId(),
        ).catch(() => null);
        const text = typeof snapshot?.text === "string" ? snapshot.text.trim() : "";
        if (text) {
          const normalized = normalizeForComparison(text);
          const isBaseline =
            normalized === baselineNormalized ||
            (baselinePrefix.length > 0 && normalized.startsWith(baselinePrefix));
          if (!isBaseline) {
            return {
              text,
              html: snapshot?.html ?? undefined,
              meta: {
                turnId: snapshot?.turnId ?? undefined,
                messageId: snapshot?.messageId ?? undefined,
              },
            };
          }
        }
        await delay(350);
      }
      return null;
    };
    const waitWithThinkingMonitor = async <T>(operation: () => Promise<T>): Promise<T> => {
      stopThinkingMonitor?.();
      stopThinkingMonitor = startThinkingStatusMonitor(Runtime, logger, {
        intervalMs: options.heartbeatIntervalMs,
        expectedConversationId: expectedConversationId(),
      });
      try {
        return await operation();
      } finally {
        stopThinkingMonitor?.();
        stopThinkingMonitor = null;
      }
    };
    const recheckDelayMs = Math.max(0, config.assistantRecheckDelayMs ?? 0);
    const recheckTimeoutMs = Math.max(0, config.assistantRecheckTimeoutMs ?? 0);
    const attemptAssistantRecheck = async () => {
      if (!recheckDelayMs) return null;
      logger(
        `[browser] Assistant response timed out; waiting ${formatElapsed(recheckDelayMs)} before rechecking conversation.`,
      );
      await raceWithDisconnect(delay(recheckDelayMs));
      await requireConversationIdentity("assistant-recheck");
      await captureRuntimeSnapshot().catch(() => undefined);
      const conversationUrl = activeConversationUrlMonitor.boundConversationUrl();
      if (conversationUrl && isConversationUrl(conversationUrl)) {
        logger(`[browser] Rechecking assistant response at ${conversationUrl}`);
        await raceWithDisconnect(navigateToChatGPT(Page, Runtime, conversationUrl, logger));
        await raceWithDisconnect(
          waitForResumedConversationHydration(Runtime, recheckTimeoutMs || 30_000, logger, {
            requirePriorTurns: true,
            requirePromptReady: false,
            expectedConversationUrl: conversationUrl,
          }),
        );
      }
      // Validate session before attempting recheck - sessions can expire during the delay
      const sessionValid = await validateChatGPTSession(Runtime, logger);
      if (!sessionValid.valid) {
        logger(`[browser] Session validation failed: ${sessionValid.reason}`);
        // Update session metadata to indicate login is needed
        await emitRuntimeHint();
        throw new BrowserAutomationError(
          `ChatGPT session expired during recheck: ${sessionValid.reason}. ` +
            `Conversation URL: ${conversationUrl || lastUrl || "unknown"}. ` +
            `Please sign in and retry.`,
          {
            stage: "assistant-recheck",
            details: {
              conversationUrl: conversationUrl || lastUrl || null,
              sessionStatus: "needs_login",
              validationReason: sessionValid.reason,
            },
            runtime: {
              browserTransport: "cdp",
              chromePid: chrome.pid,
              chromePort: chrome.port,
              chromeHost,
              userDataDir,
              chromeTargetId: lastTargetId,
              tabUrl: conversationUrl ?? lastUrl,
              conversationId: authoritativeConversationId(),
              promptSubmitted,
              controllerPid: process.pid,
              ...proTimingRuntime,
            },
          },
        );
      }
      const timeoutMs = recheckTimeoutMs > 0 ? recheckTimeoutMs : config.timeoutMs;
      const rechecked = await waitWithThinkingMonitor(() =>
        raceWithDisconnect(
          waitForAssistantOrGeneratedImageResponse({
            Runtime,
            waitForText: () =>
              waitForAssistantResponseWithReload(
                Runtime,
                Page,
                timeoutMs,
                logger,
                baselineTurns ?? undefined,
                expectedConversationId(),
              ),
            timeoutMs,
            logger,
            minTurnIndex: baselineTurns ?? undefined,
            expectedConversationId: expectedConversationId(),
            imageOutputRequested,
          }),
        ),
      );
      logger("Recovered assistant response after delayed recheck");
      return rechecked;
    };
    const imageOutputRequested = Boolean(
      options.generateImagePath ||
      options.outputPath ||
      (options as { generateImage?: string }).generateImage,
    );
    const captureAssistantTurn = async (
      turnPrompt: string,
      label: string,
    ): Promise<BrowserConversationTurn & { answerHtml: string }> => {
      let turnAnswer: AssistantAnswer;
      try {
        await requireConversationIdentity("assistant-wait");
        turnAnswer = await activeConversationUrlMonitor.guard(() =>
          waitWithThinkingMonitor(() =>
            raceWithDisconnect(
              waitForAssistantOrGeneratedImageResponse({
                Runtime,
                waitForText: () =>
                  waitForAssistantResponseWithReload(
                    Runtime,
                    Page,
                    config.timeoutMs,
                    logger,
                    baselineTurns ?? undefined,
                    expectedConversationId(),
                  ),
                timeoutMs: config.timeoutMs,
                logger,
                minTurnIndex: baselineTurns ?? undefined,
                expectedConversationId: expectedConversationId(),
                imageOutputRequested,
              }),
            ),
          ),
        );
      } catch (error) {
        if (isAssistantResponseTimeoutError(error)) {
          const rechecked = await attemptAssistantRecheckOrRethrow(attemptAssistantRecheck);
          if (rechecked) {
            turnAnswer = rechecked;
          } else {
            await requireConversationIdentity("assistant-timeout");
            await captureRuntimeSnapshot().catch(() => undefined);
            const diagnostics = await captureBrowserDiagnostics(
              Runtime,
              logger,
              "assistant-timeout",
              {
                Page,
                sessionId: options.sessionId,
              },
            ).catch(() => undefined);
            const runtime = {
              browserTransport: "cdp" as const,
              chromePid: chrome.pid,
              chromePort: chrome.port,
              chromeHost,
              userDataDir,
              chromeTargetId: lastTargetId,
              tabUrl: authoritativeConversationUrl(),
              conversationId: authoritativeConversationId(),
              promptSubmitted,
              controllerPid: process.pid,
              ...proTimingRuntime,
            };
            throw await createAssistantTimeoutError({
              Runtime,
              logger,
              runtime,
              diagnostics,
              cause: error,
            });
          }
        } else {
          throw error;
        }
      }
      // Ensure we store the final conversation URL even if the UI updated late.
      await requireConversationIdentity("post-response");
      const baselineNormalized = baselineAssistantText
        ? normalizeForComparison(baselineAssistantText)
        : "";
      if (baselineNormalized) {
        const normalizedAnswer = normalizeForComparison(turnAnswer.text ?? "");
        const baselinePrefix =
          baselineNormalized.length >= 80
            ? baselineNormalized.slice(0, Math.min(200, baselineNormalized.length))
            : "";
        const isBaseline =
          normalizedAnswer === baselineNormalized ||
          (baselinePrefix.length > 0 && normalizedAnswer.startsWith(baselinePrefix));
        if (isBaseline) {
          logger("Detected stale assistant response; waiting for new response...");
          const refreshed = await waitForFreshAssistantResponse(baselineNormalized, 15_000);
          if (refreshed) {
            turnAnswer = refreshed;
          }
        }
      }
      let turnAnswerText = turnAnswer.text;
      const turnAnswerHtml = turnAnswer.html ?? "";
      const copiedMarkdown = await raceWithDisconnect(
        withRetries(
          async () => {
            const attempt = await captureAssistantMarkdown(
              Runtime,
              turnAnswer.meta,
              logger,
              expectedConversationId(),
            );
            if (!attempt) {
              throw new Error("copy-missing");
            }
            return attempt;
          },
          {
            retries: 2,
            delayMs: 350,
            onRetry: (attempt, error) => {
              if (options.verbose) {
                logger(
                  `[retry] Markdown capture attempt ${attempt + 1}: ${error instanceof Error ? error.message : error}`,
                );
              }
            },
          },
        ),
      ).catch((error) => {
        if (
          error instanceof BrowserAutomationError &&
          (error.details as { stage?: string } | undefined)?.stage === "conversation-identity"
        ) {
          throw error;
        }
        return null;
      });
      let turnAnswerMarkdown = copiedMarkdown ?? turnAnswerText;

      const promptEchoMatcher = buildPromptEchoMatcher(turnPrompt);
      ({ answerText: turnAnswerText, answerMarkdown: turnAnswerMarkdown } =
        await maybeRecoverLongAssistantResponse({
          runtime: Runtime,
          baselineTurns,
          answerText: turnAnswerText,
          answerMarkdown: turnAnswerMarkdown,
          logger,
          allowMarkdownUpdate: !copiedMarkdown,
          expectedConversationId: expectedConversationId(),
        }));

      // Final sanity check: ensure we didn't accidentally capture the user prompt instead of the assistant turn.
      const finalSnapshot = await readAssistantSnapshot(
        Runtime,
        baselineTurns ?? undefined,
        expectedConversationId(),
      ).catch(() => null);
      const finalText = typeof finalSnapshot?.text === "string" ? finalSnapshot.text.trim() : "";
      if (finalText && finalText !== turnPrompt.trim()) {
        const trimmedMarkdown = turnAnswerMarkdown.trim();
        const finalIsEcho = promptEchoMatcher ? promptEchoMatcher.isEcho(finalText) : false;
        const lengthDelta = finalText.length - trimmedMarkdown.length;
        const missingCopy = !copiedMarkdown && lengthDelta >= 0;
        const likelyTruncatedCopy =
          copiedMarkdown &&
          trimmedMarkdown.length > 0 &&
          lengthDelta >= Math.max(12, Math.floor(trimmedMarkdown.length * 0.75));
        if ((missingCopy || likelyTruncatedCopy) && !finalIsEcho && finalText !== trimmedMarkdown) {
          logger("Refreshed assistant response via final DOM snapshot");
          turnAnswerText = finalText;
          turnAnswerMarkdown = finalText;
        }
      }

      // Detect prompt echo using normalized comparison (whitespace-insensitive).
      const alignedEcho = alignPromptEchoPair(
        turnAnswerText,
        turnAnswerMarkdown,
        promptEchoMatcher,
        copiedMarkdown ? logger : undefined,
        {
          text: "Aligned assistant response text to copied markdown after prompt echo",
          markdown: "Aligned assistant markdown to response text after prompt echo",
        },
      );
      turnAnswerText = alignedEcho.answerText;
      turnAnswerMarkdown = alignedEcho.answerMarkdown;
      const isPromptEcho = alignedEcho.isEcho;
      if (isPromptEcho) {
        logger("Detected prompt echo in response; waiting for actual assistant response...");
        const deadline = Date.now() + 15_000;
        let bestText: string | null = null;
        let stableCount = 0;
        while (Date.now() < deadline) {
          const snapshot = await readAssistantSnapshot(
            Runtime,
            baselineTurns ?? undefined,
            expectedConversationId(),
          ).catch(() => null);
          const text = typeof snapshot?.text === "string" ? snapshot.text.trim() : "";
          const isStillEcho = !text || Boolean(promptEchoMatcher?.isEcho(text));
          if (!isStillEcho) {
            if (!bestText || text.length > bestText.length) {
              bestText = text;
              stableCount = 0;
            } else if (text === bestText) {
              stableCount += 1;
            }
            if (stableCount >= 2) {
              break;
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
        if (bestText) {
          logger("Recovered assistant response after detecting prompt echo");
          turnAnswerText = bestText;
          turnAnswerMarkdown = bestText;
        }
      }
      const minAnswerChars = 16;
      if (turnAnswerText.trim().length > 0 && turnAnswerText.trim().length < minAnswerChars) {
        const deadline = Date.now() + 12_000;
        let bestText = turnAnswerText.trim();
        let stableCycles = 0;
        while (Date.now() < deadline) {
          const snapshot = await readAssistantSnapshot(
            Runtime,
            baselineTurns ?? undefined,
            expectedConversationId(),
          ).catch(() => null);
          const text = typeof snapshot?.text === "string" ? snapshot.text.trim() : "";
          if (text && text.length > bestText.length) {
            bestText = text;
            stableCycles = 0;
          } else {
            stableCycles += 1;
          }
          if (stableCycles >= 3 && bestText.length >= minAnswerChars) {
            break;
          }
          await delay(400);
        }
        if (bestText.length > turnAnswerText.trim().length) {
          logger("Refreshed short assistant response from latest DOM snapshot");
          turnAnswerText = bestText;
          turnAnswerMarkdown = bestText;
        }
      }
      return {
        label,
        answerText: turnAnswerText,
        answerMarkdown: turnAnswerMarkdown,
        answerHtml: turnAnswerHtml,
      };
    };

    const turns: BrowserConversationTurn[] = [];
    const initialTurn = await captureAssistantTurn(promptText, "Initial response");
    browserTurnState = "terminal";
    answerCaptured = true;
    recordResponseTiming(initialTurn.answerMarkdown || initialTurn.answerText);
    await emitRuntimeHint();
    turns.push(initialTurn);
    answerText = initialTurn.answerText;
    answerMarkdown = initialTurn.answerMarkdown;
    answerHtml = initialTurn.answerHtml;

    for (let index = 0; index < followUpPrompts.length; index += 1) {
      const followUpPrompt = followUpPrompts[index];
      logger(`[browser] Sending follow-up ${index + 1}/${followUpPrompts.length}`);
      await requireConversationIdentity(`follow-up-${index + 1}-owner`);
      await acquireProfileLockIfNeeded();
      try {
        await raceWithDisconnect(clearPromptComposer(Runtime, logger));
        await raceWithDisconnect(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
        const submission = await runSubmissionWithRecovery({
          prompt: followUpPrompt,
          attachments: [],
          submit: (submissionPrompt, submissionAttachments) =>
            raceWithDisconnect(submitOnce(submissionPrompt, submissionAttachments)),
          reloadPromptComposer,
          prepareFallbackSubmission: async () => {
            await raceWithDisconnect(clearPromptComposer(Runtime, logger));
            await raceWithDisconnect(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
          },
          logger,
        });
        baselineTurns = submission.baselineTurns;
        baselineAssistantText = submission.baselineAssistantText;
      } finally {
        await releaseProfileLockIfHeld();
      }
      const turn = await captureAssistantTurn(followUpPrompt, `Follow-up ${index + 1}`);
      browserTurnState = "terminal";
      answerCaptured = true;
      recordResponseTiming(turn.answerMarkdown || turn.answerText);
      await emitRuntimeHint();
      turns.push({ ...turn, prompt: followUpPrompt });
      answerText = turn.answerText;
      answerMarkdown = turn.answerMarkdown;
      answerHtml = turn.answerHtml;
    }

    if (turns.length > 1) {
      const formatted = formatBrowserTurnTranscript(turns);
      answerText = formatted.answerText;
      answerMarkdown = formatted.answerMarkdown;
      answerHtml = "";
    }
    if (connectionClosedUnexpectedly) {
      // Bail out on mid-run disconnects so the session stays reattachable.
      throw new Error("Chrome disconnected before completion");
    }
    await requireConversationIdentity("artifact-capture");
    const imageArtifacts = await activeConversationUrlMonitor.guard(() =>
      collectGeneratedImageArtifacts({
        Browser: client!.Browser,
        Client: client!,
        Page,
        Runtime,
        Network,
        logger,
        minTurnIndex: imageArtifactMinTurnIndex,
        sessionId: options.sessionId,
        generateImagePath: options.generateImagePath,
        outputPath: options.outputPath,
        answerText,
        waitTimeoutMs: options.config?.timeoutMs,
        checkBlockingUiWarning: () =>
          throwChatGptUiWarningIfPresent({
            Runtime,
            logger,
            stage: "image-artifact-wait",
            waitTarget: "generated image artifacts",
            runtime: {
              browserTransport: "cdp",
              chromePid: chrome.pid,
              chromePort: chrome.port,
              chromeHost,
              userDataDir,
              chromeTargetId: lastTargetId,
              tabUrl: authoritativeConversationUrl(),
              conversationId: authoritativeConversationId(),
              promptSubmitted,
              controllerPid: process.pid,
              ...proTimingRuntime,
            },
          }),
      }),
    );
    answerText = imageArtifacts.answerText || answerText;
    if (imageArtifacts.markdownSuffix) {
      answerMarkdown += imageArtifacts.markdownSuffix;
    }
    const fileArtifacts = await activeConversationUrlMonitor.guard(() =>
      collectChatGptFileArtifacts({
        Browser: client!.Browser,
        Client: client!,
        Page,
        Runtime,
        Network,
        answerText: [answerText, answerMarkdown, answerHtml].filter(Boolean).join("\n"),
        logger,
        minTurnIndex: imageArtifactMinTurnIndex,
        sessionId: options.sessionId,
      }),
    );
    const savedImageArtifacts = appendArtifacts(undefined, imageArtifacts.savedImages);
    const savedBrowserArtifacts = appendArtifacts(savedImageArtifacts, fileArtifacts.savedFiles);
    const transcriptArtifact = await saveOptionalArtifact(
      () =>
        saveBrowserTranscriptArtifact({
          sessionId: options.sessionId,
          prompt: promptText,
          answerMarkdown,
          conversationUrl: authoritativeConversationUrl(),
          artifacts: savedBrowserArtifacts,
          logger,
        }),
      logger,
    );
    const savedArtifacts = appendArtifacts(savedBrowserArtifacts, [transcriptArtifact]);
    runStatus = "complete";
    browserDisposition = "completed";
    recoveryKind = undefined;
    recoveryExpiresAt = undefined;
    await emitRuntimeHint();
    const durationMs = Date.now() - startedAt;
    const answerChars = answerText.length;
    const answerTokens = estimateTokenCount(answerMarkdown);
    return {
      answerText,
      answerMarkdown,
      answerHtml: answerHtml.length > 0 ? answerHtml : undefined,
      artifacts: savedArtifacts,
      generatedImages: imageArtifacts.generatedImages,
      savedImages: imageArtifacts.savedImages,
      downloadableFiles: fileArtifacts.files,
      savedFiles: fileArtifacts.savedFiles,
      modelSelection: modelSelectionEvidence,
      tookMs: durationMs,
      answerTokens,
      answerChars,
      browserTransport: "cdp",
      chromePid: chrome.pid,
      chromePort: chrome.port,
      chromeHost,
      userDataDir,
      chromeTargetId: lastTargetId,
      tabUrl: authoritativeConversationUrl(),
      conversationId: authoritativeConversationId(),
      promptSubmitted,
      browserDisposition,
      recoveryKind,
      recoveryExpiresAt,
      reconcileNeeded: reconcileNeeded || undefined,
      controllerPid: process.pid,
      browserRepairAttempted: dedicatedBootstrap?.repairAttempted || undefined,
      browserRepairOutcome: dedicatedBootstrap?.repairOutcome,
      browserRolloverPending: dedicatedBootstrap?.rolloverPending || undefined,
      ...proTimingRuntime,
    };
  } catch (error) {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    // An error can carry proof that a turn was sent even though the exact
    // commit callback never ran; the run-local flag must reflect it before any
    // classification or persistence below reads it.
    const errorDetails =
      normalizedError instanceof BrowserAutomationError
        ? (normalizedError.details as { promptSubmitted?: boolean } | undefined)
        : undefined;
    if (errorDetails?.promptSubmitted === true) {
      promptSubmitted = true;
    }
    const socketClosed = connectionClosedUnexpectedly || isWebSocketClosureError(normalizedError);
    connectionClosedUnexpectedly = connectionClosedUnexpectedly || socketClosed;
    const preservedErrorKind = classifyPreservedBrowserError(normalizedError, config.headless);
    if (preservedErrorKind === "cloudflare-challenge") {
      if (usingCopiedProfile) {
        logger(
          "Cloudflare challenge detected; closing Chrome and removing the copied profile because copy-profile runs cannot be retained.",
        );
        throw new BrowserAutomationError(
          promptSubmitted
            ? "Cloudflare challenge detected. Copy-profile runs cannot be retained; complete the check in the source Chrome profile, then use the recorded session state."
            : "Oracle needs you to complete the ChatGPT verification in the source browser. The review has not been sent.",
          {
            stage: "cloudflare-challenge",
            reattachable: false,
            promptSubmitted,
            ...(promptSubmitted
              ? {}
              : {
                  externalDataSent: false,
                  retrySafe: true,
                  retryGuidance: "complete-verification",
                }),
          },
          normalizedError,
        );
      }
      preserveBrowserOnError = true;
      browserDisposition = "recoverable";
      recoveryKind = "manual-intervention";
      recoveryExpiresAt = recoveryExpiryFromNow("manual-intervention");
      const runtime = {
        browserTransport: "cdp" as const,
        chromePid: chrome.pid,
        chromePort: chrome.port,
        chromeHost,
        userDataDir,
        chromeTargetId: lastTargetId,
        tabUrl: authoritativeConversationUrl(),
        promptSubmitted,
        browserDisposition,
        recoveryKind,
        recoveryExpiresAt,
        controllerPid: process.pid,
        ...proTimingRuntime,
      };
      const reuseProfileHint =
        `oracle --engine browser --browser-manual-login ` +
        `--browser-manual-login-profile-dir ${JSON.stringify(userDataDir)}`;
      await emitRuntimeHint();
      logger("Cloudflare challenge detected; leaving browser open so you can complete the check.");
      logger(`Reuse this browser profile with: ${reuseProfileHint}`);
      throw new BrowserAutomationError(
        promptSubmitted
          ? "ChatGPT verification interrupted the submitted review. Complete it in Oracle’s dedicated browser, then recover the existing session."
          : "Oracle needs you to complete the ChatGPT verification in its dedicated browser. The review has not been sent.",
        {
          stage: "cloudflare-challenge",
          runtime,
          reuseProfileHint,
          promptSubmitted,
          ...(promptSubmitted
            ? {}
            : { externalDataSent: false, retrySafe: true, retryGuidance: "complete-verification" }),
        },
        normalizedError,
      );
    }
    if (preservedErrorKind === "reattachable-capture") {
      if (usingCopiedProfile) {
        logger(
          "Assistant capture incomplete; closing Chrome and removing the copied profile because copy-profile runs cannot be reattached.",
        );
        const details =
          normalizedError instanceof BrowserAutomationError
            ? { ...normalizedError.details, runtime: undefined, reattachable: false }
            : { stage: "assistant-recheck", reattachable: false };
        throw new BrowserAutomationError(normalizedError.message, details, normalizedError);
      }
      preserveBrowserOnError = true;
      browserDisposition = "recoverable";
      recoveryKind = "awaiting-response";
      recoveryExpiresAt = recoveryExpiryFromNow("awaiting-response");
      await emitRuntimeHint();
      logger("Assistant capture incomplete; leaving browser open for reattach.");
      throw normalizedError;
    }
    if (preservedErrorKind === "draft-retained") {
      if (usingCopiedProfile) {
        throw normalizedError;
      }
      preserveBrowserOnError = true;
      browserDisposition = "recoverable";
      recoveryKind = "draft-retained";
      recoveryExpiresAt = recoveryExpiryFromNow("draft-retained");
      await emitRuntimeHint();
      logger("Prompt draft remains in the composer; leaving this exact tab open for recovery.");
      const details =
        normalizedError instanceof BrowserAutomationError ? normalizedError.details : undefined;
      throw new BrowserAutomationError(
        normalizedError.message,
        {
          ...details,
          runtime: {
            browserTransport: "cdp",
            chromePid: chrome.pid,
            chromePort: chrome.port,
            chromeHost,
            userDataDir,
            chromeTargetId: lastTargetId,
            tabUrl: authoritativeConversationUrl(),
            conversationId: authoritativeConversationId(),
            promptSubmitted,
            browserDisposition,
            recoveryKind,
            recoveryExpiresAt,
            controllerPid: process.pid,
            ...proTimingRuntime,
          },
        },
        normalizedError,
      );
    }
    if (!socketClosed) {
      browserDisposition = "abandoned";
      await emitRuntimeHint();
      logger(`Failed to complete ChatGPT run: ${normalizedError.message}`);
      if ((config.debug || process.env.CHATGPT_DEVTOOLS_TRACE === "1") && normalizedError.stack) {
        logger(normalizedError.stack);
      }
      throw normalizedError;
    }
    if ((config.debug || process.env.CHATGPT_DEVTOOLS_TRACE === "1") && normalizedError.stack) {
      logger(`Chrome connection lost before completion: ${normalizedError.message}`);
      logger(normalizedError.stack);
    }
    if (
      normalizedError instanceof BrowserAutomationError &&
      (normalizedError.details as { stage?: string } | undefined)?.stage === "connection-lost"
    ) {
      throw normalizedError;
    }
    const liveness = await probeChromeTargetLiveness({
      host: chromeHost,
      port: chrome.port,
      targetId: lastTargetId ?? isolatedTargetId,
    });
    const recoverable = isRecoverableChromeDisconnect(liveness);
    browserDisposition = recoverable ? "recoverable" : "abandoned";
    recoveryKind = recoverable ? "awaiting-response" : undefined;
    recoveryExpiresAt = recoverable ? recoveryExpiryFromNow("awaiting-response") : undefined;
    await emitRuntimeHint();
    throw new BrowserAutomationError(
      connectionLostUserMessage({ recoverable }),
      {
        stage: "connection-lost",
        recoverableDisconnect: recoverable,
        disconnectCause: recoverable ? "cdp-client-disconnect" : "chrome-closed",
        runtime: {
          browserTransport: "cdp",
          chromePid: chrome.pid,
          chromePort: chrome.port,
          chromeHost,
          userDataDir,
          chromeTargetId: lastTargetId,
          tabUrl: authoritativeConversationUrl() ?? liveness.matchedUrl,
          conversationId:
            authoritativeConversationId() ??
            (liveness.matchedUrl ? extractConversationIdFromUrl(liveness.matchedUrl) : undefined),
          promptSubmitted,
          browserDisposition,
          recoveryKind,
          recoveryExpiresAt,
          controllerPid: process.pid,
          ...proTimingRuntime,
        },
      },
      normalizedError,
    );
  } finally {
    await conversationUrlMonitor?.stop();
    try {
      if (!connectionClosedUnexpectedly) {
        await client?.close();
      }
    } catch {
      // ignore
    }
    // Close the isolated tab once the response has been fully captured to prevent
    // tab accumulation across repeated runs. Keep the tab open on incomplete runs
    // so reattach can recover the response.
    const shouldCloseOwnedRunTarget = shouldCloseOwnedRunTargetAfterRun({
      browserTurnState,
      answerCaptured,
      ownsTarget,
      closeOwnedTabOnComplete: options.closeOwnedTabOnComplete,
    });
    let keepBrowserOpen = shouldKeepLocalBrowserOpen({
      effectiveKeepBrowser,
      preserveBrowserOnError,
      usingCopiedProfile,
    });
    let dedicatedChromeDrained = false;
    if (tabLease) {
      const handle = tabLease;
      if (isolatedTargetId && ownsTarget) {
        await handle.setTargetDisposition(
          shouldCloseOwnedRunTarget || browserDisposition === "abandoned"
            ? "terminal"
            : "recoverable",
          {
            tabUrl: authoritativeConversationUrl(),
            recoveryKind,
            recoveryExpiresAt,
          },
        );
      }
      tabLease = null;
      const onRelease = async ({ isLastLease }: { isLastLease: boolean }) => {
        const releaseReconciliation = await reconcileOwnedBrowserTargets({
          profileDir: userDataDir,
          host: chromeHost,
          port: chrome.port,
          logger,
          ensureSentinel: keepBrowserOpen,
        });
        if (releaseReconciliation.status !== "complete") {
          reconcileNeeded = true;
          keepBrowserOpen = true;
          await emitRuntimeHint();
          logger(
            `[browser] Final target reconciliation ${releaseReconciliation.status}; leaving Chrome available for startup retry.`,
          );
        }
        if (keepBrowserOpen || !manualLogin) {
          return;
        }
        if (!isLastLease) {
          keepBrowserOpen = true;
          logger("[browser] Other ChatGPT tab leases still active; leaving shared Chrome running.");
          return;
        }

        // The registry release is already committed before this callback runs.
        // Serialize the final drain with launch/reuse, then re-read the registry:
        // a new caller may have acquired a lease while this run was finishing.
        const cleanupLockTimeoutMs = Math.max(0, config.profileLockTimeoutMs ?? 0);
        if (cleanupLockTimeoutMs === 0) {
          keepBrowserOpen = true;
          await recordDedicatedChromeHold(
            userDataDir,
            "Profile locking is disabled; final browser drain was deferred.",
          ).catch(() => undefined);
          return;
        }
        const cleanupProfileLock = await acquireProfileRunLock(userDataDir, {
          timeoutMs: cleanupLockTimeoutMs,
          logger,
          sessionId: options.sessionId,
        }).catch(() => null);
        if (!cleanupProfileLock) {
          keepBrowserOpen = true;
          logger(
            "[browser] Could not acquire the profile lock for final drain; leaving Chrome running.",
          );
          return;
        }
        try {
          const activeLeaseAppeared = await hasOtherActiveBrowserTabLeases(
            userDataDir,
            handle.id,
          ).catch(() => true);
          if (activeLeaseAppeared) {
            keepBrowserOpen = true;
            logger("[browser] A new ChatGPT tab lease appeared; leaving shared Chrome running.");
            await recordDedicatedChromeHold(
              userDataDir,
              "A new ChatGPT tab lease appeared during final drain.",
            ).catch(() => undefined);
          } else {
            const reconciliation = releaseReconciliation;
            if (
              !reconciliation ||
              reconciliation.protectedTargetIds.length > 0 ||
              reconciliation.unknownBlockingTargetIds.length > 0
            ) {
              keepBrowserOpen = true;
              if (reconciliation?.protectedTargetIds.length) {
                logger(
                  `[browser] ${reconciliation.protectedTargetIds.length} recoverable Oracle tab(s) still need Chrome; leaving it running.`,
                );
                await recordDedicatedChromeHold(
                  userDataDir,
                  "Recoverable Oracle targets still require this browser generation.",
                ).catch(() => undefined);
              } else if (reconciliation?.unknownBlockingTargetIds.length) {
                logger(
                  `[browser] ${reconciliation.unknownBlockingTargetIds.length} unowned page(s) remain; preserving the shared Chrome window.`,
                );
                await recordDedicatedChromeHold(
                  userDataDir,
                  "An unowned meaningful target prevents automatic browser drain.",
                ).catch(() => undefined);
              }
            } else if (!connectionClosedUnexpectedly) {
              const maintenance = await drainDedicatedChromeIfIdle({
                profileDir: userDataDir,
                chromePath: config.chromePath,
                logger,
                protectedState: false,
                lockHeld: true,
              }).catch(() => null);
              if (
                !maintenance ||
                maintenance.action === "block-human-action" ||
                maintenance.action === "preserve-protected" ||
                maintenance.termination?.status === "blocked" ||
                maintenance.termination?.status === "failed"
              ) {
                keepBrowserOpen = true;
                logger(
                  "[browser] Dedicated Chrome did not drain with verified ownership; leaving it available for recovery.",
                );
              } else {
                dedicatedChromeDrained = true;
              }
            }
          }
        } finally {
          await cleanupProfileLock?.release().catch(() => undefined);
        }
      };
      try {
        await handle.release({ onRelease });
      } catch (error) {
        reconcileNeeded = true;
        keepBrowserOpen = true;
        await emitRuntimeHint();
        const message = error instanceof Error ? error.message : String(error);
        logger(
          `[browser] Final tab cleanup failed; leaving Chrome running for reconciliation: ${message}`,
        );
      }
    }
    removeDialogHandler?.();
    removeTerminationHooks?.();
    if (!keepBrowserOpen) {
      if (!connectionClosedUnexpectedly) {
        try {
          if (!manualLogin || !dedicatedChromeDrained) {
            await chrome.kill();
          }
        } catch {
          // ignore kill failures
        }
      }
      if (manualLogin) {
        const shouldCleanup = await shouldCleanupManualLoginProfileState(
          userDataDir,
          logger.verbose ? logger : undefined,
          {
            connectionClosedUnexpectedly,
            host: chromeHost,
          },
        );
        if (shouldCleanup) {
          // Preserve the persistent dedicated profile, but clear stale reattach hints.
          await cleanupStaleProfileState(userDataDir, logger, { lockRemovalMode: "never" }).catch(
            () => undefined,
          );
        }
      } else {
        await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
      }
      if (!connectionClosedUnexpectedly) {
        const totalSeconds = (Date.now() - startedAt) / 1000;
        logger(`Cleanup ${runStatus} • ${totalSeconds.toFixed(1)}s total`);
      }
    } else {
      detachKeptChromeProcess(chrome);
      if (!connectionClosedUnexpectedly) {
        logger(`Chrome left running on port ${chrome.port} with profile ${userDataDir}`);
      }
    }
  }
}

const DEFAULT_DEBUG_PORT = 9222;

async function pickAvailableDebugPort(
  preferredPort: number,
  logger: BrowserLogger,
): Promise<number> {
  const start =
    Number.isFinite(preferredPort) && preferredPort > 0 ? preferredPort : DEFAULT_DEBUG_PORT;
  for (let offset = 0; offset < 10; offset++) {
    const candidate = start + offset;
    if (await isPortAvailable(candidate)) {
      return candidate;
    }
  }
  const fallback = await findEphemeralPort();
  logger(`DevTools ports ${start}-${start + 9} are occupied; falling back to ${fallback}.`);
  return fallback;
}

async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function findEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", (error) => {
      server.close();
      reject(error);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error("Failed to acquire ephemeral port")));
      }
    });
  });
}

async function waitForLogin({
  runtime,
  logger,
  appliedCookies,
  manualLogin,
  timeoutMs,
  profileDir,
  keepBrowser,
}: {
  runtime: ChromeClient["Runtime"];
  logger: BrowserLogger;
  appliedCookies: number;
  manualLogin: boolean;
  timeoutMs: number;
  profileDir?: string;
  keepBrowser?: boolean;
}): Promise<void> {
  if (!manualLogin) {
    await ensureLoggedIn(runtime, logger, { appliedCookies });
    return;
  }
  const waitMs = resolveManualLoginWaitMs(timeoutMs, Boolean(keepBrowser));
  const deadline = Date.now() + waitMs;
  let lastNotice = 0;
  while (Date.now() < deadline) {
    try {
      await ensureLoggedIn(runtime, logger, { appliedCookies });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const loginDetected = message?.toLowerCase().includes("login button");
      const sessionMissing = message?.toLowerCase().includes("session not detected");
      if (!loginDetected && !sessionMissing) {
        throw error;
      }
      const now = Date.now();
      if (now - lastNotice > 5000) {
        logger(
          "Manual login mode: please sign into chatgpt.com in the opened Chrome window; waiting for session to appear...",
        );
        lastNotice = now;
      }
      await delay(1000);
    }
  }
  const setupCommand = formatManualLoginSetupCommand(profileDir ?? defaultManualLoginProfileDir());
  throw new BrowserAutomationError(
    "Oracle needs you to complete the ChatGPT sign-in or verification in its dedicated browser. The review has not been sent.",
    {
      stage: "chatgpt-login",
      code: "dedicated-browser-login-required",
      promptSubmitted: false,
      externalDataSent: false,
      retrySafe: true,
      retryGuidance: "complete-sign-in",
      setupCommand,
    },
  );
}

async function maybeRecoverLongAssistantResponse({
  runtime,
  baselineTurns,
  answerText,
  answerMarkdown,
  logger,
  allowMarkdownUpdate,
  expectedConversationId,
}: {
  runtime: ChromeClient["Runtime"];
  baselineTurns: number | null;
  answerText: string;
  answerMarkdown: string;
  logger: BrowserLogger;
  allowMarkdownUpdate: boolean;
  expectedConversationId?: string;
}): Promise<{ answerText: string; answerMarkdown: string }> {
  // Learned: long streaming responses can still be rendering after initial capture.
  // Add a brief delay and re-poll to catch any additional content (#71).
  const capturedLength = answerText.trim().length;
  if (capturedLength <= 500) {
    return { answerText, answerMarkdown };
  }

  await delay(1500);
  let bestLength = capturedLength;
  let bestText = answerText;
  for (let i = 0; i < 5; i++) {
    const laterSnapshot = await readAssistantSnapshot(
      runtime,
      baselineTurns ?? undefined,
      expectedConversationId,
    ).catch(() => null);
    const laterText = typeof laterSnapshot?.text === "string" ? laterSnapshot.text.trim() : "";
    if (laterText.length > bestLength) {
      bestLength = laterText.length;
      bestText = laterText;
      await delay(800); // More content appeared, keep waiting
    } else {
      break; // Stable, stop polling
    }
  }
  if (bestLength > capturedLength) {
    logger(`Recovered ${bestLength - capturedLength} additional chars via delayed re-read`);
    return {
      answerText: bestText,
      answerMarkdown: allowMarkdownUpdate ? bestText : answerMarkdown,
    };
  }
  return { answerText, answerMarkdown };
}

async function _assertNavigatedToHttp(
  runtime: ChromeClient["Runtime"],
  _logger: BrowserLogger,
  timeoutMs = 10_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastUrl = "";
  while (Date.now() < deadline) {
    const { result } = await runtime.evaluate({
      expression: 'typeof location === "object" && location.href ? location.href : ""',
      returnByValue: true,
    });
    const url = typeof result?.value === "string" ? result.value : "";
    lastUrl = url;
    if (/^https?:\/\//i.test(url)) {
      return url;
    }
    await delay(250);
  }
  throw new BrowserAutomationError("ChatGPT session not detected; page never left new tab.", {
    stage: "execute-browser",
    details: { url: lastUrl || "(empty)" },
  });
}

export type BrowserChrome = LaunchedChrome & { host?: string };

function detachKeptChromeProcess(chrome: Pick<LaunchedChrome, "process">): void {
  try {
    chrome.process?.unref();
  } catch {
    // Best-effort only; cleanup should not mask the original browser result.
  }
}

export async function acquireManualLoginChromeForRun(
  userDataDir: string,
  config: ReturnType<typeof resolveBrowserConfig>,
  logger: BrowserLogger,
  sessionId?: string,
  deps: Parameters<typeof acquireDedicatedChromeForRun>[1] = {},
  currentLeaseId?: string,
): Promise<{
  chrome: BrowserChrome;
  reusedChrome: LaunchedChrome | null;
  bootstrap: DedicatedChromeBootstrapOutcome;
}> {
  return acquireDedicatedChromeForRun(
    { profileDir: userDataDir, config, logger, sessionId, currentLeaseId },
    deps,
  );
}

async function runRemoteBrowserMode(
  promptText: string,
  attachments: BrowserAttachment[],
  config: ReturnType<typeof resolveBrowserConfig>,
  logger: BrowserLogger,
  options: BrowserRunOptions,
): Promise<BrowserRunResult> {
  const remoteChromeConfig = config.remoteChrome;
  if (!remoteChromeConfig) {
    throw new Error(
      "Remote Chrome configuration missing. Pass --remote-chrome <host:port> to use this mode.",
    );
  }
  const { host, port } = remoteChromeConfig;
  logger(`Connecting to remote Chrome at ${host}:${port}`);

  let client: ChromeClient | null = null;
  let remoteTargetId: string | null = null;
  let tabLease: BrowserTabLease | null = null;
  let lastUrl: string | undefined;
  let promptSubmitted = false;
  const proTimingRequired = requiresProResponseTiming(config);
  let proTimingRuntime: BrowserRuntimeMetadata = {};
  let modelSelectionEvidence: BrowserModelSelectionEvidence | undefined;
  let attachedExistingTab = false;
  let ownsTarget = true;
  let conversationUrlMonitor: ConversationUrlMonitor | null = null;
  let committedPromptIdentity: CommittedPromptIdentity | null = null;
  const authoritativeConversationUrl = (): string | undefined =>
    conversationUrlMonitor?.boundConversationUrl() ??
    (isConversationUrl(config.resumeConversationUrl ?? "")
      ? (config.resumeConversationUrl ?? undefined)
      : lastUrl);
  const authoritativeConversationId = () =>
    conversationUrlMonitor?.boundConversationId() ??
    extractConversationIdFromUrl(authoritativeConversationUrl() ?? "");
  const runtimeHintCb = options.runtimeHintCb;
  const emitRuntimeHint = async () => {
    if (!runtimeHintCb) return;
    try {
      await runtimeHintCb(
        {
          browserTransport: "cdp" as const,
          chromePort: port,
          chromeHost: host,
          chromeBrowserWSEndpoint: browserWSEndpoint,
          chromeProfileRoot,
          chromeTargetId: remoteTargetId ?? undefined,
          tabUrl: authoritativeConversationUrl(),
          conversationId: authoritativeConversationId(),
          promptSubmitted,
          controllerPid: process.pid,
          ...proTimingRuntime,
        },
        modelSelectionEvidence,
      );
      await tabLease?.update({
        chromeHost: host,
        chromePort: port,
        chromeTargetId: remoteTargetId ?? undefined,
        tabUrl: authoritativeConversationUrl(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger(`Failed to persist runtime hint: ${message}`);
    }
  };
  const markPromptDispatched = async (): Promise<void> => {
    if (proTimingRequired) {
      proTimingRuntime = markProPromptDispatched(proTimingRuntime);
    }
    await emitRuntimeHint();
  };
  const markPromptCommitted = async (
    _committedTurns: number | null,
    committedUserTurnIndex: number | null,
    committedPrompt: string,
  ): Promise<void> => {
    if (proTimingRequired) {
      proTimingRuntime = markProPromptCommitted(proTimingRuntime, committedUserTurnIndex);
    }
    const firstPrompt = !promptSubmitted;
    if (
      firstPrompt &&
      typeof committedUserTurnIndex === "number" &&
      Number.isSafeInteger(committedUserTurnIndex) &&
      committedUserTurnIndex >= 0
    ) {
      committedPromptIdentity = {
        committedUserTurnIndex,
        promptSha256: hashProPromptIdentity(committedPrompt),
      };
    }
    promptSubmitted = true;
    await emitRuntimeHint();
  };
  const startedAt = Date.now();
  let answerText = "";
  let answerMarkdown = "";
  let answerHtml = "";
  let connectionClosedUnexpectedly = false;
  let runStatus: "attempted" | "complete" = "attempted";
  let stopThinkingMonitor: (() => void) | null = null;
  let removeDialogHandler: (() => void) | null = null;
  let connection: Awaited<ReturnType<typeof connectToRemoteChrome>> | null = null;
  const browserWSEndpoint = config.remoteChromeBrowserWSEndpoint ?? undefined;
  const chromeProfileRoot = config.remoteChromeProfileRoot ?? undefined;
  const recordResponseTiming = (answer: string, capturedAt = new Date()): void => {
    if (!proTimingRequired) return;
    const timedRuntime = completeProResponseTimingTurn({
      answer,
      runtime: {
        browserTransport: "cdp",
        chromePort: port,
        chromeHost: host,
        chromeBrowserWSEndpoint: browserWSEndpoint,
        chromeProfileRoot,
        chromeTargetId: remoteTargetId ?? undefined,
        tabUrl: authoritativeConversationUrl(),
        conversationId: authoritativeConversationId(),
        promptSubmitted,
        controllerPid: process.pid,
        ...proTimingRuntime,
      },
      capturedAt,
    });
    proTimingRuntime = pickProTimingRuntime(timedRuntime);
  };

  try {
    const remoteLeaseProfileDir = config.browserTabRef
      ? null
      : resolveRemoteTabLeaseProfileDir(config);
    if (remoteLeaseProfileDir) {
      await ensureDedicatedBrowserProfileDirectory(remoteLeaseProfileDir);
      tabLease = await acquireBrowserTabLease(remoteLeaseProfileDir, {
        maxConcurrentTabs: config.maxConcurrentTabs,
        timeoutMs: config.timeoutMs,
        logger,
        sessionId: options.sessionId,
        chromeHost: host,
        chromePort: port,
        ownerKind: "chatgpt",
        purpose: "remote-browser-run",
      });
    }
    if (config.browserTabRef) {
      const attached = await connectToExistingChatGptTab({
        host,
        port,
        ref: config.browserTabRef,
      });
      client = attached.client;
      remoteTargetId = attached.targetId ?? null;
      lastUrl = attached.tab.url || lastUrl;
      attachedExistingTab = true;
      ownsTarget = false;
      logger(
        `Attached to existing remote ChatGPT tab ${attached.targetId}${attached.tab.url ? ` (${attached.tab.url})` : ""}`,
      );
    } else {
      connection = await connectToRemoteChrome(
        host,
        port,
        logger,
        "about:blank",
        browserWSEndpoint,
        {
          approvalWaitMs: config.attachRunning && browserWSEndpoint ? 20_000 : undefined,
        },
      );
      client = connection.client;
      remoteTargetId = connection.targetId ?? null;
      ownsTarget = true;
    }
    if (tabLease && remoteTargetId) {
      await tabLease.update({
        chromeHost: host,
        chromePort: port,
        chromeTargetId: remoteTargetId,
        ownsTarget,
      });
    }
    await emitRuntimeHint();
    const markConnectionLost = () => {
      connectionClosedUnexpectedly = true;
    };
    client.on("disconnect", markConnectionLost);
    const { Network, Page, Runtime, Input, DOM, Target } = client;

    const domainEnablers = [Network.enable({}), Page.enable(), Runtime.enable()];
    if (DOM && typeof DOM.enable === "function") {
      domainEnablers.push(DOM.enable());
    }
    await Promise.all(domainEnablers);
    removeDialogHandler = installJavaScriptDialogAutoDismissal(Page, logger);
    await enableFocusEmulation(client, logger, "remote target");

    const activeConversationUrlMonitor = createConversationUrlMonitor({
      readUrl: async () => {
        const { result } = await Runtime.evaluate({
          expression: "location.href",
          returnByValue: true,
        });
        return typeof result?.value === "string" ? result.value : null;
      },
      persistUrl: async (url) => {
        lastUrl = url;
        await emitRuntimeHint();
      },
      logger,
      initialConversationUrl:
        config.resumeConversationUrl && isConversationUrl(config.resumeConversationUrl)
          ? config.resumeConversationUrl
          : lastUrl && isConversationUrl(lastUrl)
            ? lastUrl
            : undefined,
      validateCandidate: async () =>
        committedPromptIdentity
          ? readCommittedPromptIdentityStatus(Runtime, committedPromptIdentity)
          : "pending",
      watchAfterBind: true,
    });
    conversationUrlMonitor = activeConversationUrlMonitor;
    const requireConversationIdentity = async (
      label: string,
      timeoutMs = 15_000,
    ): Promise<string> => {
      const verified = await activeConversationUrlMonitor.update(label, timeoutMs);
      const conversationId = activeConversationUrlMonitor.boundConversationId();
      if (!verified || !conversationId) {
        throw new BrowserAutomationError(
          "Oracle could not verify which ChatGPT conversation owns the submitted review. The review was sent; recover this session instead of submitting it again.",
          {
            stage: "conversation-identity",
            code: "conversation-id-unbound",
            promptSubmitted,
            // Distinguishes "the route never changed" from "it changed but the
            // committed turn stayed pending" from "the page could not be read".
            diagnostics: activeConversationUrlMonitor.snapshot(),
          },
        );
      }
      return conversationId;
    };

    // Skip cookie sync for remote Chrome - it already has cookies
    logger("Skipping cookie sync for remote Chrome (using existing session)");
    // Cookie cleanup is browser-global. Without a lease scope that proves sole
    // ownership of this remote browser (attached tab, or no manual-login
    // profile), the optional cleanup is skipped rather than risked.
    const skipRemoteStaleCookieCleanup =
      !remoteLeaseProfileDir ||
      !tabLease ||
      (await shouldSkipStaleConversationCookieCleanup(() =>
        hasOtherActiveBrowserTabLeases(remoteLeaseProfileDir, tabLease!.id),
      ));
    if (skipRemoteStaleCookieCleanup) {
      logger(
        "[cookies] Skipping stale ChatGPT conversation-cookie cleanup: sole ownership of the remote browser profile was not established.",
      );
    } else {
      await clearStaleChatGptConversationCookies(Network, Target, logger, {
        preserveConversationIds: [
          extractConversationIdFromUrl(config.resumeConversationUrl ?? ""),
          extractConversationIdFromUrl(lastUrl ?? ""),
        ],
      });
    }

    if (config.resumeConversationUrl) {
      await navigateToChatGPT(Page, Runtime, config.resumeConversationUrl, logger);
    } else if (!attachedExistingTab) {
      await navigateToChatGPT(Page, Runtime, config.url, logger);
    }
    await ensureNotBlocked(Runtime, config.headless, logger);
    await ensureLoggedIn(Runtime, logger, { remoteSession: true });
    await ensurePromptReady(Runtime, config.inputTimeoutMs, logger);
    if (config.resumeConversationUrl) {
      await waitForResumedConversationHydration(Runtime, config.inputTimeoutMs, logger, {
        requirePriorTurns: true,
        expectedConversationUrl: config.resumeConversationUrl,
      });
    }
    const chatMode = await ensureChatMode(Runtime, Input, config.inputTimeoutMs, logger, {
      assumeChatWhenUnresolved: Boolean(config.resumeConversationUrl),
      resetWorkConversation:
        attachedExistingTab && !config.resumeConversationUrl
          ? async () => {
              await navigateToChatGPT(Page, Runtime, config.url, logger);
              await ensureNotBlocked(Runtime, config.headless, logger);
              await ensurePromptReady(Runtime, config.inputTimeoutMs, logger);
            }
          : undefined,
    });
    if (chatMode === "switched") {
      await ensurePromptReady(Runtime, config.inputTimeoutMs, logger);
    }
    logger(
      `Prompt textarea ready (initial focus, ${promptText.length.toLocaleString()} chars queued)`,
    );
    try {
      const { result } = await Runtime.evaluate({
        expression: "location.href",
        returnByValue: true,
      });
      if (typeof result?.value === "string") {
        lastUrl = result.value;
      }
      await emitRuntimeHint();
    } catch {
      // ignore
    }

    const modelStrategy = config.modelStrategy ?? DEFAULT_MODEL_STRATEGY;
    if (config.desiredModel && modelStrategy !== "ignore" && !config.resumeConversationUrl) {
      modelSelectionEvidence = await ensureModelSelectionWithTargetRepair({
        select: () =>
          ensureModelSelection(Runtime, config.desiredModel as string, logger, modelStrategy),
        repair: async () => {
          await navigateToChatGPT(Page, Runtime, config.url, logger);
          await ensureNotBlocked(Runtime, config.headless, logger);
          await ensureLoggedIn(Runtime, logger, { remoteSession: true });
          await ensurePromptReady(Runtime, config.inputTimeoutMs, logger);
        },
        canRepair: !attachedExistingTab,
        logger,
      });
      await ensurePromptReady(Runtime, config.inputTimeoutMs, logger);
      logger(
        `Prompt textarea ready (after model switch, ${promptText.length.toLocaleString()} chars queued)`,
      );
    } else if (modelStrategy === "ignore" || config.resumeConversationUrl) {
      modelSelectionEvidence = buildSkippedModelSelectionEvidence(
        config.desiredModel,
        modelStrategy,
      );
      logger(
        config.resumeConversationUrl
          ? "Model picker: skipped (resumed conversation)"
          : "Model picker: skipped (strategy=ignore)",
      );
    }
    const deepResearch = config.researchMode === "deep";
    // Handle thinking time selection if specified. Deep Research owns its own effort flow.
    const thinkingTime = config.thinkingTime;
    if (thinkingTime && !deepResearch) {
      const thinkingTargetModel = modelStrategy === "select" ? config.desiredModel : null;
      await withRetries(
        () => ensureThinkingTime(Runtime, thinkingTime, logger, thinkingTargetModel),
        {
          retries: 2,
          delayMs: 300,
          onRetry: (attempt, error) => {
            if (options.verbose) {
              logger(
                `[retry] Thinking time (${thinkingTime}) attempt ${attempt + 1}: ${error instanceof Error ? error.message : error}`,
              );
            }
          },
        },
      );
    }
    const submitOnce = async (prompt: string, submissionAttachments: BrowserAttachment[]) => {
      if (proTimingRequired) {
        proTimingRuntime = beginProResponseTimingTurn(proTimingRuntime, {
          inputTokens: estimateTokenCount(prompt),
          attachmentBytes: await resolveProAttachmentBytes(submissionAttachments),
          prompt,
        });
      }
      const baselineSnapshot = await readAssistantSnapshot(Runtime).catch(() => null);
      const baselineAssistantText =
        typeof baselineSnapshot?.text === "string" ? baselineSnapshot.text.trim() : "";
      const attachmentNames = submissionAttachments.map((a) => path.basename(a.path));
      const attachmentExpectations = submissionAttachments.map((a) => ({
        name: path.basename(a.path),
        generatedBundle: a.generatedBundle === true,
      }));
      await clearPromptComposer(Runtime, logger);
      await ensurePromptReady(Runtime, config.inputTimeoutMs, logger);
      if (submissionAttachments.length > 0) {
        if (!DOM) {
          throw new Error("Chrome DOM domain unavailable while uploading attachments.");
        }
        await clearComposerAttachments(Runtime, 5_000, logger);
        // Use remote file transfer for remote Chrome (reads local files and injects via CDP)
        for (const attachment of submissionAttachments) {
          logger(`Uploading attachment: ${attachment.displayPath}`);
          await uploadAttachmentViaDataTransfer({ runtime: Runtime, dom: DOM }, attachment, logger);
          await delay(500);
        }
        // Scale timeout based on number of files: base 30s + 15s per additional file
        const baseTimeout = config.inputTimeoutMs ?? 30_000;
        const perFileTimeout = 15_000;
        const waitBudget =
          Math.max(baseTimeout, 30_000) + (submissionAttachments.length - 1) * perFileTimeout;
        const attachmentWaitBudget = Math.max(config.attachmentTimeoutMs ?? 0, waitBudget);
        await waitForAttachmentCompletion(Runtime, attachmentWaitBudget, attachmentNames, logger);
        logger("All attachments uploaded");
      }
      if (deepResearch) {
        await withRetries(() => activateDeepResearch(Runtime, Input, logger), {
          retries: 2,
          delayMs: 500,
          onRetry: (attempt, error) => {
            if (options.verbose) {
              logger(
                `[retry] Deep Research activation attempt ${attempt + 1}: ${error instanceof Error ? error.message : error}`,
              );
            }
          },
        });
        await ensurePromptReady(Runtime, config.inputTimeoutMs, logger);
        logger(
          `Prompt textarea ready (after Deep Research activation, ${prompt.length.toLocaleString()} chars queued)`,
        );
      }
      let baselineTurns = await readConversationTurnCount(Runtime, logger);
      const submissionTargetId = remoteTargetId;
      const isSubmissionOwner = async (): Promise<boolean> => {
        if (!submissionTargetId || remoteTargetId !== submissionTargetId) return false;
        const { targetInfo } = await Target.getTargetInfo({ targetId: submissionTargetId });
        return targetInfo.targetId === submissionTargetId && targetInfo.type === "page";
      };
      const providerState: Record<string, unknown> = {
        runtime: Runtime,
        input: Input,
        logger,
        timeoutMs: config.timeoutMs,
        inputTimeoutMs: config.inputTimeoutMs ?? undefined,
        attachmentTimeoutMs: config.attachmentTimeoutMs ?? undefined,
        baselineTurns: baselineTurns ?? undefined,
        attachmentNames: attachmentExpectations,
        onPromptDispatched: markPromptDispatched,
        onPromptCommitted: (committedTurns: number | null, committedUserTurnIndex: number | null) =>
          markPromptCommitted(committedTurns, committedUserTurnIndex, prompt),
        onPromptCommitPending: () =>
          throwChatGptUiWarningIfPresent({
            Runtime,
            logger,
            runtime: {
              browserTransport: "cdp" as const,
              chromePort: port,
              chromeHost: host,
              chromeBrowserWSEndpoint: browserWSEndpoint,
              chromeProfileRoot,
              chromeTargetId: remoteTargetId ?? undefined,
              tabUrl: authoritativeConversationUrl(),
              conversationId: lastUrl ? extractConversationIdFromUrl(lastUrl) : undefined,
              promptSubmitted,
              controllerPid: process.pid,
              ...proTimingRuntime,
            },
            stage: "submit-prompt",
            waitTarget: "prompt commit",
            submissionCommitted: false,
            dispatchAttempted: true,
          }),
        isSubmissionOwner,
      };
      const deepResearchTargetBaseline =
        deepResearch && client
          ? await captureDeepResearchTargetBaseline(client, logger)
          : undefined;
      await throwChatGptUiWarningIfPresent({
        Runtime,
        logger,
        runtime: {
          browserTransport: "cdp" as const,
          chromePort: port,
          chromeHost: host,
          chromeBrowserWSEndpoint: browserWSEndpoint,
          chromeProfileRoot,
          chromeTargetId: remoteTargetId ?? undefined,
          tabUrl: lastUrl,
          conversationId: lastUrl ? extractConversationIdFromUrl(lastUrl) : undefined,
          promptSubmitted,
          controllerPid: process.pid,
          ...proTimingRuntime,
        },
        stage: "submit-prompt",
        waitTarget: "prompt dispatch",
        submissionCommitted: false,
        dispatchAttempted: false,
      });
      await runProviderSubmissionFlow(chatgptDomProvider, {
        prompt,
        evaluate: async () => undefined,
        delay,
        log: logger,
        state: providerState,
      });
      const providerBaselineTurns = providerState.baselineTurns;
      if (typeof providerBaselineTurns === "number" && Number.isFinite(providerBaselineTurns)) {
        baselineTurns = providerBaselineTurns;
      }
      return {
        baselineTurns,
        baselineAssistantText,
        deepResearchTargetKeys: deepResearchTargetBaseline?.targetKeys,
        deepResearchTargetBaselineCaptured: deepResearchTargetBaseline?.captured,
      };
    };
    const reloadPromptComposer = async () => {
      logger("[browser] Composer became unresponsive; reloading page and retrying once.");
      await Page.reload({ ignoreCache: true });
      await ensurePromptReady(Runtime, config.inputTimeoutMs, logger);
    };

    let baselineTurns: number | null = null;
    let baselineAssistantText: string | null = null;
    let deepResearchTargetKeys: string[] = [];
    let deepResearchTargetBaselineCaptured = false;
    const submission = await runSubmissionWithRecovery({
      prompt: promptText,
      attachments,
      fallbackSubmission: options.fallbackSubmission,
      submit: submitOnce,
      reloadPromptComposer,
      prepareFallbackSubmission: async () => {
        await clearPromptComposer(Runtime, logger);
        await ensurePromptReady(Runtime, config.inputTimeoutMs, logger);
      },
      logger,
    });
    baselineTurns = submission.baselineTurns;
    baselineAssistantText = submission.baselineAssistantText;
    deepResearchTargetKeys = submission.deepResearchTargetKeys ?? [];
    deepResearchTargetBaselineCaptured = submission.deepResearchTargetBaselineCaptured ?? false;
    const imageArtifactMinTurnIndex = baselineTurns;
    if (deepResearch) {
      await requireConversationIdentity("deep-research-wait");
      await waitForResearchPlanAutoConfirm(Runtime, logger);
      const researchResult = await activeConversationUrlMonitor.guard(() =>
        waitForDeepResearchCompletion(
          Runtime,
          logger,
          config.timeoutMs,
          baselineTurns,
          Page,
          client!,
          {
            ignoredTargetKeys: deepResearchTargetKeys,
            targetBaselineCaptured: deepResearchTargetBaselineCaptured,
          },
        ),
      );
      recordResponseTiming(researchResult.text);
      await emitRuntimeHint();
      await requireConversationIdentity("post-deep-research");
      const durationMs = Date.now() - startedAt;
      const tokens = estimateTokenCount(researchResult.text);
      const reportArtifact = await saveOptionalArtifact(
        () =>
          saveDeepResearchReportArtifact({
            sessionId: options.sessionId,
            reportMarkdown: researchResult.text,
            conversationUrl: authoritativeConversationUrl(),
            logger,
          }),
        logger,
      );
      const transcriptArtifact = await saveOptionalArtifact(
        () =>
          saveBrowserTranscriptArtifact({
            sessionId: options.sessionId,
            prompt: promptText,
            answerMarkdown: researchResult.text,
            conversationUrl: authoritativeConversationUrl(),
            artifacts: appendArtifacts(undefined, [reportArtifact]),
            logger,
          }),
        logger,
      );
      const savedArtifacts = appendArtifacts(undefined, [reportArtifact, transcriptArtifact]);
      runStatus = "complete";
      return {
        answerText: researchResult.text,
        answerMarkdown: researchResult.text,
        answerHtml: researchResult.html,
        artifacts: savedArtifacts,
        modelSelection: modelSelectionEvidence,
        tookMs: durationMs,
        answerTokens: tokens,
        answerChars: researchResult.text.length,
        browserTransport: "cdp",
        chromePort: port,
        chromeHost: host,
        chromeTargetId: remoteTargetId ?? undefined,
        tabUrl: authoritativeConversationUrl(),
        conversationId: authoritativeConversationId(),
        promptSubmitted,
        controllerPid: process.pid,
        ...proTimingRuntime,
      };
    }
    // Helper to normalize text for echo detection (collapse whitespace, lowercase)
    const normalizeForComparison = (text: string): string =>
      text.toLowerCase().replace(/\s+/g, " ").trim();
    const expectedConversationId = authoritativeConversationId;
    const waitForFreshAssistantResponse = async (baselineNormalized: string, timeoutMs: number) => {
      const baselinePrefix =
        baselineNormalized.length >= 80
          ? baselineNormalized.slice(0, Math.min(200, baselineNormalized.length))
          : "";
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const snapshot = await readAssistantSnapshot(
          Runtime,
          baselineTurns ?? undefined,
          expectedConversationId(),
        ).catch(() => null);
        const text = typeof snapshot?.text === "string" ? snapshot.text.trim() : "";
        if (text) {
          const normalized = normalizeForComparison(text);
          const isBaseline =
            normalized === baselineNormalized ||
            (baselinePrefix.length > 0 && normalized.startsWith(baselinePrefix));
          if (!isBaseline) {
            return {
              text,
              html: snapshot?.html ?? undefined,
              meta: {
                turnId: snapshot?.turnId ?? undefined,
                messageId: snapshot?.messageId ?? undefined,
              },
            };
          }
        }
        await delay(350);
      }
      return null;
    };
    const waitWithThinkingMonitor = async <T>(operation: () => Promise<T>): Promise<T> => {
      stopThinkingMonitor?.();
      stopThinkingMonitor = startThinkingStatusMonitor(Runtime, logger, {
        intervalMs: options.heartbeatIntervalMs,
        expectedConversationId: expectedConversationId(),
      });
      try {
        return await operation();
      } finally {
        stopThinkingMonitor?.();
        stopThinkingMonitor = null;
      }
    };
    const recheckDelayMs = Math.max(0, config.assistantRecheckDelayMs ?? 0);
    const recheckTimeoutMs = Math.max(0, config.assistantRecheckTimeoutMs ?? 0);
    const attemptAssistantRecheck = async () => {
      if (!recheckDelayMs) return null;
      logger(
        `[browser] Assistant response timed out; waiting ${formatElapsed(recheckDelayMs)} before rechecking conversation.`,
      );
      await delay(recheckDelayMs);
      await requireConversationIdentity("assistant-recheck");
      const conversationUrl = activeConversationUrlMonitor.boundConversationUrl();
      if (conversationUrl && isConversationUrl(conversationUrl)) {
        logger(`[browser] Rechecking assistant response at ${conversationUrl}`);
        await navigateToChatGPT(Page, Runtime, conversationUrl, logger);
        await waitForResumedConversationHydration(Runtime, recheckTimeoutMs || 30_000, logger, {
          requirePriorTurns: true,
          requirePromptReady: false,
          expectedConversationUrl: conversationUrl,
        });
      }
      // Validate session before attempting recheck - sessions can expire during the delay
      const sessionValid = await validateChatGPTSession(Runtime, logger);
      if (!sessionValid.valid) {
        logger(`[browser] Session validation failed: ${sessionValid.reason}`);
        // Update session metadata to indicate login is needed
        await emitRuntimeHint();
        throw new BrowserAutomationError(
          `ChatGPT session expired during recheck: ${sessionValid.reason}. ` +
            `Conversation URL: ${conversationUrl || lastUrl || "unknown"}. ` +
            `Please sign in and retry.`,
          {
            stage: "assistant-recheck",
            details: {
              conversationUrl: conversationUrl || lastUrl || null,
              sessionStatus: "needs_login",
              validationReason: sessionValid.reason,
            },
            runtime: {
              browserTransport: "cdp",
              chromeHost: host,
              chromePort: port,
              chromeBrowserWSEndpoint: browserWSEndpoint,
              chromeProfileRoot,
              chromeTargetId: remoteTargetId ?? undefined,
              tabUrl: conversationUrl ?? lastUrl,
              conversationId: authoritativeConversationId(),
              promptSubmitted,
              controllerPid: process.pid,
              ...proTimingRuntime,
            },
          },
        );
      }
      await emitRuntimeHint();
      const timeoutMs = recheckTimeoutMs > 0 ? recheckTimeoutMs : config.timeoutMs;
      const rechecked = await waitWithThinkingMonitor(() =>
        waitForAssistantOrGeneratedImageResponse({
          Runtime,
          waitForText: () =>
            waitForAssistantResponseWithReload(
              Runtime,
              Page,
              timeoutMs,
              logger,
              baselineTurns ?? undefined,
              expectedConversationId(),
            ),
          timeoutMs,
          logger,
          minTurnIndex: baselineTurns ?? undefined,
          expectedConversationId: expectedConversationId(),
          imageOutputRequested,
        }),
      );
      logger("Recovered assistant response after delayed recheck");
      return rechecked;
    };
    const imageOutputRequested = Boolean(
      options.generateImagePath ||
      options.outputPath ||
      (options as { generateImage?: string }).generateImage,
    );
    const captureAssistantTurn = async (
      turnPrompt: string,
      label: string,
    ): Promise<BrowserConversationTurn & { answerHtml: string }> => {
      let turnAnswer: AssistantAnswer;
      try {
        await requireConversationIdentity("assistant-wait");
        turnAnswer = await activeConversationUrlMonitor.guard(() =>
          waitWithThinkingMonitor(() =>
            waitForAssistantOrGeneratedImageResponse({
              Runtime,
              waitForText: () =>
                waitForAssistantResponseWithReload(
                  Runtime,
                  Page,
                  config.timeoutMs,
                  logger,
                  baselineTurns ?? undefined,
                  expectedConversationId(),
                ),
              timeoutMs: config.timeoutMs,
              logger,
              minTurnIndex: baselineTurns ?? undefined,
              expectedConversationId: expectedConversationId(),
              imageOutputRequested,
            }),
          ),
        );
      } catch (error) {
        if (isAssistantResponseTimeoutError(error)) {
          const rechecked = await attemptAssistantRecheckOrRethrow(attemptAssistantRecheck);
          if (rechecked) {
            turnAnswer = rechecked;
          } else {
            await requireConversationIdentity("assistant-timeout");
            const diagnostics = await captureBrowserDiagnostics(
              Runtime,
              logger,
              "assistant-timeout",
              {
                Page,
                sessionId: options.sessionId,
              },
            ).catch(() => undefined);
            const runtime = {
              browserTransport: "cdp" as const,
              chromePort: port,
              chromeHost: host,
              chromeBrowserWSEndpoint: browserWSEndpoint,
              chromeProfileRoot,
              chromeTargetId: remoteTargetId ?? undefined,
              tabUrl: authoritativeConversationUrl(),
              conversationId: authoritativeConversationId(),
              promptSubmitted,
              controllerPid: process.pid,
              ...proTimingRuntime,
            };
            throw await createAssistantTimeoutError({
              Runtime,
              logger,
              runtime,
              diagnostics,
              cause: error,
            });
          }
        } else {
          throw error;
        }
      }
      await requireConversationIdentity("post-response");
      const baselineNormalized = baselineAssistantText
        ? normalizeForComparison(baselineAssistantText)
        : "";
      if (baselineNormalized) {
        const normalizedAnswer = normalizeForComparison(turnAnswer.text ?? "");
        const baselinePrefix =
          baselineNormalized.length >= 80
            ? baselineNormalized.slice(0, Math.min(200, baselineNormalized.length))
            : "";
        const isBaseline =
          normalizedAnswer === baselineNormalized ||
          (baselinePrefix.length > 0 && normalizedAnswer.startsWith(baselinePrefix));
        if (isBaseline) {
          logger("Detected stale assistant response; waiting for new response...");
          const refreshed = await waitForFreshAssistantResponse(baselineNormalized, 15_000);
          if (refreshed) {
            turnAnswer = refreshed;
          }
        }
      }
      let turnAnswerText = turnAnswer.text;
      const turnAnswerHtml = turnAnswer.html ?? "";

      const copiedMarkdown = await withRetries(
        async () => {
          const attempt = await captureAssistantMarkdown(
            Runtime,
            turnAnswer.meta,
            logger,
            expectedConversationId(),
          );
          if (!attempt) {
            throw new Error("copy-missing");
          }
          return attempt;
        },
        {
          retries: 2,
          delayMs: 350,
          onRetry: (attempt, error) => {
            if (options.verbose) {
              logger(
                `[retry] Markdown capture attempt ${attempt + 1}: ${error instanceof Error ? error.message : error}`,
              );
            }
          },
        },
      ).catch((error) => {
        if (
          error instanceof BrowserAutomationError &&
          (error.details as { stage?: string } | undefined)?.stage === "conversation-identity"
        ) {
          throw error;
        }
        return null;
      });

      let turnAnswerMarkdown = copiedMarkdown ?? turnAnswerText;
      ({ answerText: turnAnswerText, answerMarkdown: turnAnswerMarkdown } =
        await maybeRecoverLongAssistantResponse({
          runtime: Runtime,
          baselineTurns,
          answerText: turnAnswerText,
          answerMarkdown: turnAnswerMarkdown,
          logger,
          allowMarkdownUpdate: !copiedMarkdown,
          expectedConversationId: expectedConversationId(),
        }));

      // Final sanity check: ensure we didn't accidentally capture the user prompt instead of the assistant turn.
      const finalSnapshot = await readAssistantSnapshot(
        Runtime,
        baselineTurns ?? undefined,
        expectedConversationId(),
      ).catch(() => null);
      const finalText = typeof finalSnapshot?.text === "string" ? finalSnapshot.text.trim() : "";
      if (
        finalText &&
        finalText !== turnAnswerMarkdown.trim() &&
        finalText !== turnPrompt.trim() &&
        finalText.length >= turnAnswerMarkdown.trim().length
      ) {
        logger("Refreshed assistant response via final DOM snapshot");
        turnAnswerText = finalText;
        turnAnswerMarkdown = finalText;
      }

      // Detect prompt echo using normalized comparison (whitespace-insensitive).
      const promptEchoMatcher = buildPromptEchoMatcher(turnPrompt);
      const alignedEcho = alignPromptEchoPair(
        turnAnswerText,
        turnAnswerMarkdown,
        promptEchoMatcher,
        copiedMarkdown ? logger : undefined,
        {
          text: "Aligned assistant response text to copied markdown after prompt echo",
          markdown: "Aligned assistant markdown to response text after prompt echo",
        },
      );
      turnAnswerText = alignedEcho.answerText;
      turnAnswerMarkdown = alignedEcho.answerMarkdown;
      const isPromptEcho = alignedEcho.isEcho;
      if (isPromptEcho) {
        logger("Detected prompt echo in response; waiting for actual assistant response...");
        const deadline = Date.now() + 15_000;
        let bestText: string | null = null;
        let stableCount = 0;
        while (Date.now() < deadline) {
          const snapshot = await readAssistantSnapshot(
            Runtime,
            baselineTurns ?? undefined,
            expectedConversationId(),
          ).catch(() => null);
          const text = typeof snapshot?.text === "string" ? snapshot.text.trim() : "";
          const isStillEcho = !text || Boolean(promptEchoMatcher?.isEcho(text));
          if (!isStillEcho) {
            if (!bestText || text.length > bestText.length) {
              bestText = text;
              stableCount = 0;
            } else if (text === bestText) {
              stableCount += 1;
            }
            if (stableCount >= 2) {
              break;
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
        if (bestText) {
          logger("Recovered assistant response after detecting prompt echo");
          turnAnswerText = bestText;
          turnAnswerMarkdown = bestText;
        }
      }
      return {
        label,
        answerText: turnAnswerText,
        answerMarkdown: turnAnswerMarkdown,
        answerHtml: turnAnswerHtml,
      };
    };

    const followUpPrompts = normalizeBrowserFollowUpPrompts(options.followUpPrompts);
    const turns: BrowserConversationTurn[] = [];
    const initialTurn = await captureAssistantTurn(promptText, "Initial response");
    recordResponseTiming(initialTurn.answerMarkdown || initialTurn.answerText);
    await emitRuntimeHint();
    turns.push(initialTurn);
    answerText = initialTurn.answerText;
    answerMarkdown = initialTurn.answerMarkdown;
    answerHtml = initialTurn.answerHtml;

    for (let index = 0; index < followUpPrompts.length; index += 1) {
      const followUpPrompt = followUpPrompts[index];
      logger(`[browser] Sending follow-up ${index + 1}/${followUpPrompts.length}`);
      await requireConversationIdentity(`follow-up-${index + 1}-owner`);
      await clearPromptComposer(Runtime, logger);
      await ensurePromptReady(Runtime, config.inputTimeoutMs, logger);
      const submission = await runSubmissionWithRecovery({
        prompt: followUpPrompt,
        attachments: [],
        submit: submitOnce,
        reloadPromptComposer,
        prepareFallbackSubmission: async () => {
          await clearPromptComposer(Runtime, logger);
          await ensurePromptReady(Runtime, config.inputTimeoutMs, logger);
        },
        logger,
      });
      baselineTurns = submission.baselineTurns;
      baselineAssistantText = submission.baselineAssistantText;
      const turn = await captureAssistantTurn(followUpPrompt, `Follow-up ${index + 1}`);
      recordResponseTiming(turn.answerMarkdown || turn.answerText);
      await emitRuntimeHint();
      turns.push({ ...turn, prompt: followUpPrompt });
      answerText = turn.answerText;
      answerMarkdown = turn.answerMarkdown;
      answerHtml = turn.answerHtml;
    }

    if (turns.length > 1) {
      const formatted = formatBrowserTurnTranscript(turns);
      answerText = formatted.answerText;
      answerMarkdown = formatted.answerMarkdown;
      answerHtml = "";
    }
    const canSaveBrowserDownloadsLocally = isLocalChromeHost(host);
    await requireConversationIdentity("artifact-capture");
    const imageArtifacts = await activeConversationUrlMonitor.guard(() =>
      collectGeneratedImageArtifacts({
        Browser: canSaveBrowserDownloadsLocally ? client!.Browser : undefined,
        Client: canSaveBrowserDownloadsLocally ? client! : undefined,
        Page: canSaveBrowserDownloadsLocally ? Page : undefined,
        Runtime,
        Network,
        logger,
        minTurnIndex: imageArtifactMinTurnIndex,
        sessionId: options.sessionId,
        generateImagePath: options.generateImagePath,
        outputPath: options.outputPath,
        answerText,
        waitTimeoutMs: options.config?.timeoutMs,
        checkBlockingUiWarning: () =>
          throwChatGptUiWarningIfPresent({
            Runtime,
            logger,
            stage: "image-artifact-wait",
            waitTarget: "generated image artifacts",
            runtime: {
              browserTransport: "cdp",
              chromePort: port,
              chromeHost: host,
              chromeBrowserWSEndpoint: browserWSEndpoint,
              chromeProfileRoot,
              chromeTargetId: remoteTargetId ?? undefined,
              tabUrl: authoritativeConversationUrl(),
              conversationId: authoritativeConversationId(),
              promptSubmitted,
              controllerPid: process.pid,
              ...proTimingRuntime,
            },
          }),
      }),
    );
    answerText = imageArtifacts.answerText || answerText;
    if (imageArtifacts.markdownSuffix) {
      answerMarkdown += imageArtifacts.markdownSuffix;
    }
    const fileArtifacts = await activeConversationUrlMonitor.guard(() =>
      collectChatGptFileArtifacts({
        Browser: client!.Browser,
        Client: client!,
        Page,
        Runtime,
        Network,
        answerText: [answerText, answerMarkdown, answerHtml].filter(Boolean).join("\n"),
        logger,
        minTurnIndex: imageArtifactMinTurnIndex,
        sessionId: options.sessionId,
      }),
    );
    const savedImageArtifacts = appendArtifacts(undefined, imageArtifacts.savedImages);
    const savedBrowserArtifacts = appendArtifacts(savedImageArtifacts, fileArtifacts.savedFiles);
    const transcriptArtifact = await saveOptionalArtifact(
      () =>
        saveBrowserTranscriptArtifact({
          sessionId: options.sessionId,
          prompt: promptText,
          answerMarkdown,
          conversationUrl: authoritativeConversationUrl(),
          artifacts: savedBrowserArtifacts,
          logger,
        }),
      logger,
    );
    const savedArtifacts = appendArtifacts(savedBrowserArtifacts, [transcriptArtifact]);
    const durationMs = Date.now() - startedAt;
    const answerChars = answerText.length;
    const answerTokens = estimateTokenCount(answerMarkdown);

    runStatus = "complete";
    return {
      answerText,
      answerMarkdown,
      answerHtml: answerHtml.length > 0 ? answerHtml : undefined,
      tookMs: durationMs,
      answerTokens,
      answerChars,
      browserTransport: "cdp",
      chromePid: undefined,
      chromePort: port,
      chromeHost: host,
      chromeBrowserWSEndpoint: browserWSEndpoint,
      chromeProfileRoot,
      userDataDir: undefined,
      chromeTargetId: remoteTargetId ?? undefined,
      tabUrl: authoritativeConversationUrl(),
      conversationId: authoritativeConversationId(),
      promptSubmitted,
      ...proTimingRuntime,
      artifacts: savedArtifacts,
      generatedImages: imageArtifacts.generatedImages,
      savedImages: imageArtifacts.savedImages,
      downloadableFiles: fileArtifacts.files,
      savedFiles: fileArtifacts.savedFiles,
      modelSelection: modelSelectionEvidence,
      controllerPid: process.pid,
    };
  } catch (error) {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    // An error can carry proof that a turn was sent even though the exact
    // commit callback never ran; the run-local flag must reflect it before any
    // classification or persistence below reads it.
    const errorDetails =
      normalizedError instanceof BrowserAutomationError
        ? (normalizedError.details as { promptSubmitted?: boolean } | undefined)
        : undefined;
    if (errorDetails?.promptSubmitted === true) {
      promptSubmitted = true;
    }
    const socketClosed = connectionClosedUnexpectedly || isWebSocketClosureError(normalizedError);
    connectionClosedUnexpectedly = connectionClosedUnexpectedly || socketClosed;

    if (!socketClosed) {
      logger(`Failed to complete ChatGPT run: ${normalizedError.message}`);
      if ((config.debug || process.env.CHATGPT_DEVTOOLS_TRACE === "1") && normalizedError.stack) {
        logger(normalizedError.stack);
      }
      throw normalizedError;
    }

    const liveness = await probeChromeTargetLiveness({
      host,
      port,
      targetId: remoteTargetId,
      browserWSEndpoint,
    });
    const recoverable = isRecoverableChromeDisconnect(liveness);
    throw new BrowserAutomationError(connectionLostUserMessage({ recoverable, remote: true }), {
      stage: "connection-lost",
      recoverableDisconnect: recoverable,
      disconnectCause: recoverable ? "cdp-client-disconnect" : "chrome-closed",
      runtime: {
        browserTransport: "cdp",
        chromeHost: host,
        chromePort: port,
        chromeBrowserWSEndpoint: browserWSEndpoint,
        chromeProfileRoot,
        chromeTargetId: remoteTargetId ?? undefined,
        tabUrl: authoritativeConversationUrl() ?? liveness.matchedUrl,
        conversationId:
          authoritativeConversationId() ??
          (liveness.matchedUrl ? extractConversationIdFromUrl(liveness.matchedUrl) : undefined),
        promptSubmitted,
        controllerPid: process.pid,
        ...proTimingRuntime,
      },
    });
  } finally {
    await conversationUrlMonitor?.stop();
    try {
      await closeRemoteConnectionAfterRun({
        connectionClosedUnexpectedly,
        connection,
        client,
        runStatus,
      });
    } catch {
      // ignore
    }
    removeDialogHandler?.();
    const keepRemoteBrowser = Boolean(config.keepBrowser);
    const shouldCloseOwnedRemoteTarget = shouldCloseOwnedRunTargetAfterRun({
      browserTurnState: runStatus === "complete" ? "terminal" : "active",
      ownsTarget,
      closeOwnedTabOnComplete: options.closeOwnedTabOnComplete,
    });
    const closeOwnedRemoteTarget = async () => {
      if (!shouldCloseOwnedRemoteTarget || !remoteTargetId) {
        return;
      }
      const safeToClose =
        !keepRemoteBrowser ||
        Boolean(await ensureChromePageTargetAfterClose(port, remoteTargetId, logger, host));
      if (!safeToClose) {
        logger(
          `[browser] Leaving completed remote browser tab open because Chrome has no replacement page target.`,
        );
        return;
      }
      const closeConfirmed = await closeTab(port, remoteTargetId, logger, host);
      if (!closeConfirmed && keepRemoteBrowser) {
        logger(`[browser] Remote tab close remains unconfirmed; no extra placeholder was opened.`);
      }
    };
    if (tabLease) {
      const handle = tabLease;
      tabLease = null;
      await handle
        .release({ onRelease: async () => closeOwnedRemoteTarget() })
        .catch(() => undefined);
    } else {
      await closeOwnedRemoteTarget();
    }
    // Don't kill remote Chrome - it's not ours to manage
    const totalSeconds = (Date.now() - startedAt) / 1000;
    logger(`Remote session complete • ${totalSeconds.toFixed(1)}s total`);
  }
}

export { estimateTokenCount } from "./utils.js";
export { resolveBrowserConfig, DEFAULT_BROWSER_CONFIG } from "./config.js";

// biome-ignore lint/style/useNamingConvention: test-only export used in vitest suite
export const __test__ = {
  assertManualLoginProfileReadyForRun,
  closeRemoteConnectionAfterRun,
  classifyChatGptUiWarningText,
  collectChatGptUiWarnings,
  createAssistantTimeoutError,
  createChatGptUiWarningError,
  detachKeptChromeProcess,
  formatManualLoginSetupCommand,
  isAssistantResponseTimeoutError,
  isManualLoginProfileInitialized,
  isImageOnlyUiChromeText,
  listIgnoredRemoteChromeFlags,
  normalizeAuthenticatedModelSelectionError,
  ensureModelSelectionWithTargetRepair,
  resolveAssistantReloadConversationUrl,
  resolveManualLoginWaitMs,
  shouldCloseOwnedRunTargetAfterRun,
  shouldKeepLocalBrowserOpen,
  waitForAssistantResponseWithReload,
};
export { syncCookies } from "./cookies.js";
export {
  navigateToChatGPT,
  ensureNotBlocked,
  ensurePromptReady,
  ensureModelSelection,
  submitPrompt,
  waitForAssistantResponse,
  captureAssistantMarkdown,
  uploadAttachmentFile,
  waitForAttachmentCompletion,
} from "./pageActions.js";

export async function acquireManualLoginChromeForRunForTest(
  userDataDir: string,
  config: ReturnType<typeof resolveBrowserConfig>,
  logger: BrowserLogger,
  sessionId: string | undefined,
  deps: Parameters<typeof acquireDedicatedChromeForRun>[1],
  currentLeaseId?: string,
): Promise<{ chrome: BrowserChrome; reusedChrome: LaunchedChrome | null }> {
  return acquireManualLoginChromeForRun(
    userDataDir,
    config,
    logger,
    sessionId,
    deps,
    currentLeaseId,
  );
}

export function isWebSocketClosureError(error: Error): boolean {
  const message = error.message.toLowerCase();
  return (
    message.includes("websocket connection closed") ||
    message.includes("websocket is closed") ||
    message.includes("websocket error") ||
    message.includes("inspected target navigated or closed") ||
    message.includes("target closed")
  );
}

async function waitForAssistantResponseWithReload(
  Runtime: ChromeClient["Runtime"],
  Page: ChromeClient["Page"],
  timeoutMs: number,
  logger: BrowserLogger,
  minTurnIndex?: number,
  expectedConversationId?: string,
) {
  try {
    return await waitForAssistantResponse(
      Runtime,
      timeoutMs,
      logger,
      minTurnIndex,
      expectedConversationId,
    );
  } catch (error) {
    if (!shouldReloadAfterAssistantError(error)) {
      throw error;
    }
    const observedConversationUrl = await readConversationUrl(Runtime);
    const conversationUrl = resolveAssistantReloadConversationUrl(
      observedConversationUrl,
      expectedConversationId,
    );
    if (!conversationUrl) {
      throw error;
    }
    logger("Assistant response stalled; reloading conversation and retrying once");
    await navigateToChatGPT(Page, Runtime, conversationUrl, logger);
    await waitForResumedConversationHydration(Runtime, timeoutMs, logger, {
      requirePriorTurns: true,
      requirePromptReady: false,
      expectedConversationUrl: conversationUrl,
    });
    return await waitForAssistantResponse(
      Runtime,
      timeoutMs,
      logger,
      minTurnIndex,
      expectedConversationId,
    );
  }
}

function resolveAssistantReloadConversationUrl(
  observedConversationUrl: string | null,
  expectedConversationId?: string,
): string | null {
  const observedConversationId = extractConversationIdFromUrl(observedConversationUrl ?? "");
  if (!expectedConversationId) {
    return observedConversationId && observedConversationUrl ? observedConversationUrl : null;
  }
  if (observedConversationId && observedConversationId !== expectedConversationId) {
    throw new BrowserAutomationError(
      "Oracle refused to reload a different ChatGPT conversation while capturing the submitted review.",
      {
        stage: "conversation-identity",
        code: "assistant-reload-conversation-mismatch",
        expectedConversationId,
        actualConversationId: observedConversationId,
        promptSubmitted: true,
      },
    );
  }
  if (observedConversationId === expectedConversationId && observedConversationUrl) {
    return observedConversationUrl;
  }
  return new URL(`/c/${encodeURIComponent(expectedConversationId)}`, CHATGPT_URL).toString();
}

function shouldReloadAfterAssistantError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("assistant-response") ||
    message.includes("watchdog") ||
    message.includes("timeout") ||
    message.includes("capture assistant response")
  );
}

function isAssistantResponseTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  if (!message) return false;
  return (
    message === "response timeout" ||
    message.includes("assistant-response") ||
    message.includes("assistant response") ||
    message.includes("watchdog") ||
    message.includes("capture assistant response")
  );
}

async function readConversationUrl(Runtime: ChromeClient["Runtime"]): Promise<string | null> {
  try {
    const currentUrl = await Runtime.evaluate({ expression: "location.href", returnByValue: true });
    return typeof currentUrl.result?.value === "string" ? currentUrl.result.value : null;
  } catch {
    return null;
  }
}

interface SessionValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Validates that the ChatGPT session is still active by checking for login CTAs
 * and textarea availability. Sessions can expire during long delays (e.g., recheck).
 *
 * @param Runtime - Chrome Runtime client
 * @param logger - Browser logger for diagnostics
 * @returns SessionValidationResult indicating if session is valid and reason if not
 */
async function validateChatGPTSession(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
): Promise<SessionValidationResult> {
  try {
    const outcome = await Runtime.evaluate({
      expression: buildSessionValidationExpression(),
      awaitPromise: true,
      returnByValue: true,
    });

    const result = outcome.result?.value as
      | {
          valid: boolean;
          hasLoginCta: boolean;
          hasTextarea: boolean;
          onAuthPage: boolean;
          pageUrl: string | null;
        }
      | undefined;

    if (!result) {
      return { valid: false, reason: "Failed to evaluate session state" };
    }

    if (result.onAuthPage) {
      return { valid: false, reason: "Redirected to auth page" };
    }

    if (result.hasLoginCta) {
      return { valid: false, reason: "Login button detected on page" };
    }

    if (!result.hasTextarea) {
      return { valid: false, reason: "Prompt textarea not available" };
    }

    return { valid: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(`[browser] Session validation error: ${message}`);
    return { valid: false, reason: `Validation error: ${message}` };
  }
}

function buildSessionValidationExpression(): string {
  const selectorLiteral = JSON.stringify(INPUT_SELECTORS);
  return `(async () => {
    const pageUrl = typeof location === 'object' && location?.href ? location.href : null;
    const onAuthPage =
      typeof location === 'object' &&
      typeof location.pathname === 'string' &&
      /^\\/(auth|login|signin)/i.test(location.pathname);

    // Check for login CTAs (similar to ensureLoggedIn logic)
    const hasLoginCta = (() => {
      const candidates = Array.from(
        document.querySelectorAll(
          [
            'a[href*="/auth/login"]',
            'a[href*="/auth/signin"]',
            'button[type="submit"]',
            'button[data-testid*="login"]',
            'button[data-testid*="log-in"]',
            'button[data-testid*="sign-in"]',
            'button[data-testid*="signin"]',
            'button',
            'a',
          ].join(','),
        ),
      );
      const textMatches = (text) => {
        if (!text) return false;
        const normalized = text.toLowerCase().trim();
        return ['log in', 'login', 'sign in', 'signin', 'continue with'].some((needle) =>
          normalized.startsWith(needle),
        );
      };
      for (const node of candidates) {
        if (!(node instanceof HTMLElement)) continue;
        const label =
          node.textContent?.trim() ||
          node.getAttribute('aria-label') ||
          node.getAttribute('title') ||
          '';
        if (textMatches(label)) {
          return true;
        }
      }
      return false;
    })();

    // Check for textarea availability
    const hasTextarea = (() => {
      const selectors = ${selectorLiteral};
      for (const selector of selectors) {
        const node = document.querySelector(selector);
        if (node) {
          return true;
        }
      }
      return false;
    })();

    return {
      valid: !onAuthPage && !hasLoginCta && hasTextarea,
      hasLoginCta,
      hasTextarea,
      onAuthPage,
      pageUrl,
    };
  })()`;
}

async function readConversationTurnCount(
  Runtime: ChromeClient["Runtime"],
  logger?: BrowserLogger,
): Promise<number | null> {
  const expression = buildConversationTurnCountExpression();
  const attempts = 4;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const { result } = await Runtime.evaluate({
        expression,
        returnByValue: true,
      });
      const raw = typeof result?.value === "number" ? result.value : Number(result?.value);
      if (!Number.isFinite(raw)) {
        throw new Error("Turn count not numeric");
      }
      return Math.max(0, Math.floor(raw));
    } catch (error) {
      if (attempt < attempts - 1) {
        await delay(150);
        continue;
      }
      if (logger?.verbose) {
        logger(
          `Failed to read conversation turn count: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return null;
    }
  }
  return null;
}

function describeDevtoolsFirewallHint(host: string, port: number): string | null {
  if (!isWsl()) return null;
  return [
    `DevTools port ${host}:${port} is blocked from WSL.`,
    "",
    "PowerShell (admin):",
    `New-NetFirewallRule -DisplayName 'Chrome DevTools ${port}' -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${port}`,
    "New-NetFirewallRule -DisplayName 'Chrome DevTools (chrome.exe)' -Direction Inbound -Action Allow -Program 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' -Protocol TCP",
    "",
    "Re-run the same oracle command after adding the rule.",
  ].join("\n");
}

function isWsl(): boolean {
  if (process.platform !== "linux") return false;
  if (process.env.WSL_DISTRO_NAME) return true;
  return os.release().toLowerCase().includes("microsoft");
}

async function resolveUserDataBaseDir(): Promise<string> {
  // On WSL, Chrome launched via Windows can choke on UNC paths; prefer a Windows-backed temp folder.
  if (isWsl()) {
    const candidates = [
      "/mnt/c/Users/Public/AppData/Local/Temp",
      "/mnt/c/Temp",
      "/mnt/c/Windows/Temp",
    ];
    for (const candidate of candidates) {
      try {
        await mkdir(candidate, { recursive: true });
        return candidate;
      } catch {
        // try next
      }
    }
  }
  const tmpDir = os.tmpdir();
  if (shouldPreferSystemTmpDir(process.platform, tmpDir, os.homedir())) {
    try {
      await mkdir("/tmp", { recursive: true });
      return "/tmp";
    } catch {
      // Fall back to the inherited tmpdir if /tmp is unavailable.
    }
  }
  return tmpDir;
}

function shouldPreferSystemTmpDir(
  platform: NodeJS.Platform,
  tmpDir: string,
  homeDir: string,
): boolean {
  if (platform !== "linux" || !tmpDir || !homeDir) return false;
  const relativeToHome = path.relative(homeDir, tmpDir);
  if (!relativeToHome || relativeToHome.startsWith("..") || path.isAbsolute(relativeToHome)) {
    return false;
  }
  const firstSegment = relativeToHome.split(path.sep, 1)[0];
  return Boolean(firstSegment?.startsWith("."));
}

export function shouldPreferSystemTmpDirForTest(
  platform: NodeJS.Platform,
  tmpDir: string,
  homeDir: string,
): boolean {
  return shouldPreferSystemTmpDir(platform, tmpDir, homeDir);
}
