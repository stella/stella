/**
 * One way to start a playbook over a matter.
 *
 * Four surfaces open playbook runs: the single run a user picks, the auto-run
 * over every applicable playbook, the classification trigger, and the MCP
 * tool. They drifted once already — three of them materialized the live
 * definition's columns and recorded no run at all, while the fourth pinned an
 * approved snapshot and opened one run per document — and the drift was
 * invisible because nothing connected the call sites.
 *
 * So the connection is asserted here: `openPlaybookRun` is the only caller of
 * the materializer and of the run creator, every surface goes through it, and
 * every surface classifies the workflow start it asks for afterwards. A fifth
 * surface, or a regression in an existing one, fails this file rather than
 * quietly reviewing a matter against a different playbook, or reporting a
 * review whose extraction never started.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const API_ROOT = path.resolve(import.meta.dir, "../../..");

/** The one module allowed to drive a playbook run. */
const OPENER = "src/lib/document-review/open-playbook-run.ts";

/**
 * The steps that turn a playbook into a review, and where each is defined.
 * Anything that calls one of these without going through the opener is a
 * second way to start a review.
 */
const RUN_STEPS = {
  materializePlaybookRun: "src/lib/workflow/materialize-playbook-run.ts",
  createPlaybookTableRuns: "src/lib/document-review/table-run-create.ts",
} as const;

/** Every surface that starts a playbook run, and what starts it there. */
const RUN_SURFACES = {
  "src/handlers/playbooks/run.ts": "the playbook a user picks",
  "src/handlers/playbooks/auto-run.ts": "every applicable playbook at once",
  "src/lib/workflow/route-playbooks.ts": "the classification trigger",
  "src/mcp/knowledge-tools.ts": "the run_playbook MCP tool",
} as const;

const sources = new Map(
  [...new Bun.Glob("src/**/*.ts").scanSync({ cwd: API_ROOT, onlyFiles: true })]
    .filter((file) => !file.endsWith(".test.ts"))
    .map((file) => [file, readFileSync(path.join(API_ROOT, file), "utf-8")]),
);

const sourceOf = (file: string): string => {
  const source = sources.get(file);
  if (source === undefined) {
    // A moved or renamed surface must fail loudly here; an absent file read as
    // empty text would satisfy every "no one else calls this" assertion below.
    throw new Error(`${file} is not a source file under apps/api`);
  }
  return source;
};

/** Direct calls and calls through an explicit injected-or-default seam. */
const callsDependency = (source: string, name: string): boolean =>
  source.includes(`${name}({`) ||
  new RegExp(String.raw`\?\? ${name}\s*\)\(\{`, "u").test(source);

/** Files that call `name` somewhere other than where it is defined. */
const callersOf = (name: string, declaredIn: string): string[] =>
  [...sources]
    .filter(([file, source]) =>
      file !== declaredIn ? callsDependency(source, name) : false,
    )
    .map(([file]) => file);

describe("starting a playbook run", () => {
  test.each(Object.entries(RUN_STEPS))(
    "%s is driven only by the shared opener",
    (name, declaredIn) => {
      // Both directions: the opener must actually call it (a step it stopped
      // driving would otherwise pass by being called nowhere at all), and no
      // one else may.
      expect(callsDependency(sourceOf(OPENER), name)).toBe(true);
      expect(callersOf(name, declaredIn)).toEqual([OPENER]);
    },
  );

  test.each(Object.entries(RUN_SURFACES))(
    "%s (%s) opens its runs through the shared opener",
    (file) => {
      const source = sourceOf(file);
      expect(source).toContain(
        'from "@/api/lib/document-review/open-playbook-run"',
      );
      expect(source).toContain("openPlaybookRun({");
    },
  );

  test.each(Object.entries(RUN_SURFACES))(
    "%s (%s) classifies the workflow start it asks for",
    (file) => {
      // The other half of starting a review: the queue call each surface makes
      // once its transaction commits. The queue reports an enqueue failure as
      // a status rather than a throw, so a surface that reads the result
      // without classifying it answers success for a review nothing grades.
      const source = sourceOf(file);
      expect(callsDependency(source, "startWorkflow")).toBe(true);
      expect(source).toContain("playbookRunStartOutcome(");
    },
  );

  test("the surfaces named here are the ones that exist", () => {
    // The declared list is only a guard while it is complete: a surface that
    // calls the opener without being listed would never be checked for
    // anything else this file asserts.
    expect(callersOf("openPlaybookRun", OPENER).toSorted()).toEqual(
      Object.keys(RUN_SURFACES).toSorted(),
    );
  });
});
