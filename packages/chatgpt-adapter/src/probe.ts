import { PROVIDER_CAPABILITIES, type CompatibilityReceipt } from "../../oracle-kernel/src/index.js";
import type { Page } from "playwright-core";
import { observeUiFingerprint } from "./fingerprint.js";
import { chatGptLocators } from "./selectors.js";

export interface ProbeOptions {
  adapterVersion: string;
  browserRuntimeId: string;
  timeoutMs: number;
}

export async function probeCompatibility(
  page: Page,
  options: ProbeOptions,
): Promise<CompatibilityReceipt> {
  const locators = chatGptLocators(page);
  await page.waitForLoadState("domcontentloaded");
  await locators.composer.waitFor({ state: "visible", timeout: options.timeoutMs }).catch(() => {});
  const present = async (count: () => Promise<number>) =>
    (await count()) === 1 ? ("verified" as const) : ("missing" as const);
  const rateLimited = await page
    .getByRole("alert")
    .filter({ hasText: /rate limit/i })
    .count();
  const capabilities: CompatibilityReceipt["capabilities"] = {
    loginState:
      (await locators.login.count()) === 0 && (await locators.composer.count()) === 1
        ? "verified"
        : "missing",
    composer: await present(() => locators.composer.count()),
    modelControl: await present(() => locators.modelButton.count()),
    modelVerification: await present(() => locators.modelButton.count()),
    effortVerification: await present(() => locators.effort.count()),
    attachmentControl:
      (await locators.attachmentButton.count()) === 1 && (await locators.uploadInput.count()) === 1
        ? "verified"
        : "missing",
    sendControl: rateLimited === 0 ? await present(() => locators.send.count()) : "missing",
    userTurnLocator: await present(() => locators.conversation.count()),
    assistantTurnLocator: await present(() => locators.conversation.count()),
    conversationUrlParser: parseConversationId("https://fixture.invalid/c/probe")
      ? "verified"
      : "missing",
  };
  const fingerprint = await observeUiFingerprint(page);
  return {
    compatible: PROVIDER_CAPABILITIES.every(
      (capability) => capabilities[capability] === "verified",
    ),
    adapterVersion: options.adapterVersion,
    browserRuntimeId: options.browserRuntimeId,
    uiFingerprint: fingerprint.digest,
    locale: fingerprint.locale,
    capabilities,
    probedAt: new Date().toISOString(),
  };
}

export function parseConversationId(url: string): string | undefined {
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/^\/c\/([^/?#]+)$/u);
    return match ? decodeURIComponent(match[1]!) : undefined;
  } catch {
    return undefined;
  }
}
