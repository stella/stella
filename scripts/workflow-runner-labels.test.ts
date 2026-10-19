import { expect, test } from "bun:test";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");

// Linux jobs name a pinned runner image. `ubuntu-latest` moves to a new image
// without a change in this repository and is served from its own runner pool,
// so the same job's tools and queue time can change between two runs.
const FLOATING_LABEL = /\bubuntu-latest\b/u;

const workflowFiles = (): readonly string[] => {
  const result = Bun.spawnSync(["git", "ls-files", ".github"], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
  return result.stdout
    .toString()
    .split("\n")
    .filter((file) => /\.ya?ml$/u.test(file));
};

test("no workflow, action or check pool names the floating Linux label", async () => {
  const offenders: string[] = [];
  for (const file of workflowFiles()) {
    const lines = (await Bun.file(path.join(REPO_ROOT, file)).text()).split(
      "\n",
    );
    for (const [index, line] of lines.entries()) {
      if (FLOATING_LABEL.test(line)) {
        offenders.push(`${file}:${index + 1}`);
      }
    }
  }
  expect(offenders).toEqual([]);
});
