import { describe, expect, test } from "vitest";
import {
  PROMPT_TEXT_NORMALIZER_SOURCE,
  normalizePromptText,
} from "../../src/browser/promptTextNormalizer.js";
import { hashProPromptIdentity } from "../../src/browser/proResponseTiming.js";

const pageNormalize = new Function(`return (${PROMPT_TEXT_NORMALIZER_SOURCE});`)() as (
  value: string,
) => string;

const corpus = [
  "plain text",
  "**bold** and _italic_ and __strong__",
  "## Heading\n\n- item one\n- item two\n+ item three",
  "> quoted line\n| a | b |\n|---|---|\n| 1 | 2 |",
  "```ts\nconst x = 1;\n```\ninline `code` here ~~struck~~",
  "新话题:BIT 项目(皮层内 brain-to-text)训练/验证的**多卡加速**。",
  "  spaced   out\n\n\nlines  ",
];

describe("prompt text normalizer", () => {
  test("the page-side source and the TypeScript function agree on every sample", () => {
    for (const sample of corpus) {
      expect(pageNormalize(sample)).toBe(normalizePromptText(sample));
    }
  });

  test("a rendered user turn without Markdown markers matches the Markdown prompt", () => {
    const prompt = "**多卡加速**: compare `A` vs `B`\n\n## Constraints\n- keep _semantics_";
    const rendered = "多卡加速: compare A vs B\nConstraints\nkeep semantics";
    expect(normalizePromptText(rendered)).toBe(normalizePromptText(prompt));
    expect(hashProPromptIdentity(rendered)).toBe(hashProPromptIdentity(prompt));
  });

  test("content words still distinguish prompts", () => {
    expect(normalizePromptText("**fix** the bug")).not.toBe(normalizePromptText("**fix** the test"));
  });
});
