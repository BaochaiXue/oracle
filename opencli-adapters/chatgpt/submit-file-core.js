import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const CONTRACT_VERSION = 2;
export const MAX_TOTAL_FILE_BYTES = 20 * 1024 * 1024;
export const FIXED_COMPOSER_INSTRUCTION =
  "Read every attached file in full. The oracle-submission Markdown file contains the complete authorized Oracle request. Answer that request directly and use the other attachments only as its referenced inputs.";

export function unwrapEvaluateResult(payload) {
  if (
    payload &&
    !Array.isArray(payload) &&
    typeof payload === "object" &&
    "session" in payload &&
    "data" in payload
  ) {
    return payload.data;
  }
  return payload;
}

export function assistantMarkerFromRows(rows) {
  if (!Array.isArray(rows)) return null;
  for (let offset = rows.length - 1; offset >= 0; offset -= 1) {
    const row = rows[offset];
    const markdown = String(row?.Text ?? "").trim();
    if (
      String(row?.Role ?? "")
        .trim()
        .toLowerCase() !== "assistant" ||
      !markdown
    )
      continue;
    return {
      index: Number.isFinite(row?.Index) ? Number(row.Index) : undefined,
      markdown,
      sha256: createHash("sha256").update(markdown).digest("hex"),
    };
  }
  return null;
}

export function matchesAssistantBaseline(marker, baselineIndex, baselineSha256) {
  if (!marker || (!Number.isFinite(baselineIndex) && !baselineSha256)) return false;
  if (baselineSha256 && marker.sha256 !== baselineSha256) return false;
  if (
    Number.isFinite(baselineIndex) &&
    Number.isFinite(marker.index) &&
    marker.index !== Number(baselineIndex)
  ) {
    return false;
  }
  return true;
}

export function buildGenerationControlScript() {
  return `(() => {
    const isVisible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      return !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
    };
    return Array.from(document.querySelectorAll('button')).some((button) => {
      if (!isVisible(button)) return false;
      const label = [
        button.getAttribute('aria-label'),
        button.getAttribute('title'),
        button.getAttribute('data-testid'),
        button.innerText,
      ].filter(Boolean).join(' ').replace(/\\s+/g, ' ').trim();
      return /stop[-_ ]button/iu.test(label)
        || /stop generating/iu.test(label)
        || /停止生成|停止回答|正在思考/iu.test(label)
        || /^thinking(?:\\.{3}|…)?$/iu.test(label);
    });
  })()`;
}

export function loadSubmissionManifest(manifestPath) {
  const absoluteManifestPath = path.resolve(String(manifestPath ?? ""));
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(absoluteManifestPath, "utf8"));
  } catch {
    throw new Error("Oracle submission manifest is missing or invalid.");
  }
  if (
    manifest?.contractVersion !== CONTRACT_VERSION ||
    typeof manifest?.payloadPath !== "string" ||
    typeof manifest?.payloadSha256 !== "string" ||
    !Array.isArray(manifest?.attachmentPaths)
  ) {
    throw new Error("Oracle submission manifest contract is incompatible.");
  }

  const filePaths = [manifest.payloadPath, ...manifest.attachmentPaths].map((filePath) =>
    path.resolve(String(filePath)),
  );
  const files = [];
  let totalBytes = 0;
  for (const filePath of filePaths) {
    let contents;
    let stat;
    try {
      stat = fs.statSync(filePath);
      if (!stat.isFile()) throw new Error("not-file");
      contents = fs.readFileSync(filePath);
    } catch {
      throw new Error("An authorized Oracle attachment is missing or unreadable.");
    }
    totalBytes += stat.size;
    if (totalBytes > MAX_TOTAL_FILE_BYTES) {
      throw new Error("Oracle attachments exceed the 20 MiB Browser Bridge transfer limit.");
    }
    files.push({
      path: filePath,
      name: path.basename(filePath),
      mime: mimeTypeForPath(filePath),
      sizeBytes: stat.size,
      base64: contents.toString("base64"),
    });
  }

  const payloadHash = createHash("sha256").update(files[0].base64, "base64").digest("hex");
  if (payloadHash !== manifest.payloadSha256) {
    throw new Error("Oracle payload integrity verification failed.");
  }
  return {
    contractVersion: CONTRACT_VERSION,
    manifestPath: absoluteManifestPath,
    files,
  };
}

export function mimeTypeForPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const known = {
    ".csv": "text/csv",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".gif": "image/gif",
    ".html": "text/html",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".json": "application/json",
    ".md": "text/markdown",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".txt": "text/plain",
    ".webp": "image/webp",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".zip": "application/zip",
  };
  return known[ext] ?? "application/octet-stream";
}

export function buildDataTransferScript(files) {
  const payload = files.map(({ name, mime, base64 }) => ({ name, mime, base64 }));
  return `(() => {
    const files = ${JSON.stringify(payload)};
    const input = document.querySelector('#upload-files, input[type="file"]');
    if (!(input instanceof HTMLInputElement)) return { ok: false, reason: 'file-input-missing' };
    const transfer = new DataTransfer();
    for (const item of files) {
      const binary = atob(item.base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      transfer.items.add(new File([bytes], item.name, { type: item.mime }));
    }
    input.files = transfer.files;
    const propsKey = Object.keys(input).find((key) => key.startsWith('__reactProps$'));
    if (propsKey && input[propsKey] && typeof input[propsKey].onChange === 'function') {
      const nativeEvent = new Event('change', { bubbles: true });
      input[propsKey].onChange({
        target: input,
        currentTarget: input,
        nativeEvent,
        preventDefault() {},
        stopPropagation() {},
        isDefaultPrevented() { return false; },
        isPropagationStopped() { return false; },
        persist() {},
      });
    } else {
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return { ok: true, files: transfer.files.length };
  })()`;
}

export function extractConversationReceipt(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl ?? ""));
    if (parsed.protocol !== "https:" || parsed.hostname !== "chatgpt.com") return null;
    const match = parsed.pathname.match(/^\/c\/([A-Za-z0-9_-]{8,})$/u);
    if (!match) return null;
    return { conversationId: match[1], conversationUrl: parsed.toString() };
  } catch {
    return null;
  }
}
