import { Result, TaggedError } from "better-result";
import * as v from "valibot";

import { sha256 } from "./classification-values";
import { requestsRepositoryWrite, shapeWritesRepository } from "./review";

export class AdmissionError extends TaggedError("AdmissionError")<{
  message: string;
}> {}

// Only these document/job/step keys are omitted; new keys participate automatically.
// YAML comments are absent from the parsed objects. Action inputs, including
// arbitrary github-script programs, stay intact. A GitHub-hosted
// runner image does not decide a job's kind, so `runs-on` leaves the job shape
// only when every label names one (see `projectRunner`).
export const CLASSIFICATION_EXCLUSIONS = {
  document: ["name", "run-name"],
  job: ["name", "timeout-minutes"],
  step: ["name", "timeout-minutes", "run"],
} as const;

const DOCUMENT = v.strictObject({
  digest: v.string(),
  privileged: v.boolean(),
  // Composite-action steps are not kept in the shape, so callers read this.
  writesRepository: v.boolean(),
  jobs: v.record(
    v.string(),
    v.strictObject({
      digest: v.string(),
      shape: v.strictObject({
        document: v.record(v.string(), v.unknown()),
        job: v.record(v.string(), v.unknown()),
      }),
      dependencies: v.record(
        v.string(),
        v.picklist(["action", "reusable-workflow"]),
      ),
    }),
  ),
  dependencies: v.record(
    v.string(),
    v.picklist(["action", "reusable-workflow"]),
  ),
  relocatedActions: v.record(
    v.string(),
    v.array(
      v.strictObject({
        repository: v.nullable(v.string()),
        ref: v.nullable(v.string()),
        path: v.string(),
      }),
    ),
  ),
});

export type JobShape = v.InferOutput<typeof DOCUMENT>["jobs"][string]["shape"];
export type ParsedDocument = v.InferOutput<typeof DOCUMENT>;

type JsonRecord = Record<string, unknown>;
type DependencyKind = "action" | "reusable-workflow";
type RelocatedAction = {
  repository: string | null;
  ref: string | null;
  path: string;
};

const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_EXPANDED_NODES = 250_000;
const MAX_EXPANDED_BYTES = 16 * 1024 * 1024;
const MAX_DEPTH = 256;
const encoder = new TextEncoder();

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireRecord = (value: unknown, message: string) => {
  if (!isRecord(value)) {
    throw new AdmissionError({ message });
  }
  return value;
};

const measure = (value: unknown, depth = 0): [number, number] => {
  if (depth > MAX_DEPTH) {
    throw new AdmissionError({ message: "YAML nesting limit exceeded" });
  }
  if (typeof value === "string") {
    return [1, encoder.encode(value).byteLength];
  }
  let children: unknown[] = [];
  if (Array.isArray(value)) {
    children = value;
  } else if (isRecord(value)) {
    children = Object.entries(value).flat();
  }
  let nodes = 1;
  let bytes = 0;
  for (const child of children) {
    const [childNodes, childBytes] = measure(child, depth + 1);
    nodes += childNodes;
    bytes += childBytes;
    if (nodes > MAX_EXPANDED_NODES || bytes > MAX_EXPANDED_BYTES) {
      throw new AdmissionError({
        message: "YAML alias expansion limit exceeded",
      });
    }
  }
  return [nodes, bytes];
};

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .toSorted()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
};

const digest = (value: unknown) => sha256(JSON.stringify(canonicalize(value)));

const project = (
  value: JsonRecord,
  scope: keyof typeof CLASSIFICATION_EXCLUSIONS,
) => {
  const excluded: readonly string[] = CLASSIFICATION_EXCLUSIONS[scope];
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !excluded.includes(key)),
  );
};

const secretRefs = (value: unknown): string[] => {
  if (typeof value === "string") {
    return [
      ...value.matchAll(/secrets(?:\.[A-Za-z_][A-Za-z0-9_]*|\[[^\]]+\])?/gu),
    ]
      .map(([match]) => match)
      .filter((match, index, matches) => matches.indexOf(match) === index)
      .toSorted();
  }
  let children: unknown[] = [];
  if (Array.isArray(value)) {
    children = value;
  } else if (isRecord(value)) {
    children = Object.values(value);
  }
  return [...new Set(children.flatMap(secretRefs))].toSorted();
};

const githubScript = (step: JsonRecord) => {
  const uses = step["uses"];
  const options = step["with"];
  if (
    typeof uses !== "string" ||
    !uses.startsWith("actions/github-script@") ||
    !isRecord(options)
  ) {
    return undefined;
  }
  const script = options["script"];
  return typeof script === "string" ? script : undefined;
};

const stepShapes = (value: unknown): JsonRecord[] => {
  if (!Array.isArray(value)) {
    throw new AdmissionError({ message: "steps must be array" });
  }
  return value.flatMap((candidate) => {
    const step = requireRecord(candidate, "step must be mapping");
    const shape = project(step, "step");
    const run = step["run"];
    const script = githubScript(step);
    // Arbitrary JavaScript effects cannot be proven from keyword matches:
    // retain the complete body in `with`, including calls through aliases.
    const bodies = [run, script].filter(
      (body): body is string => typeof body === "string",
    );
    const publicationCommand = bodies.some((body) =>
      /publish|deploy|release|push/iu.test(body),
    );
    if ("parallel" in step) {
      shape["parallel"] = stepShapes(step["parallel"]);
    }
    const refs = secretRefs(bodies);
    if (
      Object.keys(shape).length === 0 &&
      refs.length === 0 &&
      !publicationCommand
    ) {
      return [];
    }
    return [
      {
        definition: shape,
        "run-secret-refs": refs,
        "publication-command": publicationCommand,
      },
    ];
  });
};

// GitHub-hosted image labels only; a self-hosted, grouped or computed runner
// can change what a job can reach, so it stays in the shape and in the
// privilege check that reads it.
// Standard labels: https://docs.github.com/en/actions/reference/runners/github-hosted-runners
// Unknown labels remain classification inputs until reviewed as hosted images.
const GITHUB_HOSTED_RUNNERS = new Set([
  "ubuntu-slim",
  "ubuntu-latest",
  "ubuntu-24.04",
  "ubuntu-22.04",
  "ubuntu-26.04",
  "ubuntu-24.04-arm",
  "ubuntu-22.04-arm",
  "ubuntu-26.04-arm",
  "windows-latest",
  "windows-2025",
  "windows-2025-vs2026",
  "windows-2022",
  "windows-11-arm",
  "windows-11-vs2026-arm",
  "macos-15-intel",
  "macos-26-intel",
  "macos-latest",
  "macos-14",
  "macos-15",
  "macos-26",
  "xcode-27",
]);
const projectRunner = (job: JsonRecord, shape: JsonRecord) => {
  const runner = job["runs-on"];
  const labels: unknown[] = Array.isArray(runner) ? runner : [runner];
  const hosted =
    labels.length > 0 &&
    labels.every(
      (label) => typeof label === "string" && GITHUB_HOSTED_RUNNERS.has(label),
    );
  if (!hosted) {
    return shape;
  }
  return Object.fromEntries(
    Object.entries(shape).filter(([key]) => key !== "runs-on"),
  );
};

const canonicalSteps = (value: unknown): JsonRecord[] => {
  if (!Array.isArray(value)) {
    throw new AdmissionError({ message: "steps must be array" });
  }
  return value.flatMap((candidate) => {
    const step = requireRecord(candidate, "step must be mapping");
    if ("parallel" in step) {
      if ("uses" in step || "run" in step) {
        throw new AdmissionError({
          message: "parallel group cannot have leaf fields",
        });
      }
      return canonicalSteps(step["parallel"]);
    }
    for (const key of ["uses", "run"] as const) {
      if (key in step && typeof step[key] !== "string") {
        throw new AdmissionError({ message: `${key} must be string` });
      }
    }
    if ("uses" in step && "run" in step) {
      throw new AdmissionError({ message: "step cannot have uses and run" });
    }
    return [
      {
        uses: step["uses"] ?? null,
        run: step["run"] ?? null,
        with: step["with"] ?? null,
      },
    ];
  });
};

const addActionDependencies = (
  dependencies: Record<string, DependencyKind>,
  steps: JsonRecord[],
  relocatedActions: Record<string, RelocatedAction[]>,
) => {
  const checkouts: RelocatedAction[] = [];
  for (const step of steps) {
    const uses = step["uses"];
    if (typeof uses === "string") {
      dependencies[uses] ??= "action";
      if (uses.startsWith("./")) {
        const localPath = uses.slice(2);
        const checkout = checkouts
          .filter(({ path }) => localPath.startsWith(`${path}/`))
          .toSorted((left, right) => right.path.length - left.path.length)
          .at(0);
        if (checkout) {
          (relocatedActions[uses] ??= []).push({
            repository: checkout.repository,
            ref: checkout.ref,
            path: localPath.slice(checkout.path.length + 1),
          });
        }
      }
    }
    const withInputs = step["with"];
    if (
      typeof uses === "string" &&
      uses.startsWith("actions/checkout@") &&
      isRecord(withInputs) &&
      typeof withInputs["path"] === "string"
    ) {
      checkouts.push({
        repository:
          typeof withInputs["repository"] === "string"
            ? withInputs["repository"]
            : null,
        ref: typeof withInputs["ref"] === "string" ? withInputs["ref"] : null,
        path: withInputs["path"].replace(/^\.\//u, "").replace(/\/$/u, ""),
      });
    }
  }
};

const privileged = (value: unknown): boolean => {
  if (typeof value === "string") {
    return /secrets(?:\.|\[)|publish|deploy|release|self-hosted/iu.test(value);
  }
  if (Array.isArray(value)) {
    return value.some(privileged);
  }
  if (!isRecord(value)) {
    return false;
  }
  return Object.entries(value).some(([key, child]) => {
    // Hosted labels were removed by projectRunner; a retained runner can reach
    // infrastructure outside the standard hosted boundary.
    if (key === "runs-on") {
      return true;
    }
    if (key === "publication-command" && child === true) {
      return true;
    }
    if (key === "secrets" && child !== null) {
      return true;
    }
    if (
      key === "permissions" &&
      (child === "write-all" ||
        (isRecord(child) && Object.values(child).includes("write")))
    ) {
      return true;
    }
    return privileged(child);
  });
};

const parse = (text: string): ParsedDocument => {
  if (encoder.encode(text).byteLength > MAX_SOURCE_BYTES) {
    throw new AdmissionError({ message: "YAML source byte limit exceeded" });
  }
  const data = requireRecord(Bun.YAML.parse(text), "document must be mapping");
  measure(data);
  const shape = project(data, "document");
  const runs = data["runs"];
  if (isRecord(runs) && "steps" in runs) {
    shape["runs"] = { ...runs, steps: stepShapes(runs["steps"]) };
  }
  const context = Object.fromEntries(
    Object.entries(shape).filter(([key]) => key !== "jobs"),
  );
  const jobs: ParsedDocument["jobs"] = {};
  const dependencies: Record<string, DependencyKind> = {};
  const relocatedActions: Record<string, RelocatedAction[]> = {};
  if ("jobs" in data) {
    const jobValues = requireRecord(
      data["jobs"],
      "jobs must be nonempty mapping",
    );
    if (Object.keys(jobValues).length === 0) {
      throw new AdmissionError({ message: "jobs must be nonempty mapping" });
    }
    for (const [id, candidate] of Object.entries(jobValues)) {
      const job = requireRecord(
        candidate,
        "job must be mapping with string id",
      );
      const steps = "steps" in job ? canonicalSteps(job["steps"]) : [];
      if ("uses" in job && typeof job["uses"] !== "string") {
        throw new AdmissionError({ message: "job uses must be string" });
      }
      if (typeof job["uses"] === "string") {
        dependencies[job["uses"]] = "reusable-workflow";
      }
      addActionDependencies(dependencies, steps, relocatedActions);
      const jobDependencies: Record<string, DependencyKind> = {};
      if (typeof job["uses"] === "string") {
        jobDependencies[job["uses"]] = "reusable-workflow";
      }
      addActionDependencies(jobDependencies, steps, {});
      const jobShape = projectRunner(job, project(job, "job"));
      if ("steps" in job) {
        jobShape["steps"] = stepShapes(job["steps"]);
      }
      const jobContext = { document: context, job: jobShape };
      jobs[id] = {
        digest: digest(jobContext),
        shape: jobContext,
        dependencies: jobDependencies,
      };
    }
  }
  let actionSteps: JsonRecord[] = [];
  if ("runs" in data) {
    const actionRuns = requireRecord(runs, "action runs must be mapping");
    actionSteps =
      actionRuns["using"] === "composite"
        ? canonicalSteps(actionRuns["steps"])
        : [{ run: JSON.stringify(canonicalize(actionRuns)) }];
  }
  addActionDependencies(dependencies, actionSteps, relocatedActions);
  if ("jobs" in data) {
    shape["jobs"] = Object.fromEntries(
      Object.entries(jobs).map(([id, job]) => [id, job.digest]),
    );
  }
  return v.parse(DOCUMENT, {
    digest: digest(shape),
    privileged:
      privileged(shape) ||
      Object.values(jobs).some(({ shape: jobShape }) => privileged(jobShape)),
    writesRepository:
      requestsRepositoryWrite(actionSteps) ||
      Object.values(jobs).some(({ shape: jobShape }) =>
        shapeWritesRepository(jobShape),
      ),
    jobs,
    dependencies,
    relocatedActions,
  });
};

export const parseDocument = (text: string) =>
  Result.try({
    try: () => parse(text),
    catch: (cause) =>
      new AdmissionError({
        message: `YAML rejected: ${cause instanceof Error ? cause.message : "YAML parser failed"}`,
      }),
  });
