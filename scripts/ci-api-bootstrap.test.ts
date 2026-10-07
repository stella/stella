import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import { lexShell } from "./install-free-ci";

const stepSchema = v.looseObject({
  run: v.optional(v.string()),
  if: v.optional(v.string()),
  "working-directory": v.optional(v.string()),
  "continue-on-error": v.optional(v.unknown()),
});
const defaultsSchema = v.looseObject({
  run: v.optional(
    v.looseObject({ "working-directory": v.optional(v.string()) }),
  ),
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
const apiBootCommands = (step: v.InferOutput<typeof stepSchema>) => {
  let cwd = path.posix.normalize(step["working-directory"] ?? ".");
  const directories: string[] = [];
  const boots = [];
  for (const event of lexShell(step.run ?? "")) {
    switch (event.type) {
      case "subshell-start":
        directories.push(cwd);
        break;
      case "subshell-end":
        cwd = directories.pop() ?? ".";
        break;
      case "control-flow":
      case "unparsed":
        break;
      case "command": {
        if (event.words.at(0) === "cd") {
          const directory = event.words.at(1);
          if (directory !== undefined) {
            cwd = path.posix.normalize(path.posix.join(cwd, directory));
          }
          break;
        }
        const bunIndex = event.words.findIndex(
          (word) => word === "bun" || word.endsWith("/bun"),
        );
        if (bunIndex === -1) {
          break;
        }
        const args = event.words.slice(bunIndex + 1);
        const filteredApi = args.some(
          (word, index) =>
            word === "--filter=@stll/api" ||
            (word === "--filter" && args.at(index + 1) === "@stll/api"),
        );
        const runIndex = args.indexOf("run");
        const command =
          runIndex === -1
            ? args.find((word) => word === "dev" || word === "start")
            : args.at(runIndex + 1);
        const packageScript =
          (filteredApi || cwd === "apps/api") &&
          (command === "dev" || command === "start")
            ? command
            : undefined;
        const apiDirectory = cwd === "apps/api";
        const directServer = args.some(
          (word) =>
            word === "apps/api/src/server.ts" ||
            (word === "src/server.ts" && apiDirectory),
        );
        const generatedImport = args.some(
          (word) =>
            word.includes("/mcp/generated/") &&
            (word.includes("@/api/") ||
              word.includes("apps/api/") ||
              apiDirectory),
        );
        if (directServer || generatedImport || packageScript !== undefined) {
          boots.push({ packageScript });
        }
        break;
      }
      default: {
        const exhaustive: never = event;
        throw new TypeError(`Unknown shell event: ${String(exhaustive)}`);
      }
    }
  }
  return boots;
};

const assertPrepared = (
  steps: v.InferOutput<typeof stepSchema>[],
  scripts = api.scripts,
) => {
  let boots = 0;
  for (const [index, step] of steps.entries()) {
    const commands = apiBootCommands(step);
    if (commands.length === 0) {
      continue;
    }
    boots += commands.length;
    expect(
      commands.every(
        ({ packageScript }) =>
          packageScript !== undefined &&
          scripts[packageScript]?.startsWith(
            "bun run generate:capability-runtime &&",
          ) === true,
      ) ||
        (!/(?:always|failure|cancelled)\s*\(/u.test(step.if ?? "") &&
          steps
            .slice(0, index)
            .some(
              (previous) =>
                previous.run === producer &&
                (previous["continue-on-error"] === undefined ||
                  previous["continue-on-error"] === false) &&
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
  { run: "bun --filter=@stll/api start" },
  { run: "bun --filter @stll/api run start" },
  { run: "bun --filter=@stll/api run start" },
  { run: "bun start", "working-directory": "apps/api" },
  { run: "bun run start", "working-directory": "./apps/api" },
  { run: "bun src/server.ts", "working-directory": "./apps/api" },
  {
    run: `cd ./apps/api
bun -e 'import("./src/mcp/generated/capability-feature-bindings")'`,
  },
  {
    run: `bun -e 'import("./apps/api/src/mcp/generated/capability-feature-bindings")'`,
  },
  {
    run: "bun -e \"import '@/api/mcp/generated/capability-feature-bindings'\"",
  },
]) {
  test(`bootstrap guard rejects missing, late, conditional or tolerated preparation: ${boot.run}`, () => {
    expect(assertPrepared([{ run: producer }, boot])).toBe(1);
    expect(
      assertPrepared([{ run: producer, "continue-on-error": false }, boot]),
    ).toBe(1);
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

for (const run of [
  "bun --filter @stll/api dev",
  "bun --filter=@stll/api dev",
  "bun --filter @stll/api run dev",
  "bun --filter=@stll/api run dev",
  "bun dev",
  "bun run dev",
]) {
  test(`each self-preparing API package command is checked at its own boot: ${run}`, () => {
    const boot = { run, "working-directory": "./apps/api" };
    expect(assertPrepared([boot])).toBe(1);
    expect(() =>
      assertPrepared([boot], { ...api.scripts, dev: "bun src/server.ts" }),
    ).toThrow("needs successful generated-source preparation");
    const reordered = { ...boot, run: `bun src/server.ts\n${run}` };
    expect(apiBootCommands(reordered)).toHaveLength(2);
    expect(() => assertPrepared([reordered])).toThrow(
      "needs successful generated-source preparation",
    );
  });
}

test("workflow and job defaults preserve shell options while inheriting API directories", () => {
  const source = v.parse(sourceSchema, {
    defaults: { run: { shell: "bash", "working-directory": "./apps/api" } },
    jobs: {
      boot: {
        defaults: { run: { shell: "sh" } },
        steps: [
          { run: producer, "continue-on-error": false },
          { run: "bun run start" },
        ],
      },
    },
  });
  const job = source.jobs?.["boot"];
  expect(source.defaults?.run?.["shell"]).toBe("bash");
  expect(job?.defaults?.run?.["shell"]).toBe("sh");
  const steps = (job?.steps ?? []).map((step) => ({
    ...step,
    "working-directory":
      step["working-directory"] ??
      job?.defaults?.run?.["working-directory"] ??
      source.defaults?.run?.["working-directory"],
  }));
  expect(assertPrepared(steps)).toBe(1);
  expect(() => assertPrepared(steps.slice(1))).toThrow(
    "needs successful generated-source preparation",
  );
});
