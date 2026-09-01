import { execFile, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { FakeProvider, OracleWorker } from "../../apps/oracle-worker/src/index.js";
import { OracleClient } from "../../packages/oracle-client/src/index.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const cliEntry = path.join(process.cwd(), "bin", "oracle-cli.ts");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function rootPaths() {
  const root = mkdtempSync(path.join(tmpdir(), "oracle-v2-root-cli-"));
  roots.push(root);
  return {
    root,
    rootDir: path.join(root, "v2-store"),
    sessionsDir: path.join(root, "sessions"),
    socketPath: path.join(root, "run", "oracle.sock"),
  };
}

async function runCli(args: string[], env: NodeJS.ProcessEnv) {
  return execFileAsync(process.execPath, ["--import", "tsx", cliEntry, ...args], {
    cwd: process.cwd(),
    env,
    timeout: 20_000,
  });
}

describe("root CLI Oracle v2 broker", () => {
  test("reattaches the same idempotent root command and writes the final output", async () => {
    const paths = rootPaths();
    const provider = new FakeProvider();
    const worker = new OracleWorker({ ...paths, provider });
    await worker.start();
    const outputPath = path.join(paths.root, "answer.md");
    const env = {
      ...process.env,
      ORACLE_HOME_DIR: paths.root,
      ORACLE_V2_SOCKET_PATH: paths.socketPath,
      ORACLE_DISABLE_KEYTAR: "1",
    };
    const args = [
      "--engine",
      "broker",
      "--prompt",
      "Review the root broker command.",
      "--idempotency-key",
      "root-cli-reconnect",
      "--write-output",
      outputPath,
      "--timeout",
      "5",
    ];

    const first = await runCli(args, env);
    const second = await runCli(args, env);
    expect(first.stdout).toContain("Admitted Oracle v2 job");
    expect(second.stdout).toContain("Reattached to Oracle v2 job");
    expect(readFileSync(outputPath, "utf8")).toMatch(/^Fake answer for job_/u);
    const client = new OracleClient({ socketPath: paths.socketPath });
    const [job] = await client.listJobs();
    client.close();
    expect(job).toBeDefined();
    expect(provider.sendCount(job!.id)).toBe(1);
    const projected = await runCli(["session", job!.id], env);
    expect(projected.stdout).toContain(`Session: ${job!.id}`);
    expect(projected.stdout).toContain("Mode: broker worker");
    expect(projected.stdout).toContain("Answer:\nFake answer for");
    await worker.stop();
  }, 15_000);

  test("survives a hard-killed client process and reconnects without a second Send", async () => {
    const paths = rootPaths();
    const provider = new FakeProvider({ captureDelayMs: 1_000 });
    const worker = new OracleWorker({ ...paths, provider });
    await worker.start();
    const env = {
      ...process.env,
      ORACLE_HOME_DIR: paths.root,
      ORACLE_V2_SOCKET_PATH: paths.socketPath,
      ORACLE_DISABLE_KEYTAR: "1",
    };
    const args = [
      "--engine",
      "broker",
      "--prompt",
      "Finish after the admitting CLI is killed.",
      "--idempotency-key",
      "root-cli-hard-kill",
      "--timeout",
      "10",
    ];
    const child = spawn(process.execPath, ["--import", "tsx", cliEntry, ...args], {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    const jobId = await new Promise<string>((resolve, reject) => {
      const deadline = setTimeout(
        () => reject(new Error(`CLI admission not observed: ${stdout}`)),
        10_000,
      );
      const inspect = (): void => {
        const match = stdout.match(/Admitted Oracle v2 job (job_[A-Za-z0-9-]+)/u);
        if (!match?.[1]) return;
        clearTimeout(deadline);
        child.stdout.off("data", inspect);
        resolve(match[1]);
      };
      child.stdout.on("data", inspect);
      inspect();
    });
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));

    const client = new OracleClient({ socketPath: paths.socketPath });
    await client.waitForTerminal(jobId, { timeoutMs: 5_000 });
    client.close();
    const reconnected = await runCli(args, env);
    expect(reconnected.stdout).toContain(`Reattached to Oracle v2 job ${jobId}`);
    expect(provider.sendCount(jobId)).toBe(1);
    await worker.stop();
  });

  test("renders broker dry-run membership without a running worker", async () => {
    const paths = rootPaths();
    const source = path.join(paths.root, "source.ts");
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(source, "export const ok = true;\n"),
    );
    const result = await runCli(
      ["--engine", "broker", "--prompt", "Review source.", "--file", source, "--dry-run", "json"],
      { ...process.env, ORACLE_HOME_DIR: paths.root, ORACLE_DISABLE_KEYTAR: "1" },
    );
    const jsonStart = result.stdout.indexOf("{\n");
    const preview = JSON.parse(result.stdout.slice(jsonStart)) as {
      engine: string;
      bundle: { files: Array<{ path: string }> };
      dispatch: boolean;
    };
    expect(preview.engine).toBe("broker");
    expect(preview.bundle.files.map((file) => file.path)).toEqual([
      expect.stringMatching(/^\.oracle-v2-external\/[a-f0-9]{64}-1$/u),
    ]);
    expect(preview.dispatch).toBe(false);
  });

  test("does not silently coerce an explicit broker multi-model request to API", async () => {
    const paths = rootPaths();
    await expect(
      runCli(
        [
          "--engine",
          "broker",
          "--prompt",
          "Do not coerce this route.",
          "--models",
          "gpt-5.6-sol,gpt-5.5-pro",
          "--dry-run",
        ],
        { ...process.env, ORACLE_HOME_DIR: paths.root, ORACLE_DISABLE_KEYTAR: "1" },
      ),
    ).rejects.toThrow(/exactly one GPT-5\.6 Sol \/ Pro route/u);
  });

  test("rejects broker-only identity options on a legacy engine", async () => {
    const paths = rootPaths();
    await expect(
      runCli(
        [
          "--engine",
          "api",
          "--prompt",
          "Do not ignore broker identity.",
          "--idempotency-key",
          "must-not-be-ignored",
          "--dry-run",
        ],
        { ...process.env, ORACLE_HOME_DIR: paths.root, ORACLE_DISABLE_KEYTAR: "1" },
      ),
    ).rejects.toThrow(/broker-only options/u);
  });
});
