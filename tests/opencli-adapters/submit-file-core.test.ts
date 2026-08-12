import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONTRACT_VERSION,
  buildDataTransferScript,
  extractConversationReceipt,
  loadSubmissionManifest,
  mimeTypeForPath,
  unwrapEvaluateResult,
} from "../../opencli-adapters/chatgpt/submit-file-core.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("OpenCLI submit-file adapter core", () => {
  it("loads an authorized manifest and verifies the sealed payload digest", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-adapter-test-"));
    tempDirs.push(dir);
    const payloadPath = path.join(dir, "oracle-submission.md");
    const attachmentPath = path.join(dir, "input.json");
    const payload = "private payload\n";
    await fs.writeFile(payloadPath, payload, { mode: 0o600 });
    await fs.writeFile(attachmentPath, "{}\n", { mode: 0o600 });
    const manifestPath = path.join(dir, "submit.json");
    await fs.writeFile(
      manifestPath,
      JSON.stringify({
        contractVersion: CONTRACT_VERSION,
        payloadPath,
        payloadSha256: createHash("sha256").update(payload).digest("hex"),
        attachmentPaths: [attachmentPath],
      }),
      { mode: 0o600 },
    );

    const loaded = loadSubmissionManifest(manifestPath);
    expect(loaded.files.map((file: { name: string }) => file.name)).toEqual([
      "oracle-submission.md",
      "input.json",
    ]);
    expect(loaded.files[0]?.base64).toBe(Buffer.from(payload).toString("base64"));
  });

  it("rejects payload mutation after Oracle authorization", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-adapter-test-"));
    tempDirs.push(dir);
    const payloadPath = path.join(dir, "oracle-submission.md");
    await fs.writeFile(payloadPath, "mutated\n");
    const manifestPath = path.join(dir, "submit.json");
    await fs.writeFile(
      manifestPath,
      JSON.stringify({
        contractVersion: CONTRACT_VERSION,
        payloadPath,
        payloadSha256: "0".repeat(64),
        attachmentPaths: [],
      }),
    );

    expect(() => loadSubmissionManifest(manifestPath)).toThrow(/integrity verification failed/u);
  });

  it("builds a DataTransfer payload and parses only ChatGPT receipts", () => {
    const script = buildDataTransferScript([
      { name: "request.md", mime: "text/markdown", base64: "c2VjcmV0" },
    ]);
    expect(script).toContain("DataTransfer");
    expect(script).toContain("c2VjcmV0");
    expect(unwrapEvaluateResult({ session: "s", data: true })).toBe(true);
    expect(extractConversationReceipt("https://chatgpt.com/c/conversation_123")).toEqual({
      conversationId: "conversation_123",
      conversationUrl: "https://chatgpt.com/c/conversation_123",
    });
    expect(extractConversationReceipt("https://example.com/c/conversation_123")).toBeNull();
    expect(mimeTypeForPath("bundle.zip")).toBe("application/zip");
  });
});
