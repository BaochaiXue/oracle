import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import type { BrowserRuntimeMetadata, SessionMetadata } from "../sessionStore.js";
import { listSessionsMetadata } from "../sessionManager.js";
import { extractStableConversationIdFromUrl } from "./conversationUrl.js";
import {
  closeTab,
  createChromePageTarget,
  listRemoteChromeTargets,
  type RemoteTargetInfo,
} from "./chromeLifecycle.js";
import type { BrowserLogger } from "./types.js";
import { isProcessAlive } from "./profileState.js";
import {
  readBrowserTargetRegistry,
  registerBrowserOwnedTarget,
  removeBrowserOwnedTarget,
  type BrowserTargetRegistryFile,
} from "./tabLeaseRegistry.js";
import { delay } from "./utils.js";

const RECEIPT_FILENAME = "oracle-tab-reconciliation.json";
const RECONCILE_LOCK_DIRNAME = "oracle-tab-reconciliation.lock";
const RECONCILE_LOCK_TIMEOUT_MS = 30_000;
const POST_SENTINEL_SETTLE_MS = 2_000;
const POST_SENTINEL_POLL_MS = 250;

export interface ReconcileTarget extends RemoteTargetInfo {
  id?: string;
}

export interface BrowserTargetReconciliationPlan {
  closeTargetIds: string[];
  protectedTargetIds: string[];
  unknownTargetIds: string[];
  unknownBlockingTargetIds: string[];
  preservedTargetIds: string[];
  terminalOwnedTargetIds: string[];
  duplicateBlankTargetIds: string[];
  untrackedChatgptTargetIds: string[];
  untrackedOtherTargetIds: string[];
  nonPageTargetIds: string[];
  sentinelTargetId?: string;
  needsSentinel: boolean;
  targetSnapshots: Record<string, { type?: string; url?: string }>;
}

export type BrowserTargetReconciliationStatus = "complete" | "partial" | "failed";

export interface BrowserTargetReconciliationReceipt extends BrowserTargetReconciliationPlan {
  status: BrowserTargetReconciliationStatus;
  mode: "plan" | "apply";
  profileDir: string;
  host: string;
  port: number;
  includeUntrackedChatgpt: boolean;
  startedAt: string;
  completedAt: string;
  closedTargetIds: string[];
  skippedTargetIds: string[];
  failedTargetIds: string[];
  createdSentinelTargetId?: string;
  error?: string;
}

export type BrowserTargetReconciliationResult = BrowserTargetReconciliationReceipt;

interface ReconcileDeps {
  listTargets?: () => Promise<ReconcileTarget[]>;
  listSessions?: () => Promise<SessionMetadata[]>;
  readRegistry?: () => Promise<BrowserTargetRegistryFile>;
  closeTarget?: (
    port: number,
    targetId: string,
    logger: BrowserLogger,
    host: string,
  ) => Promise<boolean>;
  createTarget?: (port: number, logger: BrowserLogger, host: string) => Promise<string | undefined>;
  registerOwnedTarget?: typeof registerBrowserOwnedTarget;
  removeOwnedTarget?: typeof removeBrowserOwnedTarget;
  writeReceipt?: (receipt: BrowserTargetReconciliationReceipt) => Promise<void>;
  isProcessAlive?: (pid: number) => boolean;
  beforeClose?: (targetId: string) => Promise<void>;
  wait?: (ms: number) => Promise<void>;
}

function targetId(target: ReconcileTarget): string | undefined {
  return target.targetId ?? target.id;
}

function isDisposableBlankShell(url: string | undefined): boolean {
  const normalized = (url ?? "").trim().toLowerCase();
  return (
    normalized === "" ||
    normalized === "about:blank" ||
    normalized === "chrome://newtab/" ||
    normalized === "chrome://new-tab-page/"
  );
}

function isChatGptUrl(url: string | undefined): boolean {
  try {
    const host = new URL(url ?? "").hostname.toLowerCase();
    return host === "chatgpt.com" || host.endsWith(".chatgpt.com");
  } catch {
    return false;
  }
}

function runtimeMatchesTargetForProtection(
  runtime: BrowserRuntimeMetadata,
  target: ReconcileTarget,
): boolean {
  const id = targetId(target);
  if (id && runtime.chromeTargetId === id) return true;
  const conversationId = extractStableConversationIdFromUrl(target.url ?? "");
  return Boolean(
    conversationId && runtime.conversationId && runtime.conversationId === conversationId,
  );
}

function runtimeMatchesExactTarget(
  runtime: BrowserRuntimeMetadata,
  target: ReconcileTarget,
): boolean {
  const id = targetId(target);
  return Boolean(id && runtime.chromeTargetId === id);
}

function isTerminalSession(session: SessionMetadata, runtime: BrowserRuntimeMetadata): boolean {
  if (runtime.browserDisposition === "completed" || runtime.browserDisposition === "abandoned") {
    return true;
  }
  return session.status === "completed" || session.status === "cancelled";
}

function isRecoverableSession(
  session: SessionMetadata,
  runtime: BrowserRuntimeMetadata,
  nowMs: number,
): boolean {
  if (runtime.browserDisposition === "recoverable") {
    const expiry = Date.parse(runtime.recoveryExpiresAt ?? "");
    return !Number.isFinite(expiry) || expiry > nowMs;
  }
  if (session.status === "partial") return true;
  const harvestState = session.browser?.harvest?.state;
  return harvestState === "running" || harvestState === "stalled" || harvestState === "detached";
}

function isLiveActiveSession(
  session: SessionMetadata,
  runtime: BrowserRuntimeMetadata,
  alive: (pid: number) => boolean,
): boolean {
  if (isTerminalSession(session, runtime)) return false;
  if (session.status !== "running" && session.status !== "pending") return false;
  return runtime.controllerPid ? alive(runtime.controllerPid) : true;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function planOwnedTargetReconciliation(input: {
  profileDir: string;
  sessions: SessionMetadata[];
  targets: ReconcileTarget[];
  registry?: BrowserTargetRegistryFile;
  nowMs?: number;
  includeUntrackedChatgpt?: boolean;
  ensureSentinel?: boolean;
  isProcessAlive?: (pid: number) => boolean;
}): BrowserTargetReconciliationPlan {
  const nowMs = input.nowMs ?? Date.now();
  const alive = input.isProcessAlive ?? isProcessAlive;
  const registry = input.registry ?? { version: 2, leases: [], targets: [] };
  const receipts = input.sessions.flatMap((session) => {
    const runtime = session.browser?.runtime;
    if (!runtime || runtime.browserTransport === "opencli") return [];
    if (
      runtime.userDataDir !== input.profileDir &&
      runtime.chromeProfileRoot !== input.profileDir
    ) {
      return [];
    }
    return [{ session, runtime }];
  });
  const pages = input.targets.filter(
    (target) => target.type === "page" && Boolean(targetId(target)),
  );
  const nonPageTargetIds = input.targets
    .filter((target) => target.type !== "page")
    .map((target) => targetId(target))
    .filter((id): id is string => Boolean(id));
  const activeLeaseTargetIds = new Set(
    registry.leases.map((lease) => lease.chromeTargetId).filter((id): id is string => Boolean(id)),
  );
  const ownedById = new Map(registry.targets.map((target) => [target.targetId, target]));
  const protectedIds = new Set<string>();
  const terminalOwnedIds = new Set<string>();
  const untrackedChatgptIds = new Set<string>();
  const untrackedOtherIds = new Set<string>();
  const blankIds: string[] = [];

  for (const target of pages) {
    const id = targetId(target) as string;
    const disposableBlank = isDisposableBlankShell(target.url);
    if (disposableBlank) blankIds.push(id);
    const matchingReceipts = receipts.filter(({ runtime }) =>
      runtimeMatchesTargetForProtection(runtime, target),
    );
    const exactReceipts = receipts.filter(({ runtime }) =>
      runtimeMatchesExactTarget(runtime, target),
    );
    const owned = ownedById.get(id);
    const terminalBySession = exactReceipts.some(({ session, runtime }) =>
      isTerminalSession(session, runtime),
    );
    const ownedRecoveryExpiry = Date.parse(owned?.recoveryExpiresAt ?? "");
    const ownedRecoveryIsLive = Boolean(
      owned?.disposition === "recoverable" &&
      (!Number.isFinite(ownedRecoveryExpiry) || ownedRecoveryExpiry > nowMs),
    );
    const protectedBySession = matchingReceipts.some(
      ({ session, runtime }) =>
        isRecoverableSession(session, runtime, nowMs) ||
        isLiveActiveSession(session, runtime, alive),
    );
    const protectedByOwnedRecord = Boolean(
      owned &&
      (ownedRecoveryIsLive ||
        (owned.disposition === "active" &&
          !terminalBySession &&
          Boolean(owned.controllerPid && alive(owned.controllerPid)))),
    );
    if (activeLeaseTargetIds.has(id) || protectedBySession || protectedByOwnedRecord) {
      protectedIds.add(id);
      continue;
    }

    const terminalByOwnedRecord = Boolean(
      owned &&
      (owned.disposition === "terminal" ||
        (owned.disposition === "active" && (!owned.controllerPid || !alive(owned.controllerPid))) ||
        (owned.disposition === "recoverable" &&
          Number.isFinite(ownedRecoveryExpiry) &&
          ownedRecoveryExpiry <= nowMs)),
    );
    if (terminalBySession || terminalByOwnedRecord) {
      terminalOwnedIds.add(id);
      continue;
    }
    if (disposableBlank) continue;
    if (isChatGptUrl(target.url)) {
      untrackedChatgptIds.add(id);
    } else {
      untrackedOtherIds.add(id);
    }
  }

  const closeIds = new Set(terminalOwnedIds);
  if (input.includeUntrackedChatgpt) {
    for (const id of untrackedChatgptIds) closeIds.add(id);
  }
  const nonBlankSurvivorExists = pages.some((target) => {
    const id = targetId(target) as string;
    return !isDisposableBlankShell(target.url) && !closeIds.has(id);
  });
  const protectedBlankIds = blankIds.filter((id) => protectedIds.has(id)).sort();
  const availableBlankIds = blankIds
    .filter((id) => !protectedIds.has(id) && !closeIds.has(id))
    .sort();
  const sentinelTargetId = nonBlankSurvivorExists
    ? undefined
    : (protectedBlankIds[0] ?? availableBlankIds[0]);
  const duplicateBlankTargetIds = blankIds.filter(
    (id) => id !== sentinelTargetId && !protectedIds.has(id),
  );
  for (const id of duplicateBlankTargetIds) closeIds.add(id);
  if (sentinelTargetId) protectedIds.add(sentinelTargetId);

  const preservedTargetIds = pages
    .map((target) => targetId(target) as string)
    .filter((id) => !closeIds.has(id));
  const unknownTargetIds = unique([
    ...untrackedChatgptIds,
    ...untrackedOtherIds,
    ...blankIds.filter((id) => !ownedById.has(id)),
  ]).filter((id) => !terminalOwnedIds.has(id));
  const unknownBlockingTargetIds = unique([...untrackedChatgptIds, ...untrackedOtherIds]).filter(
    (id) => !closeIds.has(id),
  );
  const targetSnapshots = Object.fromEntries(
    pages.map((target) => [targetId(target) as string, { type: target.type, url: target.url }]),
  );
  return {
    closeTargetIds: pages
      .map((target) => targetId(target) as string)
      .filter((id) => closeIds.has(id)),
    protectedTargetIds: pages
      .map((target) => targetId(target) as string)
      .filter((id) => protectedIds.has(id)),
    unknownTargetIds,
    unknownBlockingTargetIds,
    preservedTargetIds,
    terminalOwnedTargetIds: pages
      .map((target) => targetId(target) as string)
      .filter((id) => terminalOwnedIds.has(id)),
    duplicateBlankTargetIds,
    untrackedChatgptTargetIds: pages
      .map((target) => targetId(target) as string)
      .filter((id) => untrackedChatgptIds.has(id)),
    untrackedOtherTargetIds: pages
      .map((target) => targetId(target) as string)
      .filter((id) => untrackedOtherIds.has(id)),
    nonPageTargetIds,
    sentinelTargetId,
    needsSentinel: Boolean(input.ensureSentinel && !nonBlankSurvivorExists && !sentinelTargetId),
    targetSnapshots,
  };
}

async function writeReconciliationReceipt(
  profileDir: string,
  receipt: BrowserTargetReconciliationReceipt,
): Promise<void> {
  await mkdir(profileDir, { recursive: true });
  const destination = path.join(profileDir, RECEIPT_FILENAME);
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  await rename(temporary, destination);
}

async function acquireReconciliationLock(profileDir: string): Promise<() => Promise<void>> {
  const lockDir = path.join(profileDir, RECONCILE_LOCK_DIRNAME);
  const startedAt = Date.now();
  await mkdir(profileDir, { recursive: true });
  for (;;) {
    try {
      await mkdir(lockDir);
      break;
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
      if (Date.now() - startedAt >= RECONCILE_LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for browser target reconciliation lock at ${lockDir}.`);
      }
      await delay(50);
    }
  }
  return async () => rm(lockDir, { recursive: true, force: true });
}

function receiptStatus(closed: string[], failed: string[]): BrowserTargetReconciliationStatus {
  if (failed.length === 0) return "complete";
  return closed.length > 0 ? "partial" : "failed";
}

export async function reconcileBrowserTargets(
  input: {
    profileDir: string;
    host: string;
    port: number;
    logger: BrowserLogger;
    apply?: boolean;
    includeUntrackedChatgpt?: boolean;
    ensureSentinel?: boolean;
  },
  deps: ReconcileDeps = {},
): Promise<BrowserTargetReconciliationReceipt> {
  const startedAt = new Date().toISOString();
  const listTargets =
    deps.listTargets ??
    (async () =>
      (await listRemoteChromeTargets({ host: input.host, port: input.port })) as ReconcileTarget[]);
  const listSessions = deps.listSessions ?? listSessionsMetadata;
  const readRegistry = deps.readRegistry ?? (() => readBrowserTargetRegistry(input.profileDir));
  const closeTarget = deps.closeTarget ?? closeTab;
  const createTarget = deps.createTarget ?? createChromePageTarget;
  const removeOwned = deps.removeOwnedTarget ?? removeBrowserOwnedTarget;
  const registerOwned = deps.registerOwnedTarget ?? registerBrowserOwnedTarget;
  const persistReceipt =
    deps.writeReceipt ?? ((receipt) => writeReconciliationReceipt(input.profileDir, receipt));
  const wait = deps.wait ?? delay;
  const buildPlan = async () =>
    planOwnedTargetReconciliation({
      profileDir: input.profileDir,
      sessions: await listSessions(),
      registry: await readRegistry(),
      targets: await listTargets(),
      includeUntrackedChatgpt: input.includeUntrackedChatgpt,
      ensureSentinel: input.ensureSentinel,
      isProcessAlive: deps.isProcessAlive,
    });

  let initialPlan: BrowserTargetReconciliationPlan;
  try {
    initialPlan = await buildPlan();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const receipt: BrowserTargetReconciliationReceipt = {
      closeTargetIds: [],
      protectedTargetIds: [],
      unknownTargetIds: [],
      unknownBlockingTargetIds: [],
      preservedTargetIds: [],
      terminalOwnedTargetIds: [],
      duplicateBlankTargetIds: [],
      untrackedChatgptTargetIds: [],
      untrackedOtherTargetIds: [],
      nonPageTargetIds: [],
      needsSentinel: false,
      targetSnapshots: {},
      status: "failed",
      mode: input.apply ? "apply" : "plan",
      profileDir: input.profileDir,
      host: input.host,
      port: input.port,
      includeUntrackedChatgpt: Boolean(input.includeUntrackedChatgpt),
      startedAt,
      completedAt: new Date().toISOString(),
      closedTargetIds: [],
      skippedTargetIds: [],
      failedTargetIds: [],
      error: message,
    };
    if (input.apply) await persistReceipt(receipt);
    return receipt;
  }

  if (!input.apply) {
    return {
      ...initialPlan,
      status: "complete",
      mode: "plan",
      profileDir: input.profileDir,
      host: input.host,
      port: input.port,
      includeUntrackedChatgpt: Boolean(input.includeUntrackedChatgpt),
      startedAt,
      completedAt: new Date().toISOString(),
      closedTargetIds: [],
      skippedTargetIds: [],
      failedTargetIds: [],
    };
  }

  let releaseReconcileLock: () => Promise<void>;
  try {
    releaseReconcileLock = await acquireReconciliationLock(input.profileDir);
  } catch (error) {
    const receipt: BrowserTargetReconciliationReceipt = {
      ...initialPlan,
      status: "failed",
      mode: "apply",
      profileDir: input.profileDir,
      host: input.host,
      port: input.port,
      includeUntrackedChatgpt: Boolean(input.includeUntrackedChatgpt),
      startedAt,
      completedAt: new Date().toISOString(),
      closedTargetIds: [],
      skippedTargetIds: [],
      failedTargetIds: [],
      error: error instanceof Error ? error.message : String(error),
    };
    await persistReceipt(receipt);
    return receipt;
  }
  const closedTargetIds: string[] = [];
  const skippedTargetIds: string[] = [];
  const failedTargetIds: string[] = [];
  const handledTargetIds = new Set<string>();
  let createdSentinelTargetId: string | undefined;
  let fatalError: string | undefined;
  const applyClosePlan = async (plan: BrowserTargetReconciliationPlan): Promise<void> => {
    for (const id of plan.closeTargetIds) {
      if (handledTargetIds.has(id)) continue;
      handledTargetIds.add(id);
      await deps.beforeClose?.(id);
      try {
        const liveTargets = await listTargets();
        const liveTarget = liveTargets.find((target) => targetId(target) === id);
        const planned = plan.targetSnapshots[id];
        if (
          !liveTarget ||
          liveTarget.type !== planned?.type ||
          (liveTarget.url ?? "") !== (planned?.url ?? "")
        ) {
          skippedTargetIds.push(id);
          continue;
        }
        const livePlan = planOwnedTargetReconciliation({
          profileDir: input.profileDir,
          sessions: await listSessions(),
          registry: await readRegistry(),
          targets: liveTargets,
          includeUntrackedChatgpt: input.includeUntrackedChatgpt,
          ensureSentinel: input.ensureSentinel,
          isProcessAlive: deps.isProcessAlive,
        });
        if (!livePlan.closeTargetIds.includes(id)) {
          skippedTargetIds.push(id);
          continue;
        }
      } catch (error) {
        failedTargetIds.push(id);
        input.logger(
          `[browser] Failed to revalidate target ${id}: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }

      try {
        if (await closeTarget(input.port, id, input.logger, input.host)) {
          closedTargetIds.push(id);
          await removeOwned(input.profileDir, id);
        } else {
          failedTargetIds.push(id);
        }
      } catch (error) {
        failedTargetIds.push(id);
        input.logger(
          `[browser] Failed to close target ${id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  };
  try {
    initialPlan = await buildPlan();
    await applyClosePlan(initialPlan);

    if (input.ensureSentinel) {
      try {
        const finalTargets = await listTargets();
        const pages = finalTargets.filter((target) => target.type === "page");
        if (pages.length === 0) {
          createdSentinelTargetId = await createTarget(input.port, input.logger, input.host);
          if (createdSentinelTargetId) {
            await registerOwned(input.profileDir, {
              targetId: createdSentinelTargetId,
              ownerKind: "sentinel",
              purpose: "persistent-browser-sentinel",
              disposition: "sentinel",
              chromeHost: input.host,
              chromePort: input.port,
              tabUrl: "about:blank",
              controllerPid: process.pid,
            });
          } else {
            fatalError = "Chrome had no surviving page target and sentinel creation failed.";
          }
        } else {
          const survivingSentinel = initialPlan.sentinelTargetId
            ? pages.find((target) => targetId(target) === initialPlan.sentinelTargetId)
            : undefined;
          if (survivingSentinel && isDisposableBlankShell(survivingSentinel.url)) {
            const latestRegistry = await readRegistry();
            const leased = latestRegistry.leases.some(
              (lease) => lease.chromeTargetId === initialPlan.sentinelTargetId,
            );
            const alreadyOwned = latestRegistry.targets.some(
              (target) => target.targetId === initialPlan.sentinelTargetId,
            );
            if (!leased && !alreadyOwned) {
              await registerOwned(input.profileDir, {
                targetId: initialPlan.sentinelTargetId as string,
                ownerKind: "sentinel",
                purpose: "persistent-browser-sentinel",
                disposition: "sentinel",
                chromeHost: input.host,
                chromePort: input.port,
                tabUrl: survivingSentinel.url ?? "about:blank",
                controllerPid: process.pid,
              });
            }
          }
        }
      } catch (error) {
        fatalError = error instanceof Error ? error.message : String(error);
      }
    }
    if (createdSentinelTargetId && !fatalError) {
      const settlePolls = Math.ceil(POST_SENTINEL_SETTLE_MS / POST_SENTINEL_POLL_MS);
      for (let poll = 0; poll < settlePolls; poll += 1) {
        await wait(POST_SENTINEL_POLL_MS);
        const latePlan = await buildPlan();
        await applyClosePlan(latePlan);
      }
    }
  } catch (error) {
    fatalError = error instanceof Error ? error.message : String(error);
  } finally {
    await releaseReconcileLock();
  }

  const status = fatalError
    ? closedTargetIds.length > 0
      ? "partial"
      : "failed"
    : receiptStatus(closedTargetIds, failedTargetIds);
  const receipt: BrowserTargetReconciliationReceipt = {
    ...initialPlan,
    status,
    mode: "apply",
    profileDir: input.profileDir,
    host: input.host,
    port: input.port,
    includeUntrackedChatgpt: Boolean(input.includeUntrackedChatgpt),
    startedAt,
    completedAt: new Date().toISOString(),
    closedTargetIds,
    skippedTargetIds,
    failedTargetIds: unique(failedTargetIds),
    createdSentinelTargetId,
    error: fatalError,
  };
  await persistReceipt(receipt);
  if (receipt.status !== "complete") {
    input.logger(
      `[browser] Target reconciliation ${receipt.status}: closed=${closedTargetIds.length} skipped=${skippedTargetIds.length} failed=${receipt.failedTargetIds.length}${fatalError ? ` error=${fatalError}` : ""}`,
    );
  } else if (closedTargetIds.length > 0) {
    input.logger(`[browser] Reconciled ${closedTargetIds.length} stale Oracle browser target(s).`);
  }
  return receipt;
}

export async function reconcileOwnedBrowserTargets(input: {
  profileDir: string;
  host: string;
  port: number;
  logger: BrowserLogger;
  sessions?: SessionMetadata[];
  ensureSentinel?: boolean;
}): Promise<BrowserTargetReconciliationResult> {
  return reconcileBrowserTargets(
    { ...input, apply: true, includeUntrackedChatgpt: false },
    input.sessions ? { listSessions: async () => input.sessions as SessionMetadata[] } : {},
  );
}
