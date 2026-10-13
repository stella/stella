import { panic } from "better-result";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import * as v from "valibot";

import { sha256Hex as hash } from "@stll/sha256/bun";

import {
  CAPTURED_FIXTURE_ROOTS,
  LEGACY_CAPTURES,
  PROVENANCE_SUFFIX,
} from "../apps/api/src/tests/fixture-provenance";
import { IN_PROCESS_DEPENDENCIES } from "../packages/external-contracts/src/dependency-dispositions";
import {
  findDependencyProblems,
  findTotalityProblems,
  findUncharacterisedGrowth,
  findVersionDrift,
  pinSourceKey,
} from "../packages/external-contracts/src/guard";
import { EXTERNAL_CONTRACTS } from "../packages/external-contracts/src/registry";
import type { ExternalSystemId } from "../packages/external-contracts/src/registry";
import type {
  ExternalContractEntry,
  FixtureSet,
  PinSource,
} from "../packages/external-contracts/src/types";
import { parseBunLockText } from "./bun-lock-text";
import { readFixtureEvidence } from "./external-contract-evidence";
import { readGitBaseline } from "./offline-git-read";
import {
  OUTBOUND_TRANSPORT_CENSUS,
  type OutboundTransportCensusEntry,
} from "./outbound-transport-census";
import { isOutboundTransportModule } from "./outbound-transport-ownership";
import { parseSource } from "./parse-memo";

const ROOT = path.resolve(import.meta.dir, "..");
const REGISTRY_PATH = "packages/external-contracts/src/registry.ts";
const DEPENDENCY_DISPOSITIONS_PATH =
  "packages/external-contracts/src/dependency-dispositions.ts";
const stringMapSchema = v.record(v.string(), v.string());
const objectSchema = v.record(v.string(), v.unknown());
const manifestSchema = v.object({
  catalog: v.optional(stringMapSchema, {}),
  dependencies: v.optional(stringMapSchema, {}),
  devDependencies: v.optional(stringMapSchema, {}),
  optionalDependencies: v.optional(stringMapSchema, {}),
  peerDependencies: v.optional(stringMapSchema, {}),
  resolutions: v.optional(stringMapSchema, {}),
  patchedDependencies: v.optional(stringMapSchema, {}),
});
const pinMetadataSchema = v.object({
  characterisedAt: stringMapSchema,
  coveredOwners: v.array(v.string()),
  coveredSdks: v.array(v.string()),
  fixtureSet: v.string(),
  provenance: v.variant("type", [
    v.object({ type: v.literal("sidecars"), format: v.string() }),
    v.object({
      type: v.literal("authored"),
      kind: v.picklist([
        "recorded",
        "synthetic-from-spec",
        "redacted-prod-shape",
      ]),
    }),
  ]),
});
const json = (root: string, file: string): unknown =>
  JSON.parse(readFileSync(path.join(root, file), "utf-8"));

const unwrap = (expression: ts.Expression): ts.Expression => {
  if (
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isParenthesizedExpression(expression)
  ) {
    return unwrap(expression.expression);
  }
  return expression;
};

const declaredInitializer = (
  file: string,
  text: string,
  name: string,
): ts.Expression => {
  const source = parseSource({ fileName: file, text });
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(declaration.name) ||
        declaration.name.text !== name ||
        declaration.initializer === undefined
      ) {
        continue;
      }
      return unwrap(declaration.initializer);
    }
  }
  return panic(
    `${file}: missing ${name}; update its external contract pin source.`,
  );
};

export const readPin = (root: string, source: PinSource): string => {
  switch (source.type) {
    case "manifest": {
      const manifest = v.parse(manifestSchema, json(root, source.file));
      return (
        manifest[source.section][source.package] ??
        panic(`${pinSourceKey(source)}: missing package pin.`)
      );
    }
    case "image": {
      const images = v.parse(
        v.array(v.object({ name: v.string(), source: v.string() })),
        json(root, source.file),
      );
      return (
        images.find(({ name }) => name === source.name)?.source ??
        panic(`${pinSourceKey(source)}: missing image pin.`)
      );
    }
    case "constant": {
      const initializer = declaredInitializer(
        source.file,
        readFileSync(path.join(root, source.file), "utf-8"),
        source.name,
      );
      if (!ts.isArrayLiteralExpression(initializer)) {
        return panic(`${pinSourceKey(source)} must be a literal string array.`);
      }
      return JSON.stringify(
        initializer.elements.map((element) =>
          ts.isStringLiteral(element)
            ? element.text
            : panic(`${pinSourceKey(source)} must be a literal string array.`),
        ),
      );
    }
    default:
      source satisfies never;
      return panic("Unhandled external pin source");
  }
};

/** The installed package a bun.lock key names: its last `parent/child` segment, where either side may be scoped. */
export const lockKeyPackageName = (key: string): string => {
  const segments = key.split("/");
  const last = segments.at(-1) ?? key;
  const scope = segments.at(-2);
  return scope?.startsWith("@") === true ? `${scope}/${last}` : last;
};

/** Include installed SDK versions and patches: a caret or patch edit can move code without moving its manifest range. */
export const readCurrentPins = (
  root: string,
  entry: ExternalContractEntry,
): Record<string, string> => {
  const current = Object.fromEntries(
    entry.pinSources.map((source) => [
      pinSourceKey(source),
      readPin(root, source),
    ]),
  );
  const lock = v.parse(
    v.object({ packages: objectSchema }),
    parseBunLockText(readFileSync(path.join(root, "bun.lock"), "utf-8")),
  );
  const manifest = v.parse(manifestSchema, json(root, "package.json"));
  for (const sdk of entry.sdks) {
    const instances = Object.entries(lock.packages).filter(
      ([key]) => lockKeyPackageName(key) === sdk,
    );
    if (instances.length === 0) {
      panic(`${sdk}: no installed SDK pin in bun.lock.`);
    }
    for (const [key, value] of instances) {
      const tuple = v.parse(v.array(v.unknown()), value);
      const version = v.parse(v.string(), tuple.at(0));
      current[`bun.lock#${key}`] = version;
    }
    for (const [key, file] of Object.entries(manifest.patchedDependencies)) {
      if (!key.startsWith(`${sdk}@`)) {
        continue;
      }
      current[`package.json#patchedDependencies.${key}`] = hash(
        readFileSync(path.join(root, file)),
      );
    }
  }
  return current;
};

export const readDirectDependencies = (root: string): string[] => {
  const dependencies = new Set<string>();
  const manifests = ["package.json"];
  for (const parent of ["apps", "packages"]) {
    for (const child of readdirSync(path.join(root, parent), {
      withFileTypes: true,
    })) {
      if (!child.isDirectory()) {
        continue;
      }
      const file = `${parent}/${child.name}/package.json`;
      if (existsSync(path.join(root, file))) {
        manifests.push(file);
      }
    }
  }
  for (const file of manifests) {
    const manifest = v.parse(manifestSchema, json(root, file));
    for (const name of [
      ...Object.keys(manifest.catalog),
      ...Object.keys(manifest.dependencies),
      ...Object.keys(manifest.devDependencies),
      ...Object.keys(manifest.optionalDependencies),
      ...Object.keys(manifest.peerDependencies),
    ]) {
      dependencies.add(name);
    }
  }
  return [...dependencies];
};

export const readExternalSdks = (root: string): string[] =>
  readDirectDependencies(root).filter(
    (name) => !Object.hasOwn(IN_PROCESS_DEPENDENCIES, name),
  );

const filesBelow = (root: string, relative: string): string[] => {
  const files: string[] = [];
  for (const child of readdirSync(path.join(root, relative), {
    withFileTypes: true,
  })) {
    const file = `${relative}/${child.name}`;
    if (child.isDirectory()) {
      files.push(...filesBelow(root, file));
    } else if (child.isFile()) {
      files.push(file);
    }
  }
  return files;
};

const providerSchemaSourceSchema = v.object({
  source: v.object({
    url: v.string(),
    retrievedAt: v.string(),
    sha256: v.string(),
  }),
  characterisedAt: stringMapSchema,
  coveredOwners: v.array(v.string()),
  coveredSdks: v.array(v.string()),
});
const wireSourceSchema = v.object({
  source: v.picklist(["recorded", "synthetic"]),
  basis: v.optional(v.string()),
  recordedAt: v.optional(v.string()),
});
const provenanceSchema = v.variant("capture", [
  v.object({
    capture: v.literal("recorded"),
    sha256: v.string(),
    sourceUrl: v.string(),
    capturedAt: v.string(),
  }),
  v.object({
    capture: v.literal("legacy"),
    sha256: v.string(),
    note: v.string(),
  }),
]);

const readFixtureReceipts = (root: string, fixture: FixtureSet) => {
  const metadata =
    "metadata" in fixture
      ? v.parse(pinMetadataSchema, json(root, fixture.metadata))
      : undefined;
  const files =
    fixture.provenance.type === "authored"
      ? []
      : filesBelow(root, fixture.path);
  const schemas =
    fixture.provenance.type === "sidecars" &&
    fixture.provenance.format === "provider-request-schemas"
      ? files
          .filter((file) => file.endsWith(".source.json"))
          .map((file) => ({
            file,
            receipt: v.parse(providerSchemaSourceSchema, json(root, file)),
          }))
      : [];
  return { metadata, files, schemas };
};

type FixtureCheckOptions = {
  root: string;
  system: string;
  fixture: FixtureSet;
  current: Readonly<Record<string, string>>;
  owners: readonly string[];
  sdks: readonly string[];
};
const checkFixture = ({
  root,
  system,
  fixture,
  current,
  owners,
  sdks,
}: FixtureCheckOptions) => {
  const problems: string[] = [];
  const coveredOwners = new Set<string>();
  const coveredSdks = new Set<string>();
  const result = { problems, coveredOwners, coveredSdks };
  if (!existsSync(path.join(root, fixture.path))) {
    problems.push(`${system}: missing fixture set ${fixture.path}.`);
    return result;
  }
  const { metadata, files, schemas } = readFixtureReceipts(root, fixture);
  const receipts = schemas.map(({ receipt }) => ({
    coveredOwners: receipt.coveredOwners,
    coveredSdks: receipt.coveredSdks,
  }));
  if (metadata !== undefined) {
    receipts.push(metadata);
  }
  const evidence = readFixtureEvidence({
    root,
    replayFiles: fixture.replayFiles,
    sdkNames: sdks,
    claims: {
      owners: receipts.flatMap((receipt) => receipt.coveredOwners),
      sdks: receipts.flatMap((receipt) => receipt.coveredSdks),
    },
  });
  problems.push(
    ...evidence.problems.map(
      (problem) => `${system}: ${fixture.path}: ${problem}`,
    ),
  );
  const recordReceipt = ({
    file,
    receipt,
  }: {
    file: string;
    receipt: {
      coveredOwners: readonly string[];
      coveredSdks: readonly string[];
    };
  }) => {
    for (const [kind, claims, declared, reachable, covered] of [
      ["owner", receipt.coveredOwners, owners, evidence.owners, coveredOwners],
      ["SDK", receipt.coveredSdks, sdks, evidence.sdks, coveredSdks],
    ] as const) {
      const seen = new Set<string>();
      for (const claim of claims) {
        if (seen.has(claim)) {
          problems.push(`${file}: duplicate ${kind} claim ${claim}.`);
          continue;
        }
        seen.add(claim);
        if (!declared.includes(claim)) {
          problems.push(
            `${file}: ${kind} claim ${claim} does not belong to ${system}.`,
          );
          continue;
        }
        if (!reachable.has(claim)) {
          problems.push(
            `${file}: ${kind} claim ${claim} is not runtime-reachable from its replay files; re-characterise ${system}.`,
          );
          continue;
        }
        covered.add(claim);
      }
    }
  };
  if ("metadata" in fixture && metadata !== undefined) {
    recordReceipt({ file: fixture.metadata, receipt: metadata });
    if (
      metadata.fixtureSet !== fixture.path ||
      JSON.stringify(metadata.provenance) !== JSON.stringify(fixture.provenance)
    ) {
      problems.push(
        `${fixture.metadata}: fixture set and provenance must match the external contract entry.`,
      );
    }
    problems.push(
      ...findVersionDrift({
        system,
        fixture: fixture.path,
        current,
        characterisedAt: metadata.characterisedAt,
      }),
    );
  }
  if (fixture.provenance.type === "authored") {
    return result;
  }
  switch (fixture.provenance.format) {
    case "provider-wire": {
      const cassettes = files.filter((file) => file.endsWith(".json"));
      if (cassettes.length === 0) {
        problems.push(`${system}: no provider wire cassettes.`);
      }
      for (const file of cassettes) {
        const provenance = v.parse(wireSourceSchema, json(root, file));
        if (provenance.source === "recorded" && !provenance.recordedAt) {
          problems.push(`${file}: recorded provenance needs recordedAt.`);
        }
        if (provenance.source === "synthetic" && !provenance.basis) {
          problems.push(`${file}: synthetic-from-spec provenance needs basis.`);
        }
      }
      return result;
    }
    case "provider-request-schemas": {
      if (schemas.length === 0) {
        problems.push(`${system}: no request schema sidecars.`);
      }
      for (const { file, receipt: provenance } of schemas) {
        recordReceipt({ file, receipt: provenance });
        problems.push(
          ...findVersionDrift({
            system,
            fixture: file,
            current,
            characterisedAt: provenance.characterisedAt,
          }),
        );
        if (
          !existsSync(
            path.join(root, file.replace(/\.source\.json$/u, ".schema.json")),
          )
        ) {
          problems.push(`${file}: missing request schema.`);
        }
      }
      return result;
    }
    case "fixture-provenance": {
      const sidecars = files.filter((file) => file.endsWith(PROVENANCE_SUFFIX));
      if (sidecars.length === 0) {
        problems.push(`${system}: no captured fixture provenance.`);
      }
      for (const file of sidecars) {
        const provenance = v.parse(provenanceSchema, json(root, file));
        const payload = file.slice(0, -PROVENANCE_SUFFIX.length);
        if (
          hash(readFileSync(path.join(root, payload))) !== provenance.sha256
        ) {
          problems.push(
            `${file}: recapture ${system}; fixture bytes differ from provenance pin.`,
          );
        }
        if (
          provenance.capture === "legacy" &&
          !LEGACY_CAPTURES.some((legacy) => payload === `apps/api/${legacy}`)
        ) {
          problems.push(`${file}: new legacy provenance is not admitted.`);
        }
      }
      return result;
    }
    default:
      fixture.provenance satisfies never;
      return panic("Unhandled external fixture provenance");
  }
};

export const uncharacterisedFromSource = (text: string): string[] => {
  const registry = declaredInitializer(
    REGISTRY_PATH,
    text,
    "EXTERNAL_CONTRACTS",
  );
  if (!ts.isObjectLiteralExpression(registry)) {
    return panic("External registry must be a closed object literal.");
  }
  return registry.properties.flatMap((property) => {
    if (
      !ts.isPropertyAssignment(property) ||
      !(ts.isStringLiteral(property.name) || ts.isIdentifier(property.name)) ||
      !ts.isObjectLiteralExpression(property.initializer)
    ) {
      return panic("External registry entries must be literal properties.");
    }
    const status = property.initializer.properties.find(
      (member) =>
        ts.isPropertyAssignment(member) &&
        (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) &&
        member.name.text === "status",
    );
    if (
      status === undefined ||
      !ts.isPropertyAssignment(status) ||
      !ts.isStringLiteral(status.initializer)
    ) {
      return panic(`${property.name.text}: missing literal contract status.`);
    }
    return status.initializer.text === "uncharacterised"
      ? [property.name.text]
      : [];
  });
};

const literalMember = (object: ts.ObjectLiteralExpression, name: string) => {
  for (const member of object.properties) {
    if (
      ts.isPropertyAssignment(member) &&
      (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) &&
      member.name.text === name
    ) {
      return unwrap(member.initializer);
    }
  }
  return panic(`External classification source: missing literal ${name}.`);
};

export const inProcessFromSource = (text: string): string[] => {
  const ledger = declaredInitializer(
    DEPENDENCY_DISPOSITIONS_PATH,
    text,
    "IN_PROCESS_DEPENDENCIES",
  );
  if (!ts.isObjectLiteralExpression(ledger)) {
    return panic("In-process dependencies must be a closed object literal.");
  }
  return ledger.properties.map((property) => {
    if (
      !ts.isPropertyAssignment(property) ||
      !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
    ) {
      return panic("In-process dependency keys must be literal properties.");
    }
    return property.name.text;
  });
};

const uncoveredScope = (entry: ts.ObjectLiteralExpression, status: string) => {
  if (status === "uncharacterised") {
    return entry;
  }
  if (status !== "characterised") {
    return panic(`External classification source: unknown status ${status}.`);
  }
  // Older characterised snapshots have no partial scope and therefore no uncovered keys.
  const scopeProperty = entry.properties.find(
    (member) =>
      ts.isPropertyAssignment(member) &&
      (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) &&
      member.name.text === "uncharacterisedScope",
  );
  if (scopeProperty === undefined) {
    return undefined;
  }
  const scope = literalMember(entry, "uncharacterisedScope");
  if (!ts.isObjectLiteralExpression(scope)) {
    return panic("External uncharacterised scope must be literal.");
  }
  return scope;
};

type UncoveredKeyOptions = {
  entry: ts.Expression;
  kind: "owners" | "sdks";
  field: "path" | "package";
  status: string;
};

const uncoveredKey = ({ entry, kind, field, status }: UncoveredKeyOptions) => {
  if (status === "uncharacterised" && kind === "sdks") {
    if (!ts.isStringLiteral(entry)) {
      return panic("Whole uncharacterised SDK keys must be literal strings.");
    }
    return entry.text;
  }
  if (!ts.isObjectLiteralExpression(entry)) {
    return panic(`Uncharacterised ${kind} entries must be literal objects.`);
  }
  const key = literalMember(entry, field);
  if (!ts.isStringLiteral(key)) {
    return panic(`Uncharacterised ${kind} keys must be literal strings.`);
  }
  return key.text;
};

export const uncharacterisedScopeFromSource = (text: string): string[] => {
  const registry = declaredInitializer(
    REGISTRY_PATH,
    text,
    "EXTERNAL_CONTRACTS",
  );
  if (!ts.isObjectLiteralExpression(registry)) {
    return panic("External registry must be a closed object literal.");
  }
  const keys: string[] = [];
  for (const property of registry.properties) {
    if (
      !ts.isPropertyAssignment(property) ||
      !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ||
      !ts.isObjectLiteralExpression(property.initializer)
    ) {
      return panic("External registry entries must be literal properties.");
    }
    const status = literalMember(property.initializer, "status");
    if (!ts.isStringLiteral(status)) {
      return panic(`${property.name.text}: missing literal contract status.`);
    }
    const scope = uncoveredScope(property.initializer, status.text);
    if (scope === undefined) {
      continue;
    }
    for (const [kind, field] of [
      ["owners", "path"],
      ["sdks", "package"],
    ] as const) {
      const entries = literalMember(scope, kind);
      if (!ts.isArrayLiteralExpression(entries)) {
        return panic(
          `${property.name.text}: uncharacterised ${kind} must be a literal array.`,
        );
      }
      for (const entry of entries.elements) {
        const key = uncoveredKey({ entry, kind, field, status: status.text });
        keys.push(`${property.name.text}#${kind}:${key}`);
      }
    }
  }
  return keys;
};

type ShrinkOnlyGrowthOptions = {
  current: readonly string[];
  baseline: readonly string[];
  label: string;
};

export const findShrinkOnlyGrowth = ({
  current,
  baseline,
  label,
}: ShrinkOnlyGrowthOptions): string[] => {
  const admitted = new Set(baseline);
  return current
    .filter((key) => !admitted.has(key))
    .map(
      (key) =>
        `${label} ${key}: classification keys only shrink; add runtime characterisation instead of expanding the exemption.`,
    );
};

type ScopePartitionOptions = {
  system: string;
  kind: "owner" | "SDK";
  declared: readonly string[];
  covered: ReadonlySet<string>;
  uncharacterised: readonly { key: string; reason: string }[];
};

const checkScopePartition = ({
  system,
  kind,
  declared,
  covered,
  uncharacterised,
}: ScopePartitionOptions) => {
  const problems: string[] = [];
  const uncovered = new Set<string>();
  for (const { key, reason } of uncharacterised) {
    if (uncovered.has(key)) {
      problems.push(`${system}: duplicate uncharacterised ${kind} ${key}.`);
    }
    uncovered.add(key);
    if (!declared.includes(key)) {
      problems.push(
        `${system}: uncharacterised ${kind} ${key} does not belong to its entry.`,
      );
    }
    if (reason.trim() === "") {
      problems.push(
        `${system}: uncharacterised ${kind} ${key} requires a reason.`,
      );
    }
    if (covered.has(key)) {
      problems.push(
        `${system}: ${kind} ${key} is both characterised and uncharacterised.`,
      );
    }
  }
  for (const key of declared) {
    if (!covered.has(key) && !uncovered.has(key)) {
      problems.push(
        `${system}: re-characterise ${system}; ${kind} ${key} has no reachable fixture receipt or uncharacterised scope disposition.`,
      );
    }
  }
  return problems;
};

type DependencyCatalogOptions = {
  registry?: Readonly<Record<ExternalSystemId, ExternalContractEntry>>;
  dependencies: readonly string[];
  inProcess?: Readonly<Record<string, string>>;
  census?: readonly OutboundTransportCensusEntry[];
  sdks?: readonly string[];
};

export const findDependencyCatalogProblems = ({
  registry = EXTERNAL_CONTRACTS,
  dependencies,
  inProcess = IN_PROCESS_DEPENDENCIES,
  census = OUTBOUND_TRANSPORT_CENSUS,
  sdks = dependencies.filter((name) => !Object.hasOwn(inProcess, name)),
}: DependencyCatalogOptions): string[] => {
  const catalogProblems = findDependencyProblems({
    registry,
    packages: dependencies,
    inProcess,
  });
  for (const name of Object.keys(inProcess)) {
    if (!name.startsWith("@stll/") && isOutboundTransportModule(name)) {
      catalogProblems.push(
        `Dependency ${name}: a transport SDK cannot be classified as in-process.`,
      );
    }
  }
  const problems = findTotalityProblems({
    registry,
    owners: census.map(({ path: owner }) => owner),
    sdks,
  });
  problems.push(...catalogProblems);
  return problems;
};

type ExternalContractCheckOptions = {
  registry?: Readonly<Record<ExternalSystemId, ExternalContractEntry>>;
  dependencies?: readonly string[];
  inProcess?: Readonly<Record<string, string>>;
  census?: readonly OutboundTransportCensusEntry[];
  sdks?: readonly string[];
};

export const checkExternalContracts = (
  root: string,
  {
    registry = EXTERNAL_CONTRACTS,
    dependencies = readDirectDependencies(root),
    inProcess = IN_PROCESS_DEPENDENCIES,
    census = OUTBOUND_TRANSPORT_CENSUS,
    sdks = dependencies.filter((name) => !Object.hasOwn(inProcess, name)),
  }: ExternalContractCheckOptions = {},
): string[] => {
  const problems = findDependencyCatalogProblems({
    registry,
    dependencies,
    inProcess,
    census,
    sdks,
  });
  for (const [system, entry] of Object.entries(registry)) {
    for (const owner of entry.owners) {
      if (!existsSync(path.join(root, owner.path))) {
        problems.push(`${system}: missing owner ${owner.path}.`);
      }
    }
    const current = readCurrentPins(root, entry);
    if (entry.status === "uncharacterised") {
      continue;
    }
    const coveredOwners = new Set<string>();
    const coveredSdks = new Set<string>();
    for (const fixture of entry.fixtures) {
      const checked = checkFixture({
        root,
        system,
        fixture,
        current,
        owners: entry.owners.map(({ path: ownerPath }) => ownerPath),
        sdks: entry.sdks,
      });
      problems.push(...checked.problems);
      for (const owner of checked.coveredOwners) {
        coveredOwners.add(owner);
      }
      for (const sdk of checked.coveredSdks) {
        coveredSdks.add(sdk);
      }
    }
    problems.push(
      ...checkScopePartition({
        system,
        kind: "owner",
        declared: entry.owners.map(({ path: ownerPath }) => ownerPath),
        covered: coveredOwners,
        uncharacterised: entry.uncharacterisedScope.owners.map(
          ({ path: ownerPath, reason }) => ({ key: ownerPath, reason }),
        ),
      }),
    );
    problems.push(
      ...checkScopePartition({
        system,
        kind: "SDK",
        declared: entry.sdks,
        covered: coveredSdks,
        uncharacterised: entry.uncharacterisedScope.sdks.map(
          ({ package: name, reason }) => ({ key: name, reason }),
        ),
      }),
    );
  }
  const publisher = registry["legal-publishers"];
  if (publisher.status === "uncharacterised") {
    problems.push("The legal-publishers contract must be characterised.");
    return problems;
  }
  for (const fixtureRoot of CAPTURED_FIXTURE_ROOTS) {
    if (
      !publisher.fixtures.some(
        ({ path: fixturePath }) => fixturePath === `apps/api/${fixtureRoot}`,
      )
    ) {
      problems.push(
        `${fixtureRoot}: register the captured publisher fixture root.`,
      );
    }
  }
  return problems;
};

if (import.meta.main) {
  const base = process.env["CHECK_BASE_REF"] ?? "origin/main";
  const problems = checkExternalContracts(ROOT);
  for (const file of [REGISTRY_PATH]) {
    const baseline = readGitBaseline({ root: ROOT, base, file });
    // The initial enrollment establishes the set; later changes may only shrink it.
    if (baseline === undefined) {
      continue;
    }
    const currentSource = readFileSync(path.join(ROOT, file), "utf-8");
    problems.push(
      ...findUncharacterisedGrowth(
        uncharacterisedFromSource(currentSource),
        uncharacterisedFromSource(baseline),
      ),
    );
    problems.push(
      ...findShrinkOnlyGrowth({
        current: uncharacterisedScopeFromSource(currentSource),
        baseline: uncharacterisedScopeFromSource(baseline),
        label: "Uncharacterised scope",
      }),
    );
  }
  if (problems.length !== 0) {
    console.error(problems.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(
      "External service contract totality and version drift: OK (offline).",
    );
  }
}
