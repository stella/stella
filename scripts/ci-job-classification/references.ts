import { panic } from "better-result";
import * as v from "valibot";

import { compareCodeUnit } from "../../packages/collation/src/collation";
import { AdmissionError } from "./yaml";
import type { ParsedDocument } from "./yaml";

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

export const metadataReferenceIdentity = (
  reference: string,
  repository: string,
) =>
  reference.startsWith("./") || reference.startsWith("$/")
    ? `${repository}:${reference}`
    : reference;

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

type LocalMetadataPathOptions = {
  reference: string;
  kind: MetadataReferenceKind;
  relocations: ParsedDocument["relocatedActions"][string];
  inheritedMount: string | null;
};

/** Local composite uses paths are workspace-relative, including inside nested composites. */
export const resolveLocalMetadataPath = ({
  reference,
  kind,
  relocations,
  inheritedMount,
}: LocalMetadataPathOptions) => {
  const localPath = reference.slice(2);
  const safe = (value: string) =>
    value !== "" &&
    !value.includes("\\") &&
    value
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..");
  if (!safe(localPath)) {
    throw new AdmissionError({ message: "unsafe local metadata reference" });
  }
  if (kind === "reusable-workflow") {
    return { path: localPath, mount: null };
  }
  const selections = relocations.map((relocation) => {
    if (
      ![
        null,
        `\${{ github.repository }}`,
        `\${{ job.workflow_repository }}`,
      ].includes(relocation.repository) ||
      ![
        null,
        `\${{ github.workflow_sha }}`,
        `\${{ job.workflow_sha }}`,
      ].includes(relocation.ref) ||
      !safe(relocation.path) ||
      !localPath.endsWith(`/${relocation.path}`)
    ) {
      throw new AdmissionError({
        message: "local metadata path, repository or origin mismatch",
      });
    }
    const mount = localPath.slice(0, -(relocation.path.length + 1));
    if (!safe(mount)) {
      throw new AdmissionError({ message: "unsafe checkout metadata mount" });
    }
    return { path: relocation.path, mount };
  });
  const selected = selections.at(0);
  if (selected) {
    if (
      selections.some(
        (value) =>
          value.path !== selected.path || value.mount !== selected.mount,
      )
    ) {
      throw new AdmissionError({
        message: "ambiguous checkout metadata mount",
      });
    }
    return selected;
  }
  if (inheritedMount !== null) {
    if (!localPath.startsWith(`${inheritedMount}/`)) {
      throw new AdmissionError({
        message: "local metadata outside inherited checkout mount",
      });
    }
    return {
      path: localPath.slice(inheritedMount.length + 1),
      mount: inheritedMount,
    };
  }
  return { path: localPath, mount: null };
};

/** A single source node cannot silently acquire the first caller's workspace context. */
type MetadataMountOptions = {
  mounts: Map<string, string>;
  identity: string;
  mount: string | null;
  document: Pick<ParsedDocument, "dependencies" | "relocatedActions">;
};
export const recordMetadataMount = ({
  mounts,
  identity,
  mount,
  document,
}: MetadataMountOptions) => {
  const context = JSON.stringify(
    Object.entries(document.dependencies)
      .filter(
        ([reference]) =>
          reference.startsWith("./") || reference.startsWith("$/"),
      )
      .toSorted(([left], [right]) => compareCodeUnit(left, right))
      .map(([reference, kind]) => [
        reference,
        resolveLocalMetadataPath({
          reference,
          kind,
          relocations: document.relocatedActions[reference] ?? [],
          inheritedMount: mount,
        }),
      ]),
  );
  if (mounts.has(identity) && mounts.get(identity) !== context) {
    throw new AdmissionError({
      message: `conflicting checkout metadata context: ${identity}`,
    });
  }
  mounts.set(identity, context);
};
