import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cli, Strategy } from "@jackwener/opencli/registry";
import { ArgumentError, CommandExecutionError } from "@jackwener/opencli/errors";
import {
  CONTRACT_VERSION,
  FIXED_COMPOSER_INSTRUCTION,
  appendTransportJournalEvent,
  assistantMarkerFromRows,
  buildDataTransferScript,
  buildGenerationControlScript,
  extractConversationReceipt,
  isAlreadyClosedPageError,
  loadSubmissionManifest,
  requireOracleGpt56SolModelOutcome,
  requireOracleProThinkingOutcome,
  unwrapEvaluateResult,
} from "./submit-file-core.js";
import {
  ORACLE_GPT56_SOL_MODEL_EXPRESSION,
  ORACLE_PRO_THINKING_EXPRESSION,
} from "./oracle-picker.generated.js";

const registryPath = fileURLToPath(import.meta.resolve("@jackwener/opencli/registry"));
const openCliPackageRoot = path.resolve(path.dirname(registryPath), "../..");
const chatGptUtils = await import(
  pathToFileURL(path.join(openCliPackageRoot, "clis/chatgpt/utils.js")).href
);

async function uploadAuthorizedFiles(page, files) {
  let uploaded = false;
  if (typeof page.setFileInput === "function") {
    try {
      await page.setFileInput(
        files.map((file) => file.path),
        "#upload-files",
      );
      const fired = unwrapEvaluateResult(
        await page.evaluate(`(() => {
          const input = document.querySelector('#upload-files, input[type="file"]');
          if (!(input instanceof HTMLInputElement)) return { ok: false };
          const propsKey = Object.keys(input).find((key) => key.startsWith('__reactProps$'));
          if (propsKey && input[propsKey] && typeof input[propsKey].onChange === 'function') {
            input[propsKey].onChange({ target: input, currentTarget: input });
          } else {
            input.dispatchEvent(new Event('change', { bubbles: true }));
          }
          return { ok: true };
        })()`),
      );
      uploaded = fired?.ok === true;
    } catch (error) {
      const message = String(error?.message ?? error);
      if (!/Not allowed|Unknown action|not supported|No element found/iu.test(message)) {
        throw error;
      }
    }
  }

  if (!uploaded) {
    const result = unwrapEvaluateResult(await page.evaluate(buildDataTransferScript(files)));
    if (result?.ok !== true || result.files !== files.length) {
      throw new CommandExecutionError("ChatGPT rejected the authorized Oracle file transfer.");
    }
  }

  const names = files.map((file) => file.name);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await page.wait(1);
    const ready = unwrapEvaluateResult(
      await page.evaluate(`(() => {
        const names = ${JSON.stringify(names)};
        const text = document.body ? (document.body.innerText || '') : '';
        return names.every((name) => text.includes(name));
      })()`),
    );
    if (ready === true) return;
  }
  throw new CommandExecutionError("ChatGPT did not confirm every authorized Oracle attachment.");
}

async function waitForConversationReceipt(page) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const url = await chatGptUtils.currentChatGPTUrl(page);
    const receipt = extractConversationReceipt(url);
    if (receipt) return receipt;
    await page.wait(1);
  }
  throw new CommandExecutionError(
    "ChatGPT did not return a conversation receipt after the Oracle submission.",
  );
}

async function generationControlIsVisible(page) {
  const result = unwrapEvaluateResult(await page.evaluate(buildGenerationControlScript()));
  if (typeof result !== "boolean") {
    throw new CommandExecutionError(
      "ChatGPT returned an invalid Oracle generation-state observation.",
    );
  }
  return result;
}

async function selectAndVerifyOraclePro(page) {
  if (!ORACLE_GPT56_SOL_MODEL_EXPRESSION || !ORACLE_PRO_THINKING_EXPRESSION) {
    throw new CommandExecutionError(
      "Oracle's generated Pro picker is missing. Run the Oracle OpenCLI adapter installer.",
    );
  }

  const deadline = Date.now() + 8_000;
  let rawModel = unwrapEvaluateResult(await page.evaluate(ORACLE_GPT56_SOL_MODEL_EXPRESSION));
  while (rawModel?.status === "button-missing" && Date.now() < deadline) {
    await page.wait(0.25);
    rawModel = unwrapEvaluateResult(await page.evaluate(ORACLE_GPT56_SOL_MODEL_EXPRESSION));
  }

  let model;
  let thinking;
  try {
    model = requireOracleGpt56SolModelOutcome(rawModel);
    thinking = requireOracleProThinkingOutcome(
      unwrapEvaluateResult(await page.evaluate(ORACLE_PRO_THINKING_EXPRESSION)),
    );
  } catch (error) {
    throw new CommandExecutionError(
      `Oracle native Pro selection failed before submission: ${String(error?.message ?? error)}`,
    );
  }
  return { model, thinking };
}

async function closeOwnedSubmissionTab(page) {
  if (typeof page.closeTab !== "function") {
    throw new CommandExecutionError(
      "OpenCLI cannot explicitly close the Oracle submission tab.",
      "Update OpenCLI before using the unattended Oracle transport.",
    );
  }
  try {
    await page.closeTab();
  } catch (error) {
    if (isAlreadyClosedPageError(error)) return;
    throw new CommandExecutionError(
      `OpenCLI failed to close the Oracle submission tab: ${String(error?.message ?? error)}`,
      "The dispatch journal still records whether submission may have occurred. Inspect or reattach the Oracle session; do not resubmit it blindly.",
    );
  }
}

export const submitFileCommand = cli({
  site: "chatgpt",
  name: "submit-file",
  description:
    "Use Oracle picker contract v3 to select GPT-5.6 Pro in the submission tab, submit a sealed file manifest, and return a conversation receipt",
  access: "write",
  example:
    "opencli chatgpt submit-file ~/.oracle/sessions/example/artifacts/opencli-submit.json --new true -f json",
  domain: "chatgpt.com",
  strategy: Strategy.COOKIE,
  browser: true,
  siteSession: "ephemeral",
  navigateBefore: false,
  args: [
    {
      name: "manifest",
      positional: true,
      required: true,
      help: "Path to a mode-0600 Oracle OpenCLI submission manifest",
    },
    {
      name: "timeout",
      type: "number",
      default: 225,
      help: "Maximum seconds for navigation, Oracle Pro selection, attachment, and submission",
    },
    { name: "new", type: "boolean", default: false, help: "Start a new ChatGPT conversation" },
    {
      name: "conversation",
      valueRequired: true,
      help: "Continue an explicit ChatGPT conversation ID or /c/<id> URL",
    },
  ],
  columns: [
    "ContractVersion",
    "Status",
    "conversationId",
    "conversationUrl",
    "Model",
    "ModelStatus",
    "ModelLabel",
    "ThinkingStatus",
    "ThinkingLabel",
    "Files",
    "BaselineAssistantIndex",
    "BaselineAssistantSha256",
  ],
  func: async (page, kwargs) => {
    try {
      const useNew = chatGptUtils.normalizeBooleanFlag(kwargs.new, false);
      if (useNew && kwargs.conversation) {
        throw new ArgumentError(
          "chatgpt submit-file cannot combine --new and --conversation.",
          "Choose one explicit Oracle conversation target.",
        );
      }
      if (!useNew && !kwargs.conversation) {
        throw new ArgumentError(
          "chatgpt submit-file requires --new true or --conversation <id>.",
          "Oracle submissions never rely on the currently active tab.",
        );
      }

      const submission = loadSubmissionManifest(kwargs.manifest);
      if (kwargs.conversation) {
        await chatGptUtils.openChatGPTConversation(page, kwargs.conversation);
      } else {
        await chatGptUtils.startNewChat(page);
      }
      await chatGptUtils.ensureChatGPTComposer(
        page,
        "ChatGPT submit-file requires an authenticated Browser Bridge session.",
      );

      const selection = await selectAndVerifyOraclePro(page);
      appendTransportJournalEvent(submission, "model-ready", {
        reportedModel: selection.model.label,
        reportedThinking: selection.thinking.label,
      });

      while (await generationControlIsVisible(page)) {
        await page.wait(3);
      }
      const baseline = kwargs.conversation
        ? assistantMarkerFromRows(
            (await chatGptUtils.getChatGPTDetailRows(page, { wantMarkdown: true })).rows,
          )
        : null;
      if (kwargs.conversation && !baseline) {
        throw new CommandExecutionError(
          "ChatGPT did not expose the prior assistant turn needed to guard this Oracle follow-up; nothing was submitted.",
        );
      }
      await uploadAuthorizedFiles(page, submission.files);
      appendTransportJournalEvent(submission, "dispatch-intent", {
        payloadSha256: submission.payloadSha256,
        attempt: 1,
      });
      const sent = await chatGptUtils.sendChatGPTMessage(page, FIXED_COMPOSER_INSTRUCTION);
      if (!sent) {
        throw new CommandExecutionError("ChatGPT did not accept the authorized Oracle turn.");
      }
      const receipt = await waitForConversationReceipt(page);
      return [
        {
          ContractVersion: CONTRACT_VERSION,
          Status: "Submitted",
          ...receipt,
          Model: "GPT-5.6 Pro",
          ModelStatus: selection.model.status,
          ModelLabel: selection.model.label,
          ThinkingStatus: selection.thinking.status,
          ThinkingLabel: selection.thinking.label,
          Files: submission.files.length,
          BaselineAssistantIndex: baseline?.index,
          BaselineAssistantSha256: baseline?.sha256,
        },
      ];
    } finally {
      await closeOwnedSubmissionTab(page);
    }
  },
});

export const __test__ = {
  openCliPackageRoot,
  sourceExists: fs.existsSync(fileURLToPath(import.meta.url)),
};
