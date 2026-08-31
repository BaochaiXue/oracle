import { createHash } from "node:crypto";
import type { BrowserContext, Page } from "playwright-core";
import type {
  CompatibilityReceipt,
  ObjectRef,
  PreparationReceipt,
  ProviderAdapter,
  ProviderCaptureContext,
  ProviderCaptureResult,
  ProviderDispatchContext,
  ProviderJobContext,
  ProviderRuntimeBindings,
  SubmissionReceipt,
} from "../../oracle-kernel/src/index.js";
import { observeUiFingerprint } from "./fingerprint.js";
import { parseConversationId, probeCompatibility } from "./probe.js";
import { chatGptLocators } from "./selectors.js";

export interface ChatGptAdapterOptions {
  context: BrowserContext;
  browserRuntimeId: string;
  urlForJob(jobId: string): string;
  adapterVersion?: string;
  actionTimeoutMs?: number;
  commitTimeoutMs?: number;
}

export class ChatGptAdapter implements ProviderAdapter {
  readonly adapterVersion: string;
  readonly browserRuntimeId: string;
  private readonly context: BrowserContext;
  private readonly urlForJob: (jobId: string) => string;
  private readonly actionTimeoutMs: number;
  private readonly commitTimeoutMs: number;
  private readonly pages = new Map<string, Page>();
  private bindings?: ProviderRuntimeBindings;

  constructor(options: ChatGptAdapterOptions) {
    this.context = options.context;
    this.browserRuntimeId = options.browserRuntimeId;
    this.urlForJob = options.urlForJob;
    this.adapterVersion = options.adapterVersion ?? "chatgpt-adapter-v2-fixture-1";
    this.actionTimeoutMs = options.actionTimeoutMs ?? 30_000;
    this.commitTimeoutMs = options.commitTimeoutMs ?? 120_000;
  }

  bindRuntime(bindings: ProviderRuntimeBindings): void {
    this.bindings = bindings;
  }

  async probe(): Promise<CompatibilityReceipt> {
    const page = await this.context.newPage();
    try {
      await page.goto(this.urlForJob("probe"));
      return await probeCompatibility(page, {
        adapterVersion: this.adapterVersion,
        browserRuntimeId: this.browserRuntimeId,
        timeoutMs: this.actionTimeoutMs,
      });
    } finally {
      await page.close();
    }
  }

  async prepare(context: ProviderJobContext): Promise<PreparationReceipt> {
    const page = await this.pageFor(context.jobId);
    const locators = chatGptLocators(page);
    await locators.modelButton.click({ timeout: this.actionTimeoutMs });
    await locators.modelOption.click({ timeout: this.actionTimeoutMs });
    if (!(await locators.effort.isVisible())) {
      await locators.modelButton.click({ timeout: this.actionTimeoutMs });
    }
    await locators.effort.fill("5", { timeout: this.actionTimeoutMs });

    const bundleSha256 = context.spec.input.bundleSha256;
    if (context.spec.input.bundle && bundleSha256) {
      const bytes = this.readObject(context.spec.input.bundle);
      await locators.uploadInput.setInputFiles({
        name: bundleFilename(bundleSha256),
        mimeType: "text/markdown",
        buffer: Buffer.from(bytes),
      });
      const exactChip = page.locator(
        `[data-attachment-chip][data-artifact-sha256="${bundleSha256}"]`,
      );
      await exactChip.first().waitFor({ state: "visible", timeout: this.actionTimeoutMs });
      if ((await exactChip.count()) !== 1 || (await locators.attachmentChips.count()) !== 1) {
        throw new Error("Bundle preparation requires exactly one composer-anchored artifact chip");
      }
      await waitForUploadToSettle(page, this.actionTimeoutMs);
    }

    const prompt = composePrompt(this.readObject(context.spec.input.prompt), createFooter(context));
    await locators.composer.fill(prompt, { timeout: this.actionTimeoutMs });
    await waitForEnabled(locators.send, this.actionTimeoutMs);
    const fingerprint = await observeUiFingerprint(page);
    return {
      adapterVersion: this.adapterVersion,
      uiFingerprint: fingerprint.digest,
      browserRuntimeId: this.browserRuntimeId,
      promptSha256: context.spec.input.promptSha256,
      ...(bundleSha256 ? { bundleSha256 } : {}),
      model: {
        requested: "gpt-5.6-sol",
        observedLabel: (await locators.modelButton.textContent())?.trim() ?? "",
        verified: true,
      },
      effort: {
        requested: "pro",
        observedLabel: (await locators.effort.inputValue()) === "5" ? "Pro" : "unknown",
        controlKind: "slider",
        verified: true,
      },
      ...(bundleSha256
        ? {
            bundleEvidence: {
              kind: "composer-anchored" as const,
              source: "chip" as const,
              artifactSha256: bundleSha256,
            },
          }
        : {}),
      preparedAt: new Date().toISOString(),
    };
  }

  async verifyPrepared(context: ProviderJobContext, receipt: PreparationReceipt): Promise<void> {
    if (!this.pages.has(context.jobId)) await this.prepare(context);
    const page = this.requireOwnedPage(context.jobId);
    const locators = chatGptLocators(page);
    const expectedPrompt = composePrompt(
      this.readObject(context.spec.input.prompt),
      createFooter(context),
    );
    if ((await readComposer(locators.composer)) !== expectedPrompt) {
      throw new Error("Final verification rejected composer prompt drift");
    }
    if (!/GPT-5\.6\s+Sol/iu.test((await locators.modelButton.textContent())?.trim() ?? "")) {
      throw new Error("Final verification rejected model drift");
    }
    if ((await locators.effort.inputValue()) !== "5") {
      throw new Error("Final verification rejected effort drift");
    }
    if (receipt.bundleSha256) {
      const chips = page.locator(
        `[data-attachment-chip][data-artifact-sha256="${receipt.bundleSha256}"]`,
      );
      if ((await chips.count()) !== 1 || (await locators.attachmentChips.count()) !== 1) {
        throw new Error("Final verification rejected attachment drift");
      }
    }
    await waitForEnabled(locators.send, this.actionTimeoutMs);
  }

  async dispatchOnce(context: ProviderDispatchContext): Promise<void> {
    const page = this.requireOwnedPage(context.jobId);
    await chatGptLocators(page).send.click({ timeout: this.actionTimeoutMs });
  }

  async observeCommit(context: ProviderDispatchContext): Promise<SubmissionReceipt | undefined> {
    const page = await this.pageFor(context.jobId);
    const locators = chatGptLocators(page);
    const expectedPrompt = composePrompt(
      this.readObject(context.spec.input.prompt),
      context.intent.receiptFooter,
    );
    const userTurn = locators.userTurns.filter({ hasText: context.intent.receiptFooter }).last();
    try {
      await userTurn.waitFor({ state: "visible", timeout: this.commitTimeoutMs });
    } catch {
      return undefined;
    }
    const observedPrompt = (await userTurn.locator("[data-message-content]").textContent()) ?? "";
    if (observedPrompt !== expectedPrompt) return undefined;
    const conversationId = await userTurn.getAttribute("data-conversation-id");
    if (!conversationId) return undefined;
    const conversationUrl = new URL(`/c/${encodeURIComponent(conversationId)}`, page.url()).href;
    const bundleSha256 = context.spec.input.bundleSha256;
    if (bundleSha256) {
      const committedAttachment = userTurn.locator(
        `[data-committed-attachment][data-artifact-sha256="${bundleSha256}"]`,
      );
      if ((await committedAttachment.count()) !== 1) return undefined;
    }
    return {
      jobId: context.jobId,
      turnAttemptId: context.intent.turnAttemptId,
      promptSha256: context.spec.input.promptSha256,
      ...(bundleSha256 ? { bundleSha256 } : {}),
      committedAt: new Date().toISOString(),
      conversationId,
      conversationUrl,
      committedUserTurnOrdinal: Math.max(0, (await locators.userTurns.count()) - 1),
      userTurnDigest: digest(Buffer.from(observedPrompt, "utf8")),
      receiptFooterVerified: true,
      modelReceipt: {
        model: "gpt-5.6-sol",
        effort: "pro",
        adapterVersion: this.adapterVersion,
        uiFingerprint:
          context.state.kind === "dispatch-at-risk"
            ? context.state.preparation.uiFingerprint
            : "unavailable",
      },
      bundleReceipt: bundleSha256
        ? {
            required: true,
            committedTurnEvidence: "attachment-ui",
            artifactSha256: bundleSha256,
            verified: true,
          }
        : { required: false },
    };
  }

  async capture(context: ProviderCaptureContext): Promise<ProviderCaptureResult> {
    const page = await this.pageFor(context.jobId);
    if (parseConversationId(page.url()) !== context.submission.conversationId) {
      await page.goto(context.submission.conversationUrl);
    }
    const assistant = page
      .locator(
        `[data-message-author-role="assistant"][data-conversation-id="${context.submission.conversationId}"]`,
      )
      .last();
    await assistant.waitFor({ state: "visible", timeout: this.actionTimeoutMs });
    await waitForStreamingToFinish(assistant, this.actionTimeoutMs);
    const content = assistant.locator("[data-message-content]");
    const first = (await content.textContent()) ?? "";
    const html = await content.innerHTML();
    await delay(30);
    const second = (await content.textContent()) ?? "";
    if (!first || first !== second) throw new Error("Assistant response is not stable");

    let markdown = "";
    let quality: "native-copy" | "html-projection" = "html-projection";
    const copy = assistant.getByRole("button", { name: /copy response/i });
    if ((await copy.count()) === 1) {
      await copy.click();
      markdown = await page.evaluate(
        () =>
          (globalThis as typeof globalThis & { __ORACLE_COPIED_MARKDOWN__?: string })
            .__ORACLE_COPIED_MARKDOWN__ ?? "",
      );
      if (markdown) quality = "native-copy";
    }
    if (!markdown) markdown = `${second.trim()}\n`;
    const answerBytes = Buffer.from(markdown, "utf8");
    const result: ProviderCaptureResult = {
      answerBytes,
      plainTextBytes: Buffer.from(`${second.trim()}\n`, "utf8"),
      htmlBytes: Buffer.from(html, "utf8"),
      mediaType: "text/markdown",
      receipt: {
        conversationId: context.submission.conversationId,
        assistantTurnDigest: digest(Buffer.from(second, "utf8")),
        responseSha256: digest(answerBytes),
        capturedAt: new Date().toISOString(),
        completionEvidence: ["assistant-successor", "streaming-finished", "stable-content"],
        markdownQuality: quality,
        adapterVersion: this.adapterVersion,
        warnings:
          quality === "native-copy" ? [] : ["native copy unavailable; used text projection"],
      },
    };
    this.pages.delete(context.jobId);
    await page.close();
    return result;
  }

  openPageCount(): number {
    return this.pages.size;
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.pages.values()].map((page) => page.close()));
    this.pages.clear();
  }

  private async pageFor(jobId: string): Promise<Page> {
    const existing = this.pages.get(jobId);
    if (existing && !existing.isClosed()) return existing;
    const page = await this.context.newPage();
    await page.goto(this.urlForJob(jobId));
    this.pages.set(jobId, page);
    return page;
  }

  private requireOwnedPage(jobId: string): Page {
    const page = this.pages.get(jobId);
    if (!page || page.isClosed()) throw new Error(`Worker does not own a page for ${jobId}`);
    return page;
  }

  private readObject(ref: ObjectRef): Uint8Array {
    if (!this.bindings) throw new Error("ChatGPT adapter object runtime is not bound");
    return this.bindings.readObject(ref);
  }
}

function createFooter(context: ProviderJobContext): string {
  const footer = "intent" in context.state ? context.state.intent.receiptFooter : undefined;
  if (footer) return footer;
  const offset = context.state.kind === "preparing" ? 2 : 1;
  const turnAttemptId = `${context.jobId}-turn-${context.stateVersion + offset}`;
  return `[Oracle receipt: job=${context.jobId}; turn=${turnAttemptId}; prompt=${context.spec.input.promptSha256.slice(0, 12)}; bundle=${context.spec.input.bundleSha256?.slice(0, 12) ?? "none"}]`;
}

function composePrompt(bytes: Uint8Array, footer: string): string {
  const prompt = Buffer.from(bytes).toString("utf8");
  return `${prompt.endsWith("\n") ? prompt : `${prompt}\n`}\n${footer}`;
}

function bundleFilename(sha256: string): string {
  return `oracle-source-${sha256.slice(0, 12)}.md`;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function waitForEnabled(
  locator: ReturnType<typeof chatGptLocators>["send"],
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  while (!(await locator.isEnabled())) {
    if (Date.now() >= deadline) throw new Error("Send control did not become enabled");
    await delay(10);
  }
}

async function readComposer(
  composer: ReturnType<typeof chatGptLocators>["composer"],
): Promise<string> {
  return composer.evaluate((element) => {
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      return element.value;
    }
    if (!(element instanceof HTMLElement)) return element.textContent ?? "";
    return element.innerText.replace(/\n{2,}/gu, (run) => "\n".repeat(Math.ceil(run.length / 2)));
  });
}

async function waitForUploadToSettle(page: Page, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const status = chatGptLocators(page).uploadStatus;
  while ((await status.count()) > 0 && (await status.textContent())?.trim()) {
    if (Date.now() >= deadline) throw new Error("Bundle upload did not settle");
    await delay(10);
  }
}

async function waitForStreamingToFinish(
  assistant: ReturnType<typeof chatGptLocators>["assistantTurns"],
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while ((await assistant.getAttribute("data-streaming")) !== "false") {
    if (Date.now() >= deadline) throw new Error("Assistant response did not finish streaming");
    await delay(10);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
