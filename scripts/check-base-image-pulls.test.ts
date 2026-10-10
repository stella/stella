import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

// Relative: CI runs this before the dependency install.
import { compareCodeUnit } from "../packages/collation/src/collation";

const GITHUB_URL = new URL("../.github/", import.meta.url);
const PULL_SCRIPT = "scripts/pull-base-images.sh";
const CI_IMAGE_SCRIPT = "scripts/ci-service-images.ts";
const CI_BUILD =
  /\bbun\s+[^\n]*scripts\/ci-service-images\.ts["']?\s+--build\s/u;
const BUILD_PUSH_ACTION = "docker/build-push-action@";
const CHECKOUT_ACTION = "actions/checkout@";
/** Checkout ref expressions that are the running workflow's own revision. */
const WORKFLOW_REVISION_REFS = new Set([
  "github.workflow_sha",
  "github.sha",
  "github.event.repository.default_branch",
]);
const EXPRESSION = /^\$\{\{\s*(.+?)\s*\}\}$/u;
/** A command, not a message that names one (`${lines:-docker build failed}`). */
const DOCKER_BUILD = /(?:^|[\s;&|(])docker\s+(?:buildx\s+)?build\b/u;
/**
 * Every image build CI and the release workflows run today. Fewer means the
 * scan stopped finding them, not that they stopped existing.
 */
const MINIMUM_BUILD_SITES = 9;
const RETRY_SCRIPT = "scripts/retry.sh";
const DOCKER_PULL = /(?:^|[\s;&|(])docker\s+pull\b/u;
/** Tolerates a checkout-path prefix, as in `.workflow-source/scripts/…`. */
const WRAPPED_PULL =
  /\bbash\s+(?:[\w.\-/]+\/)?scripts\/retry\.sh\s+docker\s+pull\b/u;
/** The registry pulls the workflows run today, counted like the builds. */
const MINIMUM_PULL_SITES = 3;

// Parsed without a schema library: CI runs this file before installing
// dependencies, on workflow-only changes.
type Scalars = Record<string, string | number | boolean>;
type Step = {
  name?: string;
  uses?: string;
  run?: string;
  env?: Scalars;
  with?: Scalars;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isOptionalString = (value: unknown) =>
  value === undefined || typeof value === "string";

const isOptionalScalars = (value: unknown) =>
  value === undefined ||
  (isRecord(value) &&
    Object.values(value).every((entry) =>
      ["string", "number", "boolean"].includes(typeof entry),
    ));

const isStep = (value: unknown): value is Step =>
  isRecord(value) &&
  isOptionalString(value["name"]) &&
  isOptionalString(value["uses"]) &&
  isOptionalString(value["run"]) &&
  isOptionalScalars(value["env"]) &&
  isOptionalScalars(value["with"]);

const stepsOf = (value: unknown, source: string): Step[] => {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || !value.every(isStep)) {
    throw new Error(`${source}: steps do not have the expected shape`);
  }
  return value;
};

type StepList = { source: string; steps: Step[] };

const readYaml = async (file: string) =>
  Bun.YAML.parse(await Bun.file(new URL(file, GITHUB_URL)).text());

const collectStepLists = async (): Promise<StepList[]> => {
  const root = fileURLToPath(GITHUB_URL);
  const lists: StepList[] = [];
  for (const file of new Bun.Glob("workflows/*.yml").scanSync({ cwd: root })) {
    const workflow = await readYaml(file);
    const jobs = isRecord(workflow) ? workflow["jobs"] : undefined;
    if (!isRecord(jobs)) {
      throw new Error(`${file}: no jobs`);
    }
    for (const [job, definition] of Object.entries(jobs)) {
      const source = `${file} (${job})`;
      const steps = isRecord(definition) ? definition["steps"] : undefined;
      lists.push({ source, steps: stepsOf(steps, source) });
    }
  }
  const actions = new Bun.Glob("actions/*/action.yml").scanSync({ cwd: root });
  for (const file of actions) {
    const action = await readYaml(file);
    const runs = isRecord(action) ? action["runs"] : undefined;
    if (!isRecord(runs)) {
      throw new Error(`${file}: no runs`);
    }
    lists.push({ source: file, steps: stepsOf(runs["steps"], file) });
  }
  return lists.toSorted((a, b) => compareCodeUnit(a.source, b.source));
};

/** A step's command, with its own `env` substituted and quotes dropped. */
const commandLine = ({ run = "", env = {} }: Step) =>
  run
    .replaceAll(/\$\{?([A-Za-z_]\w*)\}?/gu, (whole, name: string) =>
      String(env[name] ?? whole),
    )
    .replaceAll(/["']/gu, "")
    .replaceAll(/\s+/gu, " ");

type BuildSite = { file: string; buildxPlatforms: string | null };

const buildSite = (step: Step): BuildSite | null => {
  if (step.uses?.startsWith(BUILD_PUSH_ACTION)) {
    return {
      file: String(step.with?.["file"] ?? ""),
      buildxPlatforms: String(step.with?.["platforms"] ?? ""),
    };
  }
  if (
    step.run === undefined ||
    (!DOCKER_BUILD.test(step.run) && !CI_BUILD.test(step.run))
  ) {
    return null;
  }
  const words = commandLine(step).split(" ");
  const flag = words.findIndex((word) => word === "--file" || word === "-f");
  return {
    file: flag === -1 ? "" : (words.at(flag + 1) ?? ""),
    buildxPlatforms: null,
  };
};

/** The pull a build needs, as the pull step must spell it. */
const expectedPull = ({ file, buildxPlatforms }: BuildSite) =>
  buildxPlatforms === null
    ? `${PULL_SCRIPT} ${file}`
    : `${PULL_SCRIPT} --buildx ${buildxPlatforms} ${file}`;

const pullsFor = (step: Step, site: BuildSite) => {
  const command = commandLine(step);
  if (command.includes(`${CI_IMAGE_SCRIPT} --pull ${site.file}`)) {
    return true;
  }
  return (
    command.includes(expectedPull(site)) &&
    command.includes(" --buildx ") === (site.buildxPlatforms !== null)
  );
};

type ScriptRevisionArgs = { steps: Step[]; index: number; script: string };

/**
 * A job may check out an older source than the workflow's; the helper scripts
 * must still come from the workflow's revision, where they are known to exist.
 */
const scriptFromWorkflowRevision = ({
  steps,
  index,
  script,
}: ScriptRevisionArgs) => {
  const invoked =
    commandLine(steps[index] ?? {})
      .split(" ")
      .find((word) => word.endsWith(script)) ?? "";
  const directory = invoked
    .slice(0, -script.length)
    .replace(/^\.\//u, "")
    .replace(/\/$/u, "");
  // An expression (`${{ inputs.tooling-path }}`): a composite action receives
  // its tooling checkout from the caller.
  if (directory.endsWith("}}")) {
    return true;
  }
  const checkout = steps
    .slice(0, index)
    .findLast(
      (step) =>
        step.uses?.startsWith(CHECKOUT_ACTION) &&
        String(step.with?.["path"] ?? "") === directory,
    );
  const ref = checkout?.with?.["ref"];
  const expression = EXPRESSION.exec(String(ref ?? ""))?.at(1) ?? "";
  return (
    checkout !== undefined &&
    (ref === undefined || WORKFLOW_REVISION_REFS.has(expression))
  );
};

describe("image builds and pulls", () => {
  test("every image build first pulls its base images with retries", async () => {
    const problems: string[] = [];
    let sites = 0;
    for (const { source, steps } of await collectStepLists()) {
      for (const [index, step] of steps.entries()) {
        const site = buildSite(step);
        if (site === null) {
          continue;
        }
        sites += 1;
        const label = `.github/${source}: ${step.name ?? "unnamed step"}`;
        if (site.file === "" || site.buildxPlatforms === "") {
          problems.push(`${label}: name the Dockerfile and the platforms`);
          continue;
        }
        const pullIndex = steps
          .slice(0, index)
          .findIndex((prior) => pullsFor(prior, site));
        if (pullIndex === -1) {
          problems.push(
            `${label}\n    add an earlier step: bash ${expectedPull(site)}`,
          );
        } else if (
          !scriptFromWorkflowRevision({
            steps,
            index: pullIndex,
            script: commandLine(steps[pullIndex] ?? {}).includes(
              CI_IMAGE_SCRIPT,
            )
              ? CI_IMAGE_SCRIPT
              : PULL_SCRIPT,
          })
        ) {
          problems.push(
            `${label}\n    run ${PULL_SCRIPT} from a checkout of github.workflow_sha`,
          );
        }
      }
    }

    expect(sites).toBeGreaterThanOrEqual(MINIMUM_BUILD_SITES);
    expect(problems.join("\n")).toBe("");
  });

  test("every docker pull retries", async () => {
    const problems: string[] = [];
    let sites = 0;
    for (const { source, steps } of await collectStepLists()) {
      for (const [index, step] of steps.entries()) {
        const pulls = (step.run ?? "")
          .split("\n")
          .filter(
            (line) =>
              DOCKER_PULL.test(line) && !line.trimStart().startsWith("#"),
          );
        if (pulls.length === 0) {
          continue;
        }
        sites += pulls.length;
        const label = `.github/${source}: ${step.name ?? "unnamed step"}`;
        for (const line of pulls.filter((pull) => !WRAPPED_PULL.test(pull))) {
          problems.push(
            `${label}: ${line.trim()}\n    wrap it: bash ${RETRY_SCRIPT} docker pull …`,
          );
        }
        if (
          !scriptFromWorkflowRevision({ steps, index, script: RETRY_SCRIPT })
        ) {
          problems.push(
            `${label}\n    run ${RETRY_SCRIPT} from a checkout of github.workflow_sha`,
          );
        }
      }
    }

    expect(sites).toBeGreaterThanOrEqual(MINIMUM_PULL_SITES);
    expect(problems.join("\n")).toBe("");
  });
});
