import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import { compareCodeUnit } from "./e2e-spec-shards-core";
import { lexShell } from "./install-free-ci";

// Finds every Playwright run a workflow reaches, for the browser suite census
// in scripts/ci-browser-suites.test.ts: package scripts that start Playwright
// (bun --filter, bun run, bun run --cwd, working-directory, root scripts) and
// direct CLI runs (playwright test, bunx/npx playwright test), through local
// reusable workflows and composite actions.

export type Manifest = { name?: string; scripts: Record<string, string> };

export type CensusIo = {
  /** A repository YAML file, or undefined when it does not exist. */
  yaml: (file: string) => unknown;
  /** A package manifest by repository directory ("." is the root). */
  manifest: (directory: string) => Manifest | undefined;
  /** Every workspace package directory. */
  packages: () => readonly string[];
};

const readManifest = (root: string, directory: string) => {
  const absolute = path.join(root, directory, "package.json");
  if (!existsSync(absolute)) {
    return undefined;
  }
  const parsed = v.parse(
    v.looseObject({
      name: v.optional(v.string()),
      scripts: v.optional(v.record(v.string(), v.string())),
    }),
    JSON.parse(readFileSync(absolute, "utf-8")),
  );
  return {
    ...(parsed.name === undefined ? {} : { name: parsed.name }),
    scripts: parsed.scripts ?? {},
  };
};

export const repositoryIo = (root: string): CensusIo => {
  const manifests = new Map<string, Manifest | undefined>();
  const packages = ["apps", "packages"].flatMap((parent) =>
    [...new Bun.Glob(`${parent}/*/package.json`).scanSync(root)].map((entry) =>
      path.posix.dirname(entry),
    ),
  );
  const manifest = (directory: string): Manifest | undefined => {
    if (!manifests.has(directory)) {
      manifests.set(directory, readManifest(root, directory));
    }
    return manifests.get(directory);
  };
  return {
    yaml: (file) => {
      const absolute = path.join(root, file);
      return existsSync(absolute)
        ? Bun.YAML.parse(readFileSync(absolute, "utf-8"))
        : undefined;
    },
    manifest,
    packages: () => packages,
  };
};

/** A direct `playwright test` run has this pseudo script name. */
export const DIRECT_PLAYWRIGHT = "playwright test";

export type Invocation = {
  /** The ci.yml job (the caller, for a reusable workflow's jobs). */
  job: string;
  step: string;
  stepIf: string | undefined;
  run: string;
  package: string;
  script: string;
  /** Positional spec filters the command passes. */
  filters: string[];
  /** The command passes arguments computed at run time. */
  dynamic: boolean;
};

export type Census = { invocations: Invocation[]; problems: string[] };

const STEP = v.looseObject({
  name: v.optional(v.string()),
  if: v.optional(v.string()),
  run: v.optional(v.string()),
  uses: v.optional(v.string()),
  "working-directory": v.optional(v.string()),
});
type Step = v.InferOutput<typeof STEP>;
const DEFAULTS = v.optional(
  v.looseObject({
    run: v.optional(
      v.looseObject({ "working-directory": v.optional(v.string()) }),
    ),
  }),
);
const WORKFLOW = v.looseObject({
  defaults: DEFAULTS,
  jobs: v.record(
    v.string(),
    v.looseObject({
      uses: v.optional(v.string()),
      defaults: DEFAULTS,
      steps: v.optional(v.array(STEP)),
    }),
  ),
});
const ACTION = v.looseObject({
  runs: v.looseObject({
    using: v.string(),
    steps: v.optional(v.array(STEP)),
  }),
});

const SCRIPT_CALL = /\b(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?([\w:.-]+)/gu;

// Whether a package script starts Playwright, following scripts it runs.
const runsPlaywright = (
  manifest: Manifest,
  script: string,
  depth = 0,
): boolean => {
  const text = manifest.scripts[script];
  if (text === undefined || depth > 4) {
    return false;
  }
  if (/\bplaywright\s+test\b/u.test(text)) {
    return true;
  }
  return [...text.matchAll(SCRIPT_CALL)].some(
    ([, called]) =>
      called !== undefined &&
      called !== script &&
      runsPlaywright(manifest, called, depth + 1),
  );
};

const normalize = (directory: string) => {
  const normalized = path.posix.normalize(directory);
  return normalized === "" ? "." : normalized.replace(/\/$/u, "");
};

// `$GITHUB_WORKSPACE` and `${{ github.workspace }}` name the checkout root.
const resolveDirectory = (cwd: string, target: string) => {
  const rooted = target.replace(
    /^(?:\$\{?GITHUB_WORKSPACE\}?|\$\{\{\s*github\.workspace\s*\}\})\/?/u,
    "/",
  );
  return rooted.startsWith("/")
    ? normalize(rooted.slice(1) || ".")
    : normalize(path.posix.join(cwd, rooted));
};

type Found = { package: string; script: string; args: readonly string[] };

const packageName = (io: CensusIo, directory: string) =>
  io.manifest(directory)?.name ?? directory;

const directDirectoryScript = (
  io: CensusIo,
  directory: string,
  script: string | undefined,
  args: readonly string[],
): Found | undefined => {
  const manifest = io.manifest(directory);
  return script !== undefined &&
    manifest !== undefined &&
    runsPlaywright(manifest, script)
    ? { package: packageName(io, directory), script, args }
    : undefined;
};

const packageByName = (io: CensusIo, name: string): string | undefined =>
  [...io.packages(), "."].find(
    (directory) => io.manifest(directory)?.name === name,
  );

// Every Playwright run one shell command starts.
const commandRuns = (
  io: CensusIo,
  words: readonly string[],
  cwd: string,
): Found[] => {
  const found: Found[] = [];
  for (const [index, word] of words.entries()) {
    const command = path.posix.basename(word);
    const rest = words.slice(index + 1);
    if (
      (command === "playwright" && rest[0] === "test") ||
      ((command === "bunx" || command === "npx") &&
        rest[0] === "playwright" &&
        rest[1] === "test") ||
      (command === "bun" &&
        rest[0] === "x" &&
        rest[1] === "playwright" &&
        rest[2] === "test")
    ) {
      found.push({
        package: packageName(io, cwd),
        script: DIRECT_PLAYWRIGHT,
        args: rest.slice(rest.indexOf("test") + 1),
      });
      // One command starts one run.
      break;
    }
    if (command !== "bun") {
      continue;
    }
    const [first, second, third, fourth] = rest;
    if (first === "--filter" && second !== undefined) {
      const directory = packageByName(io, second);
      const run =
        directory === undefined
          ? undefined
          : directDirectoryScript(io, directory, third, rest.slice(3));
      if (run !== undefined) {
        found.push({ ...run, package: second });
        break;
      }
    } else if (first === "run" && second === "--cwd" && third !== undefined) {
      const run = directDirectoryScript(
        io,
        resolveDirectory(cwd, third),
        fourth,
        rest.slice(4),
      );
      if (run !== undefined) {
        found.push(run);
        break;
      }
    } else if (first === "--cwd" && second !== undefined && third === "run") {
      const run = directDirectoryScript(
        io,
        resolveDirectory(cwd, second),
        fourth,
        rest.slice(4),
      );
      if (run !== undefined) {
        found.push(run);
        break;
      }
    } else if (first === "run") {
      const run = directDirectoryScript(io, cwd, second, rest.slice(2));
      if (run !== undefined) {
        found.push(run);
        break;
      }
    } else if (first !== undefined && !first.startsWith("-")) {
      // `bun <script>` runs a package script of that name.
      const run = directDirectoryScript(io, cwd, first, rest.slice(1));
      if (run !== undefined) {
        found.push(run);
        break;
      }
    }
  }
  return found;
};

// Mentions of Playwright that start no test run.
const BENIGN_MENTIONS = [
  /setup-playwright/gu,
  /playwright-timings/gu,
  /playwright-blob[\w-]*/gu,
  /@stll\/playwright-tools/gu,
  /PLAYWRIGHT_[A-Z_]+/gu,
  /\.playwright\//gu,
  /playwright(?:\.[\w-]+)*\.config\.ts/gu,
];

const unexplainedMention = (run: string) => {
  let text = run
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n")
    .replaceAll(/\becho\s+"[^"\n]*"/gu, "");
  for (const pattern of BENIGN_MENTIONS) {
    text = text.replaceAll(pattern, "");
  }
  return /playwright/iu.test(text);
};

type Walk = {
  io: CensusIo;
  job: string;
  cwd: string;
  label: string;
  census: Census;
  visiting: ReadonlySet<string>;
};

const walkSteps = (steps: readonly Step[], walk: Walk) => {
  for (const step of steps) {
    const name = `${walk.label}${step.name ?? step.uses ?? "unnamed"}`;
    if (step.uses?.startsWith("./") === true) {
      const directory = normalize(step.uses.slice(2));
      const file = `${directory}/action.yml`;
      const action = v.safeParse(ACTION, walk.io.yaml(file));
      if (
        action.success &&
        action.output.runs.using === "composite" &&
        !walk.visiting.has(file)
      ) {
        walkSteps(action.output.runs.steps ?? [], {
          ...walk,
          cwd: ".",
          label: `${name} › `,
          visiting: new Set([...walk.visiting, file]),
        });
      }
    }
    if (step.run === undefined) {
      continue;
    }
    let cwd =
      step["working-directory"] === undefined
        ? walk.cwd
        : resolveDirectory(walk.cwd, step["working-directory"]);
    const found: Found[] = [];
    for (const event of lexShell(step.run)) {
      if (event.type !== "command") {
        continue;
      }
      if (event.words[0] === "cd" && event.words[1] !== undefined) {
        cwd = resolveDirectory(cwd, event.words[1]);
      }
      found.push(...commandRuns(walk.io, event.words, cwd));
    }
    for (const run of found) {
      const args = run.args.filter((arg) => arg !== "--");
      walk.census.invocations.push({
        job: walk.job,
        step: name,
        stepIf: step.if,
        run: step.run,
        package: run.package,
        script: run.script,
        filters: args
          .filter((arg) => !arg.startsWith("-") && arg.includes(".spec."))
          .toSorted(compareCodeUnit),
        dynamic: args.some((arg) => arg.includes("$")),
      });
    }
    if (found.length === 0 && unexplainedMention(step.run)) {
      walk.census.problems.push(
        `${walk.job} / ${name}: mentions Playwright without a recognised run`,
      );
    }
  }
};

type WorkflowWalk = {
  io: CensusIo;
  file: string;
  census: Census;
  /** The ci.yml job that calls this workflow, if it is reused. */
  caller: string | undefined;
  visiting: ReadonlySet<string>;
};

const walkWorkflow = ({ io, file, census, caller, visiting }: WorkflowWalk) => {
  const workflow = v.parse(WORKFLOW, io.yaml(file));
  const workflowCwd = workflow.defaults?.run?.["working-directory"] ?? ".";
  for (const [id, job] of Object.entries(workflow.jobs)) {
    const name = caller ?? id;
    if (job.uses?.startsWith("./") === true) {
      const called = normalize(job.uses.slice(2));
      if (!visiting.has(called)) {
        walkWorkflow({
          io,
          file: called,
          census,
          caller: name,
          visiting: new Set([...visiting, called]),
        });
      }
      continue;
    }
    walkSteps(job.steps ?? [], {
      io,
      job: name,
      cwd: normalize(job.defaults?.run?.["working-directory"] ?? workflowCwd),
      label: caller === undefined ? "" : `${file}#${id} › `,
      census,
      visiting,
    });
  }
};

/** Every Playwright run the workflow reaches, and every unexplained mention. */
export const browserInvocations = (
  io: CensusIo,
  workflow = ".github/workflows/ci.yml",
): Census => {
  const census: Census = { invocations: [], problems: [] };
  walkWorkflow({
    io,
    file: workflow,
    census,
    caller: undefined,
    visiting: new Set([workflow]),
  });
  return census;
};
