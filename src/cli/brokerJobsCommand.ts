import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import { admitOracleJob, OracleClient } from "../../packages/oracle-client/src/index.js";
import { resolveBrokerPaths, waitForBrokerJob } from "../v2/broker.js";

interface JsonOption {
  json?: boolean;
}

function withClient<T>(run: (client: OracleClient) => Promise<T>): Promise<T> {
  const client = new OracleClient({ socketPath: resolveBrokerPaths().socketPath });
  return run(client).finally(() => client.close());
}

export function registerBrokerJobCommands(program: Command): void {
  program
    .command("job <job-id>")
    .description("Inspect one durable Oracle v2 job and its result handle.")
    .option("--events", "Include the durable event stream.", false)
    .option("--json", "Print structured JSON.", false)
    .action(async (jobId: string, options: JsonOption & { events?: boolean }) => {
      await withClient(async (client) => {
        const job = await client.getJob(jobId);
        const result = await client.getResult(jobId);
        const events = options.events ? await client.listEvents(jobId) : undefined;
        if (options.json) {
          console.log(JSON.stringify({ job, result, events }, null, 2));
          return;
        }
        console.log(`Job: ${job.id}`);
        console.log(`State: ${job.state.kind}`);
        console.log(`Owner: ${job.spec.owner.kind}`);
        console.log(`Updated: ${job.updatedAt}`);
        if (result.ready) console.log(`\n${result.text}`.trimEnd());
        if (events) {
          console.log("\nEvents:");
          for (const event of events)
            console.log(`${event.seq}\t${event.type}\t${event.createdAt}`);
        }
      });
    });

  program
    .command("resume <job-id>")
    .description("Explicitly resume an eligible ordinary Oracle v2 job.")
    .option("--json", "Print structured JSON.", false)
    .action(async (jobId: string, options: JsonOption) => {
      await withClient(async (client) => {
        const job = await client.resumeJob(jobId);
        if (options.json) console.log(JSON.stringify(job, null, 2));
        else console.log(`Resume accepted for ${job.id}; state ${job.state.kind}.`);
      });
    });

  program
    .command("abandon <job-id>")
    .description("Abandon an eligible Oracle v2 job without retrying Send.")
    .requiredOption("--reason <text>", "Owner reason recorded in the durable job ledger.")
    .option("--json", "Print structured JSON.", false)
    .action(async (jobId: string, options: JsonOption & { reason: string }) => {
      await withClient(async (client) => {
        const job = await client.abandonJob(jobId, options.reason);
        if (options.json) console.log(JSON.stringify(job, null, 2));
        else console.log(`Abandoned ${job.id}; state ${job.state.kind}.`);
      });
    });

  const worker = program.command("worker").description("Inspect the Oracle v2 durable worker.");
  worker
    .command("run")
    .description("Run the certified Oracle v2 worker in the foreground.")
    .action(async () => {
      const { runOracleWorkerHost } = await import("../../apps/oracle-worker/src/host.js");
      await runOracleWorkerHost();
    });
  worker
    .command("status")
    .description("Read the worker readiness and queue state.")
    .option("--json", "Print structured JSON.", false)
    .action(async (options: JsonOption) => {
      await withClient(async (client) => {
        const status = await client.getWorker();
        if (options.json) console.log(JSON.stringify(status, null, 2));
        else {
          console.log(
            `Worker: ${status.phase === "starting" ? "starting" : status.ready ? "ready" : "not ready"}`,
          );
          console.log(`Provider: ${status.provider}`);
          console.log(`Jobs: ${status.running} running, ${status.queued} queued`);
        }
      });
    });
  worker
    .command("doctor")
    .description("Check the worker socket, readiness, provider compatibility, and queue state.")
    .option("--json", "Print structured JSON.", false)
    .action(async (options: JsonOption) => {
      await withClient(async (client) => {
        const status = await client.getWorker();
        const healthy = status.ready && !status.blocked && status.provider === "compatible";
        const report = {
          healthy,
          socketPath: client.socketPath,
          ...status,
        };
        if (options.json) console.log(JSON.stringify(report, null, 2));
        else {
          console.log(`Oracle v2 worker doctor: ${healthy ? "ok" : "not ready"}`);
          console.log(`Socket: ${client.socketPath}`);
          console.log(`Phase: ${status.phase}`);
          console.log(`Provider: ${status.provider}`);
          console.log(`Queue: ${status.running} running, ${status.queued} queued`);
        }
        if (!healthy) process.exitCode = 1;
      });
    });

  program
    .command("canary")
    .description("Submit one synthetic GPT-5.6 Sol / Pro canary through the durable v2 worker.")
    .option("--id <id>", "Stable canary id for explicit reattachment.")
    .option("--timeout <seconds>", "Wait budget in seconds.", (value) => Number(value), 1_800)
    .action(async (options: { id?: string; timeout: number }) => {
      const paths = resolveBrokerPaths();
      await withClient(async (client) => {
        const canaryId =
          options.id?.trim() || `cli-canary-${Date.now()}-${randomUUID().slice(0, 8)}`;
        const expected = "ORACLE_V2_CANARY_OK";
        const admission = await admitOracleJob(client, {
          requestId: canaryId,
          idempotency: { scope: "oracle-cli-canary", key: canaryId },
          owner: { kind: "canary", canaryId },
          promptBytes: Buffer.from(
            `Reply with exactly this single token and no punctuation or formatting: ${expected}\n`,
            "utf8",
          ),
          intentDirectory: paths.intentDirectory,
          admissionKind: "canary",
        });
        const jobId = admission.admission.job.id;
        console.log(
          `${admission.admission.created ? "Admitted" : "Reattached to"} canary ${jobId}.`,
        );
        const settled = await waitForBrokerJob(client, jobId, {
          timeoutMs: options.timeout * 1_000,
        });
        if (settled.timedOut) {
          console.log(
            `Canary ${jobId} remains ${settled.job.state.kind}; inspect with oracle job ${jobId}.`,
          );
          process.exitCode = 1;
          return;
        }
        if (!settled.result?.ready || settled.result.text.trim() !== expected) {
          throw new Error(`Oracle v2 canary ${jobId} did not return the certified token`);
        }
        console.log(`Oracle v2 canary passed: ${jobId}.`);
      });
    });

  const debug = program.command("debug").description("Export bounded Oracle v2 diagnostics.");
  debug
    .command("export <job-id>")
    .description(
      "Export one job's protocol metadata, events, and available result as private JSON.",
    )
    .requiredOption("--output <path>", "Destination JSON path.")
    .action(async (jobId: string, options: { output: string }) => {
      await withClient(async (client) => {
        const [job, events, result, workerStatus] = await Promise.all([
          client.getJob(jobId),
          client.listEvents(jobId),
          client.getResult(jobId),
          client.getWorker(),
        ]);
        const destination = path.resolve(options.output);
        await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
        await fs.writeFile(
          destination,
          `${JSON.stringify(
            {
              schemaVersion: "oracle.debug-export.v2",
              exportedAt: new Date().toISOString(),
              worker: workerStatus,
              job,
              events,
              result,
            },
            null,
            2,
          )}\n`,
          { mode: 0o600 },
        );
        await fs.chmod(destination, 0o600);
        console.log(`Exported Oracle v2 diagnostics to ${destination}.`);
      });
    });
}
