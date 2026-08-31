import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { chromium, type Browser, type BrowserContext } from "playwright-core";
import {
  OracleProviderFixture,
  type FixtureScenario,
} from "../../apps/oracle-provider-fixture/src/index.js";
import {
  ChatGptAdapter,
  observeComposerControlSurface,
  probeAttachmentWithoutSend,
  probeLiveCompatibilityWithoutSend,
  probeModelAndEffortControls,
} from "../../packages/chatgpt-adapter/src/index.js";
import { OracleClient } from "../../packages/oracle-client/src/index.js";
import {
  JOB_SCHEMA_VERSION,
  type JobSpec,
  type ObjectRef,
} from "../../packages/oracle-kernel/src/index.js";
import { OracleWorker } from "../../apps/oracle-worker/src/index.js";
import { OracleStore } from "../../packages/oracle-store/src/index.js";
import { findFixtureBrowserExecutable } from "./browser-runtime.js";

const executablePath = findFixtureBrowserExecutable();
const roots: string[] = [];
const contexts: BrowserContext[] = [];
const clients: OracleClient[] = [];
const workers: OracleWorker[] = [];
const fixture = new OracleProviderFixture();
let browser: Browser;

beforeAll(async () => {
  if (!executablePath) return;
  await fixture.start();
  browser = await chromium.launch({ executablePath, headless: true });
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await Promise.allSettled(workers.splice(0).map((worker) => worker.stop()));
  await Promise.allSettled(contexts.splice(0).map((context) => context.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

afterAll(async () => {
  await browser?.close();
  await fixture.stop();
});

function workerPaths() {
  const root = mkdtempSync(path.join(tmpdir(), "oracle-v2-adapter-"));
  roots.push(root);
  return {
    rootDir: path.join(root, "v2"),
    sessionsDir: path.join(root, "sessions"),
    socketPath: path.join(root, "run", "oracle.sock"),
  };
}

async function harness(scenario: FixtureScenario) {
  const browserContext = await browser.newContext();
  contexts.push(browserContext);
  const adapter = new ChatGptAdapter({
    context: browserContext,
    browserRuntimeId: "fixture-cft",
    urlForJob: (jobId) => fixture.urlFor(jobId, scenario),
    actionTimeoutMs: 5_000,
    commitTimeoutMs: 2_000,
  });
  const paths = workerPaths();
  const worker = new OracleWorker({ ...paths, provider: adapter });
  await worker.start();
  workers.push(worker);
  const client = new OracleClient({ socketPath: paths.socketPath });
  clients.push(client);
  return { adapter, client, paths, worker };
}

function jobSpec(
  prompt: Omit<ObjectRef, "objectClass"> & { objectClass: "prompt" },
  key: string,
  bundle?: Omit<ObjectRef, "objectClass"> & { objectClass: "bundle" },
): JobSpec {
  return {
    schemaVersion: JOB_SCHEMA_VERSION,
    requestId: `fixture-${key}`,
    idempotency: { scope: "adapter-fixture", key },
    owner: { kind: "ordinary", sessionSlug: key },
    input: {
      prompt,
      promptSha256: prompt.sha256,
      ...(bundle ? { bundle, bundleSha256: bundle.sha256 } : {}),
    },
    route: { provider: "chatgpt-web", model: "gpt-5.6-sol", effort: "pro" },
    policy: {
      maxCaptureMs: 60_000,
      allowAutomaticCaptureRecovery: true,
      allowAutomaticResend: false,
      requireCommittedBundleEvidence: bundle !== undefined,
    },
  };
}

async function admit(client: OracleClient, key: string, options: { bundle?: boolean } = {}) {
  const prompt = await client.putObject(Buffer.from(`Review fixture ${key}.\n`), {
    mediaType: "text/plain",
    objectClass: "prompt",
  });
  const bundle = options.bundle
    ? await client.putObject(Buffer.from(`# Sealed source for ${key}\n`), {
        mediaType: "text/markdown",
        objectClass: "bundle",
      })
    : undefined;
  return client.admitJob(jobSpec(prompt, key, bundle));
}

async function waitForIdle(client: OracleClient, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const status = await client.getWorker();
    if (status.running === 0 && status.queued === 0) return;
    if (Date.now() >= deadline) throw new Error("Fixture worker did not become idle");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitForTerminal(client: OracleClient, jobId: string, timeoutMs = 8_000) {
  try {
    return await client.waitForTerminal(jobId, { timeoutMs });
  } catch (error) {
    const job = await client.getJob(jobId);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; state=${JSON.stringify(job.state)}`,
      { cause: error },
    );
  }
}

describe.skipIf(!executablePath)("Oracle v2 ChatGPT adapter against the provider fixture", () => {
  test("probes semantic capabilities and completes text and sealed-bundle jobs", async () => {
    const { adapter, client, paths, worker } = await harness("default");
    const initialWorker = await client.getWorker();
    expect(initialWorker, JSON.stringify(initialWorker, null, 2)).toMatchObject({
      ready: true,
      provider: "compatible",
    });

    const text = await admit(client, "text-job");
    const textResult = await waitForTerminal(client, text.job.id);
    expect(textResult.state, JSON.stringify(textResult.state, null, 2)).toMatchObject({
      kind: "completed",
      preparation: {
        model: { requested: "gpt-5.6-sol", verified: true },
        effort: { requested: "pro", verified: true },
      },
      capture: { markdownQuality: "native-copy" },
    });
    if (textResult.state.kind !== "completed") throw new Error("Expected completed text job");
    expect(fixture.sendCount(textResult.state.submission.turnAttemptId)).toBe(1);

    const bundle = await admit(client, "bundle-job", { bundle: true });
    const bundleResult = await client.waitForTerminal(bundle.job.id, { timeoutMs: 8_000 });
    expect(bundleResult.state).toMatchObject({
      kind: "completed",
      preparation: { bundleEvidence: { kind: "composer-anchored" } },
      submission: { bundleReceipt: { required: true, verified: true } },
    });
    expect(adapter.openPageCount()).toBe(0);

    client.close();
    await worker.stop();
    clients.splice(clients.indexOf(client), 1);
    workers.splice(workers.indexOf(worker), 1);
    const store = new OracleStore(paths);
    const representations = store.database
      .prepare(
        `SELECT jo.role, o.object_class
         FROM job_objects jo JOIN objects o ON o.sha256 = jo.sha256
         WHERE jo.job_id = ? AND jo.role IN ('answer', 'response-plain', 'response-html')
         ORDER BY jo.role`,
      )
      .all(text.job.id);
    expect(representations).toEqual([
      { role: "answer", object_class: "answer" },
      { role: "response-html", object_class: "html" },
      { role: "response-plain", object_class: "text" },
    ]);
    store.close();
  }, 20_000);

  test.each([
    "delayed-composer",
    "attachment-chip-delay",
    "commit-delay",
    "late-conversation-url",
    "wrong-conversation-navigation",
    "streaming-assistant",
    "copy-control-missing",
  ] as const)(
    "completes the %s scenario without duplicate Send",
    async (scenario) => {
      const { client, worker } = await harness(scenario);
      const admission = await admit(client, `scenario-${scenario}`, {
        bundle: scenario === "attachment-chip-delay",
      });
      const result = await client.waitForTerminal(admission.job.id, { timeoutMs: 8_000 });
      expect(result.state.kind).toBe("completed");
      if (result.state.kind !== "completed") throw new Error(`Expected ${scenario} completion`);
      expect(fixture.sendCount(result.state.submission.turnAttemptId)).toBe(1);
      if (scenario === "copy-control-missing") {
        expect(result.state.capture.markdownQuality).toBe("html-projection");
      }
      client.close();
      await worker.stop();
      clients.splice(clients.indexOf(client), 1);
      workers.splice(workers.indexOf(worker), 1);
    },
    20_000,
  );

  test.each(["missing-attachment", "duplicate-filename"] as const)(
    "blocks %s before Send",
    async (scenario) => {
      const before = fixture.totalSendCount();
      const { client, worker } = await harness(scenario);
      const admission = await admit(client, `blocked-${scenario}`, { bundle: true });
      const result = await client.waitForTerminal(admission.job.id, { timeoutMs: 8_000 });
      expect(result.state).toMatchObject({ kind: "failed-unsent", retrySafe: true });
      expect(fixture.totalSendCount()).toBe(before);
      client.close();
      await worker.stop();
      clients.splice(clients.indexOf(client), 1);
      workers.splice(workers.indexOf(worker), 1);
    },
    15_000,
  );

  test("marks a dropped click ambiguous and never performs a second Send", async () => {
    const { client, worker } = await harness("click-dropped");
    const admission = await admit(client, "click-dropped");
    const result = await client.waitForTerminal(admission.job.id, { timeoutMs: 8_000 });
    expect(result.state.kind).toBe("ambiguous");
    if (result.state.kind !== "ambiguous") throw new Error("Expected ambiguous result");
    expect(fixture.sendCount(result.state.intent.turnAttemptId)).toBe(1);
    client.close();
    await worker.stop();
    clients.splice(clients.indexOf(client), 1);
    workers.splice(workers.indexOf(worker), 1);
  }, 15_000);

  test.each(["auth-required", "rate-limit", "unknown-ui-fingerprint"] as const)(
    "records one incompatible provider status for %s and queues new jobs without Send",
    async (scenario) => {
      const before = fixture.totalSendCount();
      const { client, paths, worker } = await harness(scenario);
      expect(await client.getWorker()).toMatchObject({ ready: true, provider: "incompatible" });
      const admission = await admit(client, `incompatible-${scenario}`);
      expect(admission.job.state).toEqual({ kind: "queued", blockedBy: "provider" });
      expect(fixture.totalSendCount()).toBe(before);
      client.close();
      await worker.stop();
      clients.splice(clients.indexOf(client), 1);
      workers.splice(workers.indexOf(worker), 1);
      const store = new OracleStore(paths);
      expect(store.getProviderStatus("chatgpt-web")).toMatchObject({
        state: "incompatible",
        receipt: { compatible: false },
      });
      const count = store.database
        .prepare("SELECT COUNT(*) AS count FROM provider_status WHERE provider = 'chatgpt-web'")
        .get() as { count: number };
      expect(count.count).toBe(1);
      store.close();
    },
    15_000,
  );

  test("keeps Send disabled for an empty composer", async () => {
    const page = await browser.newPage();
    await page.goto(fixture.urlFor("empty-composer", "default"));
    const send = page.locator('[data-testid="send-button"]');
    expect(await send.isDisabled()).toBe(true);
    await page.close();
  });

  test("reports only sanitized composer controls and never composer contents", async () => {
    const page = await browser.newPage();
    await page.goto(fixture.urlFor("surface-observation", "default"));
    await page.locator("#prompt-textarea").fill("private fixture text that must not escape");
    await page.evaluate(() => {
      const outsideMenu = document.createElement("button");
      outsideMenu.setAttribute("aria-haspopup", "menu");
      outsideMenu.setAttribute("aria-label", "private sidebar title that must not escape");
      Object.defineProperty(outsideMenu, "textContent", {
        configurable: true,
        get() {
          throw new Error("observer crossed the composer-form privacy boundary");
        },
      });
      document.body.prepend(outsideMenu);
    });
    const observation = await observeComposerControlSurface(page);
    const serialized = JSON.stringify(observation);
    expect(serialized).not.toContain("private fixture text");
    expect(serialized).not.toContain("private sidebar title");
    expect(observation.composer).toMatchObject({ present: true, tag: "DIV" });
    expect(observation.syntheticProbeAttachmentPresent).toBe(false);
    expect(observation.syntheticProbeInputSelected).toBe(false);
    expect(observation.composerButtons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ testId: "composer-plus-btn" }),
        expect.objectContaining({ testId: "send-button" }),
      ]),
    );
    expect(observation.modelCandidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ testId: "model-switcher-dropdown-button" }),
      ]),
    );
    expect(observation.modelSignals).toEqual(
      expect.arrayContaining([expect.objectContaining({ observedLabel: "Pro" })]),
    );
    await page.close();
  });

  test("verifies GPT-5.6 Sol and Pro through the picker without Send", async () => {
    const before = fixture.totalSendCount();
    const page = await browser.newPage();
    await page.goto(fixture.urlFor("model-no-send", "default"));
    const result = await probeModelAndEffortControls(page, { timeoutMs: 5_000 });
    expect(result).toMatchObject({
      modelLabel: "GPT-5.6 Sol",
      effortLabel: "Pro",
      modelVerified: true,
      effortVerified: true,
      playwrightClickWorked: true,
      promptSubmitted: false,
    });
    expect(fixture.totalSendCount()).toBe(before);
    expect(await page.locator("#prompt-textarea").textContent()).toBe("");
    await page.close();
  });

  test("uploads and removes a synthetic attachment without Send", async () => {
    const before = fixture.totalSendCount();
    const page = await browser.newPage();
    await page.goto(fixture.urlFor("attachment-no-send", "default"));
    await page.evaluate(() => {
      const modal = document.createElement("div");
      modal.id = "modal-conversation-history-rate-limit";
      modal.dataset.testid = "modal-conversation-history-rate-limit";
      modal.style.position = "fixed";
      modal.style.inset = "0";
      modal.style.zIndex = "1000";
      modal.style.background = "white";
      const close = document.createElement("button");
      close.setAttribute("aria-label", "Close");
      close.textContent = "Close";
      close.addEventListener("click", () => modal.remove());
      modal.append(close);
      document.body.append(modal);
    });
    const result = await probeAttachmentWithoutSend(page, { timeoutMs: 5_000 });
    expect(result).toMatchObject({
      filename: "oracle-v2-no-send-probe.md",
      uploadInputVerified: true,
      composerAnchored: true,
      removedAfterProbe: true,
      blockingModalDismissed: true,
      promptSubmitted: false,
    });
    expect(fixture.totalSendCount()).toBe(before);
    expect(await page.locator("[data-attachment-chip]").count()).toBe(0);
    expect(await page.locator("#prompt-textarea").textContent()).toBe("");
    await page.close();
  });

  test("emits a compatible real-style receipt without submitting the composer probe", async () => {
    const before = fixture.totalSendCount();
    const page = await browser.newPage();
    await page.goto(fixture.urlFor("compatibility-no-send", "default"));
    const receipt = await probeLiveCompatibilityWithoutSend(page, {
      adapterVersion: "chatgpt-adapter-v2-test",
      browserRuntimeId: "fixture-cft",
      timeoutMs: 5_000,
    });
    expect(receipt.compatible).toBe(true);
    expect(Object.values(receipt.capabilities)).toEqual(
      expect.not.arrayContaining(["missing", "unknown"]),
    );
    expect(fixture.totalSendCount()).toBe(before);
    expect(await page.locator("#prompt-textarea").textContent()).toBe("");
    await page.close();
  });

  test.skipIf(process.env.ORACLE_V2_FIXTURE_SOAK !== "1")(
    "completes 500 fixture jobs with linear events and no leaked pages",
    async () => {
      const jobCount = Number(process.env.ORACLE_V2_FIXTURE_SOAK_JOBS ?? 500);
      const sendsBefore = fixture.totalSendCount();
      const { adapter, client, paths, worker } = await harness("default");
      const prompt = await client.putObject(Buffer.from("Bounded fixture soak.\n"), {
        mediaType: "text/plain",
        objectClass: "prompt",
      });
      for (let offset = 0; offset < jobCount; offset += 25) {
        const batchSize = Math.min(25, jobCount - offset);
        await Promise.all(
          Array.from({ length: batchSize }, (_, index) =>
            client.admitJob(jobSpec(prompt, `fixture-soak-${offset + index}`)),
          ),
        );
      }
      await waitForIdle(client, 480_000);
      const jobs = await client.listJobs();
      expect(jobs).toHaveLength(jobCount);
      const incomplete = jobs
        .filter((job) => job.state.kind !== "completed")
        .slice(0, 10)
        .map((job) => ({
          id: job.id,
          state: job.state.kind,
          failure: "failure" in job.state ? job.state.failure : undefined,
        }));
      expect(incomplete, JSON.stringify(incomplete, null, 2)).toEqual([]);
      expect(fixture.totalSendCount() - sendsBefore).toBe(jobCount);
      expect(adapter.openPageCount()).toBe(0);

      client.close();
      await worker.stop();
      clients.splice(clients.indexOf(client), 1);
      workers.splice(workers.indexOf(worker), 1);
      const database = new DatabaseSync(path.join(paths.rootDir, "oracle.db"), {
        readOnly: true,
      });
      const counts = database
        .prepare(
          "SELECT (SELECT COUNT(*) FROM jobs) AS jobs, (SELECT COUNT(*) FROM job_events) AS events",
        )
        .get() as { jobs: number; events: number };
      database.close();
      expect(counts).toEqual({ jobs: jobCount, events: jobCount * 8 });
    },
    600_000,
  );
});
