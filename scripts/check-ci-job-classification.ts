import { Result } from "better-result";
import { readFileSync } from "node:fs";
import nodePath from "node:path";
import * as v from "valibot";

import { sha256 } from "./ci-job-classification/classification-values";
import {
  createCandidateMetadataReader,
  PUBLIC_METADATA,
  verifyPublicMetadata,
} from "./ci-job-classification/public-metadata";
import {
  GIT_ORIGIN,
  sameMetadataOrigin,
} from "./ci-job-classification/references";
import { AdmissionError } from "./ci-job-classification/yaml";

const CANDIDATE = "candidate";
const SNAPSHOT = v.strictObject({
  origin: GIT_ORIGIN,
  documents: v.record(v.string(), v.string()),
});
const SNAPSHOTS = v.record(v.string(), SNAPSHOT);

// Supplier metadata is captured at immutable revisions. Updating a caller's
// reference requires a reviewed snapshot and complete callee classifications.
export const checkJobClassification = (root: string) =>
  Result.try({
    try: () => {
      const manifest = v.parse(
        PUBLIC_METADATA,
        JSON.parse(
          readFileSync(
            nodePath.resolve(root, ".github/ci-job-classification.json"),
            "utf-8",
          ),
        ),
      );
      if (manifest.repository !== CANDIDATE) {
        throw new AdmissionError({
          message:
            "Classification root does not identify the candidate repository",
        });
      }
      const snapshots = v.parse(
        SNAPSHOTS,
        JSON.parse(
          readFileSync(
            nodePath.resolve(
              root,
              ".github/ci-job-classification-sources.json",
            ),
            "utf-8",
          ),
        ),
      );
      const candidate = createCandidateMetadataReader(
        { [CANDIDATE]: { directory: root, revision: "0".repeat(40) } },
        CANDIDATE,
      );
      const declaredSnapshots = new Set<string>();
      for (const node of manifest.nodes) {
        if (node.type !== "metadata") {
          continue;
        }
        if (node.repository === CANDIDATE) {
          if (node.origin.type !== "checkout") {
            throw new AdmissionError({
              message: "Candidate metadata must use checkout origin",
            });
          }
          continue;
        }
        const snapshot = snapshots[node.repository];
        if (!snapshot) {
          throw new AdmissionError({
            message: "Declared callee snapshot is missing",
          });
        }
        const text = snapshot.documents[node.path];
        declaredSnapshots.add(`${node.repository}:${node.path}`);
        if (text === undefined || sha256(text) !== node.digest) {
          throw new AdmissionError({
            message: "Declared callee snapshot changed",
          });
        }
        if (
          !sameMetadataOrigin({ caller: node.origin, target: snapshot.origin })
        ) {
          throw new AdmissionError({
            message: "Callee snapshot origin differs from its metadata",
          });
        }
      }
      const snapshotPaths = Object.entries(snapshots).flatMap(
        ([repository, snapshot]) =>
          Object.keys(snapshot.documents).map(
            (path) => `${repository}:${path}`,
          ),
      );
      if (
        snapshotPaths.length !== declaredSnapshots.size ||
        snapshotPaths.some((path) => !declaredSnapshots.has(path))
      ) {
        throw new AdmissionError({
          message:
            "Callee snapshot declarations do not match the reachable metadata",
        });
      }
      const result = verifyPublicMetadata({
        manifest,
        reader: {
          workflows: candidate.workflows,
          read: (repository, path) => {
            if (repository === CANDIDATE) {
              return candidate.read(repository, path);
            }
            const text = snapshots[repository]?.documents[path];
            if (text === undefined) {
              throw new AdmissionError({
                message: "Reachable callee metadata is unavailable",
              });
            }
            return text;
          },
        },
      });
      if (result.isErr()) {
        throw result.error;
      }
      return result.value;
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
  const result = checkJobClassification(
    nodePath.resolve(Bun.argv.at(2) ?? "."),
  );
  if (result.isErr()) {
    process.stderr.write(`${result.error.message}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`${JSON.stringify(result.value)}\n`);
  }
}
