import { TaggedError } from "better-result";
import { readFileSync } from "node:fs";
import * as v from "valibot";

class ReleaseStagePrerequisitesError extends TaggedError(
  "ReleaseStagePrerequisitesError",
)<{
  message: string;
}> {}

const record = (value: unknown) =>
  v.parse(v.record(v.string(), v.unknown()), value);

type ReleaseStagePrerequisitesOptions = {
  workflow: unknown;
  needs: unknown;
  plan: unknown;
};

// Read the aggregator's contract directly: the stage may never deploy a tree
// whose required code check skipped, even when no dependency reported failure.
export const checkReleaseStagePrerequisites = ({
  workflow,
  needs,
  plan,
}: ReleaseStagePrerequisitesOptions) => {
  const jobs = record(record(workflow)["jobs"]);
  const result = record(jobs["ci-result"]);
  const dependencies = result["needs"];
  const steps = result["steps"];
  if (!Array.isArray(dependencies) || !Array.isArray(steps)) {
    throw new ReleaseStagePrerequisitesError({
      message: "Missing CI aggregator contract",
    });
  }
  const evaluator: unknown = steps.find(
    (step: unknown) => record(step)["name"] === "Evaluate CI outcome",
  );
  const scopeJson = record(record(evaluator)["env"])["JOB_SCOPES"];
  if (typeof scopeJson !== "string") {
    throw new ReleaseStagePrerequisitesError({
      message: "Missing CI job scopes",
    });
  }
  const scopes = record(JSON.parse(scopeJson));
  const observed = record(needs);
  const outputs = record(plan);
  const expected = dependencies.filter(
    (job: unknown) => job !== "release-stage",
  );
  if (
    expected.length !== Object.keys(observed).length ||
    expected.some(
      (job: unknown) =>
        typeof job !== "string" || !Object.hasOwn(observed, job),
    )
  ) {
    throw new ReleaseStagePrerequisitesError({
      message: "Release stage must depend on every CI prerequisite",
    });
  }
  if (record(observed["ci-plan"])["result"] !== "success") {
    throw new ReleaseStagePrerequisitesError({
      message: "CI plan did not succeed",
    });
  }
  for (const [job, value] of Object.entries(observed)) {
    if (job === "ci-plan") {
      continue;
    }
    const scope = scopes[job];
    if (
      scope !== null &&
      (typeof scope !== "string" ||
        !["true", "false"].includes(String(outputs[scope])))
    ) {
      throw new ReleaseStagePrerequisitesError({
        message: `Missing plan scope for ${job}`,
      });
    }
    const required =
      scope === null ||
      (typeof scope === "string" && outputs[scope] === "true");
    const conclusion = record(value)["result"];
    if (
      required
        ? conclusion !== "success"
        : conclusion !== "success" && conclusion !== "skipped"
    ) {
      throw new ReleaseStagePrerequisitesError({
        message: `CI prerequisite ${job} is ${String(conclusion)}${required ? " (required)" : ""}`,
      });
    }
  }
};

if (import.meta.main) {
  checkReleaseStagePrerequisites({
    workflow: Bun.YAML.parse(readFileSync(".github/workflows/ci.yml", "utf-8")),
    needs: JSON.parse(process.env["RELEASE_STAGE_NEEDS"] ?? ""),
    plan: JSON.parse(process.env["RELEASE_STAGE_PLAN"] ?? ""),
  });
}
