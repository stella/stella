import { Result } from "better-result";
import { writeFileSync } from "node:fs";
import path from "node:path";

import {
  generateClassification,
  readClassificationInputs,
} from "./ci-job-classification/generate";
import {
  REFRESH_COMMAND,
  verifyPublicMetadata,
} from "./ci-job-classification/public-metadata";
import { sameMetadataOrigin } from "./ci-job-classification/references";
import { AdmissionError } from "./ci-job-classification/yaml";

type CheckOptions = { root: string; mode: "check" | "write" };
export const checkJobClassification = ({ root, mode }: CheckOptions) =>
  Result.try({
    try: () => {
      const inputs = readClassificationInputs(root);
      if (inputs.manifest.repository !== "candidate") {
        throw new AdmissionError({
          message:
            "Classification root does not identify the candidate repository",
        });
      }
      for (const node of inputs.manifest.nodes) {
        if (
          node.type === "metadata" &&
          node.repository === "candidate" &&
          node.origin.type !== "checkout"
        ) {
          throw new AdmissionError({
            message: "Candidate metadata must use checkout origin",
          });
        }
      }
      const generated = generateClassification(inputs);
      if (generated.isErr()) {
        throw generated.error;
      }
      for (const node of generated.value.nodes) {
        if (node.type !== "metadata" || node.repository === "candidate") {
          continue;
        }
        const snapshot = inputs.snapshots[node.repository];
        if (
          !snapshot ||
          !sameMetadataOrigin({ caller: node.origin, target: snapshot.origin })
        ) {
          throw new AdmissionError({
            message: `Callee snapshot origin differs: ${node.path}`,
          });
        }
      }
      if (mode === "write") {
        writeFileSync(
          path.resolve(root, ".github/ci-job-classification.json"),
          `${JSON.stringify(generated.value, null, 2)}\n`,
        );
      } else {
        const checked = verifyPublicMetadata(inputs);
        if (checked.isErr()) {
          throw checked.error;
        }
        if (
          JSON.stringify(inputs.manifest) !== JSON.stringify(generated.value)
        ) {
          throw new AdmissionError({
            message: `Generated classification metadata changed. Run ${REFRESH_COMMAND}`,
          });
        }
      }
      return generated.value.workflows.length;
    },
    catch: (cause) =>
      new AdmissionError({
        message:
          cause instanceof Error
            ? cause.message
            : "Classification check failed",
      }),
  });

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const result = checkJobClassification({
    root: path.resolve(args.find((arg) => arg !== "--write") ?? "."),
    mode: args.includes("--write") ? "write" : "check",
  });
  if (result.isErr()) {
    process.stderr.write(`${result.error.message}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`Classified ${result.value} workflows\n`);
  }
}
