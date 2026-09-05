export const FIXTURE_SCENARIOS = [
  "default",
  "delayed-composer",
  "attachment-chip-delay",
  "aria-file-tile-attachment",
  "missing-attachment",
  "duplicate-filename",
  "commit-delay",
  "click-dropped",
  "late-conversation-url",
  "provisional-conversation-url",
  "conversation-rollback-after-commit",
  "wrong-conversation-navigation",
  "streaming-assistant",
  "copy-control-missing",
  "conversation-history-rate-limit-modal",
  "auth-required",
  "rate-limit",
  "unknown-ui-fingerprint",
] as const;

export type FixtureScenario = (typeof FIXTURE_SCENARIOS)[number];

export interface FixtureTurn {
  jobId: string;
  turnAttemptId: string;
  prompt: string;
  bundleSha256?: string;
  bundleFilename?: string;
  conversationId: string;
  conversationUrl: string;
  assistantMarkdown: string;
  assistantHtml: string;
  sendCount: number;
  scenario: FixtureScenario;
  committed: boolean;
}
