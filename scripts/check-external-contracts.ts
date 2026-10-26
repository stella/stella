import { panic } from "better-result";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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
import {
  createLocalRuntimeClosureReader,
  readFixtureEvidence,
  runtimeModuleReferences,
  type RuntimeSnapshotReader,
} from "./external-contract-evidence";
import {
  EXTERNAL_CONTRACT_PIN_ALLOWANCES_PATH,
  readExternalContractPinAllowances,
} from "./external-contract-pin-allowances";
import {
  createGitBaselineReader,
  readGitWorkingTreeBlobIds,
} from "./offline-git-read";
import {
  OUTBOUND_TRANSPORT_CENSUS,
  type OutboundTransportCensusEntry,
} from "./outbound-transport-census";
import { isOutboundTransportModule } from "./outbound-transport-ownership";
import { parseSource } from "./parse-memo";

export const REMOVED_PIN = "<removed>";

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

/** Every declared file whose baseline contents can contribute a contract pin. */
export const baselinePinSourceFiles = (
  registry: Readonly<
    Record<string, ExternalContractEntry>
  > = EXTERNAL_CONTRACTS,
): string[] =>
  [
    "bun.lock",
    "package.json",
    ...Object.values(registry).flatMap(({ pinSources }) =>
      pinSources.map(({ file }) => file),
    ),
  ].filter((file, index, files) => files.indexOf(file) === index);
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

type DeclaredInitializerOptions = { file: string; text: string; name: string };
const findDeclaredInitializer = ({
  file,
  text,
  name,
}: DeclaredInitializerOptions): ts.Expression | undefined => {
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
  return undefined;
};

const declaredInitializer = (
  file: string,
  text: string,
  name: string,
): ts.Expression =>
  findDeclaredInitializer({ file, text, name }) ??
  panic(`${file}: missing ${name}; update its external contract pin source.`);

const readPinFromFiles = (
  source: PinSource,
  read: (file: string) => string | undefined,
): string | undefined => {
  const text = read(source.file);
  if (text === undefined) {
    return undefined;
  }
  switch (source.type) {
    case "manifest": {
      const manifest = v.parse(manifestSchema, JSON.parse(text));
      return manifest[source.section][source.package];
    }
    case "image": {
      const images = v.parse(
        v.array(v.object({ name: v.string(), source: v.string() })),
        JSON.parse(text),
      );
      return images.find(({ name }) => name === source.name)?.source;
    }
    case "constant": {
      const initializer = findDeclaredInitializer({
        file: source.file,
        text,
        name: source.name,
      });
      if (initializer === undefined) {
        return undefined;
      }
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

export const readPin = (root: string, source: PinSource): string =>
  readPinFromFiles(source, (file) =>
    readFileSync(path.join(root, file), "utf-8"),
  ) ?? panic(`${pinSourceKey(source)}: missing pin.`);

/** The installed package a bun.lock key names: its last `parent/child` segment, where either side may be scoped. */
export const lockKeyPackageName = (key: string): string => {
  const segments = key.split("/");
  const last = segments.at(-1) ?? key;
  const scope = segments.at(-2);
  return scope?.startsWith("@") === true ? `${scope}/${last}` : last;
};

/** Include installed SDK versions and patches: a caret or patch edit can move code without moving its manifest range. */
type ReadPinsFromFilesOptions = {
  entry: ExternalContractEntry;
  read: (file: string) => string | undefined;
  snapshot: "current" | "baseline";
};

const readPinsFromFiles = ({
  entry,
  read,
  snapshot,
}: ReadPinsFromFilesOptions): Record<string, string> => {
  const pins = new Map<string, string>();
  for (const source of entry.pinSources) {
    const value = readPinFromFiles(source, read);
    if (value === undefined) {
      if (snapshot === "current") {
        panic(`${pinSourceKey(source)}: missing pin.`);
      }
      continue;
    }
    pins.set(pinSourceKey(source), value);
  }
  const lockText = read("bun.lock");
  const manifestText = read("package.json");
  if (
    snapshot === "current" &&
    (lockText === undefined || manifestText === undefined)
  ) {
    panic("Missing current external contract pin manifest or lockfile.");
  }
  const lock = v.parse(
    v.object({ packages: objectSchema }),
    lockText === undefined ? { packages: {} } : parseBunLockText(lockText),
  );
  const manifest = v.parse(
    manifestSchema,
    manifestText === undefined ? {} : JSON.parse(manifestText),
  );
  for (const sdk of entry.sdks) {
    const instances = Object.entries(lock.packages).filter(
      ([key]) => lockKeyPackageName(key) === sdk,
    );
    if (instances.length === 0) {
      if (snapshot === "current") {
        panic(`${sdk}: no installed SDK pin in bun.lock.`);
      }
      // An SDK addition cannot borrow an old manifest or patch allowance.
      for (const source of entry.pinSources) {
        if (source.type === "manifest" && source.package === sdk) {
          pins.delete(pinSourceKey(source));
        }
      }
      continue;
    }
    for (const [key, value] of instances) {
      const tuple = v.parse(v.array(v.unknown()), value);
      pins.set(`bun.lock#${key}`, v.parse(v.string(), tuple.at(0)));
    }
    for (const [key, file] of Object.entries(manifest.patchedDependencies)) {
      if (!key.startsWith(`${sdk}@`)) {
        continue;
      }
      const patch = read(file);
      if (patch === undefined) {
        if (snapshot === "current") {
          panic(`Missing current external contract patch ${file}.`);
        }
        continue;
      }
      pins.set(`package.json#patchedDependencies.${key}`, hash(patch));
    }
  }
  return Object.fromEntries(pins);
};

export const readBaselinePins = (
  entry: ExternalContractEntry,
  read: (file: string) => string | undefined,
): Record<string, string> => {
  const pinSources = new Map(
    baselinePinSourceFiles({ entry }).map((file) => [file, read(file)]),
  );
  return readPinsFromFiles({
    entry,
    read: (file) => (pinSources.has(file) ? pinSources.get(file) : read(file)),
    snapshot: "baseline",
  });
};

export const readCurrentPins = (
  root: string,
  entry: ExternalContractEntry,
): Record<string, string> =>
  readPinsFromFiles({
    entry,
    read: (file) => readFileSync(path.join(root, file), "utf-8"),
    snapshot: "current",
  });

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
  admittedPins: Readonly<Record<string, string>>;
  driftReasons: Readonly<Record<string, string>>;
  owners: readonly string[];
  sdks: readonly string[];
};
const checkFixture = ({
  root,
  system,
  fixture,
  current,
  admittedPins,
  driftReasons,
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
        driftReasons,
        system,
        fixture: fixture.path,
        current,
        characterisedAt: applyAdmittedPinDrift(
          metadata.characterisedAt,
          admittedPins,
        ),
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
            driftReasons,
            system,
            fixture: file,
            current,
            characterisedAt: applyAdmittedPinDrift(
              provenance.characterisedAt,
              admittedPins,
            ),
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

const applyAdmittedPinDrift = (
  characterisedAt: Readonly<Record<string, string>>,
  admitted: Readonly<Record<string, string>>,
) =>
  Object.fromEntries([
    ...Object.entries(characterisedAt).filter(
      ([key]) => admitted[key] !== REMOVED_PIN,
    ),
    ...Object.entries(admitted).filter(([, value]) => value !== REMOVED_PIN),
  ]);

type ChangedExecutableUsageOptions = {
  sdks: readonly string[];
  file: string;
  baseline: string | undefined;
  current: string;
};

export const hasChangedExecutableUsage = ({
  sdks,
  file,
  baseline,
  current,
}: ChangedExecutableUsageOptions): boolean => {
  if (baseline === undefined) {
    return true;
  }
  const previousReferences = runtimeModuleReferences({ file, text: baseline });
  const currentReferences = runtimeModuleReferences({ file, text: current });
  const references = [...previousReferences, ...currentReferences];
  if (references.some((reference) => reference.type === "dynamic")) {
    return true;
  }
  const importsPinnedSdk = references.some((reference) => {
    switch (reference.type) {
      case "literal":
        return sdks.some(
          (sdk) =>
            reference.specifier === sdk ||
            reference.specifier.startsWith(`${sdk}/`),
        );
      case "dynamic":
        return true;
      default:
        reference satisfies never;
        return panic("Unhandled runtime module reference");
    }
  });
  if (!importsPinnedSdk) {
    return false;
  }
  // Erase TypeScript syntax rather than trying to track SDK-derived values.
  // Every emitted change can affect arguments, instances, aliases or re-exports.
  const executable = (text: string) =>
    ts.transpileModule(text, {
      fileName: file,
      compilerOptions: {
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.Preserve,
        verbatimModuleSyntax: true,
        removeComments: true,
      },
    }).outputText;
  return executable(baseline) !== executable(current);
};

type ChangedLocalRuntimeClosureOptions = {
  root: string;
  owners: readonly string[];
  sdks: readonly string[];
  scope: "sdk-reachable" | "all-owners";
  baseline: RuntimeSnapshotReader;
  current: RuntimeSnapshotReader;
  generators?: Parameters<
    typeof createLocalRuntimeClosureReader
  >[0]["generators"];
  registryFiles?: Parameters<
    typeof createLocalRuntimeClosureReader
  >[0]["registryFiles"];
  onInvalidation?: (reason: string) => void;
};

export const hasChangedLocalRuntimeClosure = ({
  root,
  owners,
  sdks,
  scope,
  baseline,
  current,
  generators,
  registryFiles,
  onInvalidation,
}: ChangedLocalRuntimeClosureOptions): boolean => {
  const previousClosure = createLocalRuntimeClosureReader({
    root,
    read: baseline,
    generators,
    registryFiles,
  });
  const currentClosure = createLocalRuntimeClosureReader({
    root,
    read: current,
    generators,
    registryFiles,
  });
  const emitted = new Map<string, string>();
  const executable = (file: string, text: string) => {
    if (!/\.[cm]?[jt]sx?$/u.test(file)) {
      return text;
    }
    const key = `${file}\0${text}`;
    if (!emitted.has(key)) {
      emitted.set(
        key,
        ts.transpileModule(text, {
          fileName: file,
          compilerOptions: {
            target: ts.ScriptTarget.ESNext,
            module: ts.ModuleKind.Preserve,
            verbatimModuleSyntax: true,
            removeComments: true,
          },
        }).outputText,
      );
    }
    return emitted.get(key);
  };
  const invalidate = (reason: string) => {
    onInvalidation?.(reason);
    return true;
  };
  for (const owner of owners) {
    const previous = previousClosure([owner]);
    const present = currentClosure([owner]);
    if (previous.problems.length > 0 || present.problems.length > 0) {
      for (const reason of new Set([
        ...previous.problems,
        ...present.problems,
      ])) {
        onInvalidation?.(reason);
      }
      return true;
    }
    if (previous.generated.size !== present.generated.size) {
      return invalidate(`Generated closure membership changed for ${owner}`);
    }
    for (const [file, identity] of previous.generated) {
      if (present.generated.get(file) !== identity) {
        return invalidate(
          `Generated input registration changed for ${file} in ${owner}`,
        );
      }
    }
    // Generated leaves stand for inputs, so their untraversed runtime edges cannot rule out SDK reachability.
    const reachesPinnedSdk =
      previous.generated.size > 0 ||
      present.generated.size > 0 ||
      [...previous.references, ...present.references].some((reference) => {
        switch (reference.type) {
          case "literal":
            return sdks.some(
              (sdk) =>
                reference.specifier === sdk ||
                reference.specifier.startsWith(`${sdk}/`),
            );
          case "dynamic":
            return true;
          default:
            reference satisfies never;
            return panic("Unhandled runtime module reference");
        }
      });
    // Image and API-version pins govern the transport even without an SDK import.
    // An unresolved edge can hide SDK reachability, so check problems before scope.
    if (scope === "sdk-reachable" && !reachesPinnedSdk) {
      continue;
    }
    if (previous.dataBlobIds.size !== present.dataBlobIds.size) {
      return invalidate(`Runtime data membership changed for ${owner}`);
    }
    for (const [file, id] of previous.dataBlobIds) {
      if (present.dataBlobIds.get(file) !== id) {
        return invalidate(`Runtime data blob changed: ${file} in ${owner}`);
      }
    }
    if (previous.files.size !== present.files.size) {
      const changed = [
        ...new Set([...previous.files.keys(), ...present.files.keys()]),
      ].filter((file) => previous.files.has(file) !== present.files.has(file));
      return invalidate(
        `Runtime closure membership changed for ${owner}: ${changed.join(", ")}`,
      );
    }
    for (const [file, source] of previous.files) {
      const next = present.files.get(file);
      if (
        next === undefined ||
        executable(file, source) !== executable(file, next)
      ) {
        return invalidate(
          `Runtime source or data changed: ${file} in ${owner}`,
        );
      }
    }
  }
  return false;
};

type AdmittedPinDriftOptions = {
  current: Readonly<Record<string, string>>;
  baseline: Readonly<Record<string, string>>;
  allowance: ReturnType<typeof readExternalContractPinAllowances>[number];
  now: Date;
  usageChanged: boolean;
  onRejected?: (key: string, reason: string) => void;
};

/** Dated debt never admits changed pins or changed executable usage. */
export const admittedPinDrift = ({
  current,
  baseline,
  allowance,
  now,
  usageChanged,
  onRejected,
}: AdmittedPinDriftOptions): Record<string, string> => {
  const pins: [string, string][] = [];
  for (const [key, value] of Object.entries(allowance.pins)) {
    let reason: string | undefined;
    if (usageChanged) {
      reason = "runtime closure changed or could not be resolved";
    } else if (Date.parse(allowance.expiresAt) <= now.getTime()) {
      reason = `dated allowance ${allowance.id} expired`;
    } else if (Object.hasOwn(current, key) && !Object.hasOwn(baseline, key)) {
      reason = "new pin source absent from merge-base";
    } else if ((current[key] ?? REMOVED_PIN) !== value) {
      reason = "current pin differs from the exact dated allowance";
    } else if ((baseline[key] ?? REMOVED_PIN) !== value) {
      reason = "merge-base pin differs from the exact dated allowance";
    }
    if (reason !== undefined) {
      onRejected?.(key, reason);
      continue;
    }
    pins.push([key, value]);
  }
  return Object.fromEntries(pins);
};

type ContractEntryCheckOptions = {
  root: string;
  system: string;
  entry: ExternalContractEntry;
  baseline: RuntimeSnapshotReader | undefined;
  admitted:
    ReturnType<typeof readExternalContractPinAllowances>[number] | undefined;
  now: Date;
};

export const checkContractEntry = ({
  root,
  system,
  entry,
  baseline,
  admitted,
  now,
}: ContractEntryCheckOptions): string[] => {
  const baselineProblems: string[] = [];
  if (admitted !== undefined && baseline === undefined) {
    baselineProblems.push(
      `${system}: ExternalContractBaselineUnavailable: dated allowance requires a merge-base snapshot.`,
    );
  }
  if (admitted !== undefined && baseline !== undefined) {
    for (const file of ["package.json", "bun.lock"]) {
      if (baseline(file) === undefined) {
        baselineProblems.push(
          `${system}: ExternalContractBaselineUnavailable: missing merge-base ${file}.`,
        );
      }
    }
  }
  const problems = [...baselineProblems];
  for (const owner of entry.owners) {
    if (!existsSync(path.join(root, owner.path))) {
      problems.push(`${system}: missing owner ${owner.path}.`);
    }
  }
  const current = readCurrentPins(root, entry);
  const baselinePins =
    baseline === undefined || admitted === undefined
      ? current
      : readBaselinePins(entry, baseline);
  const currentBytes = new Map<string, Uint8Array | undefined>();
  const currentSources = new Map<string, string | undefined>();
  const readBytes = (file: string) => {
    if (!currentBytes.has(file)) {
      const absolute = path.join(root, file);
      currentBytes.set(
        file,
        existsSync(absolute) && statSync(absolute).isFile()
          ? readFileSync(absolute)
          : undefined,
      );
    }
    return currentBytes.get(file);
  };
  const currentSource = (file: string) => {
    if (!currentSources.has(file)) {
      const bytes = readBytes(file);
      currentSources.set(
        file,
        bytes === undefined ? undefined : new TextDecoder().decode(bytes),
      );
    }
    return currentSources.get(file);
  };
  const currentObjects =
    baseline?.files === undefined || admitted === undefined
      ? undefined
      : readGitWorkingTreeBlobIds(root);
  const usageChanged =
    baseline !== undefined &&
    admitted !== undefined &&
    hasChangedLocalRuntimeClosure({
      root,
      owners: entry.owners.map(({ path: file }) => file),
      sdks: entry.sdks,
      scope: entry.pinSources.some((source) => source.type !== "manifest")
        ? "all-owners"
        : "sdk-reachable",
      baseline,
      onInvalidation: (reason) => {
        problems.push(
          `${system}: ExternalContractAllowanceInvalidated: ${reason}.`,
        );
      },
      current: Object.assign(currentSource, {
        byteLength: (file: string) => readBytes(file)?.byteLength,
        files:
          currentObjects === undefined ? undefined : [...currentObjects.keys()],
        blobId: (file: string) => currentObjects?.get(file),
      }),
    });
  let defaultDriftReason = "pin has no dated allowance";
  if (baselineProblems.length > 0) {
    defaultDriftReason = "merge-base snapshot unavailable";
  } else if (admitted === undefined) {
    defaultDriftReason = "system has no dated allowance";
  }
  const driftReasons = new Map(
    Object.keys(current).map((key) => [key, defaultDriftReason]),
  );
  const admittedPins =
    admitted === undefined ||
    baseline === undefined ||
    baselineProblems.length > 0
      ? {}
      : admittedPinDrift({
          current,
          baseline: baselinePins,
          allowance: admitted,
          now,
          usageChanged,
          onRejected: (key, reason) => {
            driftReasons.set(key, reason);
          },
        });
  if (entry.status === "uncharacterised") {
    return problems;
  }
  const coveredOwners = new Set<string>();
  const coveredSdks = new Set<string>();
  for (const fixture of entry.fixtures) {
    const checked = checkFixture({
      root,
      system,
      fixture,
      current,
      admittedPins,
      driftReasons: Object.fromEntries(driftReasons),
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
  return problems;
};

type ExternalContractCheckOptions = {
  registry?: Readonly<Record<ExternalSystemId, ExternalContractEntry>>;
  dependencies?: readonly string[];
  inProcess?: Readonly<Record<string, string>>;
  census?: readonly OutboundTransportCensusEntry[];
  sdks?: readonly string[];
  baseline?: RuntimeSnapshotReader;
  now?: Date;
};

export const checkExternalContracts = (
  root: string,
  {
    registry = EXTERNAL_CONTRACTS,
    dependencies = readDirectDependencies(root),
    inProcess = IN_PROCESS_DEPENDENCIES,
    census = OUTBOUND_TRANSPORT_CENSUS,
    sdks = dependencies.filter((name) => !Object.hasOwn(inProcess, name)),
    baseline,
    now = new Date(),
  }: ExternalContractCheckOptions = {},
): string[] => {
  const problems = findDependencyCatalogProblems({
    registry,
    dependencies,
    inProcess,
    census,
    sdks,
  });
  const publisher = registry["legal-publishers"];
  if (publisher.status === "uncharacterised") {
    problems.push("The legal-publishers contract must be characterised.");
    return problems;
  }
  const allowances = readExternalContractPinAllowances(
    readFileSync(
      path.join(ROOT, EXTERNAL_CONTRACT_PIN_ALLOWANCES_PATH),
      "utf-8",
    ),
  );
  for (const [system, entry] of Object.entries(registry)) {
    problems.push(
      ...checkContractEntry({
        root,
        system,
        entry,
        baseline,
        admitted: allowances.find((allowance) => allowance.system === system),
        now,
      }),
    );
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

export const runExternalContractCheck = (): void => {
  const base = process.env["CHECK_BASE_REF"] ?? "origin/main";
  const baseline = createGitBaselineReader({ root: ROOT, base });
  const problems = checkExternalContracts(ROOT, { baseline });
  for (const file of [REGISTRY_PATH]) {
    const baselineSource = baseline(file);
    // The initial enrollment establishes the set; later changes may only shrink it.
    if (baselineSource === undefined) {
      continue;
    }
    const currentSource = readFileSync(path.join(ROOT, file), "utf-8");
    problems.push(
      ...findUncharacterisedGrowth(
        uncharacterisedFromSource(currentSource),
        uncharacterisedFromSource(baselineSource),
      ),
    );
    problems.push(
      ...findShrinkOnlyGrowth({
        current: uncharacterisedScopeFromSource(currentSource),
        baseline: uncharacterisedScopeFromSource(baselineSource),
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
};

if (import.meta.main) {
  if (process.argv.includes("--list-baseline-pin-source-files")) {
    console.log(baselinePinSourceFiles().join("\n"));
  } else {
    runExternalContractCheck();
  }
}
