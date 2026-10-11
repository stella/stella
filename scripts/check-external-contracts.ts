import { panic } from "better-result";
import { spawnSync } from "node:child_process";
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
import { IN_PROCESS_CATALOG_PACKAGES } from "../packages/external-contracts/src/catalog-libraries";
import {
  findCatalogProblems,
  findCoverageDrift,
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
  OUTBOUND_TRANSPORT_CENSUS,
  type OutboundTransportCensusEntry,
} from "./outbound-transport-census";
import { isOutboundTransportModule } from "./outbound-transport-ownership";
import { parseSource } from "./parse-memo";

const ROOT = path.resolve(import.meta.dir, "..");
const REGISTRY_PATH = "packages/external-contracts/src/registry.ts";
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
      if (
        !ts.isArrayLiteralExpression(initializer) ||
        !initializer.elements.every(ts.isStringLiteral)
      ) {
        return panic(`${pinSourceKey(source)} must be a literal string array.`);
      }
      return JSON.stringify(initializer.elements.map(({ text }) => text));
    }
    default:
      source satisfies never;
      return panic("Unhandled external pin source");
  }
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
      ([key]) => key === sdk || key.endsWith(`/${sdk}`),
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

export const isExternalSdk = (name: string): boolean =>
  isOutboundTransportModule(name) ||
  name.startsWith("@better-auth/") ||
  /(?:^|[/-])sdk(?:$|[/-])/u.test(name);

export const readExternalSdks = (root: string): string[] => {
  const sdks = new Set<string>();
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
      if (
        name.startsWith("@stll/") ||
        name.startsWith("@types/") ||
        !isExternalSdk(name)
      ) {
        continue;
      }
      sdks.add(name);
    }
  }
  return [...sdks];
};

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
}: FixtureCheckOptions): string[] => {
  const problems: string[] = [];
  if (!existsSync(path.join(root, fixture.path))) {
    return [`${system}: missing fixture set ${fixture.path}.`];
  }
  if ("metadata" in fixture) {
    const metadata = v.parse(pinMetadataSchema, json(root, fixture.metadata));
    problems.push(
      ...findCoverageDrift({
        system,
        fixture: fixture.metadata,
        owners,
        sdks,
        coveredOwners: metadata.coveredOwners,
        coveredSdks: metadata.coveredSdks,
      }),
    );
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
    return problems;
  }
  const files = filesBelow(root, fixture.path);
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
      return problems;
    }
    case "provider-request-schemas": {
      const sidecars = files.filter((file) => file.endsWith(".source.json"));
      if (sidecars.length === 0) {
        problems.push(`${system}: no request schema sidecars.`);
      }
      for (const file of sidecars) {
        const provenance = v.parse(
          providerSchemaSourceSchema,
          json(root, file),
        );
        problems.push(
          ...findCoverageDrift({
            system,
            fixture: file,
            owners,
            sdks,
            coveredOwners: provenance.coveredOwners,
            coveredSdks: provenance.coveredSdks,
          }),
        );
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
      return problems;
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
      return problems;
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

type ExternalContractCheckOptions = {
  registry?: Readonly<Record<ExternalSystemId, ExternalContractEntry>>;
  census?: readonly OutboundTransportCensusEntry[];
  sdks?: readonly string[];
};

export const checkExternalContracts = (
  root: string,
  {
    registry = EXTERNAL_CONTRACTS,
    census = OUTBOUND_TRANSPORT_CENSUS,
    sdks = readExternalSdks(root),
  }: ExternalContractCheckOptions = {},
): string[] => {
  const manifest = v.parse(manifestSchema, json(root, "package.json"));
  const catalogProblems = findCatalogProblems({
    registry,
    packages: Object.keys(manifest.catalog),
    inProcess: IN_PROCESS_CATALOG_PACKAGES,
  });
  for (const name of Object.keys(IN_PROCESS_CATALOG_PACKAGES)) {
    if (isExternalSdk(name)) {
      catalogProblems.push(
        `Catalog package ${name}: a transport SDK cannot be classified as in-process.`,
      );
    }
  }
  const problems = findTotalityProblems({
    registry,
    owners: census.map(({ path: owner }) => owner),
    sdks,
  });
  problems.push(...catalogProblems);
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
    for (const fixture of entry.fixtures) {
      problems.push(
        ...checkFixture({
          root,
          system,
          fixture,
          current,
          owners: entry.owners.map(({ path: ownerPath }) => ownerPath),
          sdks: entry.sdks,
        }),
      );
    }
  }
  const publisher = registry["legal-publishers"];
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
  const mergeBase = spawnSync("git", ["merge-base", "HEAD", base], {
    cwd: ROOT,
    encoding: "utf-8",
  });
  if (mergeBase.status !== 0) {
    panic(
      `Cannot resolve external contract baseline ${base}: ${mergeBase.stderr}`,
    );
  }
  const tree = spawnSync(
    "git",
    ["ls-tree", "--name-only", mergeBase.stdout.trim(), "--", REGISTRY_PATH],
    { cwd: ROOT, encoding: "utf-8" },
  );
  if (tree.status !== 0) {
    panic(`Cannot inspect external contract baseline: ${tree.stderr}`);
  }
  const problems = checkExternalContracts(ROOT);
  // The first registry enrollment establishes the set; subsequent changes may only remove uncovered entries.
  if (tree.stdout.trim() !== "") {
    const baseline = spawnSync(
      "git",
      ["show", `${mergeBase.stdout.trim()}:${REGISTRY_PATH}`],
      { cwd: ROOT, encoding: "utf-8" },
    );
    if (baseline.status !== 0) {
      panic(`Cannot read external contract baseline: ${baseline.stderr}`);
    }
    problems.push(
      ...findUncharacterisedGrowth(
        uncharacterisedFromSource(
          readFileSync(path.join(ROOT, REGISTRY_PATH), "utf-8"),
        ),
        uncharacterisedFromSource(baseline.stdout),
      ),
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
