import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const resolver = path.join(process.cwd(), "skills/oracle/scripts/resolve-github-context.sh");
const temporaryRepositories: string[] = [];

async function git(repository: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repository, ...args], {
    encoding: "utf8",
  });
  return stdout.trim();
}

async function createRepository(): Promise<string> {
  const repository = await mkdtemp(path.join(os.tmpdir(), "oracle-github-context-"));
  temporaryRepositories.push(repository);
  await execFileAsync("git", ["init", "-b", "main", repository]);
  await git(repository, "config", "user.name", "Oracle Test");
  await git(repository, "config", "user.email", "oracle@example.invalid");
  await writeFile(path.join(repository, "README.md"), "test\n", "utf8");
  await git(repository, "add", "README.md");
  await git(repository, "commit", "-m", "initial");
  return repository;
}

async function resolve(repository: string): Promise<string> {
  const { stdout } = await execFileAsync("bash", [resolver, repository], {
    encoding: "utf8",
  });
  return stdout;
}

afterEach(async () => {
  await Promise.all(
    temporaryRepositories.splice(0).map((repository) => rm(repository, { recursive: true })),
  );
});

describe("Oracle skill GitHub context resolver", () => {
  test("returns an owner/repository slug without the SSH .git suffix", async () => {
    const repository = await createRepository();
    await git(repository, "remote", "add", "origin", "git@github.com:example-org/mas-bit.git");
    const commit = await git(repository, "rev-parse", "HEAD");

    const output = await resolve(repository);

    expect(output).toContain("repository=example-org/mas-bit\n");
    expect(output).toContain("branch=main\n");
    expect(output).toContain(`commit=${commit}\n`);
    expect(output).toContain("dirty=false\n");
    expect(output).toContain("selected_remote=origin\n");
    expect(output).not.toContain("mas-bit.git");
  });

  test("removes HTTPS credentials without printing them", async () => {
    const repository = await createRepository();
    await git(
      repository,
      "remote",
      "add",
      "origin",
      "https://private-token@github.com/example-org/private-project.git",
    );

    const output = await resolve(repository);

    expect(output).toContain("repository=example-org/private-project\n");
    expect(output).not.toContain("private-token");
  });

  test("prefers the fork origin and reports the sanitized upstream role", async () => {
    const repository = await createRepository();
    await git(repository, "remote", "add", "origin", "git@github.com:team/fork.git");
    await git(repository, "remote", "add", "upstream", "https://github.com/team/canonical.git");
    await git(repository, "config", "branch.main.remote", "upstream");

    const output = await resolve(repository);

    expect(output).toContain("repository=team/fork\n");
    expect(output).toContain("selected_remote=origin\n");
    expect(output).toContain("github_remote.origin=team/fork\n");
    expect(output).toContain("github_remote.upstream=team/canonical\n");
  });

  test("fails closed when no GitHub remote exists", async () => {
    const repository = await createRepository();
    await git(repository, "remote", "add", "origin", "ssh://example.invalid/project.git");

    await expect(execFileAsync("bash", [resolver, repository])).rejects.toMatchObject({
      code: 2,
      stderr: expect.not.stringContaining("ssh://example.invalid/project.git"),
    });
  });
});
