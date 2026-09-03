/**
 * Prompt text normalization shared by the Pro prompt digest (Node side) and by
 * every in-page comparison of a rendered ChatGPT user turn against the prompt
 * Oracle sent (commit verification, conversation-identity binding, reattach).
 *
 * ChatGPT renders Markdown inside user turns: emphasis markers, headings,
 * blockquotes, table pipes, and list bullets disappear from `innerText`, while
 * fences and inline code keep their content. A prompt with `**bold**` therefore
 * never matched its rendered turn, Oracle reported "not sent", and the agent
 * resent it. Both sides now drop the same Markdown punctuation before
 * comparing, so rendering differences cannot break equality; the digest stays
 * a strong identity because the content words are untouched.
 *
 * The two implementations below must stay identical; a test executes the page
 * source and compares it with the TypeScript function over a corpus.
 */
export function normalizePromptText(value: string): string {
  let text = String(value ?? "").toLowerCase();
  text = text.replace(/```[^\n]*\n([\s\S]*?)```/gu, " $1 ");
  text = text.replace(/```/gu, " ");
  text = text.replace(/`([^`]*)`/gu, "$1");
  // Inline emphasis markers vanish without leaving a gap; block markers
  // (headings, quotes, table pipes, bullets) become whitespace.
  text = text.replace(/[*_~]/gu, "");
  text = text.replace(/[#>|]/gu, " ");
  text = text.replace(/^\s*[-+]\s+/gmu, " ");
  return text.replace(/\s+/gu, " ").trim();
}

/** JavaScript source of the same function, for embedding in page expressions. */
export const PROMPT_TEXT_NORMALIZER_SOURCE =
  "((value) => {" +
  " let text = String(value ?? '').toLowerCase();" +
  " text = text.replace(/```[^\\n]*\\n([\\s\\S]*?)```/g, ' $1 ');" +
  " text = text.replace(/```/g, ' ');" +
  " text = text.replace(/`([^`]*)`/g, '$1');" +
  " text = text.replace(/[*_~]/g, '');" +
  " text = text.replace(/[#>|]/g, ' ');" +
  " text = text.replace(/^\\s*[-+]\\s+/gm, ' ');" +
  " return text.replace(/\\s+/g, ' ').trim();" +
  " })";
