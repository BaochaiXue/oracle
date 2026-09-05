import type { Page } from "playwright-core";
import { CHATGPT_COMPOSER_DOM_SELECTOR } from "./selectors.js";

export interface SanitizedControlNode {
  tag: string;
  id?: string;
  testId?: string;
  role?: string;
  type?: string;
  ariaLabel?: string;
  ariaHaspopup?: string;
  ariaExpanded?: string;
}

export interface ComposerControlSurfaceObservation {
  schemaVersion: "oracle.chatgpt-control-surface.v2";
  composer: {
    present: boolean;
    tag?: string;
    id?: string;
    dataId?: string;
    role?: string;
  };
  composerButtons: SanitizedControlNode[];
  modelCandidates: SanitizedControlNode[];
  modelSignals: Array<SanitizedControlNode & { observedLabel: string }>;
  fileInputCount: number;
  sliderCount: number;
  syntheticProbeAttachmentPresent: boolean;
  syntheticProbeInputSelected: boolean;
  composerContentsObserved: false;
}

export async function observeComposerControlSurface(
  page: Page,
): Promise<ComposerControlSurfaceObservation> {
  const expression = String.raw`(() => {
    const element = Array.from(document.querySelectorAll(${JSON.stringify(CHATGPT_COMPOSER_DOM_SELECTOR)}))
      .find((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && candidate.getAttribute("aria-hidden") !== "true";
      });
    const empty = () => ({
      schemaVersion: "oracle.chatgpt-control-surface.v2",
      composer: { present: false },
      composerButtons: [],
      modelCandidates: [],
      modelSignals: [],
      fileInputCount: 0,
      sliderCount: 0,
      syntheticProbeAttachmentPresent: false,
      syntheticProbeInputSelected: false,
      composerContentsObserved: false,
    });
    if (!element) return empty();
    const sanitize = (value, limit = 100) => {
      const normalized = String(value ?? "")
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "[redacted-email]")
        .replace(/\b[A-Za-z0-9_-]{32,}\b/gu, "[redacted]")
        .replace(/\s+/gu, " ")
        .trim()
        .slice(0, limit);
      return normalized || undefined;
    };
    const describe = (node) => ({
      tag: node.tagName,
      ...(sanitize(node.getAttribute("id")) ? { id: sanitize(node.getAttribute("id")) } : {}),
      ...(sanitize(node.getAttribute("data-testid")) ? { testId: sanitize(node.getAttribute("data-testid")) } : {}),
      ...(sanitize(node.getAttribute("role")) ? { role: sanitize(node.getAttribute("role")) } : {}),
      ...(sanitize(node.getAttribute("type")) ? { type: sanitize(node.getAttribute("type")) } : {}),
      ...(sanitize(node.getAttribute("aria-label")) ? { ariaLabel: sanitize(node.getAttribute("aria-label")) } : {}),
      ...(sanitize(node.getAttribute("aria-haspopup")) ? { ariaHaspopup: sanitize(node.getAttribute("aria-haspopup")) } : {}),
      ...(sanitize(node.getAttribute("aria-expanded")) ? { ariaExpanded: sanitize(node.getAttribute("aria-expanded")) } : {}),
    });
    const form = element.closest("form") ?? element.parentElement;
    const composerButtons = form
      ? Array.from(form.querySelectorAll("button")).slice(0, 16).map(describe)
      : [];
    const modelControlSelector = [
      '[data-testid*="model-switcher"]',
      '[data-testid*="model-picker"]',
      '[data-testid*="intelligence"]',
      'button.__composer-pill[aria-haspopup="menu"]',
      'button[aria-label="Choose model" i]',
      'button[aria-label*="model" i]',
      'button[aria-label*="intelligence" i]',
    ].join(', ');
    const modelControlNodes = Array.from(document.querySelectorAll(modelControlSelector)).slice(0, 12);
    const modelCandidates = modelControlNodes.map(describe);
    const allowedModelLabel = /^(?:ChatGPT|Auto|GPT(?:[- ]?[0-9][A-Za-z0-9. +·-]*)?|Instant|Thinking|Pro(?: (?:Standard|Extended))?)$/iu;
    const modelSignals = modelControlNodes
          .map((node) => {
            const ariaLabel = String(node.getAttribute("aria-label") ?? "").trim();
            const textLabel = String(node.textContent ?? "").replace(/\s+/gu, " ").trim();
            const observedLabel = allowedModelLabel.test(ariaLabel)
              ? ariaLabel
              : allowedModelLabel.test(textLabel)
                ? textLabel
                : "";
            return observedLabel ? { ...describe(node), observedLabel } : null;
          })
          .filter(Boolean)
          .slice(0, 6);
    const syntheticFilename = "oracle-v2-no-send-probe.md";
    const syntheticProbeAttachmentPresent = form
      ? Array.from(form.querySelectorAll("*")).some((node) =>
          String(node.textContent ?? "").includes(syntheticFilename)
        )
      : false;
    const syntheticProbeInputSelected = form
      ? Array.from(form.querySelectorAll('input[type="file"]')).some((input) =>
          Array.from(input.files ?? []).some((file) => file.name === syntheticFilename)
        )
      : false;
    return {
      schemaVersion: "oracle.chatgpt-control-surface.v2",
      composer: {
        present: true,
        tag: element.tagName,
        ...(sanitize(element.getAttribute("id")) ? { id: sanitize(element.getAttribute("id")) } : {}),
        ...(sanitize(element.getAttribute("data-id")) ? { dataId: sanitize(element.getAttribute("data-id")) } : {}),
        ...(sanitize(element.getAttribute("role")) ? { role: sanitize(element.getAttribute("role")) } : {}),
      },
      composerButtons,
      modelCandidates,
      modelSignals,
      fileInputCount: form?.querySelectorAll('input[type="file"]').length ?? 0,
      sliderCount: document.querySelectorAll('[role="slider"], input[type="range"]').length,
      syntheticProbeAttachmentPresent,
      syntheticProbeInputSelected,
      composerContentsObserved: false,
    };
  })()`;
  return page.evaluate<ComposerControlSurfaceObservation>(expression);
}
