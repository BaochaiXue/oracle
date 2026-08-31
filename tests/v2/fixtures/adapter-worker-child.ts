import { chromium } from "playwright-core";
import { ChatGptAdapter } from "../../../packages/chatgpt-adapter/src/index.js";
import { OracleWorker } from "../../../apps/oracle-worker/src/index.js";

const rootDir = required("ORACLE_V2_CHILD_ROOT");
const sessionsDir = required("ORACLE_V2_CHILD_SESSIONS");
const socketPath = required("ORACLE_V2_CHILD_SOCKET");
const fixtureOrigin = required("ORACLE_V2_FIXTURE_ORIGIN");
const executablePath = required("ORACLE_V2_FIXTURE_BROWSER_EXECUTABLE");

const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext();
const adapter = new ChatGptAdapter({
  context,
  browserRuntimeId: "fixture-cft-child",
  urlForJob: (jobId) => `${fixtureOrigin}/?job=${encodeURIComponent(jobId)}&scenario=default`,
  actionTimeoutMs: 5_000,
  commitTimeoutMs: 2_000,
});
const worker = new OracleWorker({ rootDir, sessionsDir, socketPath, provider: adapter });

await worker.start();
process.stdout.write("ORACLE_V2_CHILD_READY\n");

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await worker.stop().catch(() => undefined);
  await context.close().catch(() => undefined);
  await browser.close().catch(() => undefined);
  process.exit(0);
};
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
setInterval(() => {}, 1_000);

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
