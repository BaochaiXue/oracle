import type { Page } from "playwright-core";

const CHATGPT_COMPOSER_CANDIDATES = [
  "#prompt-textarea",
  'textarea[data-id="prompt-textarea"]',
  'textarea[name="prompt-textarea"]',
  'textarea[aria-label*="Message ChatGPT" i]',
  '.ProseMirror[contenteditable="true"]',
  '[contenteditable="true"][role="textbox"]',
];

export const CHATGPT_COMPOSER_DOM_SELECTOR = CHATGPT_COMPOSER_CANDIDATES.join(", ");
export const CHATGPT_COMPOSER_SELECTOR = CHATGPT_COMPOSER_CANDIDATES.map(
  (candidate) => `${candidate}:visible`,
).join(", ");

export function chatGptLocators(page: Page) {
  const modelButton = page
    .locator(
      [
        '[data-testid="model-switcher-dropdown-button"]',
        'button.__composer-pill[aria-haspopup="menu"]',
        'form button[aria-haspopup="menu"]:not(#composer-plus-btn):not([data-testid="composer-plus-btn"])',
        'button[aria-label="Choose model" i]',
      ].join(", "),
    )
    .first();
  const composer = page.locator(CHATGPT_COMPOSER_SELECTOR).first();
  return {
    login: page.getByRole("button", { name: /log in/i }),
    modelButton,
    modelOption: page
      .locator(
        [
          '[data-testid^="model-switcher-gpt-5-6"]',
          '[role="menuitemradio"]',
          '[role="menuitem"]',
        ].join(", "),
      )
      .filter({ hasText: /^\s*GPT-5\.6\s+Sol\s*$/iu })
      .first(),
    effort: page
      .locator(
        [
          '[data-testid="composer-model-picker-power-slider"]',
          '[role="slider"][aria-label*="Intelligence" i]',
          '[role="slider"][aria-label*="Reasoning effort" i]',
        ].join(", "),
      )
      .first(),
    attachmentButton: page
      .locator(
        [
          "#composer-plus-btn",
          'button[data-testid="composer-plus-btn"]',
          'button[aria-label*="Attach files" i]',
          'button[aria-label*="Add files" i]',
        ].join(", "),
      )
      .first(),
    uploadInput: page.locator('input[type="file"]').first(),
    uploadStatus: page.getByRole("status"),
    attachmentChips: page.locator("[data-attachment-chip]"),
    composer,
    send: page
      .locator(
        [
          'button[data-testid="send-button"]',
          'button[data-testid*="composer-send"]',
          'form button[type="submit"][aria-label*="Send" i]',
          'button[aria-label*="Send prompt" i]',
        ].join(", "),
      )
      .first(),
    conversation: page.locator('[data-testid="conversation-root"], main').first(),
    userTurns: page.locator('[data-message-author-role="user"]'),
    assistantTurns: page.locator('[data-message-author-role="assistant"]'),
  };
}
