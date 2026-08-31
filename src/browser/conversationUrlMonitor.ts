import type { BrowserLogger } from "./types.js";
import { delay } from "./utils.js";
import { extractStableConversationIdFromUrl, isStableConversationUrl } from "./conversationUrl.js";
import { BrowserAutomationError } from "../oracle/errors.js";

export type ConversationUrlCandidateStatus = "verified" | "pending" | "mismatch";

export interface ConversationUrlMonitor {
  update: (label: string, timeoutMs?: number) => Promise<boolean>;
  schedule: (label: string, timeoutMs?: number) => Promise<boolean>;
  guard: <T>(operation: () => Promise<T>) => Promise<T>;
  assertHealthy: () => void;
  boundConversationId: () => string | undefined;
  boundConversationUrl: () => string | undefined;
  isInFlight: () => boolean;
  stop: () => Promise<void>;
}

export function createConversationUrlMonitor(options: {
  readUrl: () => Promise<string | null | undefined>;
  persistUrl: (url: string) => Promise<void>;
  logger: BrowserLogger;
  initialConversationUrl?: string;
  validateCandidate?: (args: {
    url: string;
    conversationId: string;
    label: string;
  }) => Promise<ConversationUrlCandidateStatus>;
  watchAfterBind?: boolean;
  pollIntervalMs?: number;
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
}): ConversationUrlMonitor {
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const wait = options.wait ?? delay;
  const now = options.now ?? Date.now;
  let inFlight: Promise<boolean> | null = null;
  let stopped = false;
  let boundUrl =
    options.initialConversationUrl && isStableConversationUrl(options.initialConversationUrl)
      ? options.initialConversationUrl
      : undefined;
  let boundId = boundUrl ? extractStableConversationIdFromUrl(boundUrl) : undefined;
  let terminalError: BrowserAutomationError | null = null;
  let watchPromise: Promise<void> | null = null;
  let resolveFailure: ((error: BrowserAutomationError) => void) | null = null;
  const failure = new Promise<BrowserAutomationError>((resolve) => {
    resolveFailure = resolve;
  });
  const activePersists = new Set<Promise<void>>();

  const fail = (error: BrowserAutomationError): never => {
    if (!terminalError) {
      terminalError = error;
      resolveFailure?.(error);
    }
    throw terminalError;
  };

  const assertHealthy = (): void => {
    if (terminalError) throw terminalError;
  };

  const observe = async (url: string, label: string): Promise<boolean> => {
    assertHealthy();
    const observedId = extractStableConversationIdFromUrl(url);
    if (!observedId) return false;
    if (boundId && observedId !== boundId) {
      return fail(
        new BrowserAutomationError(
          "Oracle stopped response capture because the browser navigated away from the submitted conversation. The review was sent; recover this session instead of submitting it again.",
          {
            stage: "conversation-identity",
            code: "conversation-id-mismatch",
            expectedConversationId: boundId,
            observedConversationId: observedId,
            observedUrl: url,
            label,
            promptSubmitted: true,
          },
        ),
      );
    }
    let newlyBound = false;
    if (!boundId) {
      const candidateStatus = options.validateCandidate
        ? await options.validateCandidate({ url, conversationId: observedId, label })
        : "verified";
      if (candidateStatus === "pending") return false;
      if (candidateStatus === "mismatch") {
        return fail(
          new BrowserAutomationError(
            "Oracle refused to bind the submitted review to a different ChatGPT conversation. The review was sent; recover this session instead of submitting it again.",
            {
              stage: "conversation-identity",
              code: "committed-prompt-mismatch",
              observedConversationId: observedId,
              observedUrl: url,
              label,
              promptSubmitted: true,
            },
          ),
        );
      }
      boundId = observedId;
      boundUrl = url;
      newlyBound = true;
    }
    if (!newlyBound) return true;
    options.logger(`[browser] conversation url (${label}) = ${url}`);
    const persist = options.persistUrl(url);
    activePersists.add(persist);
    try {
      await persist;
    } finally {
      activePersists.delete(persist);
    }
    return true;
  };

  const startWatch = (): void => {
    if (!options.watchAfterBind || !boundId || watchPromise || stopped) return;
    watchPromise = (async () => {
      while (!stopped && !terminalError) {
        await wait(pollIntervalMs);
        if (stopped || terminalError) return;
        try {
          const url = await options.readUrl();
          if (url) await observe(url, "identity-watch");
        } catch (error) {
          if (error instanceof BrowserAutomationError) return;
          // Navigation and CDP disconnects are handled by the owning browser run.
        }
      }
    })();
  };

  const update = async (label: string, timeoutMs = 10_000): Promise<boolean> => {
    assertHealthy();
    const startedAt = now();
    while (!stopped && now() - startedAt < timeoutMs) {
      try {
        const url = await options.readUrl();
        if (stopped) {
          return false;
        }
        if (url && (await observe(url, label))) {
          startWatch();
          return true;
        }
      } catch (error) {
        if (error instanceof BrowserAutomationError) throw error;
        // The page can navigate or disconnect between polls; keep trying until timeout.
      }
      await wait(pollIntervalMs);
    }
    return false;
  };

  const schedule = (label: string, timeoutMs?: number): Promise<boolean> => {
    if (stopped) {
      return Promise.resolve(false);
    }
    if (inFlight) {
      return inFlight;
    }
    // The /c/ URL can appear after submit. Persist it without blocking response capture.
    inFlight = update(label, timeoutMs)
      .catch((error) => {
        if (error instanceof BrowserAutomationError && !terminalError) {
          terminalError = error;
          resolveFailure?.(error);
        }
        return false;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  return {
    update,
    schedule,
    guard: async <T>(operation: () => Promise<T>): Promise<T> => {
      assertHealthy();
      return Promise.race([
        operation(),
        failure.then((error) => {
          throw error;
        }),
      ]);
    },
    assertHealthy,
    boundConversationId: () => boundId,
    boundConversationUrl: () => boundUrl,
    isInFlight: () => inFlight !== null,
    stop: async () => {
      stopped = true;
      await Promise.allSettled([watchPromise, ...activePersists].filter(Boolean));
    },
  };
}
