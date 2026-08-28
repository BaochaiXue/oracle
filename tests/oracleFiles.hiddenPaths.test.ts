import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { readFiles } from "../src/oracle/files.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-hidden-files-"));
  tempDirs.push(cwd);
  await Promise.all([
    fs.mkdir(path.join(cwd, "src", ".secrets"), { recursive: true }),
    fs.mkdir(path.join(cwd, ".github", "workflows"), { recursive: true }),
  ]);
  await Promise.all([
    fs.writeFile(path.join(cwd, "src", "visible.ts"), "export const visible = true;\n"),
    fs.writeFile(path.join(cwd, "src", ".secrets", "token.txt"), "do-not-upload\n"),
    fs.writeFile(path.join(cwd, ".github", "workflows", "ci.yml"), "name: CI\n"),
    fs.writeFile(path.join(cwd, ".env"), "SECRET=local\n"),
  ]);
  return cwd;
}

function relativePaths(cwd: string, files: Awaited<ReturnType<typeof readFiles>>): string[] {
  return files.map((file) => path.relative(cwd, file.path).split(path.sep).join("/")).sort();
}

describe("hidden-path file admission", () => {
  test("does not let one explicit dot pattern enable hidden files for sibling patterns", async () => {
    const cwd = await fixture();

    const files = await readFiles(["src/**", ".github/**"], {
      cwd,
      readContents: false,
    });

    expect(relativePaths(cwd, files)).toEqual([".github/workflows/ci.yml", "src/visible.ts"]);
  });

  test("admits a hidden subtree only when that subtree is explicitly named", async () => {
    const cwd = await fixture();

    const files = await readFiles(["src/.secrets/**"], {
      cwd,
      readContents: false,
    });

    expect(relativePaths(cwd, files)).toEqual(["src/.secrets/token.txt"]);
  });

  test("keeps exact hidden-file literals as an explicit owner override", async () => {
    const cwd = await fixture();

    const files = await readFiles([".env"], {
      cwd,
      readContents: false,
    });

    expect(relativePaths(cwd, files)).toEqual([".env"]);
  });
});
