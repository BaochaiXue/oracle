const GEMINI_MODEL_PATTERN = /gemini/i;

export const GEMINI_REJECTED_MESSAGE =
  "This Oracle fork reserves its canonical lane for ChatGPT GPT-5.6 Pro. Use OpenCLI separately for Gemini.";

export function isGeminiModelRequest(model: unknown): boolean {
  return typeof model === "string" && GEMINI_MODEL_PATTERN.test(model.trim());
}

export function assertOracleModelAllowed(model: unknown): void {
  if (isGeminiModelRequest(model)) {
    throw new Error(GEMINI_REJECTED_MESSAGE);
  }
}

export function assertOracleModelsAllowed(models: readonly unknown[]): void {
  for (const model of models) {
    assertOracleModelAllowed(model);
  }
}
