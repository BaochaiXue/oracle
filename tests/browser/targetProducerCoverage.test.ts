import { describe, expect, test } from "vitest";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();

async function source(file: string): Promise<string> {
  return readFile(path.join(root, file), "utf8");
}

describe("local browser target producer ownership", () => {
  test("every persistent local producer records ownership before handing off its target", async () => {
    const [chatgpt, projectSources, reattach, recovery, reconciler] = await Promise.all([
      source("src/browser/index.ts"),
      source("src/browser/projectSourcesRunner.ts"),
      source("src/browser/reattach.ts"),
      source("src/browser/recoverConversation.ts"),
      source("src/browser/lifecycleReconciler.ts"),
    ]);

    expect(chatgpt).toMatch(/connectWithNewTab[\s\S]*ownsTarget,/);
    expect(projectSources).toMatch(/connectWithNewTab[\s\S]*ownsTarget: true/);
    expect(reattach).toMatch(/connectWithNewTab[\s\S]*ownsTarget: true/);
    expect(recovery).toMatch(
      /acquireBrowserTabLease[\s\S]*openChatGptTarget[\s\S]*ownsTarget: true/,
    );
    expect(reconciler).toMatch(/createChromePageTarget[\s\S]*registerOwned/);
    expect(chatgpt).not.toMatch(/lastTargetId\s*=\s*info\?\.targetInfo\?\.targetId/);
  });

  test("Gemini implementation and canonical routing are absent from the fork", async () => {
    await expect(access(path.join(root, "src/gemini-web/index.ts"))).rejects.toThrow();
    await expect(access(path.join(root, "src/oracle/gemini.ts"))).rejects.toThrow();

    const canonicalRoutes = await Promise.all([
      source("bin/oracle-cli.ts"),
      source("src/cli/runOptions.ts"),
      source("src/oracle/client.ts"),
    ]);
    expect(canonicalRoutes.join("\n")).not.toMatch(
      /gemini-web|resolveGeminiModelId|createGeminiClient/,
    );
  });

  test("operator reconciliation is absent from remote and attach-running execution", async () => {
    const chatgpt = await source("src/browser/index.ts");
    const remoteStart = chatgpt.indexOf("async function runRemoteBrowserMode");
    expect(remoteStart).toBeGreaterThan(0);
    const remoteBody = chatgpt.slice(remoteStart);
    expect(remoteBody).not.toContain("reconcileBrowserTargets(");
    expect(remoteBody).not.toContain("reconcileOwnedBrowserTargets(");
  });

  test("setup is manual-only and smoke closes its exact bounded target before shutdown", async () => {
    const dedicatedBrowser = await source("src/cli/dedicatedBrowser.ts");
    const setupStart = dedicatedBrowser.indexOf("export async function runDedicatedBrowserSetup");
    const smokeStart = dedicatedBrowser.indexOf("export async function runDedicatedBrowserSmoke");
    const reconcileStart = dedicatedBrowser.indexOf(
      "export async function runDedicatedBrowserReconcile",
    );
    const setupBody = dedicatedBrowser.slice(setupStart, smokeStart);
    const smokeBody = dedicatedBrowser.slice(smokeStart, reconcileStart);

    expect(setupBody).not.toContain("--remote-debugging-port");
    expect(setupBody).not.toContain("connectWithNewTab(");
    expect(smokeBody).toContain("connectWithNewTab(");
    expect(smokeBody).toContain("preserveWindowFocus: true");
    expect(smokeBody).toContain("targetId = connection.targetId");
    expect(smokeBody).toContain("closeTab(chrome.port, targetId");
    expect(smokeBody).toContain("could not confirm closure of owned target");
    expect(smokeBody).toContain("closeLaunchedChrome(");
  });
});
