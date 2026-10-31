import { expect, test } from "bun:test";
import path from "node:path";

import { readSelectionGraph } from "./ci-affected-selection";
import { rootCheckInputs, selectRootChecks } from "./ci-root-checks";

const graph = readSelectionGraph(path.resolve(import.meta.dir, ".."));
const inputs = rootCheckInputs(graph);

// One content edit inside each check's declared inputs and one beside them,
// in the same app where possible, so a declaration that widens back to the
// whole tree or loses its real reader fails here.
const CASES = [
  {
    // The step runs this package test directly; it is covered through the
    // tooling packages every narrow declaration includes.
    check: "ci-checks-rest/Generated source artifact contract",
    inside: "packages/scripts/src/prepared-generated-sources.test.ts",
    outside: "apps/landing/src/probe.ts",
  },
  {
    check: "ci-checks-rest/Chat mutation targets",
    inside: "apps/api/src/lib/chat/probe.ts",
    outside: "apps/landing/src/probe.ts",
  },
  {
    check: "ci-checks-rest/Desktop Rust inputs",
    inside: "apps/desktop/src-tauri/src/probe.rs",
    outside: "apps/web/src/probe.ts",
  },
  {
    check: "ci-checks-rest/Design token docs",
    inside: "packages/ui/src/styles/theme.css",
    outside: "packages/ui/src/probe.tsx",
  },
  {
    check: "ci-checks-rest/Query data state baseline",
    inside: "apps/web/src/probe.tsx",
    outside: "apps/api/src/probe.ts",
  },
  {
    check: "ci-checks-rest/Failure-as-empty baseline",
    inside: "apps/api/src/probe.ts",
    outside: "apps/web/src/probe.tsx",
  },
  {
    check: "ci-checks-rest/Bridge-version guard",
    inside: "apps/desktop/src/shared/rpc.ts",
    outside: "apps/desktop/src/mainview/App.tsx",
  },
  {
    check: "ci-checks-rest/Railway template shape",
    inside: "apps/api/src/handlers/health/routes.ts",
    outside: "apps/api/src/lib/s3.ts",
  },
  {
    check: "ci-checks-rest/Oxlint rule decisions",
    inside: "apps/api/src/lib/safe-handler-factories.ts",
    outside: "apps/api/src/lib/s3.ts",
  },
  {
    check: "ci-checks-rest/Test e2e shard budget",
    inside: "apps/web/e2e/shard-count.ts",
    outside: "apps/web/e2e/probe.spec.ts",
  },
  {
    check: "ci-checks-rest/MCP coverage guard",
    inside: "apps/api/src/probe.ts",
    outside: "apps/landing/src/probe.ts",
  },
] as const;

test.each(CASES)(
  "$check selects only changes to its declared inputs",
  ({ check, inside, outside }) => {
    expect(inputs.get(check)).not.toContain("**");
    const select = (file: string) =>
      selectRootChecks({ changed: [file], graph, pathChange: "content" });
    expect(select(inside)).toContain(check);
    expect(select(outside)).not.toContain(check);
  },
);

test("path inputs see derived outputs of a changed generator input", () => {
  // CLI capability shards generate apps/api/src/mcp/generated/*.ts, which CI
  // restores before the census scans apps/api/src.
  const check = "ci-checks-rest/Failure-as-empty baseline";
  expect(inputs.get(check)).not.toContain("@stll/cli");
  expect(
    selectRootChecks({
      changed: ["packages/cli/capabilities/probe.json"],
      graph,
      pathChange: "content",
    }),
  ).toContain(check);
});
