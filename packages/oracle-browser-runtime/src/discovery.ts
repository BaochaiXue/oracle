import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { ORACLE_BROWSER_RUNTIME_ID } from "./types.js";
import type { OracleBrowserRuntimeInspection, RuntimeInspectionOptions } from "./types.js";

export function inspectOracleBrowserRuntime(
  options: RuntimeInspectionOptions = {},
): OracleBrowserRuntimeInspection {
  const executableExists = options.executableExists ?? existsSync;
  const executablePath =
    options.chromeForTestingExecutablePath ?? findCurrentChromeForTestingExecutable();
  const available = Boolean(executablePath && executableExists(executablePath));

  return {
    runtimeId: ORACLE_BROWSER_RUNTIME_ID,
    label: "Managed Chrome for Testing over direct CDP",
    availability: available ? "available" : "unavailable",
    processOwner: "oracle-worker",
    transport: "direct-cdp",
    ...(executablePath ? { executablePath } : {}),
    automaticFallback: false,
    reason: available
      ? "The exact Oracle-managed Chrome for Testing executable is installed."
      : "No exact Oracle-managed Chrome for Testing executable is available.",
  };
}

function findCurrentChromeForTestingExecutable(): string | undefined {
  const root = path.join(homedir(), ".oracle", "browsers", "chrome");
  if (!existsSync(root)) return undefined;
  return findExecutables(root).sort((left, right) =>
    right.localeCompare(left, "en", { numeric: true }),
  )[0];
}

function findExecutables(directory: string): string[] {
  const executables: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      executables.push(...findExecutables(candidate));
    } else if (
      entry.isFile() &&
      entry.name === "Google Chrome for Testing" &&
      candidate.includes("Google Chrome for Testing.app/Contents/MacOS/")
    ) {
      executables.push(candidate);
    }
  }
  return executables;
}
