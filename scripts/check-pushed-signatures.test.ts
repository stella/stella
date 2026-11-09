import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(
  new URL("check-pushed-signatures.sh", import.meta.url),
);
const ZERO_OID = "0".repeat(40);

const root = mkdtempSync(path.join(tmpdir(), "pushed-signatures-"));
afterAll(() => {
  rmSync(root, { force: true, recursive: true });
});

const run = (cwd: string, command: string[]): string => {
  const result = Bun.spawnSync(command, { cwd, stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(" ")}: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
};

const key = path.join(root, "signing-key");
run(root, ["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", key]);

const remote = path.join(root, "remote.git");
const repository = path.join(root, "work");
run(root, ["git", "init", "--quiet", "--bare", remote]);
run(root, ["git", "init", "--quiet", "--initial-branch=main", repository]);
const git = (...args: string[]) => run(repository, ["git", ...args]);
git("config", "user.name", "Test");
git("config", "user.email", "test@example.com");
git("config", "commit.gpgsign", "false");
git("remote", "add", "origin", remote);

let counter = 0;
const commit = (options: { signed: boolean; message?: string }): string => {
  counter += 1;
  writeFileSync(path.join(repository, `file-${String(counter)}.txt`), "x");
  git("add", ".");
  git(
    ...(options.signed
      ? ["-c", "gpg.format=ssh", "-c", `user.signingkey=${key}`]
      : []),
    "commit",
    "--quiet",
    ...(options.signed ? ["-S"] : []),
    "-m",
    options.message ?? `commit ${String(counter)}`,
  );
  return git("rev-parse", "HEAD");
};

/** Runs the hook for one pushed ref, as `git push` hands it on stdin. */
const push = (localOid: string, remoteOid = ZERO_OID) => {
  const result = Bun.spawnSync(["bash", SCRIPT], {
    cwd: repository,
    stdin: Buffer.from(
      `refs/heads/topic ${localOid} refs/heads/topic ${remoteOid}\n`,
    ),
    stderr: "pipe",
  });
  return { exitCode: result.exitCode, stderr: result.stderr.toString() };
};

// Main is published unsigned, as a remote-tracking ref of this clone.
const published = commit({ signed: false });
git("push", "--quiet", "origin", "main");
git("fetch", "--quiet", "origin");

test("an unsigned commit the push would publish is refused by name", () => {
  git("switch", "--quiet", "-c", "unsigned", published);
  const unsigned = commit({ signed: false, message: "needs a signature" });
  const outcome = push(unsigned);
  expect(outcome.exitCode).toBe(1);
  expect(outcome.stderr).toContain("needs a signature");
});

test("signed commits pass, and published commits are not the push's to sign", () => {
  git("switch", "--quiet", "-c", "signed", published);
  const first = commit({ signed: true });
  const second = commit({ signed: true });
  expect(push(second)).toMatchObject({ exitCode: 0 });
  // Only the commits after the remote tip are checked.
  expect(push(second, first)).toMatchObject({ exitCode: 0 });
});

test("a message cannot stand in for the signature header", () => {
  git("switch", "--quiet", "-c", "forged", published);
  const forged = commit({
    signed: false,
    message: "subject\n\ngpgsig -----BEGIN SSH SIGNATURE-----",
  });
  expect(push(forged).exitCode).toBe(1);
});

test("deleting a remote ref publishes nothing", () => {
  expect(push(ZERO_OID, published)).toMatchObject({ exitCode: 0 });
});
