import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  assertManualLoginProfileReadyForRun,
  ensureDedicatedBrowserProfileDirectory,
  formatManualLoginSetupCommand,
} from "../../src/browser/manualLoginProfile.js";

describe("dedicated browser profile", () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanup.splice(0).map((entry) => rm(entry, { recursive: true, force: true })),
    );
  });

  test("creates and repairs the profile root with owner-only permissions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-profile-test-"));
    cleanup.push(root);
    const profile = path.join(root, "nested", "browser-profile");

    await ensureDedicatedBrowserProfileDirectory(profile);
    if (process.platform !== "win32") {
      expect((await stat(profile)).mode & 0o777).toBe(0o700);
      await chmod(profile, 0o755);
      await ensureDedicatedBrowserProfileDirectory(profile);
      expect((await stat(profile)).mode & 0o777).toBe(0o700);
    }
  });

  test("uses a non-submitting setup command for uninitialized profiles", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-profile-test-"));
    cleanup.push(root);
    const profile = path.join(root, "browser-profile");
    await ensureDedicatedBrowserProfileDirectory(profile);

    const command = formatManualLoginSetupCommand(profile);
    expect(command).toContain("oracle browser setup --profile-dir");
    expect(command).not.toMatch(/(?:^|\s)-p(?:\s|$)/u);
    expect(command).not.toContain("HI");

    await expect(
      assertManualLoginProfileReadyForRun({ userDataDir: profile, keepBrowser: false }),
    ).rejects.toMatchObject({
      details: expect.objectContaining({
        stage: "browser-login-setup",
        details: expect.objectContaining({ setupCommand: command }),
      }),
    });
  });
});
