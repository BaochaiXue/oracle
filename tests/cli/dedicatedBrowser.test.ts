import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  assertDedicatedBrowserProcessIdentity,
  browserCommandUsesExecutable,
  downloadArchiveWithResumeForTest,
  findContainingAppBundle,
  isSharedMacBrowserBundleId,
} from "../../src/browser/dedicatedBrowserBinary.js";
import { buildDedicatedSetupArgsForTest } from "../../src/cli/dedicatedBrowser.js";

const originalPlatform = process.platform;

afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform });
});

describe("dedicated browser setup", () => {
  test("opens a normal isolated Chrome without CDP or automation flags", () => {
    const profileDir = "/Users/example/.oracle/browser-profile";
    const args = buildDedicatedSetupArgsForTest(profileDir);

    expect(args).toEqual([
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--new-window",
      "https://chatgpt.com/",
    ]);
    expect(args.some((arg) => arg.startsWith("--remote-debugging"))).toBe(false);
    expect(args).not.toContain("--disable-background-timer-throttling");
    expect(args).not.toContain("--disable-hang-monitor");
    expect(args).not.toContain("--use-mock-keychain");
  });

  test("uses the mock keychain for unattended macOS cold starts when explicitly enabled", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    const profileDir = "/Users/example/.oracle/browser-profile";
    const args = buildDedicatedSetupArgsForTest(profileDir, true);

    expect(args).toContain("--use-mock-keychain");
    expect(args).not.toContain("--password-store=basic");
    expect(args.some((arg) => arg.startsWith("--remote-debugging"))).toBe(false);
  });

  test("resumes a retained partial Chrome for Testing archive", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-cft-resume-"));
    const archivePath = path.join(tmpDir, "chrome.zip");
    try {
      await fs.writeFile(archivePath, "abc");
      const progress = vi.fn();
      const fetchImpl = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
        if (init?.method === "HEAD") {
          return new Response(null, {
            status: 200,
            headers: { "content-length": "6" },
          });
        }
        expect(init?.headers).toEqual({ Range: "bytes=3-" });
        return new Response("def", { status: 206 });
      }) as typeof fetch;

      await downloadArchiveWithResumeForTest({
        downloadUrl: new URL("https://example.test/chrome.zip"),
        archivePath,
        onProgress: progress,
        fetchImpl,
      });

      expect(await fs.readFile(archivePath, "utf8")).toBe("abcdef");
      expect(progress).toHaveBeenCalledWith(3, 6);
      expect(progress).toHaveBeenLastCalledWith(6, 6);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("dedicated browser application identity", () => {
  test("recognizes the everyday macOS Chrome bundle id as shared", () => {
    expect(isSharedMacBrowserBundleId("com.google.Chrome")).toBe(true);
    expect(isSharedMacBrowserBundleId("com.google.Chrome.forTesting")).toBe(false);
    expect(isSharedMacBrowserBundleId("org.chromium.Chromium")).toBe(false);
  });

  test("finds the containing app bundle from a macOS executable path", () => {
    expect(
      findContainingAppBundle(
        "/tmp/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      ),
    ).toBe("/tmp/Google Chrome for Testing.app");
    expect(findContainingAppBundle("/usr/bin/chromium")).toBeNull();
  });

  test("matches a running process only to the configured dedicated executable", () => {
    const dedicatedExecutable =
      "/tmp/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
    expect(
      browserCommandUsesExecutable(
        `${dedicatedExecutable} --remote-debugging-port=9333`,
        dedicatedExecutable,
      ),
    ).toBe(true);
    expect(
      browserCommandUsesExecutable(
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9333",
        dedicatedExecutable,
      ),
    ).toBe(false);
  });

  test("fails closed when a macOS reusable process has no verifiable pid", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    await expect(
      assertDedicatedBrowserProcessIdentity(
        undefined,
        "/tmp/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      ),
    ).rejects.toMatchObject({
      details: expect.objectContaining({
        code: "running-browser-app-identity-mismatch",
        pid: null,
      }),
    });
  });
});
