import fs from "node:fs/promises";
import path from "node:path";
import { getOracleHomeDir } from "../oracleHome.js";

interface BrokerProjectionMetadata {
  schemaVersion: "oracle.job.v2";
  projectionSchemaVersion: "oracle.session-projection.v2";
  jobId: string;
  owner: { kind: string };
  state: { kind: string };
  createdAt: string;
  updatedAt: string;
  promptSha256: string;
  bundleSha256: string | null;
}

export async function displayBrokerSessionProjection(
  jobId: string,
  options: {
    sessionsDir?: string;
    pathOnly?: boolean;
    renderPrompt?: boolean;
    log?: (message: string) => void;
  } = {},
): Promise<boolean> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(jobId)) return false;
  const directory = path.join(
    options.sessionsDir ?? path.join(getOracleHomeDir(), "sessions"),
    jobId,
  );
  const metadataPath = path.join(directory, "meta.json");
  let metadata: BrokerProjectionMetadata;
  try {
    metadata = JSON.parse(await fs.readFile(metadataPath, "utf8")) as BrokerProjectionMetadata;
  } catch {
    return false;
  }
  if (
    metadata.schemaVersion !== "oracle.job.v2" ||
    metadata.projectionSchemaVersion !== "oracle.session-projection.v2" ||
    metadata.jobId !== jobId
  ) {
    return false;
  }
  const log = options.log ?? console.log;
  const promptPath = path.join(directory, "prompt.md");
  const responsePath = path.join(directory, "response.md");
  const eventsPath = path.join(directory, "log.jsonl");
  if (options.pathOnly) {
    log(`Session dir: ${directory}`);
    log(`Metadata: ${metadataPath}`);
    log(`Request: ${promptPath}`);
    log(`Log: ${eventsPath}`);
    return true;
  }
  log(`Session: ${metadata.jobId}`);
  log("Mode: broker worker");
  log(`State: ${metadata.state.kind}`);
  log(`Owner: ${metadata.owner.kind}`);
  log(`Updated: ${metadata.updatedAt}`);
  log(`Prompt SHA-256: ${metadata.promptSha256}`);
  if (metadata.bundleSha256) log(`Bundle SHA-256: ${metadata.bundleSha256}`);
  if (options.renderPrompt !== false) {
    const prompt = await fs.readFile(promptPath, "utf8").catch(() => "");
    if (prompt) log(`\nPrompt:\n${prompt.trimEnd()}`);
  }
  const response = await fs.readFile(responsePath, "utf8").catch(() => "");
  if (response) log(`\nAnswer:\n${response.trimEnd()}`);
  return true;
}
