import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { loadSealedPromptArtifacts } from "./seal.js";
import { getBatchPaths } from "./store.js";
import type { BatchAnswerReceiptV1, BatchInputManifestV1, BatchLaneState } from "./types.js";
import { BATCH_SCHEMA_VERSION } from "./types.js";

export class BatchAnswerIntegrityError extends Error {
  readonly code = "batch-answer-integrity-mismatch";
  constructor(
    readonly laneId: string,
    message: string,
  ) {
    super(message);
  }
}

export interface VerifiedBatchAnswer {
  answer: Buffer;
  receipt: BatchAnswerReceiptV1;
  inputManifest: BatchInputManifestV1;
  inputManifestBytes: Buffer;
  receiptBytes: Buffer;
}

export async function readVerifiedBatchAnswer(
  batchId: string,
  lane: BatchLaneState,
): Promise<VerifiedBatchAnswer> {
  if (
    lane.status !== "completed" ||
    !lane.sessionId ||
    !lane.outputPath ||
    !lane.outputSha256 ||
    !lane.inputManifestSha256
  ) {
    throw new BatchAnswerIntegrityError(
      lane.id,
      `Lane ${lane.id} has no complete accepted answer receipt boundary.`,
    );
  }
  const receiptPath = getAnswerReceiptPath(batchId, lane.id, lane.role);
  const [answer, receiptBytes, sealed] = await Promise.all([
    fs.readFile(lane.outputPath),
    fs.readFile(receiptPath),
    loadSealedPromptArtifacts(batchId, lane.id, lane.role),
  ]).catch((error) => {
    throw new BatchAnswerIntegrityError(
      lane.id,
      `Unable to read verified answer evidence for lane ${lane.id}: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  let receipt: BatchAnswerReceiptV1;
  try {
    receipt = JSON.parse(receiptBytes.toString("utf8")) as BatchAnswerReceiptV1;
  } catch (error) {
    throw new BatchAnswerIntegrityError(
      lane.id,
      `Invalid answer receipt JSON for lane ${lane.id}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const answerSha256 = createHash("sha256").update(answer).digest("hex");
  if (
    receipt.schemaVersion !== BATCH_SCHEMA_VERSION ||
    receipt.batchId !== batchId ||
    receipt.laneId !== lane.id ||
    receipt.role !== lane.role ||
    receipt.sessionId !== lane.sessionId ||
    receipt.status !== "completed" ||
    receipt.inputManifestSha256 !== lane.inputManifestSha256 ||
    sealed.inputManifest.inputManifestSha256 !== lane.inputManifestSha256 ||
    receipt.answerSha256 !== lane.outputSha256 ||
    answerSha256 !== lane.outputSha256 ||
    receipt.answerBytes !== answer.length
  ) {
    throw new BatchAnswerIntegrityError(
      lane.id,
      `Answer or receipt identity mismatch for lane ${lane.id}; synthesis and rendering are blocked.`,
    );
  }
  const inputManifestPath =
    lane.inputManifestPath ??
    path.join(
      getBatchPaths(batchId).inputs,
      lane.role === "lane" ? "lanes" : "synthesis",
      ...(lane.role === "lane" ? [lane.id] : []),
      "input-manifest.json",
    );
  return {
    answer,
    receipt,
    receiptBytes,
    inputManifest: sealed.inputManifest,
    inputManifestBytes: await fs.readFile(inputManifestPath),
  };
}

export function getAnswerReceiptPath(
  batchId: string,
  laneId: string,
  role: "lane" | "synthesis",
): string {
  return role === "lane"
    ? path.join(getBatchPaths(batchId).outputs, "lanes", laneId, "answer-receipt.json")
    : path.join(getBatchPaths(batchId).outputs, "synthesis", "answer-receipt.json");
}
