#!/usr/bin/env bun

import { existsSync, readFileSync, readdirSync } from "node:fs";
import nodePath from "node:path";

const DEFAULT_MANIFEST_PATH = "docs/policies/evidence.json";
const POLICY_MARKER_PATTERN =
  /<!--\s*evidence:\s*(?<controlId>[a-z0-9-]+)\s*-->/gu;

type EvidenceFile = {
  path: string;
  contains: string[];
};

type PolicyControl = {
  id: string;
  policy: string;
  evidence: EvidenceFile[];
};

type PolicyEvidenceManifest = {
  version: 1;
  controls: PolicyControl[];
};

export type PolicyEvidenceCheckResult = {
  errors: string[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isRepositoryPath = (value: string): boolean =>
  !value.startsWith("/") &&
  !value.includes("\\") &&
  value
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");

const readStringArray = (
  value: unknown,
  field: string,
  errors: string[],
): string[] => {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    errors.push(`${field} must be a non-empty array of non-empty strings`);
    return [];
  }
  return value;
};

const parseManifest = (
  raw: unknown,
): { errors: string[]; manifest: PolicyEvidenceManifest | null } => {
  const errors: string[] = [];
  if (!isRecord(raw) || raw["version"] !== 1) {
    return {
      errors: ["policy evidence manifest must be an object with version 1"],
      manifest: null,
    };
  }

  const rawControls = raw["controls"];
  if (!Array.isArray(rawControls) || rawControls.length === 0) {
    return {
      errors: ["policy evidence manifest must contain at least one control"],
      manifest: null,
    };
  }

  const controls: PolicyControl[] = [];
  for (const [controlIndex, rawControl] of rawControls.entries()) {
    const prefix = `controls[${controlIndex}]`;
    if (!isRecord(rawControl)) {
      errors.push(`${prefix} must be an object`);
      continue;
    }

    const id = rawControl["id"];
    const policy = rawControl["policy"];
    const rawEvidence = rawControl["evidence"];
    if (typeof id !== "string" || !/^[a-z0-9-]+$/u.test(id)) {
      errors.push(`${prefix}.id must use lowercase kebab-case`);
      continue;
    }
    if (
      typeof policy !== "string" ||
      !isRepositoryPath(policy) ||
      !policy.startsWith("docs/policies/") ||
      !policy.endsWith(".md")
    ) {
      errors.push(`${prefix}.policy must point to docs/policies/*.md`);
      continue;
    }
    if (!Array.isArray(rawEvidence) || rawEvidence.length === 0) {
      errors.push(`${prefix}.evidence must contain at least one file`);
      continue;
    }

    const evidence: EvidenceFile[] = [];
    for (const [evidenceIndex, rawFile] of rawEvidence.entries()) {
      const evidencePrefix = `${prefix}.evidence[${evidenceIndex}]`;
      if (!isRecord(rawFile)) {
        errors.push(`${evidencePrefix} must be an object`);
        continue;
      }
      const path = rawFile["path"];
      if (
        typeof path !== "string" ||
        path.length === 0 ||
        !isRepositoryPath(path)
      ) {
        errors.push(
          `${evidencePrefix}.path must be a repository-relative path`,
        );
        continue;
      }
      evidence.push({
        path,
        contains: readStringArray(
          rawFile["contains"],
          `${evidencePrefix}.contains`,
          errors,
        ),
      });
    }

    controls.push({ id, policy, evidence });
  }

  return {
    errors,
    manifest: errors.length === 0 ? { version: 1, controls } : null,
  };
};

const collectPolicyMarkers = (source: string): string[] =>
  [...source.matchAll(POLICY_MARKER_PATTERN)].map(
    ({ groups }) => groups?.["controlId"] ?? "",
  );

export const checkPolicyEvidence = ({
  manifestPath = DEFAULT_MANIFEST_PATH,
  rootDir,
}: {
  manifestPath?: string;
  rootDir: string;
}): PolicyEvidenceCheckResult => {
  const errors: string[] = [];
  const absoluteManifestPath = nodePath.resolve(rootDir, manifestPath);
  if (!existsSync(absoluteManifestPath)) {
    return { errors: [`missing policy evidence manifest: ${manifestPath}`] };
  }

  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(readFileSync(absoluteManifestPath, "utf-8"));
  } catch (error) {
    return {
      errors: [
        `could not parse ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }

  const parsed = parseManifest(rawManifest);
  if (!parsed.manifest) {
    return { errors: parsed.errors };
  }

  const ids = new Set<string>();
  const manifestMarkersByPolicy = new Map<string, Set<string>>();
  for (const control of parsed.manifest.controls) {
    if (ids.has(control.id)) {
      errors.push(`duplicate control id: ${control.id}`);
    }
    ids.add(control.id);

    const policyMarkers =
      manifestMarkersByPolicy.get(control.policy) ?? new Set();
    policyMarkers.add(control.id);
    manifestMarkersByPolicy.set(control.policy, policyMarkers);

    const policyPath = nodePath.resolve(rootDir, control.policy);
    if (!existsSync(policyPath)) {
      errors.push(`${control.id}: missing policy file ${control.policy}`);
      continue;
    }
    const policySource = readFileSync(policyPath, "utf-8");
    if (!collectPolicyMarkers(policySource).includes(control.id)) {
      errors.push(
        `${control.id}: ${control.policy} is missing <!-- evidence: ${control.id} -->`,
      );
    }

    for (const evidence of control.evidence) {
      const evidencePath = nodePath.resolve(rootDir, evidence.path);
      if (!existsSync(evidencePath)) {
        errors.push(`${control.id}: missing evidence file ${evidence.path}`);
        continue;
      }
      const source = readFileSync(evidencePath, "utf-8");
      for (const expected of evidence.contains) {
        if (!source.includes(expected)) {
          errors.push(
            `${control.id}: ${evidence.path} no longer contains ${JSON.stringify(expected)}`,
          );
        }
      }
    }
  }

  const policiesDir = nodePath.resolve(rootDir, "docs/policies");
  let policyFiles: string[];
  try {
    policyFiles = readdirSync(policiesDir)
      .filter((name) => name.endsWith(".md"))
      .map((name) => `docs/policies/${name}`)
      .sort();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { errors: [...errors, "missing docs/policies directory"] };
    }
    throw error;
  }
  for (const policy of policyFiles) {
    const source = readFileSync(nodePath.resolve(rootDir, policy), "utf-8");
    const markers = collectPolicyMarkers(source);
    if (markers.length === 0) {
      errors.push(`${policy} has no executable evidence marker`);
      continue;
    }
    for (const marker of markers) {
      if (!ids.has(marker)) {
        errors.push(`${policy} references unknown evidence control ${marker}`);
      }
      if (!manifestMarkersByPolicy.get(policy)?.has(marker)) {
        errors.push(
          `${marker}: manifest points at a different policy than ${policy}`,
        );
      }
    }
  }

  return { errors };
};

if (import.meta.main) {
  const result = checkPolicyEvidence({ rootDir: process.cwd() });
  if (result.errors.length > 0) {
    for (const error of result.errors) {
      console.error(`policy-evidence: ${error}`);
    }
    process.exit(1);
  }
  console.log(
    "policy-evidence: all controls match their implementation evidence",
  );
}
