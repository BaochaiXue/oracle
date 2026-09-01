import type { Locator } from "playwright-core";

export async function readComposerText(composer: Locator): Promise<string> {
  return composer.evaluate((element) => {
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      return element.value;
    }
    if (!(element instanceof HTMLElement)) return element.textContent ?? "";

    const blockTags = new Set([
      "ADDRESS",
      "BLOCKQUOTE",
      "DIV",
      "H1",
      "H2",
      "H3",
      "H4",
      "H5",
      "H6",
      "LI",
      "P",
      "PRE",
    ]);
    const significantChildren: Node[] = [];
    let usesBlockProjection = false;
    for (const node of element.childNodes) {
      if (node.nodeType === Node.TEXT_NODE && !node.textContent?.trim()) continue;
      significantChildren.push(node);
      if (node instanceof HTMLElement && blockTags.has(node.tagName)) {
        usesBlockProjection = true;
      }
    }
    if (!usesBlockProjection) return element.innerText;

    const lines: string[] = [];
    for (const node of significantChildren) {
      if (!(node instanceof HTMLElement)) {
        lines.push(node.textContent ?? "");
      } else if (node.dataset.emptyParagraph === "true") {
        lines.push("");
      } else {
        lines.push(node.innerText.replace(/\n$/u, ""));
      }
    }
    return lines.join("\n");
  });
}
