import { panic } from "better-result";
import { lstatSync } from "node:fs";
import path from "node:path";

import { BASELINE_PATHS } from "./baseline-paths.ts";
import { runLedgerMembershipGuard } from "./ledger-membership.ts";

const BASELINE_REL = BASELINE_PATHS.testState;

export const parseTestStateBaseline = (
  text: string,
  label: string,
): string[] => {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return panic(
      `${label} must be an object keyed by repository test filename`,
    );
  }

  const members: string[] = [];
  for (const [file, entry] of Object.entries(parsed)) {
    if (
      !/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file) ||
      file.includes("\\") ||
      file.includes(":") ||
      file
        .split("/")
        .some((part) => part === "" || part === "." || part === "..")
    ) {
      return panic(
        `${label}: ${file} must be a repository-relative test filename`,
      );
    }
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("count" in entry) ||
      typeof entry.count !== "number" ||
      !Number.isSafeInteger(entry.count) ||
      entry.count <= 0
    ) {
      return panic(`${label}: ${file} count must be a positive safe integer`);
    }
    if (
      !("owner" in entry) ||
      typeof entry.owner !== "string" ||
      entry.owner.trim().length === 0
    ) {
      return panic(`${label}: ${file} owner must name a nonempty lane`);
    }
    if (
      !("reason" in entry) ||
      typeof entry.reason !== "string" ||
      entry.reason.trim().length === 0
    ) {
      return panic(`${label}: ${file} reason must be nonempty`);
    }
    for (let occurrence = 1; occurrence <= entry.count; occurrence += 1) {
      members.push(`${file}::${occurrence}`);
    }
  }
  return members;
};

type ValidateTestStateBaselineFilesOptions = {
  members: readonly string[];
  repoRoot: string;
  trackedFiles: ReadonlySet<string>;
};

export const validateTestStateBaselineFiles = ({
  members,
  repoRoot,
  trackedFiles,
}: ValidateTestStateBaselineFilesOptions): void => {
  const files = new Set(members.map((member) => member.replace(/::\d+$/u, "")));
  for (const file of files) {
    if (
      !trackedFiles.has(file) ||
      !lstatSync(path.join(repoRoot, file), { throwIfNoEntry: false })?.isFile()
    ) {
      panic(
        `${BASELINE_REL}: ${file} must exist as a regular tracked test file; delete its baseline entry`,
      );
    }
  }
};

if (import.meta.main) {
  const repoRoot = path.resolve(import.meta.dir, "..");
  const tracked = Bun.spawnSync(["git", "ls-files", "-z"], {
    cwd: repoRoot,
    stderr: "pipe",
  });
  if (tracked.exitCode !== 0) {
    panic(
      `Could not enumerate tracked test files: ${tracked.stderr.toString()}`,
    );
  }
  const trackedFiles = new Set(tracked.stdout.toString().split("\0"));
  process.exit(
    runLedgerMembershipGuard({
      ledgerRel: BASELINE_REL,
      repoRoot,
      parseLedger: (text, label) => {
        const members = parseTestStateBaseline(text, label);
        if (label === BASELINE_REL) {
          validateTestStateBaselineFiles({ members, repoRoot, trackedFiles });
        }
        return members;
      },
      label: "test-state",
      remediation:
        "use an auto-restoring fixture instead of adding state access",
    }),
  );
}
