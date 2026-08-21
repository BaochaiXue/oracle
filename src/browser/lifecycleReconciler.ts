import type { BrowserRuntimeMetadata, SessionMetadata } from "../sessionStore.js";
import { listSessionsMetadata } from "../sessionManager.js";
import { extractStableConversationIdFromUrl } from "./conversationUrl.js";
import { closeTab, listRemoteChromeTargets, type RemoteTargetInfo } from "./chromeLifecycle.js";
import type { BrowserLogger } from "./types.js";
import { isProcessAlive } from "./profileState.js";

interface ReconcileTarget extends RemoteTargetInfo {
  id?: string;
}

export interface BrowserTargetReconciliationPlan {
  closeTargetIds: string[];
  protectedTargetIds: string[];
  unknownTargetIds: string[];
  /** Unknown meaningful pages block whole-browser drain; blank/new-tab shells do not. */
  unknownBlockingTargetIds: string[];
}

export interface BrowserTargetReconciliationResult extends BrowserTargetReconciliationPlan {
  closedTargetIds: string[];
  failedTargetIds: string[];
}

function targetId(target: ReconcileTarget): string | undefined {
  return target.targetId ?? target.id;
}

function receiptMatchesTarget(runtime: BrowserRuntimeMetadata, target: ReconcileTarget): boolean {
  const id = targetId(target);
  if (id && runtime.chromeTargetId === id) return true;
  const targetConversationId = extractStableConversationIdFromUrl(target.url ?? "");
  return Boolean(
    targetConversationId &&
    runtime.conversationId &&
    runtime.conversationId === targetConversationId,
  );
}

function isUnexpiredRecovery(runtime: BrowserRuntimeMetadata, nowMs: number): boolean {
  if (runtime.browserDisposition !== "recoverable") return false;
  const expiresAt = Date.parse(runtime.recoveryExpiresAt ?? "");
  return Number.isFinite(expiresAt) && expiresAt > nowMs;
}

function isLiveActiveReceipt(session: SessionMetadata, runtime: BrowserRuntimeMetadata): boolean {
  if (runtime.browserDisposition !== "active") return false;
  if (session.status !== "running" && session.status !== "pending") return false;
  return runtime.controllerPid ? isProcessAlive(runtime.controllerPid) : true;
}

function isCloseEligibleReceipt(
  session: SessionMetadata,
  runtime: BrowserRuntimeMetadata,
  nowMs: number,
): boolean {
  if (runtime.browserDisposition === "completed" || runtime.browserDisposition === "abandoned") {
    return true;
  }
  if (runtime.browserDisposition === "recoverable") {
    return !isUnexpiredRecovery(runtime, nowMs);
  }
  // Migration rule for receipts written before browserDisposition existed.
  return session.status === "completed" || session.status === "cancelled";
}

export function planOwnedTargetReconciliation(input: {
  profileDir: string;
  sessions: SessionMetadata[];
  targets: ReconcileTarget[];
  nowMs?: number;
}): BrowserTargetReconciliationPlan {
  const nowMs = input.nowMs ?? Date.now();
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
  const protectedIds = new Set<string>();
  const closeIds = new Set<string>();

  for (const target of pages) {
    const id = targetId(target) as string;
    const matches = receipts.filter(({ runtime }) => receiptMatchesTarget(runtime, target));
    if (
      matches.some(
        ({ session, runtime }) =>
          isUnexpiredRecovery(runtime, nowMs) || isLiveActiveReceipt(session, runtime),
      )
    ) {
      protectedIds.add(id);
      continue;
    }
    if (matches.some(({ session, runtime }) => isCloseEligibleReceipt(session, runtime, nowMs))) {
      closeIds.add(id);
    }
  }

  const unknownTargets = pages.filter((target) => {
    const id = targetId(target) as string;
    return !closeIds.has(id) && !protectedIds.has(id);
  });
  return {
    closeTargetIds: [...closeIds],
    protectedTargetIds: [...protectedIds],
    unknownTargetIds: unknownTargets.map((target) => targetId(target) as string),
    unknownBlockingTargetIds: unknownTargets
      .filter((target) => !isDisposableBlankShell(target.url))
      .map((target) => targetId(target) as string),
  };
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

export async function reconcileOwnedBrowserTargets(input: {
  profileDir: string;
  host: string;
  port: number;
  logger: BrowserLogger;
  sessions?: SessionMetadata[];
}): Promise<BrowserTargetReconciliationResult> {
  const sessions = input.sessions ?? (await listSessionsMetadata());
  const targets = (await listRemoteChromeTargets({
    host: input.host,
    port: input.port,
  })) as ReconcileTarget[];
  const plan = planOwnedTargetReconciliation({
    profileDir: input.profileDir,
    sessions,
    targets,
  });
  const closedTargetIds: string[] = [];
  const failedTargetIds: string[] = [];
  for (const id of plan.closeTargetIds) {
    if (await closeTab(input.port, id, input.logger, input.host)) {
      closedTargetIds.push(id);
    } else {
      failedTargetIds.push(id);
    }
  }
  if (closedTargetIds.length > 0) {
    input.logger(`[browser] Reconciled ${closedTargetIds.length} completed Oracle tab(s).`);
  }
  return { ...plan, closedTargetIds, failedTargetIds };
}
