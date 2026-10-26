import { describe, expect, test } from "bun:test";

import {
  AUTOFIX_BOT,
  AUTOFIX_COMMIT_SUBJECT,
  planAutofix,
  settledAncestor,
} from "./autofix-push-scope";
import { generatorsForFiles } from "./generated-files";

const SCHEMA = "apps/api/src/db/schema/matters.ts";
const DOC = "docs/guides/autofix-scope-example.md";

const ids = (plan: ReturnType<typeof planAutofix>) =>
  plan.generators.map(({ id }) => id);

describe("push-scoped autofix plan", () => {
  test("a docs-only push runs no generator and no baseline pruning", () => {
    const plan = planAutofix({
      pullRequestFiles: [SCHEMA, DOC],
      pushFiles: [DOC],
    });

    expect(ids(plan)).toEqual([]);
    expect(plan.prune).toBe(false);
    // The document is still formatted.
    expect(plan.scoped).toEqual([DOC]);
    expect(plan.needed).toBe(true);
  });

  test("a schema push runs the schema generators and pruning", () => {
    const plan = planAutofix({
      pullRequestFiles: [SCHEMA, DOC],
      pushFiles: [SCHEMA],
    });

    expect(ids(plan)).toContain("status-tables");
    expect(ids(plan)).toContain("schema-index");
    expect(plan.scoped).toEqual([SCHEMA]);
    expect(plan.prune).toBe(true);
  });

  test("a base-branch merge regenerates outputs the pull request owns without refixing its files", () => {
    const fromBase = "apps/api/src/db/schema/billing.ts";
    const plan = planAutofix({
      pullRequestFiles: [SCHEMA],
      pushFiles: [fromBase],
    });

    expect(ids(plan)).toContain("schema-index");
    expect(plan.scoped).toEqual([]);
    expect(plan.prune).toBe(false);
    expect(plan.needed).toBe(true);
  });

  test("a push with no fixable, generated, or prunable file needs no job", () => {
    const plan = planAutofix({
      pullRequestFiles: ["assets/logo.png"],
      pushFiles: ["assets/logo.png"],
    });

    expect(plan).toEqual({
      generators: [],
      scoped: [],
      refix: false,
      prune: false,
      needed: false,
    });
  });

  test("a push that changes nothing the pull request owns needs no job", () => {
    const plan = planAutofix({
      pullRequestFiles: [DOC],
      pushFiles: [SCHEMA],
    });

    expect(plan).toEqual({
      generators: [],
      scoped: [],
      refix: false,
      prune: false,
      needed: false,
    });
  });

  test.each([
    "oxlint.config.ts",
    "bunfig.toml",
    ".oxlint-plugins/rules/example.ts",
    "apps/api/tsconfig.json",
    "bun.lock",
  ])(
    "a base-branch merge that changes fixer input %s refixes every pull request file",
    (input) => {
      const files = [SCHEMA, DOC];
      const plan = planAutofix({ pullRequestFiles: files, pushFiles: [input] });

      expect(plan.refix).toBe(true);
      expect(plan.scoped).toEqual(files);
      expect(plan.prune).toBe(true);
      expect(plan.needed).toBe(true);
    },
  );

  test("without a settled commit the whole pull request is in scope", () => {
    const files = [SCHEMA, DOC, "apps/web/src/main.tsx"];
    const plan = planAutofix({ pullRequestFiles: files, pushFiles: null });

    expect(ids(plan).toSorted()).toEqual(
      generatorsForFiles(files)
        .map(({ id }) => id)
        .toSorted(),
    );
    expect(plan.scoped).toEqual(files);
    expect(plan.prune).toBe(true);
  });

  test("a capped file list runs every generator whatever the push changed", () => {
    const plan = planAutofix({
      pullRequestFiles: [DOC],
      pushFiles: [DOC],
      all: true,
    });

    expect(ids(plan)).toContain("schema-index");
    expect(ids(plan)).toContain("module-ownership");
  });

  test("a deleted source file or a prunable baseline still prunes", () => {
    expect(
      planAutofix({
        pullRequestFiles: ["apps/api/src/removed.ts"],
        pushFiles: ["apps/api/src/removed.ts"],
      }).prune,
    ).toBe(true);
    expect(
      planAutofix({
        pullRequestFiles: ["scripts/aggregate-lock-baseline.json"],
        pushFiles: ["scripts/aggregate-lock-baseline.json"],
      }).prune,
    ).toBe(true);
    expect(
      planAutofix({
        pullRequestFiles: ["apps/api/drizzle/0001_x/migration.sql"],
        pushFiles: ["apps/api/drizzle/0001_x/migration.sql"],
      }).prune,
    ).toBe(true);
  });
});

describe("settled ancestor", () => {
  const user = (sha: string) => ({ sha, author: "jan", subject: "fix: x" });
  const bot = (sha: string, subject = AUTOFIX_COMMIT_SUBJECT) => ({
    sha,
    author: AUTOFIX_BOT,
    subject,
  });

  test("an autofix commit is settled without a lookup", () => {
    const asked: string[] = [];
    const since = settledAncestor(
      [user("a"), bot("b"), user("c")],
      (sha) => {
        asked.push(sha);
        return false;
      },
      8,
    );

    expect(since).toBe("b");
    expect(asked).toEqual(["a"]);
  });

  test("returns the newest commit whose autofix job succeeded", () => {
    expect(
      settledAncestor(
        [user("a"), user("b"), user("c")],
        (sha) => sha !== "a",
        8,
      ),
    ).toBe("b");
  });

  test("another autofix commit message is not a settled state", () => {
    expect(
      settledAncestor(
        [bot("a", "chore: regenerate files"), user("b")],
        () => false,
        8,
      ),
    ).toBeNull();
  });

  test("stops after the lookup cap and falls back to the full scope", () => {
    const asked: string[] = [];
    const since = settledAncestor(
      [user("a"), user("b"), user("c")],
      (sha) => {
        asked.push(sha);
        return sha === "c";
      },
      2,
    );

    expect(since).toBeNull();
    expect(asked).toEqual(["a", "b"]);
  });
});
