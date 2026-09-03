import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import chalk from "chalk";
import { sessionStore } from "../sessionStore.js";
import type { SessionMetadata } from "../sessionStore.js";
import {
  collectChatGptTabs,
  DEFAULT_REMOTE_CHROME_HOST,
  DEFAULT_REMOTE_CHROME_PORT,
  extractConversationIdFromUrl,
  formatBrowserTabState,
  harvestChatGptTab,
  sessionMatchesTab,
  type ChatGptTabSummary,
} from "../browser/liveTabs.js";
import {
  isRecoveredConversationHarvestReady,
  recoverConversationTab,
  type RecoveredConversation,
} from "../browser/recoverConversation.js";
import { reconcileOwnedBrowserTargets } from "../browser/lifecycleReconciler.js";
import { resolveBrowserConfig } from "../browser/config.js";
import { resolveOutputPath } from "./writeOutputPath.js";
import { assertGenericSessionActionAllowed } from "../batch/sessionAuthority.js";

const LIVE_POLL_MS = 2000;
const DEFAULT_STALL_THRESHOLD_MS = 60_000;

function resolveProLiveTailCeilingMs(meta: SessionMetadata): number | null {
  const config = resolveBrowserConfig(meta.browser?.config);
  return config.thinkingTime === "pro" ? config.timeoutMs * 2 : null;
}

function deriveLiveTailState({
  harvested,
  unchangedMs,
  elapsedMs,
  stallThresholdMs,
  proActiveCeilingMs,
}: {
  harvested: ChatGptTabSummary;
  unchangedMs: number;
  elapsedMs: number;
  stallThresholdMs: number;
  proActiveCeilingMs: number | null;
}): "running" | "completed" | "stalled" | "detached" {
  if (harvested.stopExists) {
    if (proActiveCeilingMs !== null) {
      return elapsedMs >= proActiveCeilingMs ? "stalled" : "running";
    }
    return unchangedMs >= stallThresholdMs ? "stalled" : "running";
  }
  if (harvested.authenticated && harvested.lastMessageRole === "user") {
    // Answer pending with no Stop button: a Pro background job. Keep tailing
    // until the Pro ceiling; never report the previous turn's answer as done.
    if (proActiveCeilingMs !== null) {
      return elapsedMs >= proActiveCeilingMs ? "stalled" : "running";
    }
    return unchangedMs >= stallThresholdMs ? "stalled" : "running";
  }
  return harvested.authenticated ? "completed" : "detached";
}

function isRecoverableMissingTabError(message: string): boolean {
  return (
    message.includes("No ChatGPT tab matched") ||
    message.includes("No live ChatGPT tabs found") ||
    message.includes("ECONNREFUSED") ||
    message.includes("Could not connect")
  );
}

async function finishRecoveredChrome(
  recovered: RecoveredConversation | null,
  closeAfterRecover: boolean | undefined,
  disposition: "completed" | "recoverable",
): Promise<void> {
  if (!recovered) return;
  await recovered.finish(disposition, {
    ensureSentinel: disposition === "recoverable" || !closeAfterRecover,
  });
  if (!recovered.chrome) return;
  try {
    if (closeAfterRecover) {
      recovered.chrome.kill();
    } else {
      recovered.chrome.process?.unref?.();
    }
  } catch {
    // best-effort cleanup
  }
}

export interface BrowserHarvestOptions {
  writeOutputPath?: string;
  browserTabRef?: string;
  stallWindowMs?: number;
  quietOutput?: boolean;
  /**
   * When the live tab cannot be found, relaunch Chrome with the session's
   * persistent profile and navigate to the saved tab URL, then retry harvest.
   * Default: true.
   */
  recoverIfMissing?: boolean;
  /**
   * After a successful recovery harvest, close the relaunched Chrome.
   * Default: false (leave the recovered tab visible for the user).
   */
  closeAfterRecover?: boolean;
}

export interface BrowserLiveTailOptions {
  writeOutputPath?: string;
  browserTabRef?: string;
  stallThresholdMs?: number;
  /**
   * When no live tab matches the session's stored target, relaunch Chrome with
   * the persistent profile and navigate to the saved tab URL before tailing.
   * Default: true.
   */
  recoverIfMissing?: boolean;
  /**
   * After completion, close the relaunched Chrome.
   * Default: false (leave the recovered tab visible).
   */
  closeAfterRecover?: boolean;
}

function sessionBrowserEndpoint(
  meta: SessionMetadata | null | undefined,
): { host: string; port: number } | null {
  const runtime = meta?.browser?.runtime ?? {};
  const remote: { host?: string; port?: number } = meta?.browser?.config?.remoteChrome ?? {};
  const host = runtime.chromeHost ?? remote.host;
  const port = runtime.chromePort ?? remote.port;
  if (!host || !port) {
    return null;
  }
  return { host, port };
}

function collectUniqueEndpoints(metas: SessionMetadata[]): Array<{ host: string; port: number }> {
  const entries = new Map<string, { host: string; port: number }>();
  entries.set(`${DEFAULT_REMOTE_CHROME_HOST}:${DEFAULT_REMOTE_CHROME_PORT}`, {
    host: DEFAULT_REMOTE_CHROME_HOST,
    port: DEFAULT_REMOTE_CHROME_PORT,
  });
  for (const meta of metas) {
    const endpoint = sessionBrowserEndpoint(meta);
    if (!endpoint) {
      continue;
    }
    entries.set(`${endpoint.host}:${endpoint.port}`, endpoint);
  }
  return Array.from(entries.values());
}

function buildSessionIndex(metas: SessionMetadata[]): SessionMetadata[] {
  return metas
    .filter((meta) => meta?.mode === "browser")
    .sort((left, right) =>
      String(right.createdAt ?? "").localeCompare(String(left.createdAt ?? "")),
    );
}

function resolveLinkedSession(
  tab: ChatGptTabSummary,
  metas: SessionMetadata[],
): SessionMetadata | null {
  return buildSessionIndex(metas).find((meta) => sessionMatchesTab(meta, tab)) ?? null;
}

function snippet(text: string, max = 120): string {
  const normalized = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function resolveSessionTabRef(meta: SessionMetadata): string {
  const runtime = meta?.browser?.runtime ?? {};
  const harvest = meta?.browser?.harvest ?? {};
  return (
    harvest.url ??
    runtime.tabUrl ??
    harvest.conversationId ??
    runtime.conversationId ??
    harvest.targetId ??
    runtime.chromeTargetId ??
    "current"
  );
}

export function resolveSessionTabRefForTest(meta: SessionMetadata): string {
  return resolveSessionTabRef(meta);
}

async function persistHarvest(
  sessionId: string,
  harvested: ChatGptTabSummary,
): Promise<SessionMetadata | null> {
  const hash = createHash("sha1")
    .update(harvested.lastAssistantMarkdown ?? harvested.lastAssistantText ?? "")
    .digest("hex");
  return sessionStore.updateExistingSession(sessionId, (current) => ({
    ...current,
    browser: {
      ...(current.browser ?? {}),
      harvest: {
        targetId: harvested.targetId,
        url: harvested.url,
        conversationId: harvested.conversationId ?? extractConversationIdFromUrl(harvested.url),
        harvestedAt: new Date().toISOString(),
        assistantHash: hash,
        state: harvested.state,
        stopExists: harvested.stopExists,
        sendExists: harvested.sendExists,
        assistantCount: harvested.assistantCount,
        currentModelLabel: harvested.currentModelLabel,
        lastAssistantSnippet: harvested.lastAssistantSnippet,
      },
    },
  }));
}

interface CompletedOwnedHarvestDeps {
  readSession?: typeof sessionStore.readSession;
  updateExistingSession?: typeof sessionStore.updateExistingSession;
  reconcile?: typeof reconcileOwnedBrowserTargets;
}

function ownedCompletedRuntime(
  current: SessionMetadata,
  harvested: ChatGptTabSummary,
  endpoint: { host: string; port: number },
) {
  const runtime = current.browser?.runtime;
  if (
    !runtime?.userDataDir ||
    !runtime.chromeHost ||
    !runtime.chromePort ||
    !runtime.chromeTargetId ||
    runtime.chromeHost !== endpoint.host ||
    runtime.chromePort !== endpoint.port ||
    runtime.chromeTargetId !== harvested.targetId
  ) {
    return null;
  }
  const harvestedConversationId =
    harvested.conversationId ?? extractConversationIdFromUrl(harvested.url);
  if (runtime.conversationId && runtime.conversationId !== harvestedConversationId) {
    return null;
  }
  return runtime;
}

async function finishCompletedOwnedLiveHarvest(
  sessionId: string,
  harvested: ChatGptTabSummary,
  endpoint: { host: string; port: number },
  explicitBrowserTabRef: string | undefined,
  deps: CompletedOwnedHarvestDeps = {},
): Promise<boolean> {
  if (
    harvested.state !== "completed" ||
    !isRecoveredConversationHarvestReady(harvested) ||
    explicitBrowserTabRef
  ) {
    return false;
  }
  const readSession = deps.readSession ?? sessionStore.readSession.bind(sessionStore);
  const updateExistingSession =
    deps.updateExistingSession ?? sessionStore.updateExistingSession.bind(sessionStore);
  const reconcile = deps.reconcile ?? reconcileOwnedBrowserTargets;
  const current = await readSession(sessionId);
  if (!current || !ownedCompletedRuntime(current, harvested, endpoint)) return false;
  const terminalized = await updateExistingSession(sessionId, (live) => {
    const runtime = ownedCompletedRuntime(live, harvested, endpoint);
    if (!runtime) return null;
    return {
      ...live,
      browser: {
        ...live.browser,
        runtime: {
          ...runtime,
          browserDisposition: "completed" as const,
          recoveryKind: undefined,
          recoveryExpiresAt: undefined,
          reconcileNeeded: undefined,
        },
      },
    };
  });
  const runtime = terminalized?.browser?.runtime;
  if (!runtime?.userDataDir || !runtime.chromeTargetId) return false;

  try {
    const receipt = await reconcile({
      profileDir: runtime.userDataDir,
      host: endpoint.host,
      port: endpoint.port,
      logger: () => {},
      ensureSentinel: true,
    });
    if (
      receipt.status === "complete" &&
      (receipt.closedTargetIds.includes(runtime.chromeTargetId) ||
        !receipt.targetSnapshots[runtime.chromeTargetId])
    ) {
      return true;
    }
  } catch {
    // The terminal lifecycle state is already durable; cold-start reconciliation retries cleanup.
  }

  const afterFailure = await readSession(sessionId);
  if (!afterFailure || !ownedCompletedRuntime(afterFailure, harvested, endpoint)) {
    return false;
  }
  await updateExistingSession(sessionId, (live) => {
    const runtime = ownedCompletedRuntime(live, harvested, endpoint);
    return runtime
      ? {
          ...live,
          browser: {
            ...live.browser,
            runtime: {
              ...runtime,
              browserDisposition: "completed",
              recoveryKind: undefined,
              recoveryExpiresAt: undefined,
              reconcileNeeded: true,
            },
          },
        }
      : null;
  });
  return false;
}

function printHarvestSummary(sessionId: string, harvested: ChatGptTabSummary): void {
  console.log(chalk.bold(`Session: ${sessionId}`));
  console.log(`Target: ${harvested.targetId}`);
  console.log(`State: ${formatBrowserTabState(harvested)}`);
  console.log(`Model: ${harvested.currentModelLabel || "(unknown)"}`);
  console.log(`URL: ${harvested.url}`);
  console.log(`Assistant turns: ${harvested.assistantCount}`);
  console.log(
    `Signals: stop=${harvested.stopExists ? "yes" : "no"} send=${harvested.sendExists ? "yes" : "no"}`,
  );
  if (harvested.lastUserSnippet) {
    console.log(`Last user: ${harvested.lastUserSnippet}`);
  }
  console.log(chalk.dim("---"));
}

async function maybeWriteHarvestOutput(
  pathInput: string | undefined,
  cwd: string,
  content: string,
): Promise<void> {
  const resolved = resolveOutputPath(pathInput, cwd);
  if (!resolved) {
    return;
  }
  const payload = content ?? "";
  if (resolved === "-" || resolved === "/dev/stdout") {
    process.stdout.write(`${payload}${payload.endsWith("\n") ? "" : "\n"}`);
    return;
  }
  await fs.writeFile(resolved, payload, "utf8");
  console.log(chalk.dim(`Wrote harvested assistant output to ${resolved}`));
}

export async function showBrowserTabsStatus(): Promise<void> {
  const metas = await sessionStore.listSessions().catch(() => [] as SessionMetadata[]);
  const endpoints = collectUniqueEndpoints(metas);
  let printedAny = false;
  for (const endpoint of endpoints) {
    let tabs: ChatGptTabSummary[];
    try {
      tabs = await collectChatGptTabs(endpoint);
    } catch {
      continue;
    }
    if (tabs.length === 0) {
      continue;
    }
    printedAny = true;
    console.log(chalk.bold(`Browser Tabs ${endpoint.host}:${endpoint.port}`));
    for (const tab of tabs) {
      const linkedSession = resolveLinkedSession(
        { ...tab, host: endpoint.host, port: endpoint.port },
        metas,
      );
      console.log(
        `- ${tab.targetId} ${formatBrowserTabState(tab)} model=${tab.currentModelLabel || "(unknown)"} turns=${tab.assistantCount} stop=${tab.stopExists ? "yes" : "no"} send=${tab.sendExists ? "yes" : "no"}`,
      );
      console.log(`  title=${tab.title || "(untitled)"}`);
      console.log(`  url=${tab.url}`);
      if (linkedSession) {
        console.log(`  session=${linkedSession.id}`);
      }
      if (tab.lastAssistantSnippet) {
        console.log(`  last=${snippet(tab.lastAssistantSnippet)}`);
      }
    }
  }
  if (!printedAny) {
    console.log("No live ChatGPT tabs found on known Chrome DevTools endpoints.");
  }
}

export async function harvestSessionBrowserOutput(
  sessionId: string,
  options: BrowserHarvestOptions = {},
): Promise<ChatGptTabSummary> {
  const meta = await sessionStore.readSession(sessionId);
  if (!meta) {
    throw new Error(`No session found with ID ${sessionId}.`);
  }
  assertGenericSessionActionAllowed(meta, "harvest");
  const recordedEndpoint = sessionBrowserEndpoint(meta);
  const initialEndpoint = recordedEndpoint ?? {
    host: DEFAULT_REMOTE_CHROME_HOST,
    port: DEFAULT_REMOTE_CHROME_PORT,
  };
  const ref = options.browserTabRef ?? resolveSessionTabRef(meta);
  const recoverIfMissing = options.recoverIfMissing !== false && !options.browserTabRef;

  let recoveredConversation: RecoveredConversation | null = null;
  let recoveryDisposition: "completed" | "recoverable" = "recoverable";
  try {
    let harvested: ChatGptTabSummary;
    try {
      harvested = await harvestChatGptTab({
        host: initialEndpoint.host,
        port: initialEndpoint.port,
        ref,
        stallWindowMs: options.stallWindowMs,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isRecoverableMissingTabError(message) || !recoverIfMissing) {
        throw error;
      }
      console.log(
        chalk.yellow(
          `No live ChatGPT tab matched session "${sessionId}". Attempting recovery by reopening the saved conversation URL.`,
        ),
      );
      const recovered = await recoverConversationTab(meta, (line) => console.log(line), {
        existingEndpoint: recordedEndpoint ?? undefined,
      });
      recoveredConversation = recovered;
      harvested = await harvestChatGptTab({
        host: recovered.host,
        port: recovered.port,
        ref: recovered.ref,
        stallWindowMs: options.stallWindowMs,
      });
    }

    const persisted = await persistHarvest(sessionId, harvested);
    recoveryDisposition = harvested.state === "completed" ? "completed" : "recoverable";
    printHarvestSummary(sessionId, harvested);
    const output = harvested.lastAssistantMarkdown ?? harvested.lastAssistantText ?? "";
    if (options.writeOutputPath) {
      await maybeWriteHarvestOutput(options.writeOutputPath, meta.cwd ?? process.cwd(), output);
    }
    if (!options.quietOutput && output) {
      process.stdout.write(`${output}${output.endsWith("\n") ? "" : "\n"}`);
    }
    if (!recoveredConversation && persisted) {
      await finishCompletedOwnedLiveHarvest(
        sessionId,
        harvested,
        initialEndpoint,
        options.browserTabRef,
      );
    }
    return harvested;
  } finally {
    await finishRecoveredChrome(
      recoveredConversation,
      options.closeAfterRecover,
      recoveryDisposition,
    );
  }
}

export async function liveTailSessionBrowserOutput(
  sessionId: string,
  options: BrowserLiveTailOptions = {},
): Promise<ChatGptTabSummary> {
  const meta = await sessionStore.readSession(sessionId);
  if (!meta) {
    throw new Error(`No session found with ID ${sessionId}.`);
  }
  assertGenericSessionActionAllowed(meta, "live");
  const recordedEndpoint = sessionBrowserEndpoint(meta);
  let endpoint = recordedEndpoint ?? {
    host: DEFAULT_REMOTE_CHROME_HOST,
    port: DEFAULT_REMOTE_CHROME_PORT,
  };
  let browserTabRef = options.browserTabRef ?? resolveSessionTabRef(meta);
  const recoverIfMissing = options.recoverIfMissing !== false && !options.browserTabRef;
  let recoveredConversation: RecoveredConversation | null = null;
  let recoveryDisposition: "completed" | "recoverable" = "recoverable";
  const stallThresholdMs = options.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS;
  const liveStartedAt = Date.now();
  const proActiveCeilingMs = resolveProLiveTailCeilingMs(meta);
  let lastHash: string | null = null;
  let unchangedSince = Date.now();
  let requireRecoveredContent = false;
  let recoveredContentDeadlineMs = 0;

  try {
    // Probe once to see if the live tab is still alive; recover if not.
    try {
      await harvestChatGptTab({
        host: endpoint.host,
        port: endpoint.port,
        ref: browserTabRef,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isRecoverableMissingTabError(message) || !recoverIfMissing) {
        throw error;
      }
      console.log(
        chalk.yellow(
          `No live ChatGPT tab matched session "${sessionId}". Attempting recovery by reopening the saved conversation URL.`,
        ),
      );
      const recovered = await recoverConversationTab(meta, (line) => console.log(line), {
        existingEndpoint: recordedEndpoint ?? undefined,
        waitForReady: false,
      });
      recoveredConversation = recovered;
      endpoint = { host: recovered.host, port: recovered.port };
      browserTabRef = recovered.ref;
      requireRecoveredContent = true;
      recoveredContentDeadlineMs = Date.now() + stallThresholdMs;
    }

    while (true) {
      const harvested = await harvestChatGptTab({
        host: endpoint.host,
        port: endpoint.port,
        ref: browserTabRef,
      });
      const fullText = harvested.lastAssistantMarkdown ?? harvested.lastAssistantText ?? "";
      if (requireRecoveredContent && !isRecoveredConversationHarvestReady(harvested)) {
        if (Date.now() < recoveredContentDeadlineMs) {
          await new Promise((resolve) => setTimeout(resolve, LIVE_POLL_MS));
          continue;
        }
        throw new Error("Recovered ChatGPT conversation did not become ready in time.");
      }
      requireRecoveredContent = false;
      const hash = createHash("sha1").update(fullText).digest("hex");
      if (hash !== lastHash) {
        lastHash = hash;
        unchangedSince = Date.now();
        const statusLine =
          `[${new Date().toISOString()}] state=${harvested.state} stop=${harvested.stopExists ? "yes" : "no"} ` +
          `send=${harvested.sendExists ? "yes" : "no"} model=${harvested.currentModelLabel || "(unknown)"} ` +
          `snippet=${snippet(harvested.lastAssistantSnippet || fullText, 160)}`;
        console.log(statusLine);
        await persistHarvest(sessionId, harvested);
      }

      const now = Date.now();
      const derivedState = deriveLiveTailState({
        harvested,
        unchangedMs: now - unchangedSince,
        elapsedMs: now - liveStartedAt,
        stallThresholdMs,
        proActiveCeilingMs,
      });

      if (
        derivedState === "completed" ||
        derivedState === "stalled" ||
        derivedState === "detached"
      ) {
        recoveryDisposition = derivedState === "completed" ? "completed" : "recoverable";
        const finalHarvest: ChatGptTabSummary = {
          ...harvested,
          state: derivedState,
        };
        const persisted = await persistHarvest(sessionId, finalHarvest);
        printHarvestSummary(sessionId, finalHarvest);
        const output = finalHarvest.lastAssistantMarkdown ?? finalHarvest.lastAssistantText ?? "";
        if (options.writeOutputPath) {
          await maybeWriteHarvestOutput(options.writeOutputPath, meta.cwd ?? process.cwd(), output);
        }
        if (output) {
          process.stdout.write(`${output}${output.endsWith("\n") ? "" : "\n"}`);
        }
        if (!recoveredConversation && persisted) {
          await finishCompletedOwnedLiveHarvest(
            sessionId,
            finalHarvest,
            endpoint,
            options.browserTabRef,
          );
        }
        return finalHarvest;
      }

      await new Promise((resolve) => setTimeout(resolve, LIVE_POLL_MS));
    }
  } finally {
    await finishRecoveredChrome(
      recoveredConversation,
      options.closeAfterRecover,
      recoveryDisposition,
    );
  }
}

// biome-ignore lint/style/useNamingConvention: test-only export used in vitest suite
export const __test__ = {
  deriveLiveTailState,
  finishCompletedOwnedLiveHarvest,
  resolveProLiveTailCeilingMs,
};
