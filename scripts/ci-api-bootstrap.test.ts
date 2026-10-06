import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

const stepSchema = v.looseObject({
  run: v.optional(v.string()),
  if: v.optional(v.string()),
  "working-directory": v.optional(v.string()),
  "continue-on-error": v.optional(v.unknown()),
});
const defaultsSchema = v.object({
  run: v.optional(v.object({ "working-directory": v.optional(v.string()) })),
});
const stepsSchema = v.looseObject({
  defaults: v.optional(defaultsSchema),
  steps: v.optional(v.array(stepSchema)),
});
const sourceSchema = v.looseObject({
  defaults: v.optional(defaultsSchema),
  jobs: v.optional(v.record(v.string(), stepsSchema)),
  runs: v.optional(stepsSchema),
});
const root = path.resolve(import.meta.dirname, "..");
const producer = "bun --filter @stll/api generate:capability-runtime";
const api = v.parse(
  v.object({ scripts: v.record(v.string(), v.string()) }),
  JSON.parse(readFileSync(path.join(root, "apps/api/package.json"), "utf-8")),
);
const selfPreparing = (
  step: v.InferOutput<typeof stepSchema>,
  scripts: Record<string, string>,
) => {
  const command = step.run
    ?.match(/bun\s+--filter\s+@stll\/api\s+(dev|start)\b/u)
    ?.at(1);
  return (
    command !== undefined &&
    scripts[command]?.startsWith("bun run generate:capability-runtime &&") ===
      true
  );
};

const bootsApi = (step: v.InferOutput<typeof stepSchema>) => {
  const run = step.run ?? "";
  return (
    (run.includes("/mcp/generated/") &&
      (run.includes("@/api/") ||
        run.includes("apps/api/") ||
        step["working-directory"] === "apps/api")) ||
    /bun\s+--filter\s+@stll\/api\s+(?:dev|start)\b/u.test(run) ||
    (run.includes("src/server.ts") &&
      (run.includes("apps/api/") ||
        /cd\s+(?:\.\/)?apps\/api\b/u.test(run) ||
        step["working-directory"] === "apps/api"))
  );
};

const assertPrepared = (
  steps: v.InferOutput<typeof stepSchema>[],
  scripts = api.scripts,
) => {
  let boots = 0;
  for (const [index, step] of steps.entries()) {
    if (!bootsApi(step)) {
      continue;
    }
    boots++;
    expect(
      selfPreparing(step, scripts) ||
        (!/(?:always|failure|cancelled)\s*\(/u.test(step.if ?? "") &&
          steps
            .slice(0, index)
            .some(
              (previous) =>
                previous.run === producer &&
                previous["continue-on-error"] === undefined &&
                (previous.if === undefined || previous.if === step.if),
            )),
      `API boot at step ${index} needs successful generated-source preparation`,
    ).toBe(true);
  }
  return boots;
};

test("every workflow and composite action prepares generated sources before API boot", () => {
  let boots = 0;
  for (const file of new Bun.Glob(
    ".github/{workflows,actions}/**/*.{yml,yaml}",
  ).scanSync({ cwd: root })) {
    const source = v.parse(
      sourceSchema,
      Bun.YAML.parse(readFileSync(path.join(root, file), "utf-8")),
    );
    for (const job of Object.values(source.jobs ?? {})) {
      boots += assertPrepared(
        (job.steps ?? []).map((step) => ({
          ...step,
          "working-directory":
            step["working-directory"] ??
            job.defaults?.run?.["working-directory"] ??
            source.defaults?.run?.["working-directory"],
        })),
      );
    }
    boots += assertPrepared(source.runs?.steps ?? []);
  }
  expect(boots).toBeGreaterThan(0);
});

for (const boot of [
  { run: "bun src/server.ts", "working-directory": "apps/api" },
  { run: "cd apps/api\nnohup bun --port 3001 src/server.ts" },
  { run: "bun apps/api/src/server.ts" },
  { run: "bun --filter @stll/api start" },
  {
    run: `bun -e 'import("./apps/api/src/mcp/generated/capability-feature-bindings")'`,
  },
  {
    run: "bun -e \"import '@/api/mcp/generated/capability-feature-bindings'\"",
  },
]) {
  test(`bootstrap guard rejects missing, late, conditional or tolerated preparation: ${boot.run}`, () => {
    expect(assertPrepared([{ run: producer }, boot])).toBe(1);
    for (const steps of [
      [boot],
      [{ run: "exit 1" }, { run: producer }, { ...boot, if: "always()" }],
      [
        { run: producer, if: "failure()" },
        { ...boot, if: "failure()" },
      ],
      [boot, { run: producer }],
      [{ run: producer, if: "false" }, boot],
      [{ run: producer, "continue-on-error": true }, boot],
    ]) {
      expect(() => assertPrepared(steps)).toThrow(
        "needs successful generated-source preparation",
      );
    }
  });
}

test("API package commands that generate first need no separate preparation", () => {
  const boot = { run: "bun --filter @stll/api dev" };
  expect(assertPrepared([boot])).toBe(1);
  const scripts = { ...api.scripts, dev: "bun src/server.ts" };
  expect(scripts.dev).not.toBe(api.scripts["dev"]);
  expect(() => assertPrepared([boot], scripts)).toThrow(
    "needs successful generated-source preparation",
  );
});
