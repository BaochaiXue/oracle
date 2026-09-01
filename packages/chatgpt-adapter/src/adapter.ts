import { createHash } from "node:crypto";
import type { BrowserContext, Locator, Page } from "playwright-core";
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
import { readComposerText } from "./composer.js";
import { probeLiveCompatibilityWithoutSend } from "./liveProbe.js";
import { probeModelAndEffortControls } from "./noSendProbe.js";
import { parseConversationId } from "./probe.js";
import {
  CHATGPT_ASSISTANT_CONTENT_SELECTOR,
  CHATGPT_FINISHED_ACTION_SELECTOR,
  CHATGPT_STOP_SELECTOR,
  CHATGPT_TURN_CONTAINER_SELECTOR,
  CHATGPT_TURN_FALLBACK_SELECTOR,
  chatGptLocators,
} from "./selectors.js";
import { MAX_OWNED_CHATGPT_TABS, OwnedTabBudget, type ReleaseOwnedTab } from "./tabBudget.js";

const PROBE_PAGE_KEY = "__oracle-v2-provider-probe__";

export interface ChatGptAdapterOptions {
  context: BrowserContext;
  browserRuntimeId: string;
  urlForJob(jobId: string): string;
  openPage?(url: string): Promise<Page>;
  adapterVersion?: string;
  actionTimeoutMs?: number;
  commitTimeoutMs?: number;
  maxOpenPages?: number;
}

interface ConversationBaseline {
  turnCount: number;
  digest: string;
}

interface CommittedTurnObservation {
  conversationId: string;
  conversationUrl: string;
  turnIndex: number;
  userTurnDigest: string;
  bundleVerified: boolean;
}

interface AssistantObservation {
  status: "pending" | "identity-mismatch" | "ready";
  turnIndex?: number;
  text?: string;
  html?: string;
  streaming?: boolean;
  stopVisible?: boolean;
  finishedActionVisible?: boolean;
}

export class ChatGptAdapter implements ProviderAdapter {
  readonly adapterVersion: string;
  readonly browserRuntimeId: string;
  private readonly context: BrowserContext;
  private readonly urlForJob: (jobId: string) => string;
  private readonly openTarget: (url: string) => Promise<Page>;
  private readonly actionTimeoutMs: number;
  private readonly commitTimeoutMs: number;
  private readonly pages = new Map<string, Page>();
  private readonly pageCreations = new Map<string, Promise<Page>>();
  private readonly pageReleases = new Map<string, ReleaseOwnedTab>();
  private readonly tabBudget: OwnedTabBudget;
  private bindings?: ProviderRuntimeBindings;

  constructor(options: ChatGptAdapterOptions) {
    this.context = options.context;
    this.browserRuntimeId = options.browserRuntimeId;
    this.urlForJob = options.urlForJob;
    this.openTarget =
      options.openPage ??
      (async (url) => {
        const page = await this.context.newPage();
        await page.goto(url);
        return page;
      });
    this.adapterVersion = options.adapterVersion ?? "chatgpt-adapter-v2-r7";
    this.actionTimeoutMs = options.actionTimeoutMs ?? 30_000;
    this.commitTimeoutMs = options.commitTimeoutMs ?? 120_000;
    this.tabBudget = new OwnedTabBudget(options.maxOpenPages);
  }

  bindRuntime(bindings: ProviderRuntimeBindings): void {
    this.bindings = bindings;
  }

  async probe(): Promise<CompatibilityReceipt> {
    const page = await this.pageFor(PROBE_PAGE_KEY, this.urlForJob("probe"));
    try {
      return await probeLiveCompatibilityWithoutSend(page, {
        adapterVersion: this.adapterVersion,
        browserRuntimeId: this.browserRuntimeId,
        timeoutMs: this.actionTimeoutMs,
      });
    } finally {
      await page.close();
    }
  }

  async prepare(context: ProviderJobContext): Promise<PreparationReceipt> {
    const page = await this.pageFor(
      context.jobId,
      context.spec.conversation?.conversationUrl ?? this.urlForJob(context.jobId),
    );
    const locators = chatGptLocators(page);
    await locators.composer.waitFor({ state: "visible", timeout: this.actionTimeoutMs });

    const modelAndEffort = await probeModelAndEffortControls(page, {
      timeoutMs: this.actionTimeoutMs,
    });
    if (!modelAndEffort.modelVerified || !modelAndEffort.effortVerified) {
      throw new Error("Preparation could not independently verify GPT-5.6 Sol and Pro");
    }
    const baseline = await observeConversationBaseline(page);

    const bundleSha256 = context.spec.input.bundleSha256;
    if (context.spec.input.bundle && bundleSha256) {
      const filename = bundleFilename(bundleSha256, context.spec.input.bundle.mediaType);
      const bytes = this.readObject(context.spec.input.bundle);
      await locators.attachmentButton
        .click({ timeout: this.actionTimeoutMs })
        .catch(() => undefined);
      await locators.uploadInput.setInputFiles({
        name: filename,
        mimeType: context.spec.input.bundle.mediaType,
        buffer: Buffer.from(bytes),
      });
      await waitForComposerAttachment(page, filename, this.actionTimeoutMs);
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
      baselineConversationDigest: baseline.digest,
      baselineTurnCount: baseline.turnCount,
      model: {
        requested: "gpt-5.6-sol",
        observedLabel: modelAndEffort.modelLabel,
        verified: true,
      },
      effort: {
        requested: "pro",
        observedLabel: modelAndEffort.effortLabel,
        controlKind: modelAndEffort.pickerKind === "intelligence-picker" ? "slider" : "menu",
        verified: true,
      },
      ...(bundleSha256
        ? {
            bundleEvidence: {
              kind: "composer-anchored" as const,
              source: "tile" as const,
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
    if (
      normalizeComposerText(await readComposerText(locators.composer)) !==
      normalizeComposerText(expectedPrompt)
    ) {
      throw new Error("Final verification rejected composer prompt drift");
    }
    const modelAndEffort = await probeModelAndEffortControls(page, {
      timeoutMs: this.actionTimeoutMs,
    });
    if (!modelAndEffort.modelVerified) {
      throw new Error("Final verification rejected model drift");
    }
    if (!modelAndEffort.effortVerified) {
      throw new Error("Final verification rejected effort drift");
    }
    const baseline = await observeConversationBaseline(page);
    if (
      baseline.turnCount !== receipt.baselineTurnCount ||
      baseline.digest !== receipt.baselineConversationDigest
    ) {
      throw new Error("Final verification rejected pre-Send conversation drift");
    }
    if (receipt.bundleSha256) {
      await waitForComposerAttachment(
        page,
        bundleFilename(receipt.bundleSha256, context.spec.input.bundle?.mediaType),
        Math.min(this.actionTimeoutMs, 5_000),
      );
    }
    await waitForEnabled(locators.send, this.actionTimeoutMs);
  }

  async dispatchOnce(context: ProviderDispatchContext): Promise<void> {
    const page = this.requireOwnedPage(context.jobId);
    await chatGptLocators(page).send.click({ timeout: this.actionTimeoutMs });
  }

  async observeCommit(context: ProviderDispatchContext): Promise<SubmissionReceipt | undefined> {
    const page = await this.pageFor(context.jobId, this.urlForJob(context.jobId));
    const expectedPrompt = composePrompt(
      this.readObject(context.spec.input.prompt),
      context.intent.receiptFooter,
    );
    const bundleSha256 = context.spec.input.bundleSha256;
    const observation = await waitForCommittedTurn(page, {
      expectedUserTurnDigest: normalizedTurnDigest(expectedPrompt),
      baselineTurnCount: context.intent.baselineTurnCount,
      bundleFilename: bundleSha256
        ? bundleFilename(bundleSha256, context.spec.input.bundle?.mediaType)
        : undefined,
      timeoutMs: this.commitTimeoutMs,
    });
    if (!observation) return undefined;
    return {
      jobId: context.jobId,
      turnAttemptId: context.intent.turnAttemptId,
      promptSha256: context.spec.input.promptSha256,
      ...(bundleSha256 ? { bundleSha256 } : {}),
      committedAt: new Date().toISOString(),
      conversationId: observation.conversationId,
      conversationUrl: observation.conversationUrl,
      committedUserTurnOrdinal: observation.turnIndex,
      userTurnDigest: observation.userTurnDigest,
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
            verified: true as const,
          }
        : { required: false },
    };
  }

  async capture(context: ProviderCaptureContext): Promise<ProviderCaptureResult> {
    const page = await this.pageFor(context.jobId, context.submission.conversationUrl);
    if (parseConversationId(page.url()) !== context.submission.conversationId) {
      await page.goto(context.submission.conversationUrl, {
        waitUntil: "domcontentloaded",
        timeout: this.actionTimeoutMs,
      });
    }
    if (parseConversationId(page.url()) !== context.submission.conversationId) {
      throw new Error("Capture rejected wrong-conversation navigation");
    }
    if (context.submission.committedUserTurnOrdinal === undefined) {
      throw new Error("Capture requires a committed user-turn ordinal");
    }
    const assistant = await waitForStableAssistant(page, {
      conversationId: context.submission.conversationId,
      committedUserTurnOrdinal: context.submission.committedUserTurnOrdinal,
      expectedUserTurnDigest: context.submission.userTurnDigest,
      timeoutMs: context.spec.policy.maxCaptureMs,
    });
    const plainText = `${assistant.text!.trim()}\n`;
    const answerBytes = Buffer.from(plainText, "utf8");
    const result: ProviderCaptureResult = {
      answerBytes,
      plainTextBytes: answerBytes,
      htmlBytes: Buffer.from(assistant.html ?? "", "utf8"),
      mediaType: "text/plain",
      receipt: {
        conversationId: context.submission.conversationId,
        assistantTurnDigest: digest(Buffer.from(assistant.text!, "utf8")),
        responseSha256: digest(answerBytes),
        capturedAt: new Date().toISOString(),
        completionEvidence: [
          `assistant-successor:${assistant.turnIndex}`,
          "generation-control-absent",
          "finished-action-visible",
          "stable-content",
        ],
        markdownQuality: "plain-text",
        adapterVersion: this.adapterVersion,
        warnings: ["native markdown capture is not part of the R7 canary contract"],
      },
    };
    await page.close();
    return result;
  }

  openPageCount(): number {
    return this.pages.size;
  }

  async close(): Promise<void> {
    this.tabBudget.close();
    await Promise.allSettled([...this.pages.values()].map((page) => page.close()));
    for (const release of this.pageReleases.values()) release();
    this.pages.clear();
    this.pageReleases.clear();
    this.pageCreations.clear();
  }

  private async pageFor(jobId: string, initialUrl: string): Promise<Page> {
    const existing = this.pages.get(jobId);
    if (existing && !existing.isClosed()) return existing;
    if (existing) this.releasePage(jobId, existing);
    const pending = this.pageCreations.get(jobId);
    if (pending) return pending;
    const creation = this.openOwnedPage(jobId, initialUrl);
    this.pageCreations.set(jobId, creation);
    try {
      return await creation;
    } finally {
      this.pageCreations.delete(jobId);
    }
  }

  private async openOwnedPage(jobId: string, initialUrl: string): Promise<Page> {
    const release = await this.tabBudget.acquire();
    try {
      const contextPageCount = await waitForContextPageSlot(this.context, 1_000);
      if (contextPageCount >= MAX_OWNED_CHATGPT_TABS) {
        throw new Error(
          `Oracle v2 dedicated browser already has ${contextPageCount} pages (${this.pages.size} adapter-owned); refusing to exceed ${MAX_OWNED_CHATGPT_TABS}`,
        );
      }
      const page = await this.openTarget(initialUrl);
      this.pages.set(jobId, page);
      this.pageReleases.set(jobId, release);
      page.once("close", () => this.releasePage(jobId, page));
      return page;
    } catch (error) {
      release();
      throw error;
    }
  }

  private releasePage(jobId: string, page: Page): void {
    if (this.pages.get(jobId) !== page) return;
    this.pages.delete(jobId);
    const release = this.pageReleases.get(jobId);
    this.pageReleases.delete(jobId);
    release?.();
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

async function waitForContextPageSlot(context: BrowserContext, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let count = context.pages().filter((page) => !page.isClosed()).length;
  while (count >= MAX_OWNED_CHATGPT_TABS && Date.now() < deadline) {
    await delay(25);
    count = context.pages().filter((page) => !page.isClosed()).length;
  }
  return count;
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

function bundleFilename(sha256: string, mediaType = "text/markdown"): string {
  const extension =
    mediaType === "application/zip"
      ? "zip"
      : mediaType === "text/plain"
        ? "txt"
        : mediaType === "application/pdf"
          ? "pdf"
          : "md";
  return `oracle-source-${sha256.slice(0, 12)}.${extension}`;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizeComposerText(value: string): string {
  return value.replaceAll("\u00a0", " ").replaceAll("\r\n", "\n").trim();
}

function normalizeTurnText(value: string): string {
  return value
    .toLowerCase()
    .replace(/```[^\n]*\n([\s\S]*?)```/gu, " $1 ")
    .replace(/```/gu, " ")
    .replace(/`([^`]*)`/gu, "$1")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizedTurnDigest(value: string): string {
  return digest(Buffer.from(normalizeTurnText(value), "utf8"));
}

async function waitForEnabled(locator: Locator, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await locator.isVisible()) || !(await locator.isEnabled())) {
    if (Date.now() >= deadline) throw new Error("Send control did not become enabled");
    await delay(50);
  }
}

async function observeConversationBaseline(page: Page): Promise<ConversationBaseline> {
  const turns = await conversationTurns(page);
  const turnCount = await turns.count();
  const roles: string[] = [];
  for (let index = 0; index < turnCount; index += 1) {
    roles.push(await readTurnRole(turns.nth(index)));
  }
  const observation = {
    conversationId: parseConversationId(page.url()) ?? null,
    turnCount,
    roles,
  };
  return {
    turnCount,
    digest: digest(Buffer.from(JSON.stringify(observation), "utf8")),
  };
}

async function waitForComposerAttachment(
  page: Page,
  filename: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let readySince: number | undefined;
  while (Date.now() < deadline) {
    const composer = chatGptLocators(page).composer;
    const form = composer.locator("xpath=ancestor::form[1]");
    if ((await form.count()) !== 1) {
      await delay(50);
      continue;
    }
    const evidenceCount = await matchingAttachmentEvidenceCount(form, filename);
    const uploading = await hasUploadingSignal(form);
    if (evidenceCount === 1 && !uploading) {
      readySince ??= Date.now();
      if (Date.now() - readySince >= 250) return;
    } else {
      readySince = undefined;
      if (evidenceCount > 1) {
        throw new Error("Bundle preparation requires exactly one composer-anchored artifact");
      }
    }
    await delay(50);
  }
  throw new Error("Bundle preparation did not expose one settled composer-anchored artifact");
}

async function waitForCommittedTurn(
  page: Page,
  options: {
    expectedUserTurnDigest: string;
    baselineTurnCount: number;
    bundleFilename?: string;
    timeoutMs: number;
  },
): Promise<CommittedTurnObservation | undefined> {
  const deadline = Date.now() + options.timeoutMs;
  const stabilityMs = Math.min(750, Math.max(250, Math.floor(options.timeoutMs / 3)));
  let candidateKey = "";
  let stableSince: number | undefined;
  while (Date.now() < deadline) {
    const turns = await conversationTurns(page);
    const count = await turns.count();
    let candidate: CommittedTurnObservation | undefined;
    for (let index = options.baselineTurnCount; index < count; index += 1) {
      const turn = turns.nth(index);
      if ((await readTurnRole(turn)) !== "user") continue;
      const userTurnDigest = normalizedTurnDigest(await readUserTurnText(turn));
      if (userTurnDigest !== options.expectedUserTurnDigest) continue;
      const conversationId = parseConversationId(page.url());
      if (!conversationId) break;
      const bundleVerified = options.bundleFilename
        ? (await matchingCommittedAttachmentCount(turn, options.bundleFilename)) === 1
        : true;
      if (!bundleVerified) break;
      candidate = {
        conversationId,
        conversationUrl: page.url(),
        turnIndex: index,
        userTurnDigest,
        bundleVerified,
      };
      break;
    }
    if (candidate) {
      const nextKey = JSON.stringify(candidate);
      if (nextKey === candidateKey) {
        stableSince ??= Date.now();
        if (Date.now() - stableSince >= stabilityMs) return candidate;
      } else {
        candidateKey = nextKey;
        stableSince = Date.now();
      }
    } else {
      candidateKey = "";
      stableSince = undefined;
    }
    await delay(100);
  }
  return undefined;
}

async function waitForStableAssistant(
  page: Page,
  options: {
    conversationId: string;
    committedUserTurnOrdinal: number;
    expectedUserTurnDigest: string;
    timeoutMs: number;
  },
): Promise<AssistantObservation> {
  const deadline = Date.now() + options.timeoutMs;
  let previousKey = "";
  let stableSince: number | undefined;
  while (Date.now() < deadline) {
    const observation = await observeAssistant(page, options);
    if (observation.status === "identity-mismatch") {
      throw new Error("Capture rejected committed user-turn identity mismatch");
    }
    const ready =
      observation.status === "ready" &&
      Boolean(observation.text?.trim()) &&
      observation.streaming !== true &&
      observation.stopVisible === false &&
      observation.finishedActionVisible === true;
    if (ready) {
      const key = digest(
        Buffer.from(
          JSON.stringify({
            turnIndex: observation.turnIndex,
            text: observation.text,
            html: observation.html,
          }),
          "utf8",
        ),
      );
      if (key === previousKey) {
        stableSince ??= Date.now();
        if (Date.now() - stableSince >= 500) return observation;
      } else {
        previousKey = key;
        stableSince = undefined;
      }
    } else {
      previousKey = "";
      stableSince = undefined;
    }
    await delay(250);
  }
  throw new Error("Assistant successor did not reach a stable completed state before timeout");
}

async function observeAssistant(
  page: Page,
  options: {
    conversationId: string;
    committedUserTurnOrdinal: number;
    expectedUserTurnDigest: string;
  },
): Promise<AssistantObservation> {
  if (parseConversationId(page.url()) !== options.conversationId) {
    return { status: "identity-mismatch" };
  }
  const turns = await conversationTurns(page);
  const count = await turns.count();
  if (options.committedUserTurnOrdinal >= count) return { status: "pending" };
  const userTurn = turns.nth(options.committedUserTurnOrdinal);
  if ((await readTurnRole(userTurn)) !== "user") {
    return { status: "identity-mismatch" };
  }
  if (normalizedTurnDigest(await readUserTurnText(userTurn)) !== options.expectedUserTurnDigest) {
    return { status: "identity-mismatch" };
  }
  let assistantTurnIndex = -1;
  for (let index = options.committedUserTurnOrdinal + 1; index < count; index += 1) {
    const role = await readTurnRole(turns.nth(index));
    if (role === "user") break;
    if (role === "assistant") {
      assistantTurnIndex = index;
      break;
    }
  }
  if (assistantTurnIndex < 0) return { status: "pending" };
  const assistant = turns.nth(assistantTurnIndex);
  const contentCandidates = assistant.locator(CHATGPT_ASSISTANT_CONTENT_SELECTOR);
  const content = (await contentCandidates.count()) > 0 ? contentCandidates.first() : assistant;
  const text = (await content.innerText().catch(() => content.textContent())) ?? "";
  const html = await content.innerHTML().catch(() => "");
  const stopVisible = await anyVisible(page.locator(CHATGPT_STOP_SELECTOR));
  const finishedActionVisible = await anyVisible(
    assistant.locator(CHATGPT_FINISHED_ACTION_SELECTOR),
  );
  const streaming =
    (await assistant.getAttribute("data-streaming")) === "true" ||
    (await assistant.locator('[data-streaming="true"]').count()) > 0;
  return {
    status: "ready",
    turnIndex: assistantTurnIndex,
    text,
    html,
    streaming,
    stopVisible,
    finishedActionVisible,
  };
}

async function conversationTurns(page: Page): Promise<Locator> {
  const containers = page.locator(CHATGPT_TURN_CONTAINER_SELECTOR);
  return (await containers.count()) > 0 ? containers : page.locator(CHATGPT_TURN_FALLBACK_SELECTOR);
}

async function readTurnRole(turn: Locator): Promise<string> {
  const direct =
    (await turn.getAttribute("data-message-author-role")) ?? (await turn.getAttribute("data-turn"));
  if (direct) return direct.toLowerCase();
  const nested = turn.locator("[data-message-author-role], [data-turn]").first();
  if ((await nested.count()) === 0) return "unknown";
  return (
    (await nested.getAttribute("data-message-author-role")) ??
    (await nested.getAttribute("data-turn")) ??
    "unknown"
  ).toLowerCase();
}

async function readUserTurnText(turn: Locator): Promise<string> {
  const directRole = await readTurnRole(turn);
  const roleNode =
    directRole === "user"
      ? turn
      : turn.locator('[data-message-author-role="user"], [data-turn="user"]').first();
  const semantic = roleNode.locator(".whitespace-pre-wrap, [data-message-content]").first();
  const node = (await semantic.count()) > 0 ? semantic : roleNode;
  return (await node.innerText().catch(() => node.textContent())) ?? "";
}

async function matchingAttachmentEvidenceCount(scope: Locator, filename: string): Promise<number> {
  const normalized = filename.toLowerCase();
  const exactAccessibleMatches = await matchingAccessibleFilenameCount(scope, normalized);
  if (exactAccessibleMatches > 0) return exactAccessibleMatches;
  const removeButtons = scope.locator(
    'button[aria-label*="remove" i], button[data-testid*="remove" i], button[title*="remove" i]',
  );
  let matchingRemoveButtons = 0;
  for (let index = 0; index < (await removeButtons.count()); index += 1) {
    let node = removeButtons.nth(index);
    for (let depth = 0; depth < 4; depth += 1) {
      if (((await node.textContent()) ?? "").toLowerCase().includes(normalized)) {
        matchingRemoveButtons += 1;
        break;
      }
      node = node.locator("xpath=..");
    }
  }
  if (matchingRemoveButtons > 0) return matchingRemoveButtons;
  const roots = scope.locator(
    '[data-testid*="attachment"], [data-testid*="upload"], [data-testid*="file"]',
  );
  let matchingRoots = 0;
  for (let index = 0; index < (await roots.count()); index += 1) {
    const root = roots.nth(index);
    const values = [
      (await root.textContent()) ?? "",
      (await root.getAttribute("aria-label")) ?? "",
      (await root.getAttribute("title")) ?? "",
    ];
    if (values.some((value) => value.toLowerCase().includes(normalized))) matchingRoots += 1;
  }
  return matchingRoots;
}

async function matchingCommittedAttachmentCount(turn: Locator, filename: string): Promise<number> {
  const normalized = filename.toLowerCase();
  const exactAccessibleMatches = await matchingAccessibleFilenameCount(turn, normalized);
  if (exactAccessibleMatches > 0) return exactAccessibleMatches;
  const nodes = turn.locator(
    '[data-testid*="attachment"], [data-testid*="upload"], [data-testid*="file"], [aria-label*="file" i], [aria-label*="attachment" i], [title*="file" i], [title*="attachment" i]',
  );
  let matches = 0;
  for (let index = 0; index < (await nodes.count()); index += 1) {
    const node = nodes.nth(index);
    const values = [
      (await node.textContent()) ?? "",
      (await node.getAttribute("aria-label")) ?? "",
      (await node.getAttribute("title")) ?? "",
    ];
    if (values.some((value) => value.toLowerCase().includes(normalized))) matches += 1;
  }
  return matches;
}

async function matchingAccessibleFilenameCount(
  scope: Locator,
  normalizedFilename: string,
): Promise<number> {
  const interactive = scope.locator(
    'button[aria-label], [role="button"][aria-label], a[aria-label]',
  );
  let matches = 0;
  for (let index = 0; index < (await interactive.count()); index += 1) {
    const label = ((await interactive.nth(index).getAttribute("aria-label")) ?? "")
      .trim()
      .toLowerCase();
    if (matchesCanonicalAttachmentFilename(label, normalizedFilename)) matches += 1;
  }
  return matches;
}

function matchesCanonicalAttachmentFilename(
  observedLabel: string,
  canonicalFilename: string,
): boolean {
  if (observedLabel === canonicalFilename) return true;
  const extensionOffset = canonicalFilename.lastIndexOf(".");
  if (extensionOffset <= 0) return false;
  const stem = canonicalFilename.slice(0, extensionOffset);
  const extension = canonicalFilename.slice(extensionOffset);
  const prefix = `${stem}(`;
  const suffix = `)${extension}`;
  if (!observedLabel.startsWith(prefix) || !observedLabel.endsWith(suffix)) return false;
  const duplicateOrdinal = observedLabel.slice(prefix.length, -suffix.length);
  return /^[1-9]\d*$/u.test(duplicateOrdinal);
}

async function hasUploadingSignal(form: Locator): Promise<boolean> {
  const signals = form.locator(
    '[aria-busy="true"], [data-state="uploading"], [data-state="loading"], [role="status"]',
  );
  for (let index = 0; index < (await signals.count()); index += 1) {
    const signal = signals.nth(index);
    const state = (await signal.getAttribute("data-state"))?.toLowerCase();
    const text = ((await signal.textContent()) ?? "").toLowerCase();
    if (
      (await signal.getAttribute("aria-busy")) === "true" ||
      state === "uploading" ||
      state === "loading" ||
      /\b(?:uploading|processing)\b/u.test(text)
    ) {
      return true;
    }
  }
  return false;
}

async function anyVisible(locator: Locator): Promise<boolean> {
  for (let index = 0; index < (await locator.count()); index += 1) {
    if (await locator.nth(index).isVisible()) return true;
  }
  return false;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
