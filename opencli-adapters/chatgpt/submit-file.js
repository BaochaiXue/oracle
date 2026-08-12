import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cli, Strategy } from "@jackwener/opencli/registry";
import { ArgumentError, CommandExecutionError } from "@jackwener/opencli/errors";
import {
  CONTRACT_VERSION,
  FIXED_COMPOSER_INSTRUCTION,
  assistantMarkerFromRows,
  buildDataTransferScript,
  buildGenerationControlScript,
  extractConversationReceipt,
  loadSubmissionManifest,
  unwrapEvaluateResult,
} from "./submit-file-core.js";

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

export const submitFileCommand = cli({
  site: "chatgpt",
  name: "submit-file",
  description:
    "Submit a sealed Oracle file manifest to ChatGPT and return a conversation receipt without waiting for the answer",
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
    "Files",
    "BaselineAssistantIndex",
    "BaselineAssistantSha256",
  ],
  func: async (page, kwargs) => {
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

    const modelButtons = unwrapEvaluateResult(
      await page.evaluate(`(() => Array.from(document.querySelectorAll('form button')).map((button) => ({
        text: (button.innerText || button.textContent || '').replace(/\\s+/g, ' ').trim(),
        visible: !!(button.offsetWidth || button.offsetHeight || button.getClientRects().length),
      })))()`),
    );
    const proVisible = Array.isArray(modelButtons)
      ? modelButtons.some(
          (button) =>
            button?.visible !== false && String(button?.text ?? "").toLowerCase() === "pro",
        )
      : false;
    if (!proVisible) {
      throw new CommandExecutionError(
        "The exact ChatGPT submission tab did not visibly confirm Pro; nothing was submitted.",
      );
    }

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
        Model: "Pro",
        Files: submission.files.length,
        BaselineAssistantIndex: baseline?.index,
        BaselineAssistantSha256: baseline?.sha256,
      },
    ];
  },
});

export const __test__ = {
  openCliPackageRoot,
  sourceExists: fs.existsSync(fileURLToPath(import.meta.url)),
};
