import { describe, expect, test } from "vitest";
import {
  assertOracleModelAllowed,
  assertOracleModelsAllowed,
  GEMINI_REJECTED_MESSAGE,
  isGeminiModelRequest,
} from "../../src/oracle/forkPolicy.js";

describe("Oracle fork model policy", () => {
  test.each(["gemini", "Gemini 3.1 Pro", "gemini-3.5-flash", "google/gemini-2.5-pro"])(
    "rejects %s",
    (model) => {
      expect(isGeminiModelRequest(model)).toBe(true);
      expect(() => assertOracleModelAllowed(model)).toThrow(GEMINI_REJECTED_MESSAGE);
    },
  );

  test("rejects a Gemini member in a multi-model request", () => {
    expect(() => assertOracleModelsAllowed(["gpt-5-pro", "gemini-3.1-pro"])).toThrow(
      GEMINI_REJECTED_MESSAGE,
    );
  });

  test.each(["gpt-5-pro", "gpt-5.6-sol", "claude-4.6-sonnet", "custom/model"])(
    "does not change non-Gemini compatibility for %s",
    (model) => {
      expect(isGeminiModelRequest(model)).toBe(false);
      expect(() => assertOracleModelAllowed(model)).not.toThrow();
    },
  );
});
