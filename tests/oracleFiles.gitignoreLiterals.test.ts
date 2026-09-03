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
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-gitignore-literals-"));
  tempDirs.push(cwd);
  await Promise.all([
    fs.mkdir(path.join(cwd, "outputs"), { recursive: true }),
    fs.mkdir(path.join(cwd, "src"), { recursive: true }),
  ]);
  await Promise.all([
    fs.writeFile(path.join(cwd, ".gitignore"), "outputs/\nsrc/generated.ts\n"),
    fs.writeFile(path.join(cwd, "outputs", "plot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47])),
    fs.writeFile(path.join(cwd, "outputs", "other.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47])),
    fs.writeFile(path.join(cwd, "src", "index.ts"), "export const ok = true;\n"),
    fs.writeFile(path.join(cwd, "src", "generated.ts"), "export const generated = true;\n"),
  ]);
  return cwd;
}

function relativePaths(cwd: string, files: Awaited<ReturnType<typeof readFiles>>): string[] {
  return files.map((file) => path.relative(cwd, file.path).split(path.sep).join("/")).sort();
}

describe(".gitignore and explicitly named literal files", () => {
  test("a literal-only invocation attaches an ignored file", async () => {
    const cwd = await fixture();
    const files = await readFiles(["outputs/plot.png"], { cwd, readContents: false });
    expect(relativePaths(cwd, files)).toEqual(["outputs/plot.png"]);
  });

  test("adding a glob does not change whether the named literal is attached", async () => {
    const cwd = await fixture();
    const files = await readFiles(["outputs/plot.png", "src/**"], { cwd, readContents: false });
    // The literal survives; the ignored file discovered only through the glob does not.
    expect(relativePaths(cwd, files)).toEqual(["outputs/plot.png", "src/index.ts"]);
  });

  test("ignored files discovered through a glob or directory are still dropped", async () => {
    const cwd = await fixture();
    const files = await readFiles(["outputs", "src/**"], { cwd, readContents: false });
    expect(relativePaths(cwd, files)).toEqual(["src/index.ts"]);
  });

  test("an explicit exclusion still wins over a literal", async () => {
    const cwd = await fixture();
    const files = await readFiles(["outputs/plot.png", "src/**", "!outputs/**"], {
      cwd,
      readContents: false,
    });
    expect(relativePaths(cwd, files)).toEqual(["src/index.ts"]);
  });
});
