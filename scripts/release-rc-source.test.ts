import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const check = (incident: boolean, treeExit: string) => {
  const root = mkdtempSync(path.join(tmpdir(), "release-rc-source-"));
  try {
    writeFileSync(
      path.join(root, "tree.sh"),
      '#!/usr/bin/env bash\nexit "$TREE_EXIT"\n',
    );
    writeFileSync(
      path.join(root, "gh.sh"),
      '#!/usr/bin/env bash\nprintf "%s\\n" "$INCIDENTS"\n',
    );
    return Bun.spawnSync(
      [
        "bash",
        new URL("check-release-rc-source.sh", import.meta.url).pathname,
        "stella/stella",
        "a".repeat(40),
      ],
      {
        env: {
          ...process.env,
          RELEASE_TREE_PROOF_VERIFIER: path.join(root, "tree.sh"),
          GH_RETRY_SCRIPT: path.join(root, "gh.sh"),
          TREE_EXIT: treeExit,
          INCIDENTS: incident ? '[[{"id":1}]]' : "[[]]",
        },
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};
test("RC creation retains the open-incident gate before any tag exists", () => {
  expect(check(false, "0").exitCode).toBe(0);
  const blocked = check(true, "0");
  expect(blocked.exitCode).toBe(1);
  expect(blocked.stderr.toString()).toContain("RELEASE_OPEN_MAIN_INCIDENT");
});
test("a refused source tree cannot pass the RC gate", () => {
  expect(check(false, "1").exitCode).toBe(1);
});
