#!/usr/bin/env node
import "dotenv/config";
import { pathToFileURL } from "node:url";
import { runOracleWorkerHost } from "../apps/oracle-worker/src/host.js";

export async function main(): Promise<void> {
  await runOracleWorkerHost();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
