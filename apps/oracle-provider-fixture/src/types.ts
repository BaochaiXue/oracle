export const FIXTURE_SCENARIOS = [
  "default",
  "delayed-composer",
  "attachment-chip-delay",
  "missing-attachment",
  "duplicate-filename",
  "commit-delay",
  "click-dropped",
  "late-conversation-url",
  "wrong-conversation-navigation",
  "streaming-assistant",
  "copy-control-missing",
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
