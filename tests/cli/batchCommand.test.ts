import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const CLI_ENTRY = path.join(process.cwd(), "bin", "oracle-cli.ts");
const TSX_LOADER = pathToFileURL(
  path.join(process.cwd(), "node_modules", "tsx", "dist", "loader.mjs"),
).href;

describe("Batch Oracle CLI", () => {
  let home: string;
  let cwd: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-batch-cli-home-"));
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-batch-cli-cwd-"));
  });

  afterEach(async () => {
    await Promise.all([
      fs.rm(home, { recursive: true, force: true }),
      fs.rm(cwd, { recursive: true, force: true }),
    ]);
  });

  test("advertises the six Batch Oracle subcommands", async () => {
    const result = await execCli(["batch", "--help"]);
    expect(result.code).toBe(0);
    for (const command of ["validate", "run", "status", "resume", "accept-missing", "render"]) {
      expect(result.stdout).toMatch(new RegExp(`\\b${command}\\b`, "u"));
    }
  });

  test("offers owner closure for either an unavailable lane or synthesis", async () => {
    const result = await execCli(["batch", "accept-missing", "--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("--lane <lane-id>");
    expect(result.stdout).toContain("--synthesis");
    expect(result.stdout).toContain("--reason <text>");
  });

  test.each([
    ["neither", []],
    ["both", ["--lane", "one", "--synthesis"]],
  ])("rejects %s accept-missing target selection", async (_label, targetArgs) => {
    const result = await execCli([
      "batch",
      "accept-missing",
      "fixture-batch",
      ...targetArgs,
      "--reason",
      "owner closure",
    ]);
    expect(result.code).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "Choose exactly one accept-missing target",
    );
  });

  test("validates JSON5 and reports field-path errors without dispatch", async () => {
    await fs.writeFile(
      path.join(cwd, "valid.json5"),
      `{
      schemaVersion: 'oracle.batch.v1',
      slug: 'cli-fixture',
      project: 'fixture',
      objective: 'Exercise validation.',
      lanes: [
        { id: 'one', title: 'One', mandate: 'A', whyThisLane: 'A', falsificationTarget: 'A', prompt: 'A', outputContract: ['A'] },
        { id: 'two', title: 'Two', mandate: 'B', whyThisLane: 'B', falsificationTarget: 'B', prompt: 'B', outputContract: ['B'] },
      ],
    }`,
      "utf8",
    );
    const valid = await execCli(["batch", "validate", "valid.json5"]);
    expect(valid.code).toBe(0);
    expect(valid.stdout).toContain(
      "Valid oracle.batch.v1 manifest: cli-fixture (2 lanes, 2 max children).",
    );

    await fs.writeFile(
      path.join(cwd, "invalid.json5"),
      `{
      schemaVersion: 'oracle.batch.v1', slug: 'bad', project: 'fixture', objective: 'Bad.',
      lanes: [
        { id: 'one', title: 'One', mandate: 'A', whyThisLane: 'A', falsificationTarget: 'A', prompt: 'same', outputContract: ['A'] },
        { id: 'two', title: 'Two', mandate: 'B', whyThisLane: 'B', falsificationTarget: 'B', prompt: ' same ', outputContract: ['B'] },
      ],
    }`,
      "utf8",
    );
    const invalid = await execCli(["batch", "validate", "invalid.json5"]);
    expect(invalid.code).toBe(1);
    expect(`${invalid.stdout}\n${invalid.stderr}`).toContain("lanes[1].prompt");
  });

  function execCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      execFile(
        process.execPath,
        ["--import", TSX_LOADER, CLI_ENTRY, ...args],
        {
          cwd,
          env: {
            ...process.env,
            // biome-ignore lint/style/useNamingConvention: environment variable is canonical.
            ORACLE_HOME_DIR: home,
            // biome-ignore lint/style/useNamingConvention: environment variable is canonical.
            ORACLE_DISABLE_KEYTAR: "1",
          },
        },
        (error, stdout, stderr) =>
          resolve({
            code: typeof error?.code === "number" ? error.code : error ? 1 : 0,
            stdout: String(stdout),
            stderr: String(stderr),
          }),
      );
    });
  }
});
