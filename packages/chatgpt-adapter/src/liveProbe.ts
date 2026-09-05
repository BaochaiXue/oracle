import { PROVIDER_CAPABILITIES, type CompatibilityReceipt } from "../../oracle-kernel/src/index.js";
import type { Page } from "playwright-core";
import { probeModelAndEffortControls } from "./noSendProbe.js";
import { probeCompatibility } from "./probe.js";
import { chatGptLocators } from "./selectors.js";

export interface LiveCompatibilityProbeOptions {
  adapterVersion: string;
  browserRuntimeId: string;
  timeoutMs: number;
}

export async function probeLiveCompatibilityWithoutSend(
  page: Page,
  options: LiveCompatibilityProbeOptions,
): Promise<CompatibilityReceipt> {
  const passive = await probeCompatibility(page, options);
  if (
    passive.capabilities.loginState !== "verified" ||
    passive.capabilities.composer !== "verified"
  ) {
    return passive;
  }
  const rateLimited =
    (await page
      .getByRole("alert")
      .filter({ hasText: /rate limit/i })
      .count()) > 0;
  const modelAndEffort = await probeModelAndEffortControls(page, {
    timeoutMs: options.timeoutMs,
  });
  const sendControlVerified = rateLimited
    ? false
    : await probeComposerAndSendControlWithoutSend(page, options.timeoutMs);
  const capabilities: CompatibilityReceipt["capabilities"] = {
    ...passive.capabilities,
    modelControl: modelAndEffort.playwrightClickWorked ? "verified" : "missing",
    modelVerification: modelAndEffort.modelVerified ? "verified" : "missing",
    effortVerification: modelAndEffort.effortVerified ? "verified" : "missing",
    sendControl: sendControlVerified ? "verified" : "missing",
  };
  return {
    ...passive,
    compatible: PROVIDER_CAPABILITIES.every(
      (capability) => capabilities[capability] === "verified",
    ),
    capabilities,
    probedAt: new Date().toISOString(),
  };
}

async function probeComposerAndSendControlWithoutSend(
  page: Page,
  timeoutMs: number,
): Promise<boolean> {
  const marker = "Oracle v2 synthetic no-Send composer control probe.";
  const locators = chatGptLocators(page);
  const beforeUrl = page.url();
  try {
    await locators.composer.fill(marker, { timeout: timeoutMs });
    await locators.send.waitFor({ state: "visible", timeout: timeoutMs });
    return (await locators.send.isEnabled()) && page.url() === beforeUrl;
  } finally {
    await locators.composer.fill("").catch(() => undefined);
  }
}
