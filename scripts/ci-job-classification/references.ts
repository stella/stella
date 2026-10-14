import { panic } from "better-result";
import * as v from "valibot";

import { AdmissionError } from "./yaml";

const OWNER = v.pipe(
  v.string(),
  v.regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/u),
  v.transform((value) => value.toLowerCase()),
);
const REPO = v.pipe(
  v.string(),
  v.regex(/^[A-Za-z0-9_.-]+$/u),
  v.check((value) => value !== "." && value !== ".."),
  v.transform((value) => value.toLowerCase()),
);
const SHA = v.pipe(
  v.string(),
  v.regex(/^[0-9a-fA-F]{40}$/u),
  v.transform((value) => value.toLowerCase()),
);
const REMOTE_REFERENCE = v.strictObject({
  owner: OWNER,
  repo: REPO,
  path: v.pipe(
    v.string(),
    v.check(
      (value) =>
        value === "" ||
        value
          .split("/")
          .every((part) => part !== "" && part !== "." && part !== ".."),
    ),
  ),
  sha: SHA,
});
export const GIT_ORIGIN = v.strictObject({
  type: v.literal("git"),
  owner: OWNER,
  repo: REPO,
  sha: SHA,
});
export const METADATA_ORIGIN = v.variant("type", [
  v.strictObject({ type: v.literal("checkout") }),
  GIT_ORIGIN,
]);
export type MetadataOrigin = v.InferOutput<typeof METADATA_ORIGIN>;
export type MetadataReferenceKind = "reusable-workflow" | "action";

export const parseRemoteReference = (reference: string) => {
  const revision = reference.lastIndexOf("@");
  const parts = reference.slice(0, revision).split("/");
  const parsed = v.safeParse(REMOTE_REFERENCE, {
    owner: parts.at(0),
    repo: parts.at(1),
    path: parts.slice(2).join("/"),
    sha: reference.slice(revision + 1),
  });
  if (
    revision <= 0 ||
    parts.length < 2 ||
    parts.some((part) => part.length === 0) ||
    !parsed.success
  ) {
    throw new AdmissionError({ message: "invalid remote metadata reference" });
  }
  return parsed.output;
};

type SameMetadataOriginOptions = {
  caller: MetadataOrigin;
  target: MetadataOrigin;
};
export const sameMetadataOrigin = ({
  caller,
  target,
}: SameMetadataOriginOptions) => {
  switch (caller.type) {
    case "checkout":
      return target.type === "checkout";
    case "git":
      return (
        target.type === "git" &&
        caller.owner === target.owner &&
        caller.repo === target.repo &&
        caller.sha === target.sha
      );
    default: {
      caller satisfies never;
      return panic("Unrecognized metadata origin");
    }
  }
};

type VerifyRemoteReferenceOptions = {
  reference: string;
  origin: MetadataOrigin;
  path: string;
  kind: MetadataReferenceKind;
};
export const verifyRemoteReference = ({
  reference,
  origin,
  path,
  kind,
}: VerifyRemoteReferenceOptions) => {
  const parsed = parseRemoteReference(reference);
  if (
    origin.type !== "git" ||
    parsed.owner !== origin.owner ||
    parsed.repo !== origin.repo ||
    parsed.sha !== origin.sha
  ) {
    throw new AdmissionError({ message: "remote metadata origin mismatch" });
  }
  const directory = parsed.path ? `${parsed.path}/` : "";
  const matches =
    kind === "reusable-workflow"
      ? path === parsed.path
      : path === `${directory}action.yml` || path === `${directory}action.yaml`;
  if (!matches) {
    throw new AdmissionError({ message: "remote metadata path mismatch" });
  }
};
