import { panic } from "better-result";

import type { ExternalContractEntry, PinSource } from "./types";

export const pinSourceKey = (source: PinSource): string => {
  switch (source.type) {
    case "manifest":
      return `${source.file}#${source.section}.${source.package}`;
    case "image":
    case "constant":
      return `${source.file}#${source.name}`;
    default:
      source satisfies never;
      return panic("Unhandled external pin source");
  }
};

type TotalityOptions = {
  readonly registry: Readonly<Record<string, ExternalContractEntry>>;
  readonly owners: readonly string[];
  readonly sdks: readonly string[];
};

export const findTotalityProblems = ({
  registry,
  owners,
  sdks,
}: TotalityOptions): string[] => {
  const problems: string[] = [];
  for (const [label, required, field] of [
    ["owner", owners, "owners"],
    ["SDK", sdks, "sdks"],
  ] as const) {
    for (const member of required) {
      const matches = Object.entries(registry).filter(([, entry]) =>
        field === "owners"
          ? entry.owners.some(
              (owner) => owner.role === "primary" && owner.path === member,
            )
          : entry.sdks.includes(member),
      );
      if (matches.length === 1) {
        continue;
      }
      problems.push(
        `${label} ${member} maps to ${matches.length} external contracts; register it in exactly one EXTERNAL_CONTRACTS entry with coverage or an uncharacterised reason.`,
      );
    }
  }
  for (const [id, entry] of Object.entries(registry)) {
    for (const owner of entry.owners) {
      if (owner.role !== "shared") {
        continue;
      }
      const matches = Object.values(registry).filter((candidate) =>
        candidate.owners.some(
          (primary) =>
            primary.path === owner.path && primary.role === "primary",
        ),
      );
      if (matches.length !== 1) {
        problems.push(
          `${id}: shared owner ${owner.path} requires exactly one primary contract.`,
        );
      }
    }
    if (entry.status === "uncharacterised" && entry.reason.trim() === "") {
      problems.push(`${id}: uncharacterised contracts require a reason.`);
    }
  }
  return problems;
};

type VersionDriftOptions = {
  readonly system: string;
  readonly fixture: string;
  readonly current: Readonly<Record<string, string>>;
  readonly characterisedAt: Readonly<Record<string, string>>;
  readonly driftReasons?: Readonly<Record<string, string>>;
};

export const findVersionDrift = ({
  system,
  fixture,
  current,
  characterisedAt,
  driftReasons,
}: VersionDriftOptions): string[] => {
  const problems: string[] = [];
  for (const [source, version] of Object.entries(current)) {
    if (characterisedAt[source] === version) {
      continue;
    }
    problems.push(
      `${fixture}: re-characterise ${system} at ${version} (${source}; fixture pin ${characterisedAt[source] ?? "missing"}).${driftReasons === undefined ? "" : ` Allowance not applied: ${driftReasons[source] ?? "pin has no dated allowance"}.`}`,
    );
  }
  for (const source of Object.keys(characterisedAt)) {
    if (Object.hasOwn(current, source)) {
      continue;
    }
    problems.push(
      `${fixture}: ${system} records an unused pin ${source}; update its fixture metadata.`,
    );
  }
  return problems;
};

export const findUncharacterisedGrowth = (
  current: readonly string[],
  baseline: readonly string[],
): string[] =>
  current
    .filter((id) => !baseline.includes(id))
    .map(
      (id) =>
        `${id}: uncharacterised contracts only shrink; add characterisation before enrolling a new system.`,
    );

type DependencyOptions = {
  readonly registry: Readonly<Record<string, ExternalContractEntry>>;
  readonly packages: readonly string[];
  readonly inProcess: Readonly<Record<string, string>>;
};

export const findDependencyProblems = ({
  registry,
  packages,
  inProcess,
}: DependencyOptions): string[] => {
  const problems: string[] = [];
  for (const name of packages) {
    const matches = Object.values(registry).filter((entry) =>
      entry.sdks.includes(name),
    ).length;
    if (matches + (Object.hasOwn(inProcess, name) ? 1 : 0) === 1) {
      continue;
    }
    problems.push(
      `Dependency ${name}: classify it as an external contract SDK or an in-process package in exactly one place.`,
    );
  }
  for (const [name, reason] of Object.entries(inProcess)) {
    if (!packages.includes(name)) {
      problems.push(
        `${name}: remove stale non-external dependency classification.`,
      );
    }
    if (reason.trim() === "") {
      problems.push(
        `${name}: non-external dependency classification requires a reason.`,
      );
    }
  }
  return problems;
};
