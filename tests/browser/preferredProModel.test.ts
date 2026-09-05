import { beforeEach, expect, test, vi } from "vitest";
import { BrowserAutomationError } from "../../src/oracle/errors.js";
import { ensurePreferredProModel } from "../../src/browser/actions/preferredProModel.js";
import { ensureModelSelection } from "../../src/browser/actions/modelSelection.js";
import { ensureThinkingTime } from "../../src/browser/actions/thinkingTime.js";

vi.mock("../../src/browser/actions/modelSelection.js", () => ({ ensureModelSelection: vi.fn() }));
vi.mock("../../src/browser/actions/thinkingTime.js", () => ({ ensureThinkingTime: vi.fn() }));
const runtime = {} as never;
const logger = vi.fn();
const selected = (label: string) => ({
  requestedModel: label,
  resolvedLabel: label,
  status: "switched" as const,
  verified: true,
  source: "chatgpt-model-picker" as const,
  capturedAt: "2026-09-05T00:00:00Z",
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(ensureModelSelection).mockImplementation(async (_runtime, model) => selected(model));
  vi.mocked(ensureThinkingTime).mockResolvedValue(undefined);
});

test("selects and verifies GPT-6 Pro first", async () => {
  expect(await ensurePreferredProModel(runtime, "GPT-6", logger, "select", "pro")).toMatchObject({
    selectedModel: "GPT-6",
    verified: true,
  });
  expect(ensureModelSelection).toHaveBeenCalledTimes(1);
  expect(ensureThinkingTime).toHaveBeenCalledWith(runtime, "pro", logger, "GPT-6");
});

test.each(["model-option-unavailable", "pro-effort-unavailable"])(
  "falls back only for confirmed %s before Send",
  async (code) => {
    const error = new BrowserAutomationError("unavailable", { code, promptSubmitted: false });
    if (code === "model-option-unavailable")
      vi.mocked(ensureModelSelection).mockRejectedValueOnce(error);
    else vi.mocked(ensureThinkingTime).mockRejectedValueOnce(error);
    expect(await ensurePreferredProModel(runtime, "GPT-6", logger, "select", "pro")).toMatchObject({
      requestedModel: "GPT-6",
      selectedModel: "GPT-5.6 Sol",
      fallbackReason: code,
      verified: true,
    });
    expect(ensureThinkingTime).toHaveBeenLastCalledWith(runtime, "pro", logger, "GPT-5.6 Sol");
  },
);

test.each([
  "model-selector-button-missing",
  "pro-effort-unverified",
  "model-selection-unverified",
  "assistant-timeout",
  "prompt-commit-identity-unverified",
])("does not fallback for %s", async (code) => {
  const error = new BrowserAutomationError("failed", { code, promptSubmitted: false });
  vi.mocked(ensureModelSelection).mockRejectedValueOnce(error);
  await expect(ensurePreferredProModel(runtime, "GPT-6", logger, "select", "pro")).rejects.toBe(
    error,
  );
  expect(ensureModelSelection).toHaveBeenCalledTimes(1);
});

test("never falls back on a sent or unknown-state error", async () => {
  for (const promptSubmitted of [true, undefined]) {
    const error = new BrowserAutomationError("unavailable", {
      code: "model-option-unavailable",
      promptSubmitted,
    });
    vi.mocked(ensureModelSelection).mockRejectedValueOnce(error);
    await expect(ensurePreferredProModel(runtime, "GPT-6", logger, "select", "pro")).rejects.toBe(
      error,
    );
  }
  expect(ensureModelSelection).toHaveBeenCalledTimes(2);
});

test("stops when the fallback also fails verification", async () => {
  vi.mocked(ensureModelSelection).mockRejectedValueOnce(
    new BrowserAutomationError("unavailable", {
      code: "model-option-unavailable",
      promptSubmitted: false,
    }),
  );
  vi.mocked(ensureThinkingTime).mockRejectedValueOnce(new Error("fallback failed"));
  await expect(ensurePreferredProModel(runtime, "GPT-6", logger, "select", "pro")).rejects.toThrow(
    "fallback failed",
  );
  expect(ensureModelSelection).toHaveBeenCalledTimes(2);
});
