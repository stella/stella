import { Result } from "better-result";
import { appendFileSync } from "node:fs";
import path from "node:path";

import {
  generateClassification,
  readClassificationInputs,
} from "./ci-job-classification/generate";
import {
  isPrivilegedJob,
  ReviewRequiredError,
} from "./ci-job-classification/review";
import { AdmissionError, parseDocument } from "./ci-job-classification/yaml";

const gitShow = (root: string, revision: string, file: string) => {
  const result = Bun.spawnSync(
    ["git", "-C", root, "show", `${revision}:${file}`],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (result.exitCode !== 0) {
    throw new AdmissionError({
      message:
        new TextDecoder().decode(result.stderr).trim() ||
        `Cannot read ${file} at ${revision}`,
    });
  }
  return new TextDecoder().decode(result.stdout);
};

const jobLocation = (key: string) => {
  const separator = key.indexOf(":");
  const slash = key.lastIndexOf("/");
  return {
    repository: key.slice(0, separator),
    file: key.slice(separator + 1, slash),
    id: key.slice(slash + 1),
  };
};

const sensitiveChanges = (root: string, base: string) => {
  const head = readClassificationInputs(root);
  const baseDecisions = JSON.parse(
    gitShow(root, base, ".github/ci-job-classification-decisions.json"),
  ) as Record<
    string,
    { kind: "ordinary" | "support" | "priority"; reviewedDigest: string }
  >;
  return Object.entries(head.decisions).flatMap(([key, decision]) => {
    const previous = baseDecisions[key];
    if (previous?.reviewedDigest === decision.reviewedDigest) {
      return [];
    }
    const location = jobLocation(key);
    const headParsed = parseDocument(
      head.reader.read(location.repository, location.file),
    );
    if (headParsed.isErr()) {
      throw headParsed.error;
    }
    const headJob = headParsed.value.jobs[location.id];
    let basePrivileged = previous?.kind === "priority";
    if (previous && location.repository === "candidate") {
      const parsed = parseDocument(gitShow(root, base, location.file));
      if (parsed.isErr()) {
        throw parsed.error;
      }
      const job = parsed.value.jobs[location.id];
      basePrivileged = job
        ? isPrivilegedJob({ kind: previous.kind, shape: job.shape })
        : basePrivileged;
    }
    return (headJob &&
      isPrivilegedJob({ kind: decision.kind, shape: headJob.shape })) ||
      basePrivileged
      ? [key]
      : [];
  });
};

export const checkJobClassification = (root: string, base?: string) =>
  Result.try({
    try: () => {
      const result = generateClassification(readClassificationInputs(root));
      if (result.isErr()) {
        throw result.error;
      }
      return {
        workflowCount: result.value.workflows.length,
        privilegedJobs: base ? sensitiveChanges(root, base) : [],
      };
    },
    catch: (cause) =>
      cause instanceof ReviewRequiredError
        ? cause
        : new AdmissionError({
            message:
              cause instanceof Error
                ? cause.message
                : "Classification check failed",
          }),
  });

const escapeAnnotation = (value: string) =>
  value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const root = args.at(0) ?? ".";
  const base = args.at(1) === "--base" ? args.at(2) : undefined;
  const result =
    root.startsWith("--") || (args.length !== 1 && !(args.length === 3 && base))
      ? Result.err(
          new AdmissionError({
            message:
              "usage: bun scripts/check-ci-job-classification.ts [ROOT] [--base REF]",
          }),
        )
      : checkJobClassification(path.resolve(root), base);
  let privilegedJobs: string[] = [];
  if (result.isErr() && result.error instanceof ReviewRequiredError) {
    privilegedJobs = result.error.privilegedJobs;
  } else if (result.isOk()) {
    privilegedJobs = result.value.privilegedJobs;
  }
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `privileged_classification_change=${privilegedJobs.length > 0}\n`,
    );
  }
  if (privilegedJobs.length) {
    process.stdout.write(
      `::error title=Sensitive classification change::${escapeAnnotation(privilegedJobs.join(", "))}\n`,
    );
  }
  if (result.isErr()) {
    process.stderr.write(`${result.error.message}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `Classified ${result.value.workflowCount} workflows\n`,
    );
  }
}
