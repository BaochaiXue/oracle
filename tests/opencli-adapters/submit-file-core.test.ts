import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONTRACT_VERSION,
  appendTransportJournalEvent,
  assistantMarkerFromRows,
  buildDataTransferScript,
  buildGenerationControlScript,
  extractConversationReceipt,
  isAlreadyClosedPageError,
  loadSubmissionManifest,
  matchesAssistantBaseline,
  mimeTypeForPath,
  requireOracleGpt56SolModelOutcome,
  requireOracleProThinkingOutcome,
  unwrapEvaluateResult,
} from "../../opencli-adapters/chatgpt/submit-file-core.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("OpenCLI submit-file adapter core", () => {
  it("uses the v3 same-tab native-picker receipt contract", () => {
    expect(CONTRACT_VERSION).toBe(3);
  });

  it("treats an already-closed OpenCLI page identity as idempotent cleanup", () => {
    expect(
      isAlreadyClosedPageError(
        new Error("Page not found: 72C85A3C22F85A7D5D61F05D8B8C9F40 — stale page identity"),
      ),
    ).toBe(true);
    expect(
      isAlreadyClosedPageError(new Error("Page not found: 72C85A3C22F85A7D5D61F05D8B8C9F40")),
    ).toBe(true);
    expect(isAlreadyClosedPageError(new Error("Browser Bridge disconnected"))).toBe(false);
  });

  it("loads an authorized manifest and verifies the sealed payload digest", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-adapter-test-"));
    tempDirs.push(dir);
    const payloadPath = path.join(dir, "oracle-submission.md");
    const attachmentPath = path.join(dir, "input.json");
    const payload = "private payload\n";
    await fs.writeFile(payloadPath, payload, { mode: 0o600 });
    await fs.writeFile(attachmentPath, "{}\n", { mode: 0o600 });
    const manifestPath = path.join(dir, "submit.json");
    const operationRef = "oracle-adapter-test-turn";
    const journalPath = path.join(dir, `opencli-transport-${operationRef}.ndjson`);
    await fs.writeFile(
      manifestPath,
      JSON.stringify({
        contractVersion: CONTRACT_VERSION,
        payloadPath,
        payloadSha256: createHash("sha256").update(payload).digest("hex"),
        attachmentPaths: [attachmentPath],
        operationRef,
        journalPath,
      }),
      { mode: 0o600 },
    );

    const loaded = loadSubmissionManifest(manifestPath);
    expect(loaded.files.map((file: { name: string }) => file.name)).toEqual([
      "oracle-submission.md",
      "input.json",
    ]);
    expect(loaded.files[0]?.base64).toBe(Buffer.from(payload).toString("base64"));
    appendTransportJournalEvent(loaded, "model-ready", { reportedModel: "Pro" });
    appendTransportJournalEvent(loaded, "dispatch-intent", { attempt: 1 });
    const journal = (await fs.readFile(journalPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(journal).toMatchObject([
      { event: "model-ready", operationRef, reportedModel: "Pro" },
      { event: "dispatch-intent", operationRef, attempt: 1 },
    ]);
    expect((await fs.stat(journalPath)).mode & 0o777).toBe(0o600);
  });

  it("rejects payload mutation after Oracle authorization", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-adapter-test-"));
    tempDirs.push(dir);
    const payloadPath = path.join(dir, "oracle-submission.md");
    await fs.writeFile(payloadPath, "mutated\n");
    const manifestPath = path.join(dir, "submit.json");
    const operationRef = "oracle-mutated-turn";
    await fs.writeFile(
      manifestPath,
      JSON.stringify({
        contractVersion: CONTRACT_VERSION,
        payloadPath,
        payloadSha256: "0".repeat(64),
        attachmentPaths: [],
        operationRef,
        journalPath: path.join(dir, `opencli-transport-${operationRef}.ndjson`),
      }),
    );

    expect(() => loadSubmissionManifest(manifestPath)).toThrow(/integrity verification failed/u);
  });

  it("accepts only verified Oracle-native Pro picker outcomes", () => {
    expect(requireOracleGpt56SolModelOutcome({ status: "switched", label: "GPT-5.6 Sol" })).toEqual(
      {
        status: "switched",
        label: "GPT-5.6 Sol",
      },
    );
    expect(() =>
      requireOracleGpt56SolModelOutcome({ status: "switched", label: "GPT-5.6 Sol Pro" }),
    ).toThrow(/invalid GPT-5\.6 Sol label/u);
    expect(() =>
      requireOracleGpt56SolModelOutcome({ status: "switched", label: "GPT-5.5" }),
    ).toThrow(/invalid GPT-5\.6 Sol label/u);
    expect(requireOracleProThinkingOutcome({ status: "switched", label: "Pro" })).toEqual({
      status: "switched",
      label: "Pro",
    });
    expect(() =>
      requireOracleProThinkingOutcome({ status: "option-not-found", label: "极高" }),
    ).toThrow(/did not confirm Pro/u);
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

  it("marks the latest assistant Markdown and distinguishes a follow-up from its baseline", () => {
    const previous = assistantMarkerFromRows([
      { Index: 1, Role: "User", Text: "question" },
      { Index: 2, Role: "Assistant", Text: "Previous answer" },
    ]);
    const current = assistantMarkerFromRows([
      { Index: 2, Role: "Assistant", Text: "Previous answer" },
      { Index: 3, Role: "User", Text: "follow-up" },
      { Index: 4, Role: "Assistant", Text: "New **Markdown** answer" },
    ]);

    expect(previous).toMatchObject({ index: 2, markdown: "Previous answer" });
    expect(previous?.sha256).toBe(createHash("sha256").update("Previous answer").digest("hex"));
    expect(matchesAssistantBaseline(previous, previous?.index, previous?.sha256)).toBe(true);
    expect(matchesAssistantBaseline(current, previous?.index, previous?.sha256)).toBe(false);
  });

  it("detects generation controls without scanning assistant answer text", () => {
    const script = buildGenerationControlScript();
    expect(script).toContain("querySelectorAll('button')");
    expect(script).toContain("stop generating");
    expect(script).not.toContain("document.body");
  });
});
