import { Buffer } from "node:buffer";
import type { Page, Request } from "playwright-core";
import { chatGptLocators } from "./selectors.js";

export interface AttemptSandboxPageObservation {
  schemaVersion: "oracle.attempt-sandbox-page-observation.v1";
  composerPresent: boolean;
  composerEmpty: boolean;
  markerPresent: boolean;
  attachmentPresent: boolean;
  attachmentInputSelected: boolean;
  userTurnPresent: boolean;
  conversationRoutePresent: boolean;
  recoveryWindowNamePresent: boolean;
  recoveryStoragePresent: boolean;
  promptSubmitted: false;
}

export interface PotentialSubmissionMonitor {
  count(): number;
  stop(): void;
}

export interface StableAttemptSandboxPageDependencies {
  observe?: typeof observeAttemptSandboxPage;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
  waitForReady?: (page: Page, timeoutMs: number) => Promise<void>;
}

export function monitorPotentialSubmissions(page: Page): PotentialSubmissionMonitor {
  let submissionCount = 0;
  const observe = (request: Request) => {
    if (request.method() !== "POST") return;
    try {
      const pathname = new URL(request.url()).pathname;
      if (
        pathname === "/backend-api/conversation" ||
        pathname === "/api/send" ||
        pathname.endsWith("/conversation") ||
        pathname.includes("/conversation/submit")
      ) {
        submissionCount += 1;
      }
    } catch {
      // An unparseable request URL is not treated as permission to submit.
    }
  };
  page.on("request", observe);
  return {
    count: () => submissionCount,
    stop: () => page.off("request", observe),
  };
}

export async function observeAttemptSandboxPage(
  page: Page,
  input: { marker: string; filename: string },
): Promise<AttemptSandboxPageObservation> {
  const locators = chatGptLocators(page);
  const composerPresent = (await locators.composer.count()) === 1;
  const form = composerPresent ? locators.composer.locator("xpath=ancestor::form[1]") : undefined;
  const state = composerPresent
    ? await locators.composer.evaluate((node, marker) => {
        const element = node as HTMLElement & { value?: string };
        const contents =
          typeof element.value === "string"
            ? element.value
            : element.innerText || element.textContent;
        return {
          empty: !(contents ?? "").trim(),
          markerPresent: (contents ?? "").includes(marker),
        };
      }, input.marker)
    : { empty: false, markerPresent: false };
  const namedAttachmentPresent = form
    ? (await form
        .getByText(input.filename, { exact: false })
        .or(form.locator(`[title="${cssAttributeValue(input.filename)}"]`))
        .count()) > 0
    : false;
  const attachmentInputSelected = form
    ? await form
        .locator('input[type="file"]')
        .evaluateAll(
          (inputs, filename) =>
            inputs.some((input) =>
              Array.from((input as HTMLInputElement).files ?? []).some(
                (file) => file.name === filename,
              ),
            ),
          input.filename,
        )
    : false;
  const attachmentChipPresent = form
    ? (await form
        .locator(
          '[data-testid*="attachment"]:visible, [data-testid*="upload"]:visible, [data-testid*="file"]:visible, button[aria-label*="Remove attachment" i]:visible, button[aria-label*="Remove file" i]:visible',
        )
        .count()) > 0
    : false;
  const recovery = await page.evaluate(() => ({
    windowNamePresent: /oracle-v2-(?:at-risk|target|recovery)/u.test(window.name),
    storagePresent: Object.keys(localStorage).some((key) =>
      /oracle.*(?:at-risk|target|recovery)|(?:at-risk|target|recovery).*oracle/iu.test(key),
    ),
  }));
  return {
    schemaVersion: "oracle.attempt-sandbox-page-observation.v1",
    composerPresent,
    composerEmpty: state.empty,
    markerPresent: state.markerPresent,
    attachmentPresent: namedAttachmentPresent || attachmentInputSelected || attachmentChipPresent,
    attachmentInputSelected,
    userTurnPresent: (await locators.userTurns.count()) > 0,
    conversationRoutePresent: new URL(page.url()).pathname.startsWith("/c/"),
    recoveryWindowNamePresent: recovery.windowNamePresent,
    recoveryStoragePresent: recovery.storagePresent,
    promptSubmitted: false,
  };
}

export async function observeStableAttemptSandboxPage(
  page: Page,
  input: {
    marker: string;
    filename: string;
    timeoutMs: number;
    quietPeriodMs?: number;
    pollIntervalMs?: number;
  },
  dependencies: StableAttemptSandboxPageDependencies = {},
): Promise<AttemptSandboxPageObservation> {
  const observe = dependencies.observe ?? observeAttemptSandboxPage;
  const now = dependencies.now ?? Date.now;
  const wait = dependencies.wait ?? ((milliseconds) => page.waitForTimeout(milliseconds));
  const waitForReady =
    dependencies.waitForReady ??
    ((target, timeoutMs) => target.waitForLoadState("domcontentloaded", { timeout: timeoutMs }));
  const quietPeriodMs = input.quietPeriodMs ?? 5_000;
  const pollIntervalMs = input.pollIntervalMs ?? 250;
  const deadline = now() + input.timeoutMs;
  await waitForReady(page, input.timeoutMs);
  let stableFingerprint: string | undefined;
  let stableSince = 0;
  while (now() <= deadline) {
    const observation = await observe(page, input);
    const fingerprint = JSON.stringify(observation);
    if (!observation.composerPresent) {
      stableFingerprint = undefined;
      stableSince = 0;
    } else if (fingerprint !== stableFingerprint) {
      stableFingerprint = fingerprint;
      stableSince = now();
    } else if (now() - stableSince >= quietPeriodMs) {
      return observation;
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await wait(Math.min(pollIntervalMs, remaining));
  }
  throw new Error("Attempt sandbox page did not reach a stable initial state before timeout");
}

export async function dirtyAttemptSandboxWithoutSend(
  page: Page,
  input: { marker: string; filename: string; timeoutMs: number },
): Promise<AttemptSandboxPageObservation> {
  const locators = chatGptLocators(page);
  await locators.composer.waitFor({ state: "visible", timeout: input.timeoutMs });
  const form = locators.composer.locator("xpath=ancestor::form[1]");
  if ((await form.count()) !== 1 || (await locators.uploadInput.count()) !== 1) {
    throw new Error("Attempt sandbox no-Send probe could not bind one composer and file input");
  }
  await locators.composer.fill(input.marker, { timeout: input.timeoutMs });
  await locators.attachmentButton.click({ timeout: input.timeoutMs });
  await page.waitForTimeout(250);
  await locators.uploadInput.setInputFiles({
    name: input.filename,
    mimeType: "text/plain",
    buffer: Buffer.from("Oracle disposable attempt sandbox no-Send proof.\n", "utf8"),
  });
  await form
    .getByText(input.filename, { exact: false })
    .or(form.locator(`[title="${cssAttributeValue(input.filename)}"]`))
    .first()
    .waitFor({ state: "visible", timeout: input.timeoutMs });
  return observeAttemptSandboxPage(page, input);
}

function cssAttributeValue(value: string): string {
  return value.replace(/["\\]/gu, "\\$&");
}
