import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cli, Strategy } from "@jackwener/opencli/registry";
import {
  ArgumentError,
  CommandExecutionError,
  EmptyResultError,
  TimeoutError,
} from "@jackwener/opencli/errors";
import {
  CONTRACT_VERSION,
  assistantMarkerFromRows,
  buildGenerationControlScript,
  matchesAssistantBaseline,
  unwrapEvaluateResult,
} from "./submit-file-core.js";

const registryPath = fileURLToPath(import.meta.resolve("@jackwener/opencli/registry"));
const openCliPackageRoot = path.resolve(path.dirname(registryPath), "../..");
const chatGptUtils = await import(
  pathToFileURL(path.join(openCliPackageRoot, "clis/chatgpt/utils.js")).href
);

async function generationControlIsVisible(page) {
  const result = unwrapEvaluateResult(await page.evaluate(buildGenerationControlScript()));
  if (typeof result !== "boolean") {
    throw new CommandExecutionError(
      "ChatGPT returned an invalid Oracle generation-state observation.",
    );
  }
  return result;
}

function parseBaseline(kwargs) {
  const rawSha256 = String(kwargs["baseline-sha256"] ?? "")
    .trim()
    .toLowerCase();
  if (rawSha256 && !/^[a-f0-9]{64}$/u.test(rawSha256)) {
    throw new ArgumentError(
      "chatgpt oracle-wait --baseline-sha256 must be a SHA-256 digest.",
      "Use the baseline receipt returned by chatgpt submit-file.",
    );
  }
  const rawIndex = kwargs["baseline-index"];
  if (rawIndex !== undefined && (!Number.isInteger(Number(rawIndex)) || Number(rawIndex) < 1)) {
    throw new ArgumentError(
      "chatgpt oracle-wait --baseline-index must be a positive integer.",
      "Use the baseline receipt returned by chatgpt submit-file.",
    );
  }
  return {
    index: rawIndex === undefined ? undefined : Number(rawIndex),
    sha256: rawSha256 || undefined,
  };
}

async function waitForOracleResult(page, kwargs) {
  const conversationId = chatGptUtils.parseChatGPTConversationId(kwargs.id);
  const timeoutSeconds = chatGptUtils.requirePositiveInt(
    Number(kwargs.timeout ?? 1200),
    "chatgpt oracle-wait --timeout",
    "Example: opencli chatgpt oracle-wait <id> --timeout 1200",
  );
  const stableSeconds = chatGptUtils.requireNonNegativeInt(
    Number(kwargs.stable ?? 9),
    "chatgpt oracle-wait --stable",
    "Example: opencli chatgpt oracle-wait <id> --stable 9",
  );
  const baseline = parseBaseline(kwargs);

  await chatGptUtils.openChatGPTConversation(page, conversationId);
  await chatGptUtils.ensureChatGPTLogin(
    page,
    "ChatGPT Oracle wait requires an authenticated Browser Bridge session.",
  );

  const startedAt = Date.now();
  let lastCandidateSha256 = "";
  let stableStartedAt = 0;
  let sawAssistant = false;

  while (Date.now() - startedAt < timeoutSeconds * 1000) {
    const { rows } = await chatGptUtils.getChatGPTDetailRows(page, { wantMarkdown: true });
    const marker = assistantMarkerFromRows(rows);
    sawAssistant ||= marker !== null;
    const generationActive = await generationControlIsVisible(page);
    const isNewAssistant =
      marker && !matchesAssistantBaseline(marker, baseline.index, baseline.sha256);

    if (isNewAssistant && !generationActive) {
      if (marker.sha256 !== lastCandidateSha256) {
        lastCandidateSha256 = marker.sha256;
        stableStartedAt = Date.now();
      }
      const elapsedSeconds = Math.floor((Date.now() - stableStartedAt) / 1000);
      if (elapsedSeconds >= stableSeconds) {
        return {
          ContractVersion: CONTRACT_VERSION,
          Status: "Complete",
          conversationId,
          conversationUrl: `https://chatgpt.com/c/${conversationId}`,
          AssistantIndex: marker.index,
          AssistantSha256: marker.sha256,
          Markdown: marker.markdown,
          StableSeconds: elapsedSeconds,
        };
      }
    } else {
      lastCandidateSha256 = "";
      stableStartedAt = 0;
    }

    const remainingSeconds = Math.max(
      0.1,
      Math.min(3, (timeoutSeconds * 1000 - (Date.now() - startedAt)) / 1000),
    );
    await page.wait(remainingSeconds);
  }

  if (!sawAssistant) {
    throw new EmptyResultError(
      "chatgpt oracle-wait",
      `No visible assistant turn was found for conversation ${conversationId}.`,
    );
  }
  throw new TimeoutError(
    "chatgpt oracle-wait",
    timeoutSeconds,
    "The submitted Oracle turn did not produce a new stable assistant reply before timeout. Reattach the Oracle session; do not resubmit it.",
  );
}

async function closeOwnedLease(page) {
  if (typeof page.closeTab !== "function") {
    throw new CommandExecutionError(
      "OpenCLI cannot explicitly close the Oracle waiter tab.",
      "Update OpenCLI before using the unattended Oracle transport.",
    );
  }
  try {
    await page.closeTab();
  } catch (error) {
    throw new CommandExecutionError(
      `OpenCLI failed to close the Oracle waiter tab: ${String(error?.message ?? error)}`,
      "The conversation receipt is still safe. Reattach the Oracle session after inspecting the Browser Bridge.",
    );
  }
}

export const oracleWaitCommand = cli({
  site: "chatgpt",
  name: "oracle-wait",
  description:
    "Wait for one submitted Oracle turn on one owned ChatGPT tab lease and return its stable Markdown reply",
  access: "read",
  example:
    "opencli chatgpt oracle-wait https://chatgpt.com/c/example --timeout 1200 --stable 9 -f json",
  domain: "chatgpt.com",
  strategy: Strategy.COOKIE,
  browser: true,
  siteSession: "ephemeral",
  navigateBefore: false,
  args: [
    {
      name: "id",
      positional: true,
      required: true,
      help: "Conversation ID or full /c/<id> URL",
    },
    {
      name: "baseline-index",
      type: "int",
      valueRequired: true,
      help: "Prior assistant row index returned by chatgpt submit-file",
    },
    {
      name: "baseline-sha256",
      valueRequired: true,
      help: "Prior assistant Markdown digest returned by chatgpt submit-file",
    },
    { name: "timeout", type: "int", default: 1200, help: "Maximum wait in seconds" },
    {
      name: "stable",
      type: "int",
      default: 9,
      help: "Seconds the final assistant Markdown must remain unchanged",
    },
  ],
  columns: [
    "ContractVersion",
    "Status",
    "conversationId",
    "conversationUrl",
    "AssistantIndex",
    "AssistantSha256",
    "Markdown",
    "StableSeconds",
  ],
  func: async (page, kwargs) => {
    let result;
    let commandError;
    try {
      result = await waitForOracleResult(page, kwargs);
    } catch (error) {
      commandError = error;
    }

    await closeOwnedLease(page);
    if (commandError) throw commandError;
    return [result];
  },
});

export const __test__ = {
  openCliPackageRoot,
};
