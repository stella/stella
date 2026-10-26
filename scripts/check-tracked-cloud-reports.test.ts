import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const checkScript = path.resolve(
  import.meta.dirname,
  "check-tracked-cloud-reports.ts",
);

const withRepository = (
  files: readonly string[],
  run: (root: string) => void,
) => {
  const root = mkdtempSync(path.join(tmpdir(), "tracked-cloud-reports-"));
  try {
    const init = spawnSync("git", ["init", "--quiet"], {
      maxBuffer: 2 ** 30,
      cwd: root,
    });
    expect(init.status).toBe(0);
    for (const file of files) {
      const absolutePath = path.join(root, file);
      mkdirSync(path.dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, "task output\n");
    }
    const add = spawnSync("git", ["add", "--", ...files], {
      maxBuffer: 2 ** 30,
      cwd: root,
    });
    expect(add.status).toBe(0);
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const runCheck = (root: string) =>
  spawnSync(process.execPath, [checkScript], {
    maxBuffer: 2 ** 30,
    cwd: root,
    encoding: "utf-8",
  });

test("a repository without a cloud report passes", () => {
  withRepository([], (root) => {
    const result = runCheck(root);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });
});

test("a tracked root cloud report fails", () => {
  withRepository(["CLOUD_REPORT.md"], (root) => {
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('"CLOUD_REPORT.md"');
  });
});

test("a tracked nested cloud report fails", () => {
  withRepository(["docs/x/CLOUD_REPORT.md"], (root) => {
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('"docs/x/CLOUD_REPORT.md"');
  });
});

test("cloud report basename matching is case-insensitive", () => {
  withRepository(["artifacts/Cloud_Report.MD"], (root) => {
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('"artifacts/Cloud_Report.MD"');
  });
});

test("an unrelated plural report passes", () => {
  withRepository(["CLOUD_REPORTS.md"], (root) => {
    const result = runCheck(root);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });
});

test("an untracked cloud report passes", () => {
  withRepository([], (root) => {
    writeFileSync(path.join(root, "CLOUD_REPORT.md"), "local proof\n");
    const result = runCheck(root);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });
});

test("pre-commit does not refuse staged cloud reports", () => {
  const lefthook = readFileSync(
    path.resolve(import.meta.dirname, "../lefthook.yml"),
    "utf-8",
  );
  expect(lefthook).not.toContain("check-tracked-cloud-reports.ts");
  expect(lefthook).not.toContain("tracked-cloud-reports:");
});

test("workflows never read a cloud report from the checkout", () => {
  const workflows = path.resolve(import.meta.dirname, "../.github/workflows");
  for (const file of readdirSync(workflows).filter((name) =>
    /\.ya?ml$/u.test(name),
  )) {
    const source = readFileSync(path.join(workflows, file), "utf-8");
    expect(source, file).not.toMatch(
      /(?:cat|head|tail|less|more|sed|awk|grep)\s+(?:--\s+)?["']?(?:\.\/)?CLOUD_REPORT\.md\b/iu,
    );
  }
});
