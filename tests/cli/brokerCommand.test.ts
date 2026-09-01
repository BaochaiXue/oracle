import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test as vitestTest } from "vitest";
import { FakeProvider, OracleWorker } from "../../apps/oracle-worker/src/index.js";
import { BrokerCliJobError, runBrokerCliCommand } from "../../src/cli/brokerCommand.js";

const roots: string[] = [];
const test = process.platform === "win32" ? vitestTest.skip : vitestTest;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("broker CLI command", () => {
  test("renders completion and writes only the final answer artifact", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "oracle-v2-broker-cli-"));
    roots.push(root);
    const paths = {
      rootDir: path.join(root, "store"),
      sessionsDir: path.join(root, "sessions"),
      socketPath: path.join(root, "run", "oracle.sock"),
      intentDirectory: path.join(root, "intents"),
    };
    const worker = new OracleWorker({ ...paths, provider: new FakeProvider() });
    await worker.start();
    const outputPath = path.join(root, "answer.md");
    const lines: string[] = [];
    const result = await runBrokerCliCommand({
      prompt: "Return the broker CLI fixture answer.",
      idempotencyKey: "broker-cli-output",
      wait: true,
      timeoutMs: 5_000,
      writeOutputPath: outputPath,
      paths,
      log: (line) => lines.push(line),
    });

    expect(result.state).toBe("completed");
    expect(result.answer).toMatch(/^Fake answer for job_/u);
    if (!result.answer) throw new Error("Missing broker CLI fixture answer");
    expect(readFileSync(outputPath, "utf8")).toBe(
      result.answer.endsWith("\n") ? result.answer : `${result.answer}\n`,
    );
    expect(statSync(outputPath).mode & 0o777).toBe(0o600);
    expect(readdirSync(path.dirname(outputPath)).filter((name) => name.endsWith(".tmp"))).toEqual(
      [],
    );
    expect(lines.some((line) => line.includes("submission-committed"))).toBe(true);
    await worker.stop();
  });

  test("returns a durable job handle when the host wait budget expires", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "oracle-v2-broker-timeout-"));
    roots.push(root);
    const paths = {
      rootDir: path.join(root, "store"),
      sessionsDir: path.join(root, "sessions"),
      socketPath: path.join(root, "run", "oracle.sock"),
      intentDirectory: path.join(root, "intents"),
    };
    const worker = new OracleWorker({
      ...paths,
      provider: new FakeProvider({ captureDelayMs: 1_000 }),
    });
    await worker.start();
    const result = await runBrokerCliCommand({
      prompt: "Outlive the CLI wait budget.",
      idempotencyKey: "broker-cli-timeout",
      wait: true,
      timeoutMs: 1,
      paths,
      log: () => undefined,
    });

    expect(result.jobId).toMatch(/^job_/u);
    expect(result.timedOut).toBe(true);
    await worker.stop();
  });

  test("retains the admitted job handle when client observation fails", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "o2-cli-err-"));
    roots.push(root);
    const paths = {
      rootDir: path.join(root, "store"),
      sessionsDir: path.join(root, "sessions"),
      socketPath: path.join(root, "run", "oracle.sock"),
      intentDirectory: path.join(root, "intents"),
    };
    const worker = new OracleWorker({ ...paths, provider: new FakeProvider() });
    await worker.start();

    const error = await runBrokerCliCommand({
      prompt: "Keep the job handle after the caller logger fails.",
      idempotencyKey: "broker-cli-observation-error",
      wait: true,
      timeoutMs: 5_000,
      paths,
      log: () => {
        throw new Error("logger unavailable");
      },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BrokerCliJobError);
    expect(error).toMatchObject({
      jobId: expect.stringMatching(/^job_/u),
      phase: "observation",
    });
    await worker.stop();
  });
});
