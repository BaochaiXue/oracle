import { describe, expect, test, vi } from "vitest";
import { createHash, webcrypto } from "node:crypto";
import {
  buildCommittedPromptIdentityExpression,
  buildConversationTurnCountExpression,
  buildConversationTurnListExpression,
} from "../../src/browser/conversationTurns.js";
import {
  CONVERSATION_TURN_CONTAINER_SELECTOR,
  CONVERSATION_TURN_SELECTOR,
} from "../../src/browser/constants.js";

function evaluate(expression: string, responses: Map<string, unknown[]>): unknown {
  const document = {
    querySelectorAll: vi.fn((selector: string) => responses.get(selector) ?? []),
  };
  return Function("document", `return ${expression};`)(document);
}

describe("conversation turn expressions", () => {
  test("prefers top-level turn containers over nested broad-selector matches", () => {
    const containers = [{ id: "user" }, { id: "assistant" }];
    const nestedMatches = [...containers, { id: "nested-assistant" }];
    const responses = new Map([
      [CONVERSATION_TURN_CONTAINER_SELECTOR, containers],
      [CONVERSATION_TURN_SELECTOR, nestedMatches],
    ]);

    expect(evaluate(buildConversationTurnListExpression(), responses)).toEqual(containers);
    expect(evaluate(buildConversationTurnCountExpression(), responses)).toBe(2);
  });

  test("falls back to the broad selector for older conversation markup", () => {
    const legacyTurns = [{ id: "user" }, { id: "assistant" }];
    const responses = new Map([
      [CONVERSATION_TURN_CONTAINER_SELECTOR, []],
      [CONVERSATION_TURN_SELECTOR, legacyTurns],
    ]);

    expect(evaluate(buildConversationTurnListExpression(), responses)).toEqual(legacyTurns);
  });

  test.each([
    ["Exact committed prompt", "verified"],
    ["Different prompt", "mismatch"],
  ])(
    "checks the committed user turn digest before binding a conversation: %s",
    async (text, expected) => {
      const prompt = "Exact committed prompt";
      const userTurn = {
        dataset: { turn: "user" },
        innerText: text,
        textContent: text,
        getAttribute: (name: string) => (name === "data-turn" ? "user" : null),
        querySelector: () => null,
      };
      const document = {
        querySelectorAll: vi.fn((selector: string) =>
          selector === CONVERSATION_TURN_CONTAINER_SELECTOR ? [userTurn] : [],
        ),
      };
      const expression = buildCommittedPromptIdentityExpression({
        committedUserTurnIndex: 0,
        promptSha256: createHash("sha256").update(prompt.toLowerCase()).digest("hex"),
      });

      await expect(
        Function(
          "document",
          "crypto",
          "TextEncoder",
          `return ${expression};`,
        )(document, webcrypto, TextEncoder),
      ).resolves.toBe(expected);
    },
  );

  test("keeps candidate binding pending while the committed turn is still hydrating", async () => {
    const document = { querySelectorAll: vi.fn(() => []) };
    const expression = buildCommittedPromptIdentityExpression({
      committedUserTurnIndex: 2,
      promptSha256: "a".repeat(64),
    });

    await expect(
      Function(
        "document",
        "crypto",
        "TextEncoder",
        `return ${expression};`,
      )(document, webcrypto, TextEncoder),
    ).resolves.toBe("pending");
  });
});
