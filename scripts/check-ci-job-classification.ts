import { Result } from "better-result";
import { appendFileSync } from "node:fs";
import path from "node:path";

import {
  generateClassification,
  readClassificationInputs,
} from "./ci-job-classification/generate";
import { ReviewRequiredError } from "./ci-job-classification/review";
import { AdmissionError } from "./ci-job-classification/yaml";

export const checkJobClassification = (root: string) =>
  Result.try({
    try: () => {
      const result = generateClassification(readClassificationInputs(root));
      if (result.isErr()) {
        throw result.error;
      }
      return result.value.workflows.length;
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
  const [root = ".", ...extra] = Bun.argv.slice(2);
  const result =
    root.startsWith("--") || extra.length
      ? Result.err(
          new AdmissionError({
            message: "usage: bun scripts/check-ci-job-classification.ts [ROOT]",
          }),
        )
      : checkJobClassification(path.resolve(root));
  const privilegedJobs =
    result.isErr() && result.error instanceof ReviewRequiredError
      ? result.error.privilegedJobs
      : [];
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `privileged_classification_change=${privilegedJobs.length > 0}\n`,
    );
  }
  if (result.isErr()) {
    if (privilegedJobs.length) {
      process.stdout.write(
        `::error title=Sensitive classification change::${escapeAnnotation(privilegedJobs.join(", "))}\n`,
      );
    }
    process.stderr.write(`${result.error.message}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`Classified ${result.value} workflows\n`);
  }
}
