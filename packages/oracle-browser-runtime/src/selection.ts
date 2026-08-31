import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ORACLE_BROWSER_RUNTIME_ID, RUNTIME_ACCEPTANCE_CHECKS } from "./types.js";
import type { RuntimeAcceptanceReceipt, RuntimeCertificationReceipt } from "./types.js";
import { readRuntimeLaunchReceipt, writePrivateJson } from "./runtime.js";

const ACCEPTANCE_RECEIPT = "browser-runtime-acceptance.json";
const CERTIFICATION_RECEIPT = "browser-runtime.json";

export function recordRuntimeAcceptance(input: {
  runtimeRoot: string;
  checks: Record<string, unknown>;
  observedBy: "owner";
  notes?: string;
}): RuntimeAcceptanceReceipt {
  const launch = readRuntimeLaunchReceipt(input.runtimeRoot);
  if (!launch || launch.runtimeId !== ORACLE_BROWSER_RUNTIME_ID) {
    throw new Error("No matching managed Chrome for Testing launch receipt exists");
  }
  if (!launch.closedAt) {
    throw new Error("Managed Chrome for Testing runtime is still open");
  }
  const checks = Object.fromEntries(
    RUNTIME_ACCEPTANCE_CHECKS.map((check) => {
      const result = input.checks[check];
      if (result !== "pass" && result !== "fail" && result !== "blocked") {
        throw new Error(`Runtime acceptance check ${check} must be pass, fail, or blocked`);
      }
      return [check, result];
    }),
  ) as RuntimeAcceptanceReceipt["checks"];
  const receipt: RuntimeAcceptanceReceipt = {
    schemaVersion: "oracle.browser-runtime-acceptance.v2",
    runtimeId: ORACLE_BROWSER_RUNTIME_ID,
    profileDir: launch.profileDir,
    browserRuntimeId: launch.browserRuntimeId,
    restartOrdinal: launch.restartOrdinal,
    checks,
    observedBy: input.observedBy,
    observedAt: new Date().toISOString(),
    ...(input.notes?.trim() ? { notes: input.notes.trim() } : {}),
  };
  writePrivateJson(path.join(path.resolve(input.runtimeRoot), ACCEPTANCE_RECEIPT), receipt);
  return receipt;
}

export function readRuntimeAcceptance(runtimeRoot: string): RuntimeAcceptanceReceipt | undefined {
  return readJson<RuntimeAcceptanceReceipt>(
    path.join(path.resolve(runtimeRoot), ACCEPTANCE_RECEIPT),
  );
}

export function certifyOracleBrowserRuntime(input: {
  runtimeRoot: string;
}): RuntimeCertificationReceipt {
  const launch = readRuntimeLaunchReceipt(input.runtimeRoot);
  const acceptance = readRuntimeAcceptance(input.runtimeRoot);
  if (!launch || !acceptance) {
    throw new Error("Managed Chrome for Testing runtime has no complete owner acceptance");
  }
  if (
    acceptance.runtimeId !== ORACLE_BROWSER_RUNTIME_ID ||
    acceptance.browserRuntimeId !== launch.browserRuntimeId ||
    acceptance.profileDir !== launch.profileDir ||
    acceptance.restartOrdinal !== launch.restartOrdinal
  ) {
    throw new Error("Runtime acceptance is not bound to the latest managed browser launch");
  }
  for (const check of RUNTIME_ACCEPTANCE_CHECKS) {
    if (acceptance.checks[check] !== "pass") {
      throw new Error(
        `Managed Chrome for Testing did not pass acceptance check ${check}: ${acceptance.checks[check]}`,
      );
    }
  }
  const receipt: RuntimeCertificationReceipt = {
    schemaVersion: "oracle.browser-runtime-certification.v2",
    runtimeId: ORACLE_BROWSER_RUNTIME_ID,
    browserRuntimeId: acceptance.browserRuntimeId,
    processOwner: "oracle-worker",
    transport: "direct-cdp",
    profileDir: acceptance.profileDir,
    executablePath: launch.executablePath,
    automaticFallback: false,
    acceptance,
    certifiedAt: new Date().toISOString(),
  };
  writePrivateJson(path.join(path.resolve(input.runtimeRoot), CERTIFICATION_RECEIPT), receipt);
  return receipt;
}

export function readRuntimeCertification(
  runtimeRoot: string,
): RuntimeCertificationReceipt | undefined {
  return readJson<RuntimeCertificationReceipt>(
    path.join(path.resolve(runtimeRoot), CERTIFICATION_RECEIPT),
  );
}

function readJson<T>(filePath: string): T | undefined {
  if (!existsSync(filePath)) return undefined;
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}
