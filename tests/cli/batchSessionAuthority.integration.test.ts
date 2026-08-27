import { afterEach, describe, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const CLI_ENTRY = path.join(process.cwd(), "bin", "oracle-cli.ts");
const temporaryHomes: string[] = [];

async function execCli(
  oracleHome: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--import", "tsx", CLI_ENTRY, ...args],
      {
        env: {
          ...process.env,
          // biome-ignore lint/style/useNamingConvention: environment variable name
          ORACLE_HOME_DIR: oracleHome,
          // biome-ignore lint/style/useNamingConvention: environment variable name
          ORACLE_DISABLE_KEYTAR: "1",
          // biome-ignore lint/style/useNamingConvention: environment variable name
          NO_COLOR: "1",
        },
        timeout: 30_000,
      },
      (error, stdout, stderr) => {
        resolve({
          code: typeof error?.code === "number" ? error.code : error ? 1 : 0,
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
  });
}

async function createBatchSynthesisFixture(status = "running"): Promise<{
  oracleHome: string;
  sessionId: string;
  metadataPath: string;
  logPath: string;
  metadataText: string;
}> {
  const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-batch-authority-"));
  temporaryHomes.push(oracleHome);
  const sessionId = "abandoned-batch-synthesis";
  const sessionDir = path.join(oracleHome, "sessions", sessionId);
  await mkdir(sessionDir, { recursive: true });
  const metadata = {
    id: sessionId,
    createdAt: "2026-01-01T00:00:00.000Z",
    status,
    mode: "browser",
    model: "gpt-5-pro",
    options: {
      prompt: "sealed synthesis prompt",
      model: "gpt-5-pro",
      mode: "browser",
      zombieTimeoutMs: 1,
    },
    browser: {
      config: { manualLogin: true },
      runtime: {
        promptSubmitted: true,
        conversationId: "retained-conversation",
        tabUrl: "https://chatgpt.com/c/retained-conversation",
      },
    },
    batch: {
      batchId: "batch-123",
      laneId: "adjudication",
      role: "synthesis",
      attempt: 1,
      inputManifestSha256: "e".repeat(64),
    },
  };
  const metadataText = JSON.stringify(metadata, null, 2);
  const metadataPath = path.join(sessionDir, "meta.json");
  const logPath = path.join(sessionDir, "output.log");
  await writeFile(metadataPath, metadataText, "utf8");
  await writeFile(logPath, "retained synthesis evidence\n", "utf8");
  return { oracleHome, sessionId, metadataPath, logPath, metadataText };
}

afterEach(async () => {
  await Promise.all(temporaryHomes.splice(0).map((entry) => rm(entry, { recursive: true })));
});

describe("Batch child generic CLI authority", () => {
  test("status inspection does not reconcile or mutate Batch metadata", async () => {
    const fixture = await createBatchSynthesisFixture();

    const result = await execCli(fixture.oracleHome, ["status", "--all"]);

    expect(result.code).toBe(0);
    expect(await readFile(fixture.metadataPath, "utf8")).toBe(fixture.metadataText);
  });

  test("restart rejects an abandoned synthesis before creating a session", async () => {
    const fixture = await createBatchSynthesisFixture("error");

    const result = await execCli(fixture.oracleHome, ["restart", fixture.sessionId]);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.code).toBe(1);
    expect(output).toMatch(
      /batchId=batch-123, laneId=adjudication, role=synthesis.*restart.*ordinary Oracle run.*oracle batch resume batch-123/s,
    );
    expect(await readdir(path.join(fixture.oracleHome, "sessions"))).toEqual([fixture.sessionId]);
    expect(await readFile(fixture.metadataPath, "utf8")).toBe(fixture.metadataText);
  });

  test("hidden stored-session execution cannot run or mutate a Batch child", async () => {
    const fixture = await createBatchSynthesisFixture("error");
    const initialLog = await readFile(fixture.logPath, "utf8");

    const result = await execCli(fixture.oracleHome, ["--exec-session", fixture.sessionId]);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.code).toBe(1);
    expect(output).toMatch(
      /batchId=batch-123, laneId=adjudication, role=synthesis.*stored-session execution.*oracle batch resume batch-123/s,
    );
    expect(await readFile(fixture.metadataPath, "utf8")).toBe(fixture.metadataText);
    expect(await readFile(fixture.logPath, "utf8")).toBe(initialLog);
  });
});
