import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { OracleProviderFixture } from "../../apps/oracle-provider-fixture/src/index.js";
import {
  ORACLE_BROWSER_RUNTIME_ID,
  RUNTIME_ACCEPTANCE_CHECKS,
  certifyOracleBrowserRuntime,
  closeRestoredBrowserPages,
  inspectOracleBrowserRuntime,
  launchOracleBrowserRuntime,
  readRuntimeCertification,
  recordRuntimeAcceptance,
  sanitizeRuntimeObservationUrl,
  type LaunchManagedBrowser,
} from "../../packages/oracle-browser-runtime/src/index.js";
import { findFixtureBrowserExecutable } from "./browser-runtime.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "oracle-v2-runtime-"));
  roots.push(root);
  return root;
}

describe("Oracle v2 certified browser runtime", () => {
  test("waits for delayed restored targets and closes them before exposing the runtime", async () => {
    const openTargetIds = new Set(Array.from({ length: 23 }, (_, index) => `restored-${index}`));
    let observations = 0;
    const browser = {
      async newBrowserCDPSession() {
        return {
          async send(method: string, parameters?: { targetId?: string }) {
            if (method === "Target.getTargets") {
              observations += 1;
              return {
                targetInfos:
                  observations < 3
                    ? []
                    : [...openTargetIds].map((targetId) => ({ targetId, type: "page" })),
              };
            }
            if (method === "Target.closeTarget" && parameters?.targetId) {
              openTargetIds.delete(parameters.targetId);
              return { success: true };
            }
            throw new Error(`Unexpected CDP method ${method}`);
          },
          async detach() {},
        };
      },
    } as unknown as Pick<Browser, "newBrowserCDPSession">;

    await expect(
      closeRestoredBrowserPages(browser, { quietMs: 10, timeoutMs: 500, pollMs: 1 }),
    ).resolves.toBe(23);
    expect(openTargetIds.size).toBe(0);
  });

  test("exposes one managed Chrome for Testing direct-CDP runtime", () => {
    const runtime = inspectOracleBrowserRuntime({
      chromeForTestingExecutablePath: "/runtime/chrome-for-testing",
      executableExists: () => true,
    });

    expect(runtime).toMatchObject({
      runtimeId: ORACLE_BROWSER_RUNTIME_ID,
      availability: "available",
      processOwner: "oracle-worker",
      transport: "direct-cdp",
      executablePath: "/runtime/chrome-for-testing",
      automaticFallback: false,
    });
  });

  test("fails before launch when the exact managed executable is unavailable", async () => {
    const launches: unknown[] = [];
    await expect(
      launchOracleBrowserRuntime({
        runtimeRoot: temporaryRoot(),
        headless: true,
        inspection: {
          chromeForTestingExecutablePath: "/missing/chrome-for-testing",
          executableExists: () => false,
        },
        launchManagedBrowser: async (input) => {
          launches.push(input);
          throw new Error("unexpected launch");
        },
      }),
    ).rejects.toThrow(/managed Chrome for Testing.*unavailable/i);
    expect(launches).toEqual([]);
  });

  test("uses one fixed worker-owned profile and persists a direct-CDP launch receipt", async () => {
    const runtimeRoot = temporaryRoot();
    const launches: Parameters<LaunchManagedBrowser>[0][] = [];
    const runtime = await launchOracleBrowserRuntime({
      runtimeRoot,
      headless: false,
      inspection: {
        chromeForTestingExecutablePath: "/runtime/chrome-for-testing",
        executableExists: () => true,
      },
      launchManagedBrowser: fakeLaunch(launches),
    });
    await runtime.close();

    expect(launches).toEqual([
      {
        executablePath: "/runtime/chrome-for-testing",
        profileDir: path.join(runtimeRoot, "browser-profile"),
        headless: false,
      },
    ]);
    expect(runtime.receipt).toMatchObject({
      schemaVersion: "oracle.browser-runtime-launch.v2",
      runtimeId: ORACLE_BROWSER_RUNTIME_ID,
      processOwner: "oracle-worker",
      transport: "direct-cdp",
      profileDir: path.join(runtimeRoot, "browser-profile"),
      browserRuntimeId: `${ORACLE_BROWSER_RUNTIME_ID}:test-browser`,
      restartOrdinal: 1,
      restoredPageCount: 0,
      automaticFallback: false,
    });
    expect(runtime.receipt.closedAt).toEqual(expect.any(String));
    expect(runtime.receipt).not.toHaveProperty("pid");
    expect(runtime.receipt).not.toHaveProperty("port");
    expect(
      JSON.parse(readFileSync(path.join(runtimeRoot, "browser-runtime-launch.json"), "utf8")),
    ).toEqual(runtime.receipt);
  });

  test("retries managed runtime cleanup when the first close attempt fails", async () => {
    const runtimeRoot = temporaryRoot();
    let closeAttempts = 0;
    const runtime = await launchOracleBrowserRuntime({
      runtimeRoot,
      headless: true,
      inspection: {
        chromeForTestingExecutablePath: "/runtime/chrome-for-testing",
        executableExists: () => true,
      },
      launchManagedBrowser: async (input) => ({
        context: { close: async () => undefined } as unknown as BrowserContext,
        browserVersion: "test-browser",
        executablePath: input.executablePath,
        restoredPageCount: 0,
        openPage: async () => ({}) as Page,
        close: async () => {
          closeAttempts += 1;
          if (closeAttempts === 1) throw new Error("injected close failure");
        },
      }),
    });

    await expect(runtime.close()).rejects.toThrow("injected close failure");
    await expect(runtime.close()).resolves.toBeUndefined();
    expect(closeAttempts).toBe(2);
    expect(runtime.receipt.closedAt).toEqual(expect.any(String));
  });

  test("redacts query and fragment state from observed runtime URLs", () => {
    expect(
      sanitizeRuntimeObservationUrl(
        "https://chatgpt.com/?__cf_chl_rt_tk=sensitive-runtime-token#fragment",
      ),
    ).toBe("https://chatgpt.com/");
  });

  test.skipIf(!findFixtureBrowserExecutable())(
    "persists profile state across a real managed-process direct-CDP cold restart",
    async () => {
      const executablePath = findFixtureBrowserExecutable();
      if (!executablePath) throw new Error("Fixture browser executable is unavailable");
      const runtimeRoot = temporaryRoot();
      const fixture = new OracleProviderFixture();
      let first: Awaited<ReturnType<typeof launchOracleBrowserRuntime>> | undefined;
      let second: Awaited<ReturnType<typeof launchOracleBrowserRuntime>> | undefined;
      await fixture.start();
      try {
        first = await launchOracleBrowserRuntime({
          runtimeRoot,
          headless: true,
          inspection: { chromeForTestingExecutablePath: executablePath },
        });
        const firstPage = await first.openPage(fixture.urlFor("runtime-restart"));
        await firstPage.evaluate(() => localStorage.setItem("oracle-v2-login-sentinel", "present"));
        expect(
          await firstPage.evaluate(() => localStorage.getItem("oracle-v2-login-sentinel")),
        ).toBe("present");
        await firstPage.close();
        await new Promise((resolve) => setTimeout(resolve, 250));
        await first.close();
        first = undefined;

        second = await launchOracleBrowserRuntime({
          runtimeRoot,
          headless: true,
          inspection: { chromeForTestingExecutablePath: executablePath },
        });
        const secondPage = await second.openPage(fixture.urlFor("runtime-restart"));
        expect(
          await secondPage.evaluate(() => localStorage.getItem("oracle-v2-login-sentinel")),
        ).toBe("present");
        expect(second.receipt.restartOrdinal).toBe(2);
        await second.close();
        second = undefined;
      } finally {
        await second?.close().catch(() => undefined);
        await first?.close().catch(() => undefined);
        await fixture.stop();
      }
    },
    120_000,
  );

  test.skipIf(!findFixtureBrowserExecutable())(
    "closes late unowned targets and binds concurrent opens to their exact pages",
    async () => {
      const executablePath = findFixtureBrowserExecutable();
      if (!executablePath) throw new Error("Fixture browser executable is unavailable");
      const runtimeRoot = temporaryRoot();
      const fixture = new OracleProviderFixture();
      let runtime: Awaited<ReturnType<typeof launchOracleBrowserRuntime>> | undefined;
      await fixture.start();
      try {
        runtime = await launchOracleBrowserRuntime({
          runtimeRoot,
          headless: true,
          inspection: { chromeForTestingExecutablePath: executablePath },
        });
        const browser = runtime.context.browser();
        if (!browser) throw new Error("Managed runtime did not expose its browser connection");
        const session = await browser.newBrowserCDPSession();
        try {
          for (let index = 0; index < 3; index += 1) {
            await session.send("Target.createTarget", {
              url: `about:blank#late-unowned-${index}`,
              background: true,
            });
          }
        } finally {
          await session.detach();
        }
        await waitForPageCount(runtime.context, 0, 5_000);

        const [first, second] = await Promise.all([
          runtime.openPage(fixture.urlFor("exact-first")),
          runtime.openPage(fixture.urlFor("exact-second")),
        ]);
        expect(new URL(first.url()).searchParams.get("job")).toBe("exact-first");
        expect(new URL(second.url()).searchParams.get("job")).toBe("exact-second");
        expect(runtime.context.pages().filter((page) => !page.isClosed())).toHaveLength(2);
        await Promise.all([first.close(), second.close()]);
      } finally {
        await runtime?.close().catch(() => undefined);
        await fixture.stop();
      }
    },
    120_000,
  );

  test("certifies only the fixed runtime after every owner acceptance check passes", async () => {
    const runtimeRoot = temporaryRoot();
    const runtime = await launchOracleBrowserRuntime({
      runtimeRoot,
      headless: true,
      inspection: {
        chromeForTestingExecutablePath: "/runtime/chrome-for-testing",
        executableExists: () => true,
      },
      launchManagedBrowser: fakeLaunch(),
    });
    await runtime.close();

    recordRuntimeAcceptance({
      runtimeRoot,
      checks: Object.fromEntries(
        RUNTIME_ACCEPTANCE_CHECKS.map((check) => [
          check,
          check === "login" ? "fail" : check === "dailyChromeUnaffected" ? "pass" : "blocked",
        ]),
      ),
      observedBy: "owner",
    });
    expect(() => certifyOracleBrowserRuntime({ runtimeRoot })).toThrow(/login.*fail/i);

    recordRuntimeAcceptance({
      runtimeRoot,
      checks: Object.fromEntries(RUNTIME_ACCEPTANCE_CHECKS.map((check) => [check, "pass"])),
      observedBy: "owner",
    });
    const certification = certifyOracleBrowserRuntime({ runtimeRoot });
    expect(certification).toMatchObject({
      schemaVersion: "oracle.browser-runtime-certification.v2",
      runtimeId: ORACLE_BROWSER_RUNTIME_ID,
      processOwner: "oracle-worker",
      transport: "direct-cdp",
      automaticFallback: false,
      profileDir: path.join(runtimeRoot, "browser-profile"),
      browserRuntimeId: `${ORACLE_BROWSER_RUNTIME_ID}:test-browser`,
    });
    expect(readRuntimeCertification(runtimeRoot)).toEqual(certification);
    expect(
      JSON.parse(readFileSync(path.join(runtimeRoot, "browser-runtime.json"), "utf8")),
    ).toEqual(certification);
  });
});

function fakeLaunch(launches: Parameters<LaunchManagedBrowser>[0][] = []): LaunchManagedBrowser {
  return async (input) => {
    launches.push(input);
    return {
      context: {
        close: async () => undefined,
      } as unknown as BrowserContext,
      browserVersion: "test-browser",
      executablePath: input.executablePath,
      restoredPageCount: 0,
      openPage: async () => ({}) as Page,
      close: async () => undefined,
    };
  };
}

async function waitForPageCount(
  context: BrowserContext,
  expected: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (context.pages().filter((page) => !page.isClosed()).length !== expected) {
    if (Date.now() >= deadline) {
      throw new Error(
        `Expected ${expected} runtime pages, observed ${context.pages().filter((page) => !page.isClosed()).length}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
