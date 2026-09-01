import { createHash } from "node:crypto";
import type { Page } from "playwright-core";
import { chatGptLocators } from "./selectors.js";

export interface UiFingerprintObservation {
  digest: string;
  locale: string;
  structure: {
    locatorFamily: "role-name+stable-attributes";
    modelControl: "menu" | "missing";
    effortControl: "slider" | "missing";
    effortRange?: { min: string; max: string };
    attachmentSurface: "file-input" | "missing";
    messageTurnAttribute: "data-message-author-role" | "missing";
  };
}

export async function observeUiFingerprint(page: Page): Promise<UiFingerprintObservation> {
  const locators = chatGptLocators(page);
  const modelControl = (await locators.modelButton.count()) === 1 ? "menu" : "missing";
  const effortControl = (await locators.effort.count()) === 1 ? "slider" : "missing";
  const effortRange =
    effortControl === "slider"
      ? {
          min: (await locators.effort.getAttribute("min")) ?? "",
          max: (await locators.effort.getAttribute("max")) ?? "",
        }
      : undefined;
  const structure: UiFingerprintObservation["structure"] = {
    locatorFamily: "role-name+stable-attributes",
    modelControl,
    effortControl,
    ...(effortRange ? { effortRange } : {}),
    attachmentSurface:
      (await locators.attachmentButton.count()) === 1 && (await locators.uploadInput.count()) === 1
        ? "file-input"
        : "missing",
    messageTurnAttribute:
      (await locators.conversation.count()) === 1 ? "data-message-author-role" : "missing",
  };
  const locale = await page.locator("html").getAttribute("lang");
  const serialized = JSON.stringify({ locale: locale ?? "unknown", structure });
  return {
    digest: createHash("sha256").update(serialized).digest("hex"),
    locale: locale ?? "unknown",
    structure,
  };
}
