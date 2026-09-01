import { Buffer } from "node:buffer";
import type { Locator, Page } from "playwright-core";
import { chatGptLocators } from "./selectors.js";

export interface ModelAndEffortProbeResult {
  schemaVersion: "oracle.chatgpt-model-effort-probe.v2";
  modelLabel: "GPT-5.6 Sol" | "missing";
  effortLabel: "Pro" | "missing";
  modelVerified: boolean;
  effortVerified: boolean;
  playwrightClickWorked: boolean;
  pickerKind: "intelligence-picker" | "menu" | "missing";
  promptSubmitted: false;
}

export interface AttachmentNoSendProbeResult {
  schemaVersion: "oracle.chatgpt-attachment-probe.v2";
  filename: "oracle-v2-no-send-probe.md";
  uploadInputVerified: boolean;
  composerAnchored: boolean;
  removedAfterProbe: boolean;
  blockingModalDismissed: boolean;
  promptSubmitted: false;
}

interface PickerObservation {
  modelFound: boolean;
  modelSelected: boolean;
  effortFound: boolean;
  effortSelected: boolean;
  advanced?: Locator;
  intelligencePicker: boolean;
}

export async function probeModelAndEffortControls(
  page: Page,
  options: { timeoutMs: number },
): Promise<ModelAndEffortProbeResult> {
  const modelButton = chatGptLocators(page).modelButton;
  await dismissConversationHistoryRateLimitModal(page, options.timeoutMs);
  await modelButton.waitFor({ state: "visible", timeout: options.timeoutMs });
  const initialTextLabel = normalizeControlLabel((await modelButton.textContent()) ?? "");
  const initialAriaLabel = normalizeControlLabel(
    (await modelButton.getAttribute("aria-label")) ?? "",
  );
  const initialLabel = initialTextLabel === "other" ? initialAriaLabel : initialTextLabel;
  let clicked = false;
  let observation: PickerObservation = {
    modelFound: false,
    modelSelected: false,
    effortFound: false,
    effortSelected: false,
    intelligencePicker: false,
  };
  try {
    await clickModelButtonWithLateModalRecovery(page, modelButton, options.timeoutMs);
    clicked = true;
    await waitForPicker(page, options.timeoutMs);
    observation = await inspectPicker(page);
    if (!observation.modelSelected && observation.advanced) {
      await observation.advanced.click({ timeout: options.timeoutMs });
      await page.waitForTimeout(100);
      observation = mergeObservations(observation, await inspectPicker(page));
    }
  } finally {
    if (clicked) {
      await page.keyboard.press("Escape").catch(() => undefined);
      await page.keyboard.press("Escape").catch(() => undefined);
      const picker = page
        .locator(
          '[data-testid="composer-intelligence-picker-content"]:visible, [role="menu"]:visible',
        )
        .first();
      if ((await picker.count()) > 0 && (await picker.isVisible())) {
        await modelButton.click({ timeout: options.timeoutMs }).catch(() => undefined);
      }
    }
  }

  const effortVerified =
    observation.effortSelected || (initialLabel === "Pro" && observation.intelligencePicker);
  return {
    schemaVersion: "oracle.chatgpt-model-effort-probe.v2",
    modelLabel: observation.modelSelected ? "GPT-5.6 Sol" : "missing",
    effortLabel: effortVerified ? "Pro" : "missing",
    modelVerified: observation.modelSelected,
    effortVerified,
    playwrightClickWorked: clicked,
    pickerKind: observation.intelligencePicker
      ? "intelligence-picker"
      : clicked
        ? "menu"
        : "missing",
    promptSubmitted: false,
  };
}

export async function probeAttachmentWithoutSend(
  page: Page,
  options: { timeoutMs: number },
): Promise<AttachmentNoSendProbeResult> {
  const filename = "oracle-v2-no-send-probe.md" as const;
  const locators = chatGptLocators(page);
  await locators.composer.waitFor({ state: "visible", timeout: options.timeoutMs });
  const blockingModalDismissed = await dismissConversationHistoryRateLimitModal(
    page,
    options.timeoutMs,
  );
  const form = locators.composer.locator("xpath=ancestor::form[1]");
  if ((await form.count()) !== 1 || (await locators.uploadInput.count()) !== 1) {
    return {
      schemaVersion: "oracle.chatgpt-attachment-probe.v2",
      filename,
      uploadInputVerified: false,
      composerAnchored: false,
      removedAfterProbe: false,
      blockingModalDismissed,
      promptSubmitted: false,
    };
  }

  const filenameLabel = form
    .getByText(filename, { exact: false })
    .or(form.locator(`[title="${filename}"], [aria-label*="${filename}"]`))
    .first();
  let composerAnchored = false;
  let removedAfterProbe = false;
  try {
    await locators.attachmentButton.click({ timeout: options.timeoutMs });
    await page.waitForTimeout(250);
    await locators.uploadInput.setInputFiles({
      name: filename,
      mimeType: "text/markdown",
      buffer: Buffer.from("Oracle v2 synthetic no-Send attachment probe.\n", "utf8"),
    });
    await filenameLabel.waitFor({ state: "visible", timeout: options.timeoutMs });
    composerAnchored = (await filenameLabel.count()) === 1;
    await filenameLabel.hover().catch(() => undefined);
    const remove = form
      .locator(
        'button[aria-label*="Remove" i], button[data-testid*="remove" i], button[title*="Remove" i]',
      )
      .first();
    await remove.waitFor({ state: "visible", timeout: options.timeoutMs });
    await remove.click({ timeout: options.timeoutMs });
    await filenameLabel.waitFor({ state: "detached", timeout: options.timeoutMs });
    removedAfterProbe = true;
  } finally {
    if (!removedAfterProbe) {
      await form
        .locator(
          'button[aria-label*="Remove" i], button[data-testid*="remove" i], button[title*="Remove" i]',
        )
        .first()
        .click({ timeout: 1_000 })
        .catch(() => undefined);
    }
    await locators.uploadInput.setInputFiles([]).catch(() => undefined);
    await page.keyboard.press("Escape").catch(() => undefined);
  }
  return {
    schemaVersion: "oracle.chatgpt-attachment-probe.v2",
    filename,
    uploadInputVerified: true,
    composerAnchored,
    removedAfterProbe,
    blockingModalDismissed,
    promptSubmitted: false,
  };
}

async function dismissConversationHistoryRateLimitModal(
  page: Page,
  timeoutMs: number,
): Promise<boolean> {
  const modal = page.locator('[data-testid="modal-conversation-history-rate-limit"]');
  if ((await modal.count()) === 0 || !(await modal.first().isVisible())) return false;
  const close = modal
    .first()
    .getByRole("button", { name: /^(?:close|dismiss|got it|ok|okay)$/iu })
    .first();
  if ((await close.count()) === 1 && (await close.isVisible())) {
    await close.click({ timeout: Math.min(timeoutMs, 5_000) });
  } else {
    await page.keyboard.press("Escape");
  }
  await modal.first().waitFor({ state: "hidden", timeout: Math.min(timeoutMs, 5_000) });
  return true;
}

async function clickModelButtonWithLateModalRecovery(
  page: Page,
  modelButton: Locator,
  timeoutMs: number,
): Promise<void> {
  try {
    await modelButton.click({ timeout: Math.min(timeoutMs, 1_500) });
  } catch (error) {
    const dismissed = await dismissConversationHistoryRateLimitModal(page, timeoutMs);
    if (!dismissed) throw error;
    await modelButton.click({ timeout: timeoutMs });
  }
}

async function waitForPicker(page: Page, timeoutMs: number): Promise<void> {
  const picker = page
    .locator('[data-testid="composer-intelligence-picker-content"]:visible, [role="menu"]:visible')
    .first();
  await picker.waitFor({ state: "visible", timeout: timeoutMs });
}

async function inspectPicker(page: Page): Promise<PickerObservation> {
  const visiblePickers = page.locator(
    '[data-testid="composer-intelligence-picker-content"]:visible, [role="menu"]:visible',
  );
  const result: PickerObservation = {
    modelFound: false,
    modelSelected: false,
    effortFound: false,
    effortSelected: false,
    intelligencePicker:
      (await page.locator('[data-testid="composer-intelligence-picker-content"]:visible').count()) >
      0,
  };
  const pickerCount = await visiblePickers.count();
  for (let pickerIndex = 0; pickerIndex < pickerCount; pickerIndex += 1) {
    const items = visiblePickers
      .nth(pickerIndex)
      .locator('button, [role="menuitem"], [role="menuitemradio"], [role="option"]');
    const itemCount = Math.min(await items.count(), 40);
    for (let itemIndex = 0; itemIndex < itemCount; itemIndex += 1) {
      const item = items.nth(itemIndex);
      const label = normalizeControlLabel(
        `${(await item.getAttribute("aria-label")) ?? ""} ${(await item.textContent()) ?? ""}`,
      );
      const selected = await isSelected(item);
      if (label === "GPT-5.6 Sol") {
        result.modelFound = true;
        result.modelSelected =
          result.modelSelected || selected || (await item.getAttribute("aria-haspopup")) === "menu";
      } else if (label === "Pro") {
        result.effortFound = true;
        result.effortSelected = result.effortSelected || selected;
      } else if (label === "Advanced" && !result.advanced) {
        result.advanced = item;
      }
    }
  }
  return result;
}

async function isSelected(locator: Locator): Promise<boolean> {
  const values = await Promise.all([
    locator.getAttribute("aria-checked"),
    locator.getAttribute("aria-selected"),
    locator.getAttribute("aria-current"),
    locator.getAttribute("data-selected"),
    locator.getAttribute("data-state"),
  ]);
  return values.some((value) =>
    ["true", "checked", "selected", "on"].includes((value ?? "").toLowerCase()),
  );
}

function normalizeControlLabel(value: string): "GPT-5.6 Sol" | "Pro" | "Advanced" | "other" {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (/\bGPT-?5\.6\s+Sol\b/iu.test(normalized)) return "GPT-5.6 Sol";
  if (/^Pro$/iu.test(normalized)) return "Pro";
  if (/^Advanced$/iu.test(normalized)) return "Advanced";
  return "other";
}

function mergeObservations(first: PickerObservation, second: PickerObservation): PickerObservation {
  return {
    modelFound: first.modelFound || second.modelFound,
    modelSelected: first.modelSelected || second.modelSelected,
    effortFound: first.effortFound || second.effortFound,
    effortSelected: first.effortSelected || second.effortSelected,
    ...((second.advanced ?? first.advanced) ? { advanced: second.advanced ?? first.advanced } : {}),
    intelligencePicker: first.intelligencePicker || second.intelligencePicker,
  };
}
