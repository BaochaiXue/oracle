import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = process.cwd();
const tmpRoot = mkdtempSync(join(tmpdir(), "oracle-packed-cli-"));

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  });
}

try {
  run("pnpm", ["pack", "--pack-destination", tmpRoot]);
  const tarball = readdirSync(tmpRoot).find((entry) => entry.endsWith(".tgz"));
  if (!tarball) {
    throw new Error("pnpm pack did not produce a .tgz file");
  }

  const installDir = join(tmpRoot, "install");
  mkdirSync(installDir);
  run("npm", ["init", "-y"], { cwd: installDir });
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", join(tmpRoot, tarball)], {
    cwd: installDir,
  });
  const cliPath = join(
    installDir,
    "node_modules",
    "@steipete",
    "oracle",
    "dist",
    "bin",
    "oracle-cli.js",
  );
  const packageRoot = join(installDir, "node_modules", "@steipete", "oracle");
  // An explicit broker/worker must load from a production install, not rely
  // on the development workspace's Playwright dependency. Imports do not
  // launch a browser, open a profile, or start a worker.
  for (const modulePath of [
    "dist/packages/oracle-browser-runtime/src/index.js",
    "dist/packages/chatgpt-adapter/src/index.js",
    "dist/apps/oracle-worker/src/index.js",
  ]) {
    run(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `await import(${JSON.stringify(join(packageRoot, modulePath))})`,
      ],
      { cwd: installDir },
    );
  }
  for (const packagedPath of [
    "opencli-adapters/chatgpt/oracle-picker.generated.js",
    "opencli-adapters/chatgpt/submit-file-core.js",
    "opencli-adapters/chatgpt/submit-file.js",
    "opencli-adapters/chatgpt/oracle-wait.js",
    "scripts/install-opencli-submit-file-adapter.mjs",
  ]) {
    if (!existsSync(join(packageRoot, packagedPath))) {
      throw new Error(`packed Oracle is missing ${packagedPath}`);
    }
  }
  const help = run(process.execPath, [cliPath, "--help", "--verbose"], { cwd: installDir });

  for (const expected of [
    "--no-azure",
    "--provider <provider>",
    "--http-timeout",
    "--allow-partial",
    "--preflight",
    "--browser-transport <transport>",
    "browser",
    "docs",
  ]) {
    if (!help.includes(expected)) {
      throw new Error(`packed CLI help is missing ${expected}`);
    }
  }

  const browserHelp = run(process.execPath, [cliPath, "browser", "--help"], { cwd: installDir });
  for (const expected of ["install [options]", "setup [options]", "smoke [options]"]) {
    if (!browserHelp.includes(expected)) {
      throw new Error(`packed browser help is missing ${expected}`);
    }
  }

  const batchHelp = run(process.execPath, [cliPath, "batch", "--help"], { cwd: installDir });
  for (const expected of [
    "validate <manifest.json5>",
    "run [options] <manifest.json5>",
    "status [options] [batch-id]",
    "resume [options] <batch-id>",
    "render [options] <batch-id>",
  ]) {
    if (!batchHelp.includes(expected)) {
      throw new Error(`packed batch help is missing ${expected}`);
    }
  }

  const installHelp = run(process.execPath, [cliPath, "browser", "install", "--help"], {
    cwd: installDir,
  });
  for (const expected of ["--cache-dir <path>", "--config <path>", "--no-write-config", "--json"]) {
    if (!installHelp.includes(expected)) {
      throw new Error(`packed browser install help is missing ${expected}`);
    }
  }

  const setupHelp = run(process.execPath, [cliPath, "browser", "setup", "--help"], {
    cwd: installDir,
  });
  for (const expected of ["--profile-dir <path>", "--chrome-path <path>"]) {
    if (!setupHelp.includes(expected)) {
      throw new Error(`packed browser setup help is missing ${expected}`);
    }
  }
  if (setupHelp.includes("--port")) {
    throw new Error("packed browser setup must not expose a CDP port");
  }

  const smokeHelp = run(process.execPath, [cliPath, "browser", "smoke", "--help"], {
    cwd: installDir,
  });
  for (const expected of ["--profile-dir <path>", "--port <number>", "--visible", "--json"]) {
    if (!smokeHelp.includes(expected)) {
      throw new Error(`packed browser smoke help is missing ${expected}`);
    }
  }
  console.log("Packed CLI help smoke: ok");
} finally {
  rmSync(tmpRoot, { recursive: true, force: true });
}
