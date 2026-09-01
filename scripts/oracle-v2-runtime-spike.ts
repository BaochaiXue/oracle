#!/usr/bin/env node
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import {
  RUNTIME_ACCEPTANCE_CHECKS,
  certifyOracleBrowserRuntime,
  inspectOracleBrowserRuntime,
  launchOracleBrowserRuntime,
  readRuntimeAcceptance,
  readRuntimeCertification,
  recordRuntimeAcceptance,
  sanitizeRuntimeObservationUrl,
  writePrivateJson,
  type RuntimeAcceptanceCheck,
  type RuntimeAcceptanceResult,
} from "../packages/oracle-browser-runtime/src/index.js";
import {
  observeComposerControlSurface,
  probeCompatibility,
  probeAttachmentWithoutSend,
  probeModelAndEffortControls,
  probeLiveCompatibilityWithoutSend,
} from "../packages/chatgpt-adapter/src/index.js";

const CHATGPT_URL = "https://chatgpt.com/";
const runtimeRoot = path.resolve(
  process.env.ORACLE_V2_RUNTIME_ROOT?.trim() || path.join(homedir(), ".oracle", "v2"),
);

async function main(): Promise<void> {
  const [command = "inspect", ...args] = process.argv.slice(2);
  switch (command) {
    case "inspect":
      print({
        schemaVersion: "oracle.browser-runtime-spike.v2",
        runtimeRoot,
        profileDir: path.join(runtimeRoot, "browser-profile"),
        runtime: inspectOracleBrowserRuntime(),
        acceptance: readRuntimeAcceptance(runtimeRoot) ?? null,
        certification: readRuntimeCertification(runtimeRoot) ?? null,
      });
      return;
    case "open":
      await openRuntime(args);
      return;
    case "probe":
      await probeRuntime();
      return;
    case "model-no-send":
      await modelNoSend();
      return;
    case "attachment-no-send":
      await attachmentNoSend();
      return;
    case "compatibility-no-send":
      await compatibilityNoSend();
      return;
    case "record":
      recordAcceptance(args);
      return;
    case "certify":
      print(certifyOracleBrowserRuntime({ runtimeRoot }));
      return;
    case "acceptance":
      print(readRuntimeAcceptance(runtimeRoot) ?? null);
      return;
    case "certification":
      print(readRuntimeCertification(runtimeRoot) ?? null);
      return;
    default:
      throw new Error(`Unknown runtime-spike command: ${command}`);
  }
}

async function modelNoSend(): Promise<void> {
  const runtime = await launchOracleBrowserRuntime({ runtimeRoot, headless: false });
  try {
    const page = await runtime.openPage(CHATGPT_URL);
    const result = await probeModelAndEffortControls(page, { timeoutMs: 30_000 });
    print({
      runtimeId: runtime.receipt.runtimeId,
      restartOrdinal: runtime.receipt.restartOrdinal,
      url: sanitizeRuntimeObservationUrl(page.url()),
      ...result,
      automaticFallback: false,
    });
  } finally {
    await runtime.close();
  }
}

async function attachmentNoSend(): Promise<void> {
  const runtime = await launchOracleBrowserRuntime({ runtimeRoot, headless: false });
  try {
    const page = await runtime.openPage(CHATGPT_URL);
    const result = await probeAttachmentWithoutSend(page, { timeoutMs: 30_000 });
    print({
      runtimeId: runtime.receipt.runtimeId,
      restartOrdinal: runtime.receipt.restartOrdinal,
      url: sanitizeRuntimeObservationUrl(page.url()),
      ...result,
      automaticFallback: false,
    });
  } finally {
    await runtime.close();
  }
}

async function compatibilityNoSend(): Promise<void> {
  const certification = readRuntimeCertification(runtimeRoot);
  if (!certification) {
    throw new Error(
      "The managed browser runtime must be certified before the R6 compatibility probe",
    );
  }
  const runtime = await launchOracleBrowserRuntime({ runtimeRoot, headless: false });
  try {
    if (certification.browserRuntimeId !== runtime.receipt.browserRuntimeId) {
      throw new Error("The R6 compatibility probe runtime does not match the G1 certification");
    }
    const page = await runtime.openPage(CHATGPT_URL);
    const compatibility = await probeLiveCompatibilityWithoutSend(page, {
      adapterVersion: "chatgpt-adapter-v2-r6",
      browserRuntimeId: runtime.receipt.browserRuntimeId,
      timeoutMs: 30_000,
    });
    const envelope = {
      schemaVersion: "oracle.chatgpt-no-send-compatibility.v2",
      runtimeId: runtime.receipt.runtimeId,
      browserRuntimeId: runtime.receipt.browserRuntimeId,
      restartOrdinal: runtime.receipt.restartOrdinal,
      compatibility,
      promptSubmitted: false,
      automaticFallback: false,
      certifiedAt: new Date().toISOString(),
    } as const;
    if (!compatibility.compatible) {
      throw new Error(`R6 compatibility probe rejected: ${JSON.stringify(envelope)}`);
    }
    writePrivateJson(path.join(runtimeRoot, "chatgpt-adapter-compatibility.json"), envelope);
    print(envelope);
  } finally {
    await runtime.close();
  }
}

async function probeRuntime(): Promise<void> {
  const runtime = await launchOracleBrowserRuntime({ runtimeRoot, headless: false });
  try {
    const page = await runtime.openPage(CHATGPT_URL);
    const controlSurface = await waitForComposerControlSurface(page, 30_000);
    const compatibility = await probeCompatibility(page, {
      adapterVersion: "oracle-v2-r5-probe",
      browserRuntimeId: runtime.receipt.browserRuntimeId,
      timeoutMs: 30_000,
    });
    print({
      schemaVersion: "oracle.browser-runtime-probe.v2",
      runtimeId: runtime.receipt.runtimeId,
      restartOrdinal: runtime.receipt.restartOrdinal,
      url: sanitizeRuntimeObservationUrl(page.url()),
      title: (await page.title()).slice(0, 120),
      compatibility,
      controlSurface,
      promptSubmitted: false,
      automaticFallback: false,
    });
  } finally {
    await runtime.close();
  }
}

async function waitForComposerControlSurface(
  page: Parameters<typeof observeComposerControlSurface>[0],
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  let observation = await observeComposerControlSurface(page);
  while (!observation.composer.present && Date.now() < deadline) {
    await page.waitForTimeout(250);
    observation = await observeComposerControlSurface(page);
  }
  return observation;
}

async function openRuntime(args: string[]): Promise<void> {
  const headless = args.includes("--headless");
  const runtime = await launchOracleBrowserRuntime({ runtimeRoot, headless });
  try {
    const page = await runtime.openPage(CHATGPT_URL);
    print({
      schemaVersion: "oracle.browser-runtime-open.v2",
      runtimeId: runtime.receipt.runtimeId,
      browserRuntimeId: runtime.receipt.browserRuntimeId,
      processOwner: runtime.receipt.processOwner,
      transport: runtime.receipt.transport,
      restartOrdinal: runtime.receipt.restartOrdinal,
      profileDir: runtime.receipt.profileDir,
      url: sanitizeRuntimeObservationUrl(page.url()),
      promptSubmitted: false,
      automaticFallback: false,
      instruction: headless
        ? "Headless runtime opened; press Enter to close."
        : "Complete manual login or no-Send observation in this dedicated window, then press Enter here to close it.",
    });
    const input = createInterface({ input: process.stdin, output: process.stdout });
    try {
      await input.question("");
    } finally {
      input.close();
    }
  } finally {
    await runtime.close();
  }
}

function recordAcceptance(args: string[]): void {
  const checks = Object.fromEntries(
    RUNTIME_ACCEPTANCE_CHECKS.map((check) => [check, readCheck(args, check)]),
  ) as Record<RuntimeAcceptanceCheck, RuntimeAcceptanceResult>;
  const notesIndex = args.indexOf("--notes");
  const notes = notesIndex >= 0 ? args[notesIndex + 1] : undefined;
  print(
    recordRuntimeAcceptance({
      runtimeRoot,
      checks,
      observedBy: "owner",
      ...(notes ? { notes } : {}),
    }),
  );
}

function readCheck(args: string[], check: RuntimeAcceptanceCheck): RuntimeAcceptanceResult {
  const pass = valuesFor(args, "--pass").includes(check);
  const fail = valuesFor(args, "--fail").includes(check);
  const blocked = valuesFor(args, "--blocked").includes(check);
  if (Number(pass) + Number(fail) + Number(blocked) !== 1) {
    throw new Error(`Record exactly one --pass, --fail, or --blocked value for ${check}`);
  }
  return pass ? "pass" : fail ? "fail" : "blocked";
}

function valuesFor(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag && args[index + 1]) values.push(args[index + 1]!);
  }
  return values;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
