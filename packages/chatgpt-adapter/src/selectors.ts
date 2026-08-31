import type { Page } from "playwright-core";

export function chatGptLocators(page: Page) {
  return {
    login: page.getByRole("button", { name: /log in/i }),
    modelButton: page.getByRole("button", { name: /choose model/i }),
    modelOption: page.getByRole("menuitemradio", { name: "GPT-5.6 Sol", exact: true }),
    effort: page.getByRole("slider", { name: /reasoning effort/i }),
    attachmentButton: page.getByRole("button", { name: /attach files/i }),
    uploadInput: page.locator('input[type="file"]'),
    uploadStatus: page.getByRole("status"),
    attachmentChips: page.locator("[data-attachment-chip]"),
    composer: page.getByRole("textbox", { name: /message chatgpt/i }),
    send: page.getByRole("button", { name: /send prompt/i }),
    conversation: page.locator('[data-testid="conversation-turns"]'),
    userTurns: page.locator('[data-message-author-role="user"]'),
    assistantTurns: page.locator('[data-message-author-role="assistant"]'),
  };
}
