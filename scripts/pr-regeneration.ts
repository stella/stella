import { existsSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

type GeneratorDefinition = {
  command: readonly string[];
  environment: Readonly<Record<string, string>>;
  services: readonly string[];
  prerequisites: readonly string[];
  outputs: readonly string[];
  owner: { type: "generator"; id: string } | { type: "test" };
};

export const PR_GENERATORS = {
  "api-typecheck-projects": {
    command: ["bun", "packages/scripts/src/api-typecheck-regenerate.ts"],
    environment: {},
    services: [],
    prerequisites: [],
    outputs: [
      "apps/api/tsconfig.declarations.json",
      "apps/api/tsconfig.src.json",
      "apps/api/tsconfig.tests.json",
      "turbo.json",
    ],
    owner: { type: "generator", id: "api-typecheck-projects" },
  },
  "query-plan-contracts": {
    command: [
      "bun",
      "--no-env-file",
      "--cwd=apps/api",
      "test",
      "--preload",
      "./src/tests/setup-env.ts",
      "./src/tests/query-plans/query-plans.db.test.ts",
    ],
    environment: { STELLA_UPDATE_PLAN_CONTRACTS: "1" },
    services: [],
    prerequisites: ["cli-runtime", "capability-runtime"],
    outputs: [
      "apps/api/src/tests/query-plans/contracts.json",
      "apps/api/src/tests/query-plans/workspace-rls-plan.fixture.json",
    ],
    owner: { type: "test" },
  },
} as const satisfies Record<string, GeneratorDefinition>;

// These controls run before installation, so errors are tagged without a dependency.
export class PrRegenerationRefusalError extends Error {
  override name = "PrRegenerationRefusalError";
  readonly _tag = "PrRegenerationRefusalError";
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

export const selectedGenerator = (id: string) => {
  const entry = Object.entries(PR_GENERATORS).find(([name]) => name === id);
  if (entry === undefined) {
    throw new PrRegenerationRefusalError("Unknown regeneration generator");
  }
  return entry[1];
};

type TargetOptions = {
  pullRequest: unknown;
  number: string;
  repository: string;
  ref: string;
  runSha: string;
};

export const regenerationTarget = ({
  pullRequest: pull,
  number,
  repository,
  ref,
  runSha,
}: TargetOptions) => {
  if (!/^[1-9][0-9]*$/u.test(number) || !Number.isSafeInteger(Number(number))) {
    throw new PrRegenerationRefusalError("Invalid pull request number");
  }
  if (
    !isRecord(pull) ||
    pull.number !== Number(number) ||
    pull.state !== "open" ||
    !isRecord(pull.head) ||
    !isRecord(pull.head.repo) ||
    !isRecord(pull.base) ||
    !isRecord(pull.base.repo)
  ) {
    throw new PrRegenerationRefusalError("Expected an open pull request");
  }
  if (
    pull.head.repo.full_name !== repository ||
    pull.base.repo.full_name !== repository
  ) {
    throw new PrRegenerationRefusalError("Fork pull requests are not eligible");
  }
  if (
    typeof pull.base.repo.default_branch !== "string" ||
    pull.base.repo.default_branch.length === 0 ||
    typeof pull.head.ref !== "string" ||
    pull.head.ref.length === 0 ||
    /[\r\n\0]/u.test(pull.head.ref) ||
    pull.head.ref === pull.base.repo.default_branch ||
    ref !== `refs/heads/${pull.head.ref}`
  ) {
    throw new PrRegenerationRefusalError(
      "Dispatch must run on the pull request branch",
    );
  }
  if (
    typeof pull.head.sha !== "string" ||
    !/^[a-f0-9]{40}$/u.test(pull.head.sha) ||
    pull.head.sha !== runSha
  ) {
    throw new PrRegenerationRefusalError(
      "Pull request head changed; dispatch the current head",
    );
  }
  return { head: pull.head.sha, branch: pull.head.ref };
};

export const assertOutputPaths = (
  generator: string,
  files: readonly string[],
) => {
  const selected = selectedGenerator(generator);
  const outputs = new Set<string>(selected.outputs);
  const unexpected = files.filter((file) => !outputs.has(file));
  if (unexpected.length > 0) {
    throw new PrRegenerationRefusalError(
      `Changes outside generator outputs: ${unexpected.join(", ")}`,
    );
  }
};

export const assertRequiredServices = (
  required: readonly string[],
  available: unknown,
) => {
  if (available !== null && !isRecord(available)) {
    throw new PrRegenerationRefusalError("Invalid job service metadata");
  }
  const names = new Set(Object.keys(available ?? {}));
  const missing = required.filter((name) => !names.has(name));
  if (missing.length > 0) {
    throw new PrRegenerationRefusalError(
      `Generator requires unavailable services: ${missing.join(", ")}`,
    );
  }
};

const gitRead = (root: string, args: readonly string[]) => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  const result = Bun.spawnSync(["git", "-C", root, ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new PrRegenerationRefusalError(
      `Git inspection failed: ${result.stderr.toString()}`,
    );
  }
  return result.stdout.toString();
};

type GeneratedTreeOptions = { root: string; generator: string; head: string };
export const assertGeneratedTree = ({
  root,
  generator,
  head,
}: GeneratedTreeOptions) => {
  if (
    !/^[a-f0-9]{40}$/u.test(head) ||
    gitRead(root, ["rev-parse", "HEAD"]).trim() !== head
  ) {
    throw new PrRegenerationRefusalError(
      "Generator moved the checked-out head",
    );
  }
  const changed = new Set(
    [
      ...gitRead(root, [
        "diff",
        "--name-only",
        "--no-renames",
        "--no-ext-diff",
        "-z",
        head,
        "--",
      ]).split("\0"),
      ...gitRead(root, [
        "diff",
        "--cached",
        "--name-only",
        "--no-renames",
        "--no-ext-diff",
        "-z",
        head,
        "--",
      ]).split("\0"),
      ...gitRead(root, [
        "diff",
        "--name-only",
        "--no-renames",
        "--no-ext-diff",
        "-z",
        "--",
      ]).split("\0"),
      ...gitRead(root, [
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
      ]).split("\0"),
    ].filter(Boolean),
  );
  assertOutputPaths(generator, [...changed]);
  const physicalRoot = realpathSync(root);
  for (const file of changed) {
    const full = path.join(physicalRoot, file);
    if (
      !existsSync(full) ||
      !lstatSync(full).isFile() ||
      realpathSync(full) !== full
    ) {
      throw new PrRegenerationRefusalError(
        `Generated output must be a regular file: ${file}`,
      );
    }
  }
  gitRead(root, ["diff", "--check", head, "--"]);
  return [...changed];
};

const runCommand = (
  command: readonly string[],
  environment: Readonly<Record<string, string>>,
) => {
  const result = Bun.spawnSync([...command], {
    env: { ...process.env, ...environment },
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) {
    throw new PrRegenerationRefusalError(
      `Generator command failed: ${command.join(" ")}`,
    );
  }
};

const sourceOwner = (owners: readonly unknown[], id: string) => {
  const owner = owners.find((entry) => isRecord(entry) && entry.id === id);
  if (
    !isRecord(owner) ||
    !isStrings(owner.write) ||
    !isStrings(owner.outputs)
  ) {
    throw new PrRegenerationRefusalError(
      `Owning generator is unavailable: ${id}`,
    );
  }
  return { command: owner.write, outputs: owner.outputs };
};

const runGenerator = async (id: string) => {
  const selected = selectedGenerator(id);
  const loaded: unknown = await import(
    pathToFileURL(path.resolve("scripts/generated-files.ts")).href
  );
  if (!isRecord(loaded) || !Array.isArray(loaded.GENERATORS)) {
    throw new PrRegenerationRefusalError(
      "Owning generator registry is unavailable",
    );
  }
  switch (selected.owner.type) {
    case "generator": {
      const owner = sourceOwner(loaded.GENERATORS, selected.owner.id);
      if (
        JSON.stringify(owner.command) !== JSON.stringify(selected.command) ||
        JSON.stringify(owner.outputs.toSorted()) !==
          JSON.stringify([...selected.outputs].toSorted())
      ) {
        throw new PrRegenerationRefusalError(
          "Owning generator declaration differs from the approved regeneration surface",
        );
      }
      break;
    }
    case "test":
      break;
    default:
      selected.owner satisfies never;
      throw new PrRegenerationRefusalError("Unknown generator owner");
  }
  for (const prerequisite of selected.prerequisites) {
    runCommand(sourceOwner(loaded.GENERATORS, prerequisite).command, {});
  }
  runCommand(selected.command, selected.environment);
};

if (import.meta.main) {
  try {
    const [mode, id = "", argument = ""] = process.argv.slice(2);
    const selected = selectedGenerator(id);
    assertRequiredServices(
      selected.services,
      JSON.parse(process.env["JOB_SERVICES"] ?? "{}"),
    );
    switch (mode) {
      case "plan": {
        const target = regenerationTarget({
          pullRequest: JSON.parse(await Bun.file(argument).text()),
          number: process.env["PR_NUMBER"] ?? "",
          repository: process.env["GITHUB_REPOSITORY"] ?? "",
          ref: process.env["GITHUB_REF"] ?? "",
          runSha: process.env["GITHUB_SHA"] ?? "",
        });
        console.log(`head=${target.head}\nbranch=${target.branch}`);
        console.log(`services=${JSON.stringify(selected.services)}`);
        break;
      }
      case "run":
        await runGenerator(id);
        break;
      case "check":
        console.log(
          `Verified ${assertGeneratedTree({ root: process.cwd(), generator: id, head: argument }).length} generated output(s)`,
        );
        break;
      default:
        throw new PrRegenerationRefusalError(
          "Usage: pr-regeneration.ts plan <generator> <pull-json> | run <generator> | check <generator> <head>",
        );
    }
  } catch (error) {
    if (!(error instanceof PrRegenerationRefusalError)) {
      throw error;
    }
    console.error(error.message);
    process.exit(1);
  }
}
