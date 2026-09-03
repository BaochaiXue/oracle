import { PROMPT_TEXT_NORMALIZER_SOURCE } from "./promptTextNormalizer.js";
import { CONVERSATION_TURN_CONTAINER_SELECTOR, CONVERSATION_TURN_SELECTOR } from "./constants.js";
import type { ChromeClient } from "./types.js";

/** Build a browser-context expression that returns one DOM node per conversation turn. */
export function buildConversationTurnListExpression(rootExpression = "document"): string {
  const containerSelector = JSON.stringify(CONVERSATION_TURN_CONTAINER_SELECTOR);
  const fallbackSelector = JSON.stringify(CONVERSATION_TURN_SELECTOR);
  return `(() => {
    const root = ${rootExpression};
    const containers = Array.from(root.querySelectorAll(${containerSelector}));
    return containers.length > 0
      ? containers
      : Array.from(root.querySelectorAll(${fallbackSelector}));
  })()`;
}

export function buildConversationTurnCountExpression(rootExpression = "document"): string {
  return `(${buildConversationTurnListExpression(rootExpression)}).length`;
}

export type CommittedPromptIdentityStatus = "verified" | "pending" | "mismatch";

export interface CommittedPromptIdentity {
  committedUserTurnIndex: number;
  promptSha256: string;
}

/**
 * Build an in-page check that binds a durable conversation URL to the exact
 * user turn whose commit was already observed. This is intentionally based on
 * the privacy-safe normalized prompt digest stored by the Pro timing receipt.
 */
export function buildCommittedPromptIdentityExpression(identity: CommittedPromptIdentity): string {
  const committedUserTurnIndex = Number.isSafeInteger(identity.committedUserTurnIndex)
    ? identity.committedUserTurnIndex
    : -1;
  const promptSha256 = JSON.stringify(identity.promptSha256);
  return `(async () => {
    const COMMITTED_USER_TURN_INDEX = ${committedUserTurnIndex};
    const EXPECTED_PROMPT_SHA256 = ${promptSha256};
    if (COMMITTED_USER_TURN_INDEX < 0 || !/^[a-f0-9]{64}$/.test(EXPECTED_PROMPT_SHA256)) {
      return 'mismatch';
    }
    const turns = ${buildConversationTurnListExpression()};
    const node = turns[COMMITTED_USER_TURN_INDEX];
    if (!node) return 'pending';
    const role = String(
      node.getAttribute?.('data-message-author-role') ||
      node.getAttribute?.('data-turn') ||
      node.dataset?.turn ||
      '',
    ).toLowerCase();
    const roleNode = role === 'user'
      ? node
      : node.querySelector?.('[data-message-author-role="user"], [data-turn="user"]');
    if (!roleNode) return 'mismatch';
    const messageNode = roleNode.querySelector?.('.whitespace-pre-wrap') || roleNode;
    const normalize = ${PROMPT_TEXT_NORMALIZER_SOURCE};
    const normalized = normalize(messageNode.innerText || messageNode.textContent || '');
    if (!normalized) return 'pending';
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
    const actualSha256 = Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    return actualSha256 === EXPECTED_PROMPT_SHA256 ? 'verified' : 'mismatch';
  })()`;
}

export async function readCommittedPromptIdentityStatus(
  Runtime: ChromeClient["Runtime"],
  identity: CommittedPromptIdentity,
): Promise<CommittedPromptIdentityStatus> {
  const { result } = await Runtime.evaluate({
    expression: buildCommittedPromptIdentityExpression(identity),
    returnByValue: true,
    awaitPromise: true,
  });
  return result?.value === "verified"
    ? "verified"
    : result?.value === "mismatch"
      ? "mismatch"
      : "pending";
}
