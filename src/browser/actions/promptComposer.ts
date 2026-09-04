import { randomUUID } from "node:crypto";
import type { ChromeClient, BrowserLogger } from "../types.js";
import {
  INPUT_SELECTORS,
  PROMPT_PRIMARY_SELECTOR,
  PROMPT_FALLBACK_SELECTOR,
  SEND_BUTTON_SELECTORS,
  STOP_BUTTON_SELECTOR,
  ASSISTANT_ROLE_SELECTOR,
} from "../constants.js";
import {
  buildConversationTurnCountExpression,
  buildConversationTurnListExpression,
} from "../conversationTurns.js";
import { delay } from "../utils.js";
import { logDomFailure } from "../domDebug.js";
import { buildClickDispatcher } from "./domEvents.js";
import { BrowserAutomationError } from "../../oracle/errors.js";
import { PROMPT_TEXT_NORMALIZER_SOURCE } from "../promptTextNormalizer.js";

const ENTER_KEY_EVENT = {
  key: "Enter",
  code: "Enter",
  windowsVirtualKeyCode: 13,
  nativeVirtualKeyCode: 13,
} as const;
const ENTER_KEY_TEXT = "\r";
const RETAINED_DRAFT_RETRY_DELAY_MS = 2_000;
const SUBMISSION_DOCUMENT_TOKEN_PROPERTY = "__oracleSubmissionDocumentToken";

// Input.insertText gives ProseMirror plain text, but ProseMirror renders each
// line as a direct block. HTMLElement.innerText inserts an extra newline
// between those blocks, so an unchanged multiline prompt appears mutated.
// Reconstruct the plain-text value from the editor blocks instead. Real text,
// empty paragraphs, and explicit hard breaks remain identity-bearing.
const COMPOSER_VALUE_READER_SOURCE = `
      const readComposerValue = (node) => {
        if (!node) return '';
        if (node instanceof HTMLTextAreaElement) return node.value ?? '';
        const readInlineText = (current) => {
          if (current?.nodeType === Node.TEXT_NODE) return current.nodeValue ?? '';
          if (!(current instanceof HTMLElement)) return '';
          if (current.tagName === 'BR') {
            return current.classList.contains('ProseMirror-trailingBreak') ? '' : '\\n';
          }
          return Array.from(current.childNodes).map(readInlineText).join('');
        };
        if (
          node instanceof HTMLElement &&
          (node.isContentEditable || node.getAttribute('contenteditable') === 'true')
        ) {
          const blocks = Array.from(node.children);
          return blocks.length > 0
            ? blocks.map(readInlineText).join('\\n')
            : readInlineText(node);
        }
        return node.innerText ?? node.textContent ?? '';
      };
`;

export interface AttachmentReadyExpectation {
  name: string;
  generatedBundle?: boolean;
}

type AttachmentReadyInput = string | AttachmentReadyExpectation;

type RetainedDraftRetryStatus = "dispatched" | "blocked" | "unavailable";

interface RetainedDraftRetryResult {
  status: RetainedDraftRetryStatus;
  reason?: string;
  gate?: Record<string, unknown>;
}

export async function submitPrompt(
  deps: {
    runtime: ChromeClient["Runtime"];
    input: ChromeClient["Input"];
    attachmentNames?: AttachmentReadyInput[];
    baselineTurns?: number | null;
    inputTimeoutMs?: number | null;
    attachmentTimeoutMs?: number | null;
    onPromptDispatched?: () => Promise<void> | void;
    onPromptCommitted?: (
      committedTurns: number | null,
      committedUserTurnIndex: number | null,
    ) => Promise<void> | void;
    onPromptCommitPending?: () => Promise<void> | void;
    isSubmissionOwner?: () => Promise<boolean> | boolean;
  },
  prompt: string,
  logger: BrowserLogger,
): Promise<number | null> {
  const { runtime, input } = deps;

  await waitForDomReady(runtime, logger, deps.inputTimeoutMs ?? undefined);
  const encodedPrompt = JSON.stringify(prompt);
  const focusResult = await runtime.evaluate({
    expression: `(() => {
      ${buildClickDispatcher()}
      const SELECTORS = ${JSON.stringify(INPUT_SELECTORS)};
      const isVisible = (node) => {
        if (!node || typeof node.getBoundingClientRect !== 'function') {
          return false;
        }
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const focusNode = (node) => {
        if (!node) {
          return false;
        }
        // Learned: React/ProseMirror require a real click + focus + selection for inserts to stick.
        dispatchClickSequence(node);
        if (typeof node.focus === 'function') {
          node.focus();
        }
        const doc = node.ownerDocument;
        const selection = doc?.getSelection?.();
        if (selection) {
          const range = doc.createRange();
          range.selectNodeContents(node);
          range.collapse(false);
          selection.removeAllRanges();
          selection.addRange(range);
        }
        return true;
      };

      const candidates = [];
      for (const selector of SELECTORS) {
        const node = document.querySelector(selector);
        if (node) {
          candidates.push(node);
        }
      }
      const preferred = candidates.find((node) => isVisible(node)) || candidates[0];
      if (preferred && focusNode(preferred)) {
        return { focused: true };
      }
      return { focused: false };
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  if (!focusResult.result?.value?.focused) {
    await logDomFailure(runtime, logger, "focus-textarea");
    throw new Error("Failed to focus prompt textarea");
  }

  await input.insertText({ text: prompt });

  // Some pages (notably ChatGPT when subscriptions/widgets load) need a brief settle
  // before the send button becomes enabled; give it a short breather to avoid races.
  await delay(500);

  const primarySelectorLiteral = JSON.stringify(PROMPT_PRIMARY_SELECTOR);
  const fallbackSelectorLiteral = JSON.stringify(PROMPT_FALLBACK_SELECTOR);
  const verification = await runtime.evaluate({
    expression: `(() => {
      const editor = document.querySelector(${primarySelectorLiteral});
      const fallback = document.querySelector(${fallbackSelectorLiteral});
      const inputSelectors = ${JSON.stringify(INPUT_SELECTORS)};
      ${COMPOSER_VALUE_READER_SOURCE}
      const isVisible = (node) => {
        if (!node || typeof node.getBoundingClientRect !== 'function') return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const candidates = inputSelectors
        .map((selector) => document.querySelector(selector))
        .filter((node) => Boolean(node));
      const active = candidates.find((node) => isVisible(node)) || candidates[0] || null;
      return {
        editorText: readComposerValue(editor),
        fallbackValue: fallback?.value ?? '',
        activeValue: readComposerValue(active),
      };
    })()`,
    returnByValue: true,
  });

  const editorTextRaw = verification.result?.value?.editorText ?? "";
  const fallbackValueRaw = verification.result?.value?.fallbackValue ?? "";
  const activeValueRaw = verification.result?.value?.activeValue ?? "";
  const editorTextTrimmed = editorTextRaw?.trim?.() ?? "";
  const fallbackValueTrimmed = fallbackValueRaw?.trim?.() ?? "";
  const activeValueTrimmed = activeValueRaw?.trim?.() ?? "";
  if (!editorTextTrimmed && !fallbackValueTrimmed && !activeValueTrimmed) {
    // Learned: occasionally Input.insertText doesn't land in the editor; force textContent/value + input events.
    await runtime.evaluate({
      expression: `(() => {
        const fallback = document.querySelector(${fallbackSelectorLiteral});
        if (fallback) {
          fallback.value = ${encodedPrompt};
          fallback.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${encodedPrompt}, inputType: 'insertFromPaste' }));
          fallback.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const editor = document.querySelector(${primarySelectorLiteral});
        if (editor) {
          editor.textContent = ${encodedPrompt};
          // Nudge ProseMirror to register the textContent write so its state/send-button updates
          editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${encodedPrompt}, inputType: 'insertFromPaste' }));
        }
      })()`,
    });
  }

  const preDispatchBaseline =
    typeof deps.baselineTurns === "number" &&
    Number.isFinite(deps.baselineTurns) &&
    deps.baselineTurns >= 0
      ? Math.floor(deps.baselineTurns)
      : null;
  const retainedDraftRecoveryEligible =
    preDispatchBaseline !== null &&
    !deps.attachmentNames?.length &&
    typeof deps.isSubmissionOwner === "function";
  const submissionDocumentToken = retainedDraftRecoveryEligible ? randomUUID() : null;
  const promptLength = prompt.length;
  const postVerification = await runtime.evaluate({
    expression: `(() => {
      const submissionDocumentToken = ${JSON.stringify(submissionDocumentToken)};
      const submissionDocumentTokenProperty = ${JSON.stringify(SUBMISSION_DOCUMENT_TOKEN_PROPERTY)};
      if (submissionDocumentToken) {
        Object.defineProperty(document, submissionDocumentTokenProperty, {
          configurable: true,
          enumerable: false,
          value: submissionDocumentToken,
          writable: true,
        });
      }
      const editor = document.querySelector(${primarySelectorLiteral});
      const fallback = document.querySelector(${fallbackSelectorLiteral});
      const inputSelectors = ${JSON.stringify(INPUT_SELECTORS)};
      ${COMPOSER_VALUE_READER_SOURCE}
      const isVisible = (node) => {
        if (!node || typeof node.getBoundingClientRect !== 'function') return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const candidates = inputSelectors
        .map((selector) => document.querySelector(selector))
        .filter((node) => Boolean(node));
      const active = candidates.find((node) => isVisible(node)) || candidates[0] || null;
      return {
        editorText: readComposerValue(editor),
        fallbackValue: fallback?.value ?? '',
        activeValue: readComposerValue(active),
        href: typeof location === 'object' && location.href ? location.href : '',
        documentTokenStored:
          !submissionDocumentToken ||
          document[submissionDocumentTokenProperty] === submissionDocumentToken,
      };
    })()`,
    returnByValue: true,
  });
  const observedEditor = postVerification.result?.value?.editorText ?? "";
  const observedFallback = postVerification.result?.value?.fallbackValue ?? "";
  const observedActive = postVerification.result?.value?.activeValue ?? "";
  const submissionOwnerHref = postVerification.result?.value?.href ?? "";
  const submissionDocumentTokenStored =
    postVerification.result?.value?.documentTokenStored === true;
  const observedComposer = observedActive || observedEditor || observedFallback;
  const observedLength = Math.max(
    observedEditor.length,
    observedFallback.length,
    observedActive.length,
  );
  if (promptLength >= 50_000 && observedLength > 0 && observedLength < promptLength - 2_000) {
    // Learned: very large prompts can truncate silently; fail fast so we can fall back to file uploads.
    await logDomFailure(runtime, logger, "prompt-too-large");
    throw new BrowserAutomationError(
      "Prompt appears truncated in the composer (likely too large).",
      {
        stage: "submit-prompt",
        code: "prompt-too-large",
        promptLength,
        observedLength,
      },
    );
  }

  // The dedicated browser is deliberately visible but must never claim the
  // operator's keyboard focus. Re-read the visible composer immediately before
  // Send and fail closed if anything changed after Oracle populated it.
  if (normalizeComposerText(observedComposer) !== normalizeComposerText(prompt)) {
    throw new BrowserAutomationError(
      "Prompt composer changed after Oracle populated it; refusing to send.",
      {
        stage: "submit-prompt",
        code: "composer-mutated-before-send",
        submissionCommitted: false,
        draftRetained: observedLength > 0,
        expectedLength: prompt.length,
        observedLength,
      },
    );
  }

  const clicked = await attemptSendButton(
    runtime,
    input,
    logger,
    deps?.attachmentNames,
    deps?.attachmentTimeoutMs,
    prompt,
  );
  if (!clicked) {
    await assertComposerUnchanged(runtime, prompt);
    await input.dispatchKeyEvent({
      type: "keyDown",
      ...ENTER_KEY_EVENT,
      text: ENTER_KEY_TEXT,
      unmodifiedText: ENTER_KEY_TEXT,
    });
    await input.dispatchKeyEvent({
      type: "keyUp",
      ...ENTER_KEY_EVENT,
    });
    logger("Submitted prompt via Enter key");
  } else {
    logger("Clicked send button");
  }
  await deps.onPromptDispatched?.();

  const commitTimeoutMs = Math.max(60_000, deps.inputTimeoutMs ?? 0);
  // Learned: the send button can succeed but the turn doesn't appear immediately; verify commit via turns/stop button.
  const committed = await verifyPromptCommitted(
    runtime,
    prompt,
    commitTimeoutMs,
    logger,
    preDispatchBaseline ?? undefined,
    deps.onPromptCommitPending,
    clicked &&
      retainedDraftRecoveryEligible &&
      submissionOwnerHref &&
      submissionDocumentToken &&
      submissionDocumentTokenStored
      ? () =>
          attemptRetainedDraftPageRetry({
            Runtime: runtime,
            prompt,
            baseline: preDispatchBaseline,
            submissionOwnerHref,
            submissionDocumentToken,
            isSubmissionOwner: deps.isSubmissionOwner!,
          })
      : undefined,
  );
  await deps.onPromptCommitted?.(committed.turnsCount, committed.userTurnIndex);
  return committed.turnsCount;
}

export async function clearPromptComposer(Runtime: ChromeClient["Runtime"], logger: BrowserLogger) {
  const primarySelectorLiteral = JSON.stringify(PROMPT_PRIMARY_SELECTOR);
  const fallbackSelectorLiteral = JSON.stringify(PROMPT_FALLBACK_SELECTOR);
  const inputSelectorsLiteral = JSON.stringify(INPUT_SELECTORS);
  const result = await Runtime.evaluate({
    expression: `(() => {
      const SELECTORS = ${inputSelectorsLiteral};
      const fallback = document.querySelector(${fallbackSelectorLiteral});
      const editor = document.querySelector(${primarySelectorLiteral});
      const readValue = (node) => {
        if (!node) return '';
        if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) return node.value ?? '';
        return node.innerText ?? node.textContent ?? '';
      };
      const dispatchClearEvents = (node) => {
        try {
          node.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, data: null, inputType: 'deleteContentBackward' }));
        } catch {}
        try {
          node.dispatchEvent(new InputEvent('input', { bubbles: true, data: '', inputType: 'deleteByCut' }));
        } catch {
          node.dispatchEvent(new Event('input', { bubbles: true }));
        }
        node.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const clearEditable = (node) => {
        if (!node) return false;
        try {
          node.focus?.();
        } catch {}
        if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) {
          node.value = '';
          dispatchClearEvents(node);
          return true;
        }
        if (node.isContentEditable || node.getAttribute('contenteditable') === 'true') {
          try {
            const selection = node.ownerDocument?.getSelection?.();
            const range = node.ownerDocument?.createRange?.();
            if (selection && range) {
              range.selectNodeContents(node);
              selection.removeAllRanges();
              selection.addRange(range);
              node.ownerDocument?.execCommand?.('delete', false);
            }
          } catch {}
          node.textContent = '';
          dispatchClearEvents(node);
          return true;
        }
        return false;
      };
      let cleared = false;
      const nodes = SELECTORS
        .map((selector) => document.querySelector(selector))
        .filter((node) => Boolean(node));
      for (const node of Array.from(new Set([fallback, editor, ...nodes])).filter(Boolean)) {
        cleared = clearEditable(node) || cleared;
      }
      const remaining = Array.from(new Set([fallback, editor, ...nodes]))
        .filter(Boolean)
        .map((node) => readValue(node).trim())
        .filter(Boolean);
      return { cleared, remaining };
    })()`,
    returnByValue: true,
  });
  const value = result.result?.value as { cleared?: boolean; remaining?: string[] } | undefined;
  if (!value?.cleared || (value.remaining?.length ?? 0) > 0) {
    await logDomFailure(Runtime, logger, "clear-composer");
    throw new Error("Failed to clear prompt composer");
  }
  await delay(250);
}

async function waitForDomReady(
  Runtime: ChromeClient["Runtime"],
  logger?: BrowserLogger,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { result } = await Runtime.evaluate({
      expression: `(() => {
        const ready = document.readyState === 'complete';
        const composer = document.querySelector('[data-testid*="composer"]') || document.querySelector('form');
        const fileInput = document.querySelector('input[type="file"]');
        return { ready, composer: Boolean(composer), fileInput: Boolean(fileInput) };
      })()`,
      returnByValue: true,
    });
    const value = result?.value as
      | { ready?: boolean; composer?: boolean; fileInput?: boolean }
      | undefined;
    if (value?.ready && value.composer) {
      return;
    }
    await delay(150);
  }
  logger?.(`Page did not reach ready/composer state within ${timeoutMs}ms; continuing cautiously.`);
}

function buildAttachmentReadyExpression(attachmentNames: AttachmentReadyInput[]): string {
  const attachmentExpectations = attachmentNames.map((attachment) => {
    const name = typeof attachment === "string" ? attachment : attachment.name;
    const normalized = name.toLowerCase().replace(/\s+/g, " ").trim();
    return {
      name: normalized,
      stem: normalized.replace(/\.[a-z0-9]{1,10}$/i, ""),
      extension: normalized.match(/(\.[a-z0-9]{1,10})$/i)?.[1] ?? "",
      generatedBundle: typeof attachment === "object" && attachment.generatedBundle === true,
    };
  });
  const namesLiteral = JSON.stringify(attachmentExpectations);
  return `(() => {
    const expected = ${namesLiteral};
    const sendSelectors = ${JSON.stringify(SEND_BUTTON_SELECTORS)};
    const normalize = (value) => String(value || '').toLowerCase().replace(/\\s+/g, ' ').trim();
    const hasNameBoundary = (text, name) => {
      if (!name) return false;
      let from = 0;
      while (from < text.length) {
        const index = text.indexOf(name, from);
        if (index === -1) return false;
        const previous = text[index - 1] || '';
        const next = text[index + name.length] || '';
        const previousOk = !previous || !/[a-z0-9._-]/.test(previous);
        const nextOk = !next || !/[a-z0-9._-]/.test(next);
        if (previousOk && nextOk) return true;
        from = index + name.length;
      }
      return false;
    };
    const hasStemFileBoundary = (text, stem) => {
      if (!stem) return false;
      let from = 0;
      while (from < text.length) {
        const index = text.indexOf(stem, from);
        if (index === -1) return false;
        const previous = text[index - 1] || '';
        const next = text[index + stem.length] || '';
        const previousOk = !previous || !/[a-z0-9._-]/.test(previous);
        const nextOk = !next || !/[a-z0-9._-]/.test(next);
        if (previousOk && nextOk) return true;
        from = index + stem.length;
      }
      return false;
    };
    const hasBareStemBoundary = (text, stem) => {
      if (!stem) return false;
      let from = 0;
      while (from < text.length) {
        const index = text.indexOf(stem, from);
        if (index === -1) return false;
        const previous = text[index - 1] || '';
        const next = text[index + stem.length] || '';
        const previousOk = !previous || !/[a-z0-9._-]/.test(previous);
        const nextOk = !next || !/[a-z0-9._(-]/.test(next);
        if (previousOk && nextOk) return true;
        from = index + stem.length;
      }
      return false;
    };
    const hasExtensionBoundary = (text, extension) => {
      if (!extension) return false;
      let from = 0;
      while (from < text.length) {
        const index = text.indexOf(extension, from);
        if (index === -1) return false;
        const next = text[index + extension.length] || '';
        if (!next || !/[a-z0-9]/.test(next)) return true;
        from = index + extension.length;
      }
      return false;
    };
    const matchesExpected = (value, item) => {
      const text = normalize(value);
      if (!text) return false;
      if (hasNameBoundary(text, item.name)) return true;
      if (item.generatedBundle && hasBareStemBoundary(text, item.stem)) return true;
      if (
        item.stem &&
        item.stem.length >= 4 &&
        item.extension &&
        text.includes(item.stem + '(') &&
        hasExtensionBoundary(text, item.extension)
      ) {
        return true;
      }
      if (text.includes('…') || text.includes('...')) {
        const marker = text.includes('…') ? '…' : '...';
        const [prefixRaw, suffixRaw] = text.split(marker);
        const prefix = normalize(prefixRaw);
        const suffix = normalize(suffixRaw);
        const prefixParts = prefix.split(' ').filter(Boolean);
        const suffixParts = suffix.split(' ').filter(Boolean);
        const prefixCandidates = prefixParts.map((_, index) => prefixParts.slice(index).join(' '));
        const suffixCandidates = suffixParts.map((_, index) =>
          suffixParts.slice(0, suffixParts.length - index).join(' '),
        );
        if (prefixCandidates.length === 0 || suffixCandidates.length === 0) return false;
        const targets = [item.name, item.stem && item.stem.length >= 4 ? item.stem : ''].filter(Boolean);
        return targets.some((target) => {
          return prefixCandidates.some((prefixPart) =>
            suffixCandidates.some((suffixPart) => {
              const strongEnough =
                suffixPart.length >= 2 &&
                (prefixPart.length >= 3 || (prefixPart.length >= 2 && suffixPart.length >= 4));
              return strongEnough && target.startsWith(prefixPart) && target.endsWith(suffixPart);
            }),
          );
        });
      }
      return false;
    };
    // Restrict to attachment affordances; never scan generic div/span nodes (prompt text can contain the file name).
    const attachmentSelectors = [
      // Current ChatGPT file tiles expose the filename through a role-group aria label.
      '[role="group"][aria-label]',
      '[data-testid*="chip"]',
      '[data-testid*="attachment"]',
      '[data-testid*="upload"]',
      '[data-testid*="file"]',
      '[aria-label*="Remove file"]',
      'button[aria-label*="Remove file"]',
      '[aria-label*="remove file"]',
      'button[aria-label*="remove file"]',
      '[aria-label*="Remove attachment"]',
      'button[aria-label*="Remove attachment"]',
      '[aria-label*="remove attachment"]',
      'button[aria-label*="remove attachment"]',
    ];
    const sendButton = sendSelectors
      .map((selector) => document.querySelector(selector))
      .find(Boolean);
    const isUsableComposerRoot = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      if (String(node.tagName || '').toLowerCase() === 'button') return false;
      const testId = String(node.getAttribute?.('data-testid') || '').toLowerCase();
      if (!testId.includes('composer')) return false;
      return !(
        testId.includes('footer') ||
        testId.includes('action') ||
        testId.includes('plus') ||
        testId.includes('send')
      );
    };
    const closestComposerRoot = (node) => {
      let current = node instanceof HTMLElement ? node : null;
      while (current) {
        if (isUsableComposerRoot(current)) return current;
        current = current.parentElement;
      }
      return null;
    };
    const firstComposerRoot = () =>
      Array.from(document.querySelectorAll('[data-testid*="composer"]')).find(isUsableComposerRoot) || null;
    const composer =
      closestComposerRoot(sendButton) ||
      sendButton?.closest?.('form') ||
      firstComposerRoot() ||
      document.querySelector('form') ||
      document.body ||
      document;
    // Walk node + ancestors (up to grandparent) + descendants to gather every textual hint.
    // ChatGPT's current chip DOM nests the filename inside truncated child spans, so checking
    // only the node's own textContent/aria/title misses the match.
    const collectOwnLabelHaystack = (node) => {
      if (!node) return '';
      const pieces = [];
      const pushAttrs = (el) => {
        if (!el || typeof el.getAttribute !== 'function') return;
        for (const attr of ['aria-label', 'title', 'data-testid', 'data-tooltip', 'data-tooltip-content']) {
          const v = el.getAttribute(attr);
          if (v) pieces.push(v);
        }
      };
      const pushText = (el) => {
        if (!el) return;
        const text = (el.innerText ?? el.textContent ?? '').trim();
        if (text) pieces.push(text);
      };
      pushAttrs(node);
      pushText(node);
      return pieces.join(' ').toLowerCase();
    };
    const collectLabelHaystack = (node) => {
      if (!node) return '';
      const pieces = [collectOwnLabelHaystack(node)];
      const push = (el) => {
        const text = collectOwnLabelHaystack(el);
        if (text) pieces.push(text);
      };
      const parent = node.parentElement;
      push(parent);
      const grandparent = parent?.parentElement;
      push(grandparent);
      return pieces.join(' ').toLowerCase();
    };
    const attachmentRoots = Array.from(new Set([composer])).filter(Boolean);
    const collectChipNodes = () => {
      const seen = new Set();
      const collected = [];
      for (const root of attachmentRoots) {
        for (const node of Array.from(root.querySelectorAll(attachmentSelectors.join(',')))) {
          if (!(node instanceof HTMLElement)) continue;
          // Skip elements clearly inside the editable input (composer textarea may contain
          // filename text in the user's prompt — avoid mistaking that for a chip).
          if (node.closest('textarea,[contenteditable="true"]')) continue;
          if (seen.has(node)) continue;
          seen.add(node);
          collected.push(node);
        }
      }
      return collected;
    };
    const chipNodes = collectChipNodes();
    const chipLabels = chipNodes.map((node) => collectLabelHaystack(node));
    const chipOwnLabels = chipNodes.map((node) => collectOwnLabelHaystack(node));
    const hasEllipsisSuffix = (label) => {
      const marker = label.includes('…') ? '…' : label.includes('...') ? '...' : '';
      if (!marker) return false;
      return normalize(label.split(marker)[1] || '').length > 0;
    };
    const chipOwnLabelsWithVisibleNames = chipOwnLabels.filter((label) =>
      /\\.[a-z][a-z0-9]{0,9}(?:\\b|$)/i.test(label) ||
      hasEllipsisSuffix(label),
    );
    const visibleExtensionLabelsMatchExpected = chipOwnLabelsWithVisibleNames.every((label) =>
      expected.some((item) => matchesExpected(label, item)),
    );
    const visibleStemOnlyMismatch = chipOwnLabels.some((label) =>
      expected.some(
        (item) =>
          !item.generatedBundle &&
          item.stem &&
          hasStemFileBoundary(label, item.stem) &&
          !matchesExpected(label, item),
      ),
    );

    const chipsReady = (() => {
      const used = new Set();
      return expected.every((item) => {
        const index = chipLabels.findIndex((label, candidateIndex) =>
          !used.has(candidateIndex) && matchesExpected(label, item),
        );
        if (index === -1) return false;
        used.add(index);
        return true;
      });
    })();
    const inputsReady = expected.every((item) =>
      attachmentRoots.some((root) =>
        Array.from(root.querySelectorAll('input[type="file"]')).some((el) =>
          Array.from((el instanceof HTMLInputElement ? el.files : []) || []).some((file) =>
            matchesExpected(file?.name, item),
          ),
        ),
      ),
    );
    // Count-based fallback: if we cannot match names individually (ChatGPT may strip
    // the filename out of attribute-readable text into a deeply nested span), but we
    // do see at least as many distinct "Remove" affordances as attachments we
    // uploaded, trust the upload without double-counting nested chip/remove nodes.
    const removeAffordances = [];
    const removeSeen = new Set();
    for (const root of attachmentRoots) {
      for (const node of Array.from(root.querySelectorAll(
        '[aria-label*="Remove" i], [aria-label*="remove" i], button[aria-label*="Remove" i], button[aria-label*="remove" i]',
      ))) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.closest('textarea,[contenteditable="true"]')) continue;
        const aria = (node.getAttribute?.('aria-label') ?? '').toLowerCase();
        const fileSpecific = aria.includes('remove file') || aria.includes('remove attachment');
        const attachmentOwner = node.closest(
          '[data-testid*="chip"], [data-testid*="attachment"], [data-testid*="upload"], [data-testid*="file"]',
        );
        if (!fileSpecific && !attachmentOwner) continue;
        if (removeSeen.has(node)) continue;
        removeSeen.add(node);
        removeAffordances.push(node);
      }
    }
    const countReady =
      !visibleStemOnlyMismatch &&
      visibleExtensionLabelsMatchExpected &&
      removeAffordances.length >= expected.length;

    return chipsReady || inputsReady || countReady;
  })()`;
}

export function buildAttachmentReadyExpressionForTest(attachmentNames: AttachmentReadyInput[]) {
  return buildAttachmentReadyExpression(attachmentNames);
}

async function attemptSendButton(
  Runtime: ChromeClient["Runtime"],
  Input: ChromeClient["Input"],
  _logger?: BrowserLogger,
  attachmentNames?: AttachmentReadyInput[],
  attachmentTimeoutMs?: number | null,
  expectedPrompt?: string,
): Promise<boolean> {
  const needAttachment = Array.isArray(attachmentNames) && attachmentNames.length > 0;
  const expectedPromptLiteral = JSON.stringify(expectedPrompt ?? null);
  const script = `(() => {
    ${buildClickDispatcher()}
    const selectors = ${JSON.stringify(SEND_BUTTON_SELECTORS)};
    const expectedPrompt = ${expectedPromptLiteral};
    const inputSelectors = ${JSON.stringify(INPUT_SELECTORS)};
    ${COMPOSER_VALUE_READER_SOURCE}
    const normalizeComposer = (value) => String(value ?? '')
      .replace(/\\r\\n?/g, '\\n')
      .replace(/\\u00a0/g, ' ');
    const isVisible = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(node);
      return style.display !== 'none' && style.visibility !== 'hidden';
    };
    const isEnabled = (node) => {
      const ariaDisabled = node.getAttribute('aria-disabled');
      const dataDisabled = node.getAttribute('data-disabled');
      const style = window.getComputedStyle(node);
      return !(
        node.hasAttribute('disabled') ||
        ariaDisabled === 'true' ||
        dataDisabled === 'true' ||
        style.pointerEvents === 'none' ||
        style.display === 'none'
      );
    };
    if (expectedPrompt !== null) {
      const inputs = inputSelectors
        .map((selector) => document.querySelector(selector))
        .filter((node) => Boolean(node));
      const active = inputs.find((node) => isVisible(node)) || inputs[0] || null;
      const observed = readComposerValue(active);
      if (normalizeComposer(observed) !== normalizeComposer(expectedPrompt)) {
        return { status: 'mutated', observedLength: observed.length };
      }
    }
    const candidates = [];
    for (const selector of selectors) {
      candidates.push(...Array.from(document.querySelectorAll(selector)));
    }
    const button = candidates.find((node) => isVisible(node) && isEnabled(node)) || null;
    if (!button) return { status: 'missing' };
    button.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = button.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      return { status: 'point', x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }
    // Last-resort fallback for unusual DOMs where the button is visible but has no useful rect.
    dispatchClickSequence(button);
    return { status: 'clicked' };
  })()`;

  // Give attachment-bearing submissions more headroom. ChatGPT's chip render can
  // settle slowly for multi-file uploads, but plain text sends should keep the
  // shorter historical deadline.
  const timeoutMs = sendButtonTimeoutMs(attachmentNames, attachmentTimeoutMs);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (needAttachment) {
      const ready = await Runtime.evaluate({
        expression: buildAttachmentReadyExpression(attachmentNames),
        returnByValue: true,
      });
      if (!ready?.result?.value) {
        await delay(150);
        continue;
      }
    }
    const { result } = await Runtime.evaluate({ expression: script, returnByValue: true });
    const value = result.value as
      | {
          status?: "clicked" | "missing" | "mutated" | "point";
          x?: number;
          y?: number;
          observedLength?: number;
        }
      | string
      | undefined;
    const status = typeof value === "string" ? value : value?.status;
    if (status === "mutated") {
      throwComposerMutationError(
        expectedPrompt ?? "",
        typeof value === "object" && typeof value.observedLength === "number"
          ? value.observedLength
          : 0,
      );
    }
    if (
      status === "point" &&
      typeof value === "object" &&
      typeof value.x === "number" &&
      typeof value.y === "number"
    ) {
      await clickTrustedPoint(Runtime, Input, value.x, value.y);
      return true;
    }
    if (status === "clicked") {
      return true;
    }
    if (status === "missing") {
      break;
    }
    await delay(100);
  }
  if (Array.isArray(attachmentNames) && attachmentNames.length > 0) {
    throw new BrowserAutomationError(
      `Attachments never reached a clickable send button after ${Math.ceil(
        timeoutMs / 1000,
      )}s; tune --browser-attachment-timeout.`,
      {
        stage: "submit-prompt",
        code: "attachment-send-not-ready",
        attachmentNames,
        timeoutMs,
      },
    );
  }
  return false;
}

async function attemptRetainedDraftPageRetry({
  Runtime,
  prompt,
  baseline,
  submissionOwnerHref,
  submissionDocumentToken,
  isSubmissionOwner,
}: {
  Runtime: ChromeClient["Runtime"];
  prompt: string;
  baseline: number;
  submissionOwnerHref: string;
  submissionDocumentToken: string;
  isSubmissionOwner: () => Promise<boolean> | boolean;
}): Promise<RetainedDraftRetryResult> {
  let ownerConfirmed = false;
  try {
    ownerConfirmed = (await isSubmissionOwner()) === true;
  } catch {
    return { status: "blocked", reason: "target-owner-check-failed" };
  }
  if (!ownerConfirmed) {
    return { status: "blocked", reason: "target-owner-mismatch" };
  }

  const script = `(() => {
    const expectedPrompt = ${JSON.stringify(prompt)};
    const expectedOwnerHref = ${JSON.stringify(submissionOwnerHref)};
    const expectedDocumentToken = ${JSON.stringify(submissionDocumentToken)};
    const submissionDocumentTokenProperty = ${JSON.stringify(SUBMISSION_DOCUMENT_TOKEN_PROPERTY)};
    const baseline = ${JSON.stringify(baseline)};
    const inputSelectors = ${JSON.stringify(INPUT_SELECTORS)};
    const sendSelectors = ${JSON.stringify(SEND_BUTTON_SELECTORS)};
    const stopSelector = ${JSON.stringify(STOP_BUTTON_SELECTOR)};
    ${COMPOSER_VALUE_READER_SOURCE}
    const normalizeComposer = (value) => String(value ?? '')
      .replace(/\\r\\n?/g, '\\n')
      .replace(/\\u00a0/g, ' ');
    const normalizeTurn = ${PROMPT_TEXT_NORMALIZER_SOURCE};
    const normalizeOwner = (value) => {
      try {
        const url = new URL(String(value ?? ''), location.href);
        return url.origin + url.pathname.replace(/\\/$/, '');
      } catch {
        return '';
      }
    };
    const isVisible = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(node);
      return style.display !== 'none' && style.visibility !== 'hidden';
    };
    const isEnabled = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(node);
      return !(
        node.hasAttribute('disabled') ||
        node.getAttribute('aria-disabled') === 'true' ||
        node.getAttribute('data-disabled') === 'true' ||
        style.pointerEvents === 'none' ||
        style.display === 'none'
      );
    };
    const roleOf = (node) => String(
      node?.getAttribute?.('data-message-author-role') ||
      node?.getAttribute?.('data-turn') ||
      node?.dataset?.turn ||
      node?.querySelector?.('[data-message-author-role], [data-turn]')?.getAttribute?.(
        'data-message-author-role',
      ) ||
      node?.querySelector?.('[data-message-author-role], [data-turn]')?.getAttribute?.('data-turn') ||
      '',
    ).toLowerCase();
    const articles = ${buildConversationTurnListExpression()};
    const turnsCount = articles.length;
    const newArticles = baseline >= 0 ? articles.slice(baseline) : articles;
    const userMatched = normalizeTurn(expectedPrompt).length > 0 && newArticles.some((node) => {
      if (roleOf(node) !== 'user') return false;
      const roleNode = node?.getAttribute?.('data-message-author-role') === 'user' ||
        node?.getAttribute?.('data-turn') === 'user'
        ? node
        : node?.querySelector?.('[data-message-author-role="user"], [data-turn="user"]');
      const messageNode = roleNode?.querySelector?.('.whitespace-pre-wrap') || roleNode;
      return normalizeTurn(messageNode?.innerText || messageNode?.textContent || '') ===
        normalizeTurn(expectedPrompt);
    });
    const hasNewTurn = baseline >= 0 && turnsCount > baseline;
    const submissionCommitted = hasNewTurn && userMatched;
    const assistantVisible = baseline < 0 || newArticles.some((node) => roleOf(node) === 'assistant');
    const stopVisible = Array.from(document.querySelectorAll(stopSelector)).some(isVisible);
    const inputs = inputSelectors
      .map((selector) => document.querySelector(selector))
      .filter((node) => Boolean(node));
    const active = inputs.find((node) => isVisible(node)) || inputs[0] || null;
    const observed = readComposerValue(active);
    const composerMatchesPrompt =
      normalizeComposer(observed) === normalizeComposer(expectedPrompt);
    const composerCleared = !String(observed).trim();
    const draftRetained = !composerCleared;
    const ownerMatched =
      normalizeOwner(location.href) === normalizeOwner(expectedOwnerHref);
    const documentTokenMatched =
      document[submissionDocumentTokenProperty] === expectedDocumentToken;
    const gate = {
      submissionCommitted,
      draftRetained,
      composerMatchesPrompt,
      hasNewTurn,
      userMatched,
      stopVisible,
      assistantVisible,
      baselineKnown: baseline >= 0,
      baselineUnchanged: baseline >= 0 && turnsCount === baseline,
      ownerMatched,
      documentTokenMatched,
      turnsCount,
    };
    const allowed =
      gate.submissionCommitted === false &&
      gate.draftRetained === true &&
      gate.composerMatchesPrompt === true &&
      gate.hasNewTurn === false &&
      gate.userMatched === false &&
      gate.stopVisible === false &&
      gate.assistantVisible === false &&
      gate.baselineKnown === true &&
      gate.baselineUnchanged === true &&
      gate.ownerMatched === true &&
      gate.documentTokenMatched === true;
    if (!allowed) return { status: 'blocked', reason: 'gate-closed', gate };
    const candidates = sendSelectors.flatMap((selector) =>
      Array.from(document.querySelectorAll(selector)),
    );
    const button = candidates.find((node) => isVisible(node) && isEnabled(node)) || null;
    if (!button) return { status: 'unavailable', reason: 'send-button-unavailable', gate };
    button.click();
    return { status: 'dispatched', gate };
  })()`;
  const result = await Runtime.evaluate({ expression: script, returnByValue: true }).catch(
    () => null,
  );
  if (!result) {
    return { status: "blocked", reason: "retry-evidence-unavailable" };
  }
  const value = result.result?.value as RetainedDraftRetryResult | undefined;
  if (
    !value ||
    (value.status !== "dispatched" && value.status !== "blocked" && value.status !== "unavailable")
  ) {
    return { status: "blocked", reason: "retry-evidence-unavailable" };
  }
  return value;
}

async function assertComposerUnchanged(
  Runtime: ChromeClient["Runtime"],
  expectedPrompt: string,
): Promise<void> {
  const result = await Runtime.evaluate({
    expression: `(() => {
      const inputSelectors = ${JSON.stringify(INPUT_SELECTORS)};
      ${COMPOSER_VALUE_READER_SOURCE}
      const isVisible = (node) => {
        if (!node || typeof node.getBoundingClientRect !== 'function') return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const normalizeComposer = (value) => String(value ?? '')
        .replace(/\\r\\n?/g, '\\n')
        .replace(/\\u00a0/g, ' ');
      const inputs = inputSelectors
        .map((selector) => document.querySelector(selector))
        .filter((node) => Boolean(node));
      const active = inputs.find((node) => isVisible(node)) || inputs[0] || null;
      const observed = readComposerValue(active);
      return {
        unchanged: normalizeComposer(observed) === normalizeComposer(${JSON.stringify(expectedPrompt)}),
        observedLength: observed.length,
      };
    })()`,
    returnByValue: true,
  });
  const value = result.result?.value as
    | { unchanged?: boolean; observedLength?: number }
    | undefined;
  if (!value?.unchanged) {
    throwComposerMutationError(expectedPrompt, value?.observedLength ?? 0);
  }
}

function throwComposerMutationError(expectedPrompt: string, observedLength: number): never {
  throw new BrowserAutomationError(
    "Prompt composer changed after Oracle populated it; refusing to send.",
    {
      stage: "submit-prompt",
      code: "composer-mutated-before-send",
      submissionCommitted: false,
      draftRetained: observedLength > 0,
      expectedLength: expectedPrompt.length,
      observedLength,
    },
  );
}

async function clickTrustedPoint(
  Runtime: ChromeClient["Runtime"],
  Input: ChromeClient["Input"],
  x: number,
  y: number,
): Promise<void> {
  if (Input && typeof Input.dispatchMouseEvent === "function") {
    await Input.dispatchMouseEvent({ type: "mouseMoved", x, y });
    await Input.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await Input.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    return;
  }
  await Runtime.evaluate({
    expression: `(() => {
      const el = document.elementFromPoint(${JSON.stringify(x)}, ${JSON.stringify(y)});
      if (!(el instanceof HTMLElement)) return false;
      el.click();
      return true;
    })()`,
    returnByValue: true,
  });
}

function sendButtonTimeoutMs(
  attachmentNames?: AttachmentReadyInput[],
  attachmentTimeoutMs?: number | null,
): number {
  if (!Array.isArray(attachmentNames) || attachmentNames.length === 0) {
    return 20_000;
  }
  return typeof attachmentTimeoutMs === "number" && Number.isFinite(attachmentTimeoutMs)
    ? Math.max(1_000, attachmentTimeoutMs)
    : 45_000;
}

async function verifyPromptCommitted(
  Runtime: ChromeClient["Runtime"],
  prompt: string,
  timeoutMs: number,
  logger?: BrowserLogger,
  baselineTurns?: number,
  onCommitPending?: () => Promise<void> | void,
  retryRetainedDraft?: () => Promise<RetainedDraftRetryResult>,
): Promise<{ turnsCount: number | null; userTurnIndex: number | null }> {
  const deadline = Date.now() + timeoutMs;
  const retainedDraftRetryAt = Date.now() + RETAINED_DRAFT_RETRY_DELAY_MS;
  const encodedPrompt = JSON.stringify(prompt.trim());
  const primarySelectorLiteral = JSON.stringify(PROMPT_PRIMARY_SELECTOR);
  const fallbackSelectorLiteral = JSON.stringify(PROMPT_FALLBACK_SELECTOR);
  const inputSelectorsLiteral = JSON.stringify(INPUT_SELECTORS);
  const stopSelectorLiteral = JSON.stringify(STOP_BUTTON_SELECTOR);
  const assistantSelectorLiteral = JSON.stringify(ASSISTANT_ROLE_SELECTOR);
  let baseline: number | null =
    typeof baselineTurns === "number" && Number.isFinite(baselineTurns) && baselineTurns >= 0
      ? Math.floor(baselineTurns)
      : null;
  if (baseline === null) {
    try {
      const { result } = await Runtime.evaluate({
        expression: buildConversationTurnCountExpression(),
        returnByValue: true,
      });
      const raw = typeof result?.value === "number" ? result.value : Number(result?.value);
      if (Number.isFinite(raw)) {
        baseline = Math.max(0, Math.floor(raw));
      }
    } catch {
      // ignore; baseline stays unknown
    }
  }
  const baselineLiteral = baseline ?? -1;
  // Read the semantic user-message node so attachment labels and turn controls
  // do not contaminate the prompt identity check. Exact identity prevents a
  // prompt plus stray operator keystrokes from being accepted as committed.
  const script = `(() => {
		    const editor = document.querySelector(${primarySelectorLiteral});
		    const fallback = document.querySelector(${fallbackSelectorLiteral});
		    const inputSelectors = ${inputSelectorsLiteral};
	    const normalize = ${PROMPT_TEXT_NORMALIZER_SOURCE};
		    const normalizedPrompt = normalize(${encodedPrompt});
		    const articles = ${buildConversationTurnListExpression()};
		    const normalizedTurns = articles.map((node) => normalize(node?.innerText));
		    const userTurns = articles.map((node, index) => {
		      const role = String(
		        node?.getAttribute?.('data-message-author-role') ||
		        node?.getAttribute?.('data-turn') ||
		        node?.dataset?.turn ||
		        '',
		      ).toLowerCase();
		      const isUser = role === 'user' || Boolean(
		        node?.querySelector?.('[data-message-author-role="user"], [data-turn="user"]'),
		      );
		      if (!isUser) return null;
		      const roleNode = role === 'user'
		        ? node
		        : node?.querySelector?.('[data-message-author-role="user"], [data-turn="user"]');
		      const messageNode = roleNode?.querySelector?.('.whitespace-pre-wrap') || roleNode;
		      return {
		        index,
		        text: normalize(messageNode?.innerText || messageNode?.textContent || ''),
		      };
		    }).filter((entry) => entry && entry.text);
		    const userTurnTexts = userTurns.map((entry) => entry.text);
	    const readValue = (node) => {
	      if (!node) return '';
	      if (node instanceof HTMLTextAreaElement) return node.value ?? '';
	      return node.innerText ?? '';
	    };
	    const isVisible = (node) => {
	      if (!node || typeof node.getBoundingClientRect !== 'function') return false;
	      const rect = node.getBoundingClientRect();
	      return rect.width > 0 && rect.height > 0;
	    };
	    const inputs = inputSelectors
	      .map((selector) => document.querySelector(selector))
	      .filter((node) => Boolean(node));
	    const visibleInputs = inputs.filter((node) => isVisible(node));
	    const activeInputs = visibleInputs.length > 0 ? visibleInputs : inputs;
		    const userMatched =
		      normalizedPrompt.length > 0 && userTurnTexts.some((text) => text === normalizedPrompt);
		    const matchedUserTurn = [...userTurns]
		      .reverse()
		      .find((entry) => entry.text === normalizedPrompt) || null;
			    const lastTurn = userTurnTexts[userTurnTexts.length - 1] ?? '';
			    const lastMatched =
			      normalizedPrompt.length > 0 && lastTurn === normalizedPrompt;
		    const baseline = ${baselineLiteral};
		    const hasNewTurn = baseline < 0 ? false : normalizedTurns.length > baseline;
		    // A new *user-role* turn is the safety boundary for "a prompt was sent":
		    // total growth can also come from an assistant or progress container.
		    const newUserTurns = baseline < 0 ? [] : userTurns.filter((entry) => entry && entry.index >= baseline);
		    const hasNewUserTurn = newUserTurns.length > 0;
		    const newestUserTurnIndex = hasNewUserTurn ? newUserTurns[newUserTurns.length - 1].index : null;
		    const stopVisible = Boolean(document.querySelector(${stopSelectorLiteral}));
		    const assistantVisible = Boolean(
		      document.querySelector(${assistantSelectorLiteral}) ||
		      document.querySelector('[data-testid*="assistant"]'),
		    );
	    // Learned: composer clearing + stop button or assistant presence is a reliable fallback signal.
      const editorValue = editor?.innerText ?? '';
      const fallbackValue = fallback?.value ?? '';
      const activeEmpty =
        activeInputs.length === 0 ? null : activeInputs.every((node) => !String(readValue(node)).trim());
      const composerCleared = activeEmpty ?? !(String(editorValue).trim() || String(fallbackValue).trim());
      const href = typeof location === 'object' && location.href ? location.href : '';
      const inConversation = /\\/c\\//.test(href);
		    return {
        baseline,
	      userMatched,
	      matchedUserTurnIndex: matchedUserTurn?.index ?? null,
	      lastMatched,
	      lastUserTurnAvailable: userTurnTexts.length > 0,
	      hasNewTurn,
	      hasNewUserTurn,
	      newestUserTurnIndex,
      stopVisible,
      assistantVisible,
      composerCleared,
      inConversation,
      href,
      fallbackValue,
      editorValue,
      lastTurn,
      turnsCount: normalizedTurns.length,
    };
  })()`;

  let lastProbe: CommitProbeState | undefined;
  let nextPendingCheckAt = 0;
  let retainedDraftRetryDecided = false;
  while (Date.now() < deadline) {
    const { result } = await Runtime.evaluate({ expression: script, returnByValue: true });
    const info = result.value as CommitProbeState | undefined;
    if (info && typeof info === "object") {
      lastProbe = info;
    }
    const turnsCount = (result.value as { turnsCount?: number } | undefined)?.turnsCount;
    const matchesPrompt = Boolean(info?.lastMatched);
    // In a resumed, long conversation ChatGPT virtualizes the transcript: the
    // new user turn appears while an older turn leaves the DOM, so the rendered
    // turn count never exceeds the baseline. The prompt is nevertheless
    // committed when it is the last user turn, the composer has been cleared,
    // and generation is visibly in progress. This never fires for a historical
    // match of a resent identical prompt: then the composer still holds the
    // draft and no generation is running.
    const committedInVirtualizedThread =
      matchesPrompt &&
      typeof info?.baseline === "number" &&
      info.baseline >= 0 &&
      info?.composerCleared === true &&
      info?.stopVisible === true;
    if (matchesPrompt && (info?.hasNewTurn || committedInVirtualizedThread)) {
      const userTurnIndex = info?.matchedUserTurnIndex;
      return {
        turnsCount:
          typeof turnsCount === "number" && Number.isFinite(turnsCount) ? turnsCount : null,
        userTurnIndex:
          typeof userTurnIndex === "number" && Number.isSafeInteger(userTurnIndex)
            ? userTurnIndex
            : null,
      };
    }
    if (retryRetainedDraft && !retainedDraftRetryDecided && Date.now() >= retainedDraftRetryAt) {
      retainedDraftRetryDecided = true;
      const retry = await retryRetainedDraft();
      logger?.(
        `Retained-draft Send retry decision: ${retry.status}${
          retry.reason ? ` (${retry.reason})` : ""
        }`,
      );
      continue;
    }
    if (onCommitPending && Date.now() >= nextPendingCheckAt) {
      nextPendingCheckAt = Date.now() + 500;
      await onCommitPending();
    }
    await delay(100);
  }
  await onCommitPending?.();
  const finalProbe = await Runtime.evaluate({ expression: script, returnByValue: true })
    .then((res) => res?.result?.value as CommitProbeState | undefined)
    .catch(() => undefined);
  const probe = finalProbe && typeof finalProbe === "object" ? finalProbe : lastProbe;
  if (logger) {
    logger(
      `Prompt commit check failed; latest state: ${
        probe ? JSON.stringify(summarizeCommitProbe(probe)) : "unavailable"
      }`,
    );
    await logDomFailure(Runtime, logger, "prompt-commit");
  }
  if (prompt.trim().length >= 50_000) {
    throw new BrowserAutomationError(
      "Prompt did not appear in conversation before timeout (likely too large).",
      {
        stage: "submit-prompt",
        code: "prompt-too-large",
        promptLength: prompt.trim().length,
        timeoutMs,
      },
    );
  }
  // A new user-role turn appeared and the composer emptied: something was sent
  // even though its text did not match the expected prompt exactly (ChatGPT
  // renders Markdown, a mutation slipped in, or the turn was virtualized).
  // Sending again would duplicate it, so this is terminal and recoverable,
  // with promptSubmitted:true, and it never completes a Pro receipt or a
  // committed prompt digest: identity stays unverified.
  const submittedUnverified = Boolean(
    probe?.hasNewUserTurn === true && probe.composerCleared === true,
  );
  if (submittedUnverified) {
    throw new BrowserAutomationError(
      "A new user turn was committed and the composer cleared, but Oracle could not verify the exact prompt identity. The review was sent; recover this session and do not submit it again.",
      {
        stage: "submit-prompt",
        code: "prompt-commit-identity-unverified",
        promptSubmitted: true,
        submissionState: "submitted-unverified",
        promptIdentityVerified: false,
        retrySafe: false,
        draftRetained: false,
        candidateUserTurnIndex: probe?.newestUserTurnIndex ?? null,
        promptLength: prompt.trim().length,
        timeoutMs,
        commitProbe: probe ? summarizeCommitProbe(probe) : undefined,
      },
    );
  }
  const draftRetained = Boolean(
    probe &&
    probe.composerCleared === false &&
    typeof probe.editorValue === "string" &&
    probe.editorValue.trim().length > 0 &&
    !probe.hasNewTurn &&
    !probe.stopVisible &&
    !probe.assistantVisible &&
    !probe.inConversation,
  );
  throw new BrowserAutomationError(
    draftRetained
      ? "Prompt remained in the composer after the send attempt; submission did not commit."
      : "Prompt did not appear in conversation before timeout (send may have failed)",
    {
      stage: "submit-prompt",
      code: "prompt-commit-timeout",
      submissionCommitted: false,
      draftRetained,
      promptLength: prompt.trim().length,
      timeoutMs,
      commitProbe: probe ? summarizeCommitProbe(probe) : undefined,
    },
  );
}

interface CommitProbeState {
  baseline?: number;
  userMatched?: boolean;
  matchedUserTurnIndex?: number | null;
  lastMatched?: boolean;
  lastUserTurnAvailable?: boolean;
  hasNewTurn?: boolean;
  hasNewUserTurn?: boolean;
  newestUserTurnIndex?: number | null;
  stopVisible?: boolean;
  assistantVisible?: boolean;
  composerCleared?: boolean;
  inConversation?: boolean;
  turnsCount?: number;
  href?: string;
  editorValue?: string;
  fallbackValue?: string;
  lastTurn?: string;
}

// Keep booleans/counts but replace free text with lengths so session metadata stays lean.
function summarizeCommitProbe(probe: CommitProbeState): Record<string, unknown> {
  return {
    baseline: probe.baseline,
    turnsCount: probe.turnsCount,
    userMatched: probe.userMatched,
    matchedUserTurnIndex: probe.matchedUserTurnIndex,
    lastMatched: probe.lastMatched,
    lastUserTurnAvailable: probe.lastUserTurnAvailable,
    hasNewTurn: probe.hasNewTurn,
    hasNewUserTurn: probe.hasNewUserTurn,
    newestUserTurnIndex: probe.newestUserTurnIndex,
    stopVisible: probe.stopVisible,
    assistantVisible: probe.assistantVisible,
    composerCleared: probe.composerCleared,
    inConversation: probe.inConversation,
    editorLength: typeof probe.editorValue === "string" ? probe.editorValue.length : undefined,
    lastTurnLength: typeof probe.lastTurn === "string" ? probe.lastTurn.length : undefined,
  };
}

function normalizeComposerText(value: string): string {
  return value.replace(/\r\n?/gu, "\n").replace(/\u00a0/gu, " ");
}

// biome-ignore lint/style/useNamingConvention: test-only export used in vitest suite
export const __test__ = {
  attemptRetainedDraftPageRetry,
  attemptSendButton,
  composerValueReaderSource: COMPOSER_VALUE_READER_SOURCE,
  sendButtonTimeoutMs,
  submissionDocumentTokenProperty: SUBMISSION_DOCUMENT_TOKEN_PROPERTY,
  verifyPromptCommitted,
};
