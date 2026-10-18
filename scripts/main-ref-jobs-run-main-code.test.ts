import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import * as v from "valibot";

// A job that only runs on main's ref holds main's Actions cache scope (and
// often main's secrets). Branch code must never run there: such a job checks
// out only main's own commit or a commit proven to come from main, and so
// never executes a branch's local action either.

const workflowsDirectory = new URL("../.github/workflows/", import.meta.url);
const MAIN_REF = "github.ref == 'refs/heads/main'";

const stepSchema = v.looseObject({
  uses: v.optional(v.string()),
  with: v.optional(v.looseObject({ ref: v.optional(v.unknown()) })),
});
const workflowSchema = v.looseObject({
  jobs: v.optional(
    v.record(
      v.string(),
      v.looseObject({
        if: v.optional(v.unknown()),
        steps: v.optional(v.array(stepSchema)),
      }),
    ),
    {},
  ),
});

const normalized = (value: unknown) =>
  String(value ?? "")
    .replaceAll(/^\$\{\{\s*|\s*\}\}$/gu, "")
    .replaceAll(/\s+/gu, " ")
    .trim();

// Main's ref is a required conjunct: the whole condition, or its first term
// joined by a top-level `&&`.
const mainGated = (condition: unknown) => {
  const text = normalized(condition);
  return text === MAIN_REF || text.startsWith(`${MAIN_REF} && `);
};

const expression = (body: string) => `\${{ ${body} }}`;

// Refs that always name main's own tree.
const MAIN_TREE_REFS = new Set([
  "",
  expression("github.sha"),
  expression("github.workflow_sha"),
  expression("github.event.repository.default_branch"),
  "main",
]);

// Main-gated jobs that check out another commit, each reviewed. This list may
// only shrink: the test fails both on a new entry and on a stale one.
const RELEASE_CANDIDATE =
  "a main ancestor, or a release pull request head whose tree passes the release tree proof (scripts/check-release-candidate.sh)";
const REVIEWED_EXCEPTIONS: Readonly<Record<string, string>> =
  Object.fromEntries(
    ["build-api", "build-web", "promote-staging"].map((job) => [
      `deploy-staging.yml/${job}: ${expression("needs.resolve.outputs.sha")}`,
      RELEASE_CANDIDATE,
    ]),
  );

const violations = () =>
  readdirSync(workflowsDirectory)
    .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
    .toSorted()
    .flatMap((file) => {
      const workflow = v.parse(
        workflowSchema,
        Bun.YAML.parse(
          readFileSync(new URL(file, workflowsDirectory), "utf-8"),
        ),
      );
      return Object.entries(workflow.jobs)
        .filter(([, job]) => mainGated(job.if))
        .flatMap(([id, job]) =>
          (job.steps ?? [])
            .filter((step) => step.uses?.startsWith("actions/checkout@"))
            .map((step) => String(step.with?.ref ?? ""))
            .filter((ref) => !MAIN_TREE_REFS.has(ref))
            .map((ref) => `${file}/${id}: ${ref}`),
        );
    });

test("main-ref jobs check out only main's own tree", () => {
  expect(violations()).toEqual(Object.keys(REVIEWED_EXCEPTIONS).toSorted());
});

test("the main-ref detector recognises a required conjunct only", () => {
  expect(mainGated(expression(MAIN_REF))).toBe(true);
  expect(mainGated(`${MAIN_REF} && inputs.branch != ''`)).toBe(true);
  expect(mainGated(`inputs.x || ${MAIN_REF}`)).toBe(false);
  expect(mainGated("github.ref != 'refs/heads/main'")).toBe(false);
});
