import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { chromium, type BrowserServer } from "playwright-core";
import { OracleProviderFixture } from "../../apps/oracle-provider-fixture/src/index.js";
import { OracleClient } from "../../packages/oracle-client/src/index.js";
import {
  JOB_SCHEMA_VERSION,
  type JobSpec,
  type ObjectRef,
} from "../../packages/oracle-kernel/src/index.js";
import { WORKER_FAULT_POINTS, type WorkerFaultPoint } from "../../apps/oracle-worker/src/index.js";
import { findFixtureBrowserExecutable } from "./browser-runtime.js";

const executablePath = findFixtureBrowserExecutable();
const fixture = new OracleProviderFixture();
const roots: string[] = [];
const children = new Set<ChildProcess>();
const browserServers = new Set<BrowserServer>();

beforeAll(async () => {
  if (executablePath) await fixture.start();
});

afterEach(async () => {
  await Promise.allSettled([...children].map((child) => stopChild(child)));
  children.clear();
  await Promise.allSettled([...browserServers].map((server) => server.close()));
  browserServers.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

afterAll(async () => fixture.stop());

function pathsForFault() {
  const root = mkdtempSync(path.join(tmpdir(), "oracle-v2-hard-fault-"));
  roots.push(root);
  return {
    rootDir: path.join(root, "v2"),
    sessionsDir: path.join(root, "sessions"),
    socketPath: path.join(root, "run", "oracle.sock"),
  };
}

function specFor(
  prompt: Omit<ObjectRef, "objectClass"> & { objectClass: "prompt" },
  fault: WorkerFaultPoint,
): JobSpec {
  return {
    schemaVersion: JOB_SCHEMA_VERSION,
    requestId: `hard-fault-${fault}`,
    idempotency: { scope: "hard-fault", key: fault },
    owner: { kind: "ordinary", sessionSlug: fault },
    input: { prompt, promptSha256: prompt.sha256 },
    route: { provider: "chatgpt-web", model: "gpt-5.6-sol", effort: "pro" },
    policy: {
      maxCaptureMs: 60_000,
      allowAutomaticCaptureRecovery: true,
      allowAutomaticResend: false,
      requireCommittedBundleEvidence: false,
    },
  };
}

async function startChild(
  paths: ReturnType<typeof pathsForFault>,
  browserEndpoint: string,
  fault?: WorkerFaultPoint,
): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", path.join(import.meta.dirname, "fixtures", "adapter-worker-child.ts")],
    {
      cwd: path.resolve(import.meta.dirname, "../.."),
      env: {
        ...process.env,
        ORACLE_V2_CHILD_ROOT: paths.rootDir,
        ORACLE_V2_CHILD_SESSIONS: paths.sessionsDir,
        ORACLE_V2_CHILD_SOCKET: paths.socketPath,
        ORACLE_V2_FIXTURE_ORIGIN: new URL(fixture.urlFor("probe")).origin,
        ORACLE_V2_FIXTURE_BROWSER_ENDPOINT: browserEndpoint,
        ...(fault
          ? { ORACLE_V2_TEST_FAULTS: "1", ORACLE_FAULT_AT: fault }
          : { ORACLE_V2_TEST_FAULTS: "0", ORACLE_FAULT_AT: "" }),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  children.add(child);
  await waitForReady(child);
  return child;
}

async function startBrowserServer(): Promise<BrowserServer> {
  if (!executablePath) throw new Error("Fixture browser executable is unavailable");
  const server = await chromium.launchServer({ executablePath, headless: true });
  browserServers.add(server);
  return server;
}

function waitForReady(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(
      () => reject(new Error(`Child readiness timed out: ${stderr}`)),
      15_000,
    );
    child.stdout!.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.includes("ORACLE_V2_CHILD_READY")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.stderr!.on("data", (chunk) => (stderr += String(chunk)));
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Child exited before ready with ${code}: ${stderr}`));
    });
  });
}

function waitForExit(child: ChildProcess, expectedCode?: number): Promise<void> {
  if (child.exitCode !== null) {
    if (expectedCode !== undefined) expect(child.exitCode).toBe(expectedCode);
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Child exit timed out")), 15_000);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (expectedCode !== undefined) expect(code).toBe(expectedCode);
      resolve();
    });
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await waitForExit(child);
}

describe.skipIf(!executablePath)("Oracle v2 hard process fault recovery", () => {
  test(
    "recovers every fault serially with one harness-owned browser and at most one Send per attempt",
    async () => {
      for (const fault of WORKER_FAULT_POINTS) {
        const server = await startBrowserServer();
        try {
          const paths = pathsForFault();
          const sendsBefore = fixture.totalSendCount();
          const first = await startChild(paths, server.wsEndpoint(), fault);
          const firstClient = new OracleClient({ socketPath: paths.socketPath });
          const prompt = await firstClient.putObject(Buffer.from(`Hard fault ${fault}.\n`), {
            mediaType: "text/plain",
            objectClass: "prompt",
          });
          const spec = specFor(prompt, fault);
          await firstClient.admitJob(spec).catch(() => undefined);
          firstClient.close();
          await waitForExit(first, 86);
          children.delete(first);

          const second = await startChild(paths, server.wsEndpoint());
          const secondClient = new OracleClient({ socketPath: paths.socketPath });
          const admission = await secondClient.admitJob(spec);
          const terminal = await secondClient.waitForTerminal(admission.job.id, {
            timeoutMs: 10_000,
          });
          const sends = fixture.totalSendCount() - sendsBefore;
          expect(sends).toBeLessThanOrEqual(1);
          if (
            fault === "after-dispatch-at-risk" ||
            fault === "immediately-after-click" ||
            fault === "after-commit-observed"
          ) {
            expect(terminal.state.kind, JSON.stringify(terminal.state, null, 2)).toBe("ambiguous");
            expect(sends).toBe(fault === "after-dispatch-at-risk" ? 0 : 1);
          } else {
            expect(terminal.state.kind, JSON.stringify(terminal.state, null, 2)).toBe("completed");
            expect(sends).toBe(1);
          }
          secondClient.close();
          await stopChild(second);
          children.delete(second);
        } finally {
          await server.close().catch(() => undefined);
          browserServers.delete(server);
        }
      }
    },
    5 * 60_000,
  );
});
