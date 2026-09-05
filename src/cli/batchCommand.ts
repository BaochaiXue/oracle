import type { Command } from "commander";
import {
  acceptMissingBatchLane,
  acceptMissingBatchSynthesis,
  getBatchStatus,
  listRecentBatches,
  renderStoredBatch,
  resumeBatch,
  runBatch,
  validateBatchFile,
} from "../batch/runtime.js";
import { buildBatchStatusProjection } from "../batch/render.js";

export function registerBatchCommand(program: Command): void {
  const batch = program
    .command("batch")
    .description("Run recoverable parallel GPT-6 Pro consultation lanes and optional synthesis.");

  batch
    .command("validate <manifest.json5>")
    .description(
      "Strictly validate a Batch Oracle v1 manifest and resolve its files without dispatch.",
    )
    .action(async (manifestPath: string) => {
      const loaded = await validateBatchFile(manifestPath);
      const childCount = loaded.manifest.lanes.length + (loaded.manifest.synthesis ? 1 : 0);
      console.log(
        `Valid ${loaded.manifest.schemaVersion} manifest: ${loaded.manifest.slug} (${loaded.manifest.lanes.length} lanes, ${childCount} max children).`,
      );
      console.log(`Resolved cwd: ${loaded.cwd}`);
    });

  batch
    .command("run <manifest.json5>")
    .description(
      "Seal all first-stage inputs, dispatch ready lanes in parallel, and cross the barrier.",
    )
    .option(
      "--max-parallel <count>",
      "Lower the configured parallel dispatch cap.",
      parsePositiveInt,
    )
    .action(async (manifestPath: string, options: { maxParallel?: number }) => {
      const result = await runBatch(manifestPath, { maxParallel: options.maxParallel });
      printRunOutcome(result.state, result.reportPath);
    });

  batch
    .command("status [batch-id]")
    .description("List recent batches or show reconciled lane/session status for one batch.")
    .option(
      "--hours <hours>",
      "Look back this many hours when listing batches.",
      parsePositiveNumber,
      72,
    )
    .option("--json", "Print a stable machine-readable projection.", false)
    .action(async (batchId: string | undefined, options: { hours: number; json?: boolean }) => {
      if (batchId) {
        const { state, projection } = await getBatchStatus(batchId);
        if (options.json) console.log(JSON.stringify(projection, null, 2));
        else printBatchProjection(projection);
        process.exitCode = state.status === "error" ? 1 : 0;
        return;
      }
      const states = await listRecentBatches(options.hours);
      if (options.json) {
        console.log(JSON.stringify(states.map(buildBatchStatusProjection), null, 2));
        return;
      }
      if (states.length === 0) {
        console.log("No recent Batch Oracle runs.");
        return;
      }
      for (const state of states) {
        const completed = state.lanes.filter((lane) => lane.status === "completed").length;
        console.log(
          `${state.batchId}  ${state.status}  ${completed}/${state.lanes.length} lanes  ${state.project}`,
        );
      }
    });

  batch
    .command("resume <batch-id>")
    .description(
      "Reconcile and resume original child sessions without duplicate committed prompts.",
    )
    .option(
      "--allow-partial",
      "Cross the barrier after unavailable lanes have explicit accept-missing decisions.",
      false,
    )
    .action(async (batchId: string, options: { allowPartial?: boolean }) => {
      const result = await resumeBatch(batchId, { allowPartial: options.allowPartial });
      printRunOutcome(result.state, result.reportPath);
    });

  batch
    .command("accept-missing <batch-id>")
    .description(
      "Record an explicit owner decision to abandon one unavailable lane or terminal synthesis without re-sending it.",
    )
    .option("--lane <lane-id>", "Lane to close as accepted-missing.")
    .option("--synthesis", "Close a recoverable, error, or indeterminate synthesis stage.", false)
    .requiredOption("--reason <text>", "Durable owner reason for accepting the missing evidence.")
    .action(
      async (batchId: string, options: { lane?: string; synthesis?: boolean; reason: string }) => {
        if (Boolean(options.lane) === Boolean(options.synthesis)) {
          throw new Error("Choose exactly one accept-missing target: --lane <id> or --synthesis.");
        }
        if (options.synthesis) {
          const state = await acceptMissingBatchSynthesis(batchId, options.reason);
          console.log(`Batch ${batchId}: synthesis accepted unavailable; status=${state.status}`);
          return;
        }
        const state = await acceptMissingBatchLane(batchId, options.lane!, options.reason);
        console.log(
          `Batch ${batchId}: lane ${options.lane} accepted missing; status=${state.status}`,
        );
        console.log(`Next: oracle batch resume ${batchId} --allow-partial`);
      },
    );

  batch
    .command("render <batch-id>")
    .description("Render manifest-ordered batch status, raw answers on demand, and synthesis.")
    .option("--lane <lane-id>", "Render one raw lane answer.")
    .option("--all", "Render every raw lane answer in manifest order before synthesis.", false)
    .action(async (batchId: string, options: { lane?: string; all?: boolean }) => {
      if (options.lane && options.all) throw new Error("Choose either --lane or --all, not both.");
      console.log(await renderStoredBatch(batchId, { laneId: options.lane, all: options.all }));
    });
}

function printRunOutcome(
  state: Awaited<ReturnType<typeof getBatchStatus>>["state"],
  reportPath: string,
): void {
  console.log(`Batch ${state.batchId}: ${state.status}`);
  for (const lane of state.lanes) {
    console.log(`- ${lane.id}: ${lane.status}; session=${lane.sessionId ?? "none"}`);
  }
  if (state.synthesis) {
    console.log(
      `- synthesis ${state.synthesis.id}: ${state.synthesis.status}; session=${state.synthesis.sessionId ?? "none"}`,
    );
  }
  console.log(`Report: ${reportPath}`);
  if (["awaiting-recovery", "interrupted"].includes(state.status)) {
    console.log(`Resume: oracle batch resume ${state.batchId}`);
  }
}

function printBatchProjection(projection: ReturnType<typeof buildBatchStatusProjection>): void {
  console.log(`${projection.batchId}: ${projection.status}`);
  console.log(`Objective: ${projection.objective}`);
  for (const lane of projection.lanes) {
    console.log(
      `- ${lane.id}: ${lane.status}; attempt=${lane.attempt ?? 0}; session=${lane.sessionId ?? "none"}`,
    );
    if (lane.error) console.log(`  error: ${lane.error.message}`);
  }
  if (projection.synthesis) {
    console.log(
      `- synthesis ${projection.synthesis.id}: ${projection.synthesis.status}; session=${projection.synthesis.sessionId ?? "none"}`,
    );
  }
  if (projection.ownerAction) console.log(`Owner action: ${projection.ownerAction}`);
  console.log(`Resume: ${projection.resumeCommand}`);
}

function parsePositiveInt(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error("Expected an integer >= 1.");
  return parsed;
}

function parsePositiveNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("Expected a number > 0.");
  return parsed;
}
