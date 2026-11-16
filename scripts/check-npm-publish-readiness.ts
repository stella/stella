#!/usr/bin/env bun

// Anonymous census, not an authorization dry run: npm's trust-list endpoint
// requires package write access. Historical provenance cannot reveal a later
// deleted, pending, expired, or changed publisher (including its environment).
// See https://api-docs.npmjs.com/ and https://docs.npmjs.com/trusted-publishers/.
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  readPublishablePackages,
  type RegistryFetch,
} from "./check-npm-publish-lag";

const REGISTRY = "https://registry.npmjs.org";
const REPOSITORY = "https://github.com/stella/stella";
const WORKFLOW = ".github/workflows/publish-npm.yml";
const SLSA = "https://slsa.dev/provenance/v1";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type ReadinessFailure = {
  status: "failed";
  reason: "first-publish" | "mismatch" | "unreadable";
  detail: string;
};

export type PublishReadiness =
  { status: "passed"; detail: string } | ReadinessFailure;

const firstPublish = (detail: string): ReadinessFailure => ({
  status: "failed",
  reason: "first-publish",
  detail: `FIRST PUBLISH: ${detail}; configure or refresh Settings → Trusted publishing on npmjs.com for stella/stella, workflow publish-npm.yml, environment release-app, allowing npm publish; publish within 48 h of creating it.`,
});

const unreadable = (detail: string): ReadinessFailure => ({
  status: "failed",
  reason: "unreadable",
  detail,
});

type AssessPublishReadinessOptions = {
  name: string;
  packument: unknown;
  attestations: unknown;
};

// Decode untrusted registry data at its boundary, keeping the decision total.
const decodeStatement = (payload: string): unknown => {
  try {
    return JSON.parse(Buffer.from(payload, "base64").toString("utf-8"));
  } catch {
    return undefined;
  }
};

type AssessProvenanceOptions = {
  entry: unknown;
  name: string;
  latest: string;
  manifest: Record<string, unknown>;
};

const assessProvenance = ({
  entry,
  name,
  latest,
  manifest,
}: AssessProvenanceOptions): ReadinessFailure | undefined => {
  if (
    !record(entry) ||
    !record(entry["bundle"]) ||
    !record(entry["bundle"]["dsseEnvelope"])
  ) {
    return unreadable("invalid SLSA bundle");
  }
  const envelope = entry["bundle"]["dsseEnvelope"];
  if (typeof envelope["payload"] !== "string") {
    return unreadable("missing SLSA payload");
  }
  const statement = decodeStatement(envelope["payload"]);
  if (
    !record(statement) ||
    statement["predicateType"] !== SLSA ||
    !Array.isArray(statement["subject"])
  ) {
    return unreadable("invalid SLSA statement");
  }
  const subjectName = `pkg:npm/${name.replace("@", "%40")}@${latest}`;
  const dist = manifest["dist"];
  if (
    !record(dist) ||
    typeof dist["integrity"] !== "string" ||
    !dist["integrity"].startsWith("sha512-")
  ) {
    return unreadable("missing npm tarball integrity");
  }
  const integrity = dist["integrity"].slice("sha512-".length);
  const bytes = Buffer.from(integrity, "base64");
  if (bytes.length !== 64 || bytes.toString("base64") !== integrity) {
    return unreadable("invalid npm tarball integrity");
  }
  const digest = bytes.toString("hex");
  if (
    !statement["subject"].some(
      (subject: unknown) =>
        record(subject) &&
        subject["name"] === subjectName &&
        record(subject["digest"]) &&
        subject["digest"]["sha512"] === digest,
    )
  ) {
    return unreadable("provenance does not identify the latest tarball");
  }
  const predicate = statement["predicate"];
  const definition = record(predicate)
    ? predicate["buildDefinition"]
    : undefined;
  const parameters = record(definition)
    ? definition["externalParameters"]
    : undefined;
  const workflow = record(parameters) ? parameters["workflow"] : undefined;
  if (!record(workflow)) {
    return unreadable("provenance has no workflow identity");
  }
  if (workflow["repository"] !== REPOSITORY || workflow["path"] !== WORKFLOW) {
    return {
      status: "failed",
      reason: "mismatch",
      detail: `MISMATCH: ${latest} provenance must name ${REPOSITORY} and ${WORKFLOW}; inspect Settings → Trusted publishing on npmjs.com (environment release-app).`,
    };
  }
  return undefined;
};

/** Public registry responses only; no token and no publish operation. */
export const assessPublishReadiness = ({
  name,
  packument,
  attestations,
}: AssessPublishReadinessOptions): PublishReadiness => {
  if (packument === null) {
    return firstPublish("package does not exist on npm");
  }
  if (
    !record(packument) ||
    !record(packument["versions"]) ||
    !record(packument["dist-tags"])
  ) {
    return unreadable("invalid npm packument");
  }
  const versions = packument["versions"];
  const published = Object.keys(versions);
  if (published.every((version) => version.includes("-placeholder."))) {
    return firstPublish("only placeholder versions exist on npm");
  }
  const latest = packument["dist-tags"]["latest"];
  if (typeof latest !== "string" || !record(versions[latest])) {
    return unreadable("npm latest does not identify a published version");
  }
  const manifest = versions[latest];
  if (manifest["name"] !== name || manifest["version"] !== latest) {
    return unreadable(
      "npm latest manifest does not match the package and version",
    );
  }
  if (attestations === null) {
    return firstPublish(`${latest} has no provenance`);
  }
  if (!record(attestations) || !Array.isArray(attestations["attestations"])) {
    return unreadable("invalid npm attestation response");
  }
  const provenance = attestations["attestations"].filter(
    (entry: unknown) => record(entry) && entry["predicateType"] === SLSA,
  );
  if (provenance.length === 0) {
    return firstPublish(`${latest} has no SLSA provenance`);
  }
  for (const entry of provenance) {
    const problem = assessProvenance({ entry, name, latest, manifest });
    if (problem) {
      return problem;
    }
  }
  return {
    status: "passed",
    detail: `${latest}: latest provenance names stella/stella publish-npm.yml; current trust settings are not observable anonymously`,
  };
};

type ReadinessReadOptions = { name: string; fetchImpl?: RegistryFetch };

export const checkPublishReadiness = async ({
  name,
  fetchImpl = fetch,
}: ReadinessReadOptions): Promise<PublishReadiness> => {
  // Network and JSON decoding form the external boundary. Never print response
  // bodies or ambient credentials in the release report.
  try {
    const signal = AbortSignal.timeout(15_000);
    const response = await fetchImpl(
      `${REGISTRY}/${encodeURIComponent(name)}`,
      { signal },
    );
    if (response.status === 404) {
      return assessPublishReadiness({
        name,
        packument: null,
        attestations: null,
      });
    }
    if (!response.ok) {
      return unreadable(`npm packument HTTP ${response.status}`);
    }
    const packument: unknown = await response.json();
    const tags = record(packument) ? packument["dist-tags"] : undefined;
    const latest = record(tags) ? tags["latest"] : undefined;
    if (typeof latest !== "string") {
      return assessPublishReadiness({ name, packument, attestations: null });
    }
    const attestationResponse = await fetchImpl(
      `${REGISTRY}/-/npm/v1/attestations/${encodeURIComponent(name)}@${encodeURIComponent(latest)}`,
      { signal },
    );
    if (attestationResponse.status !== 404 && !attestationResponse.ok) {
      return unreadable(`npm attestations HTTP ${attestationResponse.status}`);
    }
    return assessPublishReadiness({
      name,
      packument,
      attestations:
        attestationResponse.status === 404
          ? null
          : await attestationResponse.json(),
    });
  } catch {
    return unreadable("npm readiness read failed or returned malformed JSON");
  }
};

if (import.meta.main) {
  try {
    const root = path.resolve(import.meta.dirname, "..");
    const packages = readPublishablePackages({
      readManifest: (directory) =>
        readFileSync(
          path.join(root, "packages", directory, "package.json"),
          "utf-8",
        ),
    });
    let failures = 0;
    for (const { name } of packages) {
      const result = await checkPublishReadiness({ name });
      console.log(`${name}: ${result.status}: ${result.detail}`);
      if (result.status === "failed") {
        failures += 1;
      }
    }
    console.log(
      `npm-publish-readiness: ${failures} of ${packages.length} packages failed the anonymous census`,
    );
    process.exitCode = failures === 0 ? 0 : 1;
  } catch {
    console.error(
      "npm-publish-readiness: cannot read publishable package manifests",
    );
    process.exitCode = 2;
  }
}
