import type { BrowserSessionConfig, SessionMetadata } from "../sessionStore.js";
import { CHATGPT_URL } from "../browser/constants.js";
import { buildConversationUrl } from "../browser/reattachHelpers.js";
import { resolveRecoveryUrl } from "../browser/recoverConversation.js";
import { isRecoverableChatGptConversationUrl } from "../browser/reattachability.js";
import { DEFAULT_MODEL } from "../oracle/config.js";
import type { ModelName } from "../oracle/types.js";
import { assertGenericSessionActionAllowed } from "../batch/sessionAuthority.js";
import { inferModelFromLabel } from "./options.js";
import { mapModelToBrowserLabel } from "./browserConfig.js";

export interface BrowserFollowupResolution {
  sessionId: string;
  resumeConversationUrl: string;
  model: ModelName;
  browserConfig: BrowserSessionConfig;
}

export interface FollowupSessionReader {
  readSession(sessionId: string): Promise<SessionMetadata | null>;
}

/**
 * Resolve the ChatGPT conversation URL to reopen for a browser follow-up.
 *
 * Reuses the same recoverable-URL gate as conversation recovery
 * (`resolveRecoveryUrl`): prefer the post-harvest URL, fall back to the
 * runtime tab URL, and reject home / project-shell / external URLs via
 * `isRecoverableChatGptConversationUrl`. Only when neither candidate is a
 * recoverable `chatgpt.com/c/<id>` URL do we rebuild from a stored
 * `conversationId` against the session's ChatGPT base — and that rebuilt URL is
 * gated too. This prevents a stale or attacker-controlled URL in session
 * metadata from navigating the signed-in browser profile somewhere unintended.
 */
export function resolveBrowserResumeConversationUrl(
  metadata: SessionMetadata,
  fallbackBaseUrl = CHATGPT_URL,
): string | null {
  const gatedUrl = resolveRecoveryUrl(metadata);
  if (gatedUrl) {
    return gatedUrl;
  }
  const conversationId = metadata.browser?.runtime?.conversationId?.trim();
  if (!conversationId) {
    return null;
  }
  const baseUrl = metadata.browser?.config?.url ?? fallbackBaseUrl;
  const built = buildConversationUrl({ conversationId }, baseUrl);
  if (built && isRecoverableChatGptConversationUrl(built)) {
    return built;
  }
  return null;
}

export async function resolveBrowserFollowupReference(
  value: string,
  store: FollowupSessionReader,
  requestedModel?: string,
): Promise<BrowserFollowupResolution | null> {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("resp_")) {
    return null;
  }

  const metadata = await store.readSession(trimmed);
  if (!metadata) {
    return null;
  }
  assertGenericSessionActionAllowed(metadata, "followup");
  const mode = metadata.mode ?? metadata.options?.mode;
  const hasBrowserMetadata = Boolean(
    metadata.browser?.runtime || metadata.browser?.config || metadata.options?.browserConfig,
  );
  if (mode !== "browser" && !hasBrowserMetadata) {
    return null;
  }

  const resumeConversationUrl = resolveBrowserResumeConversationUrl(metadata);
  if (!resumeConversationUrl) {
    throw new Error(
      `Session ${trimmed} is a browser session but does not contain a ChatGPT conversation URL. Run "oracle status --hours 72 --limit 20" to list recent sessions.`,
    );
  }
  const parentBrowserConfig = metadata.options?.browserConfig ?? metadata.browser?.config;
  if (!parentBrowserConfig) {
    throw new Error(`Session ${trimmed} is missing its stored browser configuration.`);
  }
  const storedModel = metadata.options?.model ?? metadata.model;
  const inheritedModel =
    typeof storedModel === "string" && storedModel.startsWith("gpt-")
      ? (storedModel as ModelName)
      : DEFAULT_MODEL;
  // A new follow-up is a new dispatch in the same conversation. The moving Pro
  // policy must be resolved anew; yesterday's fallback is not today's default.
  const canonicalPro =
    ["gpt-5-pro", "gpt-6-pro"].includes(inheritedModel) ||
    (parentBrowserConfig.thinkingTime === "pro" &&
      ["GPT-6", "GPT-5.6 Sol"].includes(parentBrowserConfig.desiredModel ?? ""));
  const model = requestedModel
    ? inferModelFromLabel(requestedModel)
    : canonicalPro
      ? "gpt-5-pro"
      : inheritedModel;
  const refreshModel = Boolean(requestedModel) || canonicalPro;
  return {
    sessionId: metadata.id,
    resumeConversationUrl,
    model,
    browserConfig: {
      ...parentBrowserConfig,
      ...(refreshModel
        ? {
            desiredModel: mapModelToBrowserLabel(model),
            modelStrategy: "select" as const,
            thinkingTime: ["gpt-5-pro", "gpt-6-pro"].includes(model)
              ? ("pro" as const)
              : parentBrowserConfig.thinkingTime,
          }
        : {}),
      browserTabRef: null,
      resumeConversationUrl,
      researchMode: "off",
    },
  };
}
