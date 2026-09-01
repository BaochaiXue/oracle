import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { FakeProvider, OracleWorker } from "../../apps/oracle-worker/src/index.js";
import { OracleClient } from "../../packages/oracle-client/src/index.js";
import type {
  ClientEvent,
  ClientJob,
  ClientJobResult,
} from "../../packages/oracle-client/src/index.js";
import { admitBrokerReview, prepareBrokerReview, waitForBrokerJob } from "../../src/v2/broker.js";
import { buildMarkdownBundle } from "../../src/cli/markdownBundle.js";

const roots: string[] = [];
const workerTest = process.platform === "win32" ? test.skip : test;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Oracle v2 broker bridge", () => {
  test("uses legacy source selection membership and seals one deterministic bundle", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "oracle-v2-broker-bundle-"));
    roots.push(root);
    writeFileSync(path.join(root, "b.ts"), "export const b = 2;\r\n");
    writeFileSync(path.join(root, "a.ts"), "export const a = 1;\n");

    const prepared = await prepareBrokerReview({
      cwd: root,
      prompt: "Review these sources.",
      system: "Be exact.",
      files: ["*.ts"],
    });
    const legacy = await buildMarkdownBundle(
      { prompt: "Review these sources.", file: ["*.ts"], system: "Be exact." },
      { cwd: root },
    );
    expect(prepared.selectedFiles).toEqual(legacy.files.map((file) => path.resolve(file.path)));
    expect(prepared.files.map((file) => file.path)).toEqual(["a.ts", "b.ts"]);
    expect(prepared.selectedFiles).toEqual([path.join(root, "a.ts"), path.join(root, "b.ts")]);
    expect(prepared.bundleFilename).toBe(`oracle-source-${prepared.bundleSha256?.slice(0, 12)}.md`);
    expect(prepared.promptText).toBe(
      `Be exact.\n\nReview these sources.\n\nOracle source bundle SHA-256: ${prepared.bundleSha256}\n`,
    );
  });

  workerTest("reconnects with one stable request identity and returns the completed answer", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "oracle-v2-broker-review-"));
    roots.push(root);
    const paths = {
      rootDir: path.join(root, "store"),
      sessionsDir: path.join(root, "sessions"),
      socketPath: path.join(root, "run", "oracle.sock"),
      intentDirectory: path.join(root, "intents"),
    };
    const provider = new FakeProvider();
    const worker = new OracleWorker({ ...paths, provider });
    await worker.start();
    const client = new OracleClient({ socketPath: paths.socketPath });

    const input = {
      prompt: "Review the broker reconnect path.",
      idempotencyScope: "test-broker",
      idempotencyKey: "same-logical-call",
      paths,
      client,
    };
    const first = await admitBrokerReview(input);
    const second = await admitBrokerReview(input);
    expect(second.requestId).toBe(first.requestId);
    expect(second.admission.created).toBe(false);
    expect(second.admission.job.id).toBe(first.admission.job.id);

    const settled = await waitForBrokerJob(client, first.admission.job.id, { timeoutMs: 5_000 });
    expect(settled.timedOut).toBe(false);
    expect(settled.result).toMatchObject({ ready: true, state: "completed" });
    expect(provider.sendCount(first.admission.job.id)).toBe(1);

    client.close();
    await worker.stop();
  });

  test("drains terminal events that arrive with the terminal state transition", async () => {
    const terminalEvent: ClientEvent = {
      seq: 9,
      type: "capture-completed",
      event: { state: "completed" },
      createdAt: new Date().toISOString(),
    };
    let eventRead = 0;
    const client = {
      listEvents: async () => (eventRead++ === 0 ? [] : [terminalEvent]),
      getJob: async () => ({ id: "job_terminal-drain", state: { kind: "completed" } }) as ClientJob,
      getResult: async () =>
        ({
          jobId: "job_terminal-drain",
          state: "completed",
          ready: true,
          answer: {
            sha256: "a".repeat(64),
            sizeBytes: 7,
            mediaType: "text/plain",
            objectClass: "answer",
          },
          text: "answer\n",
          mediaType: "text/plain",
        }) satisfies ClientJobResult,
    };
    const observed: string[] = [];

    const settled = await waitForBrokerJob(client, "job_terminal-drain", {
      timeoutMs: 1_000,
      onEvent: (event) => {
        observed.push(event.type);
      },
    });

    expect(settled.timedOut).toBe(false);
    expect(settled.lastEventSeq).toBe(terminalEvent.seq);
    expect(observed).toEqual(["capture-completed"]);
  });
});
