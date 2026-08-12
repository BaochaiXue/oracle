import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const sourceDir = path.resolve(scriptDir, "../opencli-adapters/chatgpt");
const targetDir = path.join(os.homedir(), ".opencli", "clis", "chatgpt");
const filenames = ["submit-file-core.js", "submit-file.js", "oracle-wait.js"];
const replace = process.argv.includes("--replace");

await fs.mkdir(targetDir, { recursive: true });
for (const filename of filenames) {
  const sourcePath = path.join(sourceDir, filename);
  const targetPath = path.join(targetDir, filename);
  const source = await fs.readFile(sourcePath, "utf8");
  const existing = await fs.readFile(targetPath, "utf8").catch(() => null);
  if (existing === source) {
    process.stdout.write(`current ${targetPath}\n`);
    continue;
  }
  if (existing !== null && !replace) {
    throw new Error(
      `${targetPath} already exists with different content; inspect it or rerun with --replace.`,
    );
  }
  const temporaryPath = `${targetPath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, source, { encoding: "utf8", mode: 0o644, flag: "wx" });
  await fs.rename(temporaryPath, targetPath);
  await fs.chmod(targetPath, 0o644);
  process.stdout.write(`installed ${targetPath}\n`);
}
