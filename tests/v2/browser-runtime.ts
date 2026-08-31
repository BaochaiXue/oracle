import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export function findFixtureBrowserExecutable(): string | undefined {
  const configured = process.env.ORACLE_V2_FIXTURE_BROWSER_EXECUTABLE?.trim();
  if (configured) return existsSync(configured) ? configured : undefined;
  const root = path.join(homedir(), ".oracle", "browsers", "chrome");
  if (!existsSync(root)) return undefined;
  return findExecutable(root);
}

function findExecutable(directory: string): string | undefined {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = findExecutable(candidate);
      if (nested) return nested;
    } else if (
      entry.isFile() &&
      entry.name === "Google Chrome for Testing" &&
      candidate.includes("Google Chrome for Testing.app/Contents/MacOS/")
    ) {
      return candidate;
    }
  }
  return undefined;
}
