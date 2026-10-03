#!/usr/bin/env bun

import { Result, TaggedError } from "better-result";
import JSZip from "jszip";
import path from "node:path";
import { parseXmlDocument } from "slimdom";

import allowedValues from "./office-fixture-metadata-allowlist.json";

const OFFICE_EXTENSIONS = new Set([
  ".docx",
  ".xlsx",
  ".pptx",
  ".odt",
  ".ods",
  ".odp",
  ".dotx",
]);
const METADATA_PARTS = ["docProps/core.xml", "docProps/app.xml", "meta.xml"];
const METADATA_FIELDS = new Set([
  "creator",
  "lastmodifiedby",
  "company",
  "manager",
  "template",
  "title",
  "subject",
  "keywords",
  "keyword",
  "description",
  "initial-creator",
  "printed-by",
  "user-defined",
]);
const METADATA_ATTRIBUTES = new Set(["href", "name", "title"]);
const ALLOWED_VALUES = new Set(allowedValues);

export class OfficeFixtureMetadataError extends TaggedError(
  "OfficeFixtureMetadataError",
)<{
  message: string;
  path: string;
  field: string;
  reason: "unreadable" | "invalid-xml" | "encrypted" | "not-allowed";
}> {}

type MetadataFailureOptions = {
  filePath: string;
  field: string;
  reason: OfficeFixtureMetadataError["reason"];
};

const failure = ({ filePath, field, reason }: MetadataFailureOptions) =>
  new OfficeFixtureMetadataError({
    message: "Office fixture metadata could not be validated",
    path: filePath,
    field,
    reason,
  });

type InspectOfficeFixtureOptions = {
  filePath: string;
  bytes: Uint8Array;
};

/** Diagnostics contain paths and field names, never property contents. */
export const inspectOfficeFixture = async ({
  filePath,
  bytes,
}: InspectOfficeFixtureOptions): Promise<
  Result<OfficeFixtureMetadataError[], OfficeFixtureMetadataError>
> => {
  const loaded = await Result.tryPromise({
    try: async () => await JSZip.loadAsync(bytes, { checkCRC32: true }),
    catch: () => failure({ filePath, field: "archive", reason: "unreadable" }),
  });
  if (Result.isError(loaded)) {
    return loaded;
  }
  const findings: OfficeFixtureMetadataError[] = [];
  for (const part of [...METADATA_PARTS, "META-INF/manifest.xml"]) {
    const entry = loaded.value.file(part);
    if (entry === null) {
      continue;
    }
    const parsed = await Result.tryPromise({
      try: async () => {
        const xml = await entry.async("string");
        if (/<!DOCTYPE/iu.test(xml)) {
          throw failure({ filePath, field: part, reason: "invalid-xml" });
        }
        return parseXmlDocument(xml);
      },
      catch: () => failure({ filePath, field: part, reason: "invalid-xml" }),
    });
    if (Result.isError(parsed)) {
      return parsed;
    }
    for (const element of parsed.value.getElementsByTagNameNS("*", "*")) {
      const field = element.localName.toLowerCase();
      if (field === "encryption-data") {
        return Result.err(
          failure({ filePath, field: part, reason: "encrypted" }),
        );
      }
      if (part === "META-INF/manifest.xml" || !METADATA_FIELDS.has(field)) {
        continue;
      }
      if (!ALLOWED_VALUES.has(element.textContent ?? "")) {
        findings.push(
          failure({
            filePath,
            field: `${part}:${element.localName}`,
            reason: "not-allowed",
          }),
        );
      }
      for (const attribute of element.attributes) {
        if (!METADATA_ATTRIBUTES.has(attribute.localName)) {
          continue;
        }
        if (!ALLOWED_VALUES.has(attribute.value)) {
          findings.push(
            failure({
              filePath,
              field: `${part}:${element.localName}@${attribute.localName}`,
              reason: "not-allowed",
            }),
          );
        }
      }
    }
  }
  return Result.ok(findings);
};

export const listOfficeFixtures = (
  rootDir: string,
): Result<string[], OfficeFixtureMetadataError> => {
  const result = Bun.spawnSync(["git", "ls-files", "--cached", "-z"], {
    cwd: rootDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    return Result.err(
      failure({ filePath: ".", field: "tracked-files", reason: "unreadable" }),
    );
  }
  return Result.ok(
    result.stdout
      .toString()
      .split("\0")
      .filter((file) =>
        OFFICE_EXTENSIONS.has(path.extname(file).toLowerCase()),
      ),
  );
};

const main = async () => {
  const rootDir = path.resolve(import.meta.dir, "..");
  const files = listOfficeFixtures(rootDir);
  if (Result.isError(files)) {
    console.error(`${files.error.path}: ${files.error.field}`);
    return 1;
  }
  let failed = false;
  for (const filePath of files.value) {
    const bytes = await Result.tryPromise({
      try: async () =>
        new Uint8Array(
          await Bun.file(path.join(rootDir, filePath)).arrayBuffer(),
        ),
      catch: () =>
        failure({ filePath, field: "archive", reason: "unreadable" }),
    });
    const inspected = Result.isError(bytes)
      ? bytes
      : await inspectOfficeFixture({ filePath, bytes: bytes.value });
    const findings = Result.isError(inspected)
      ? [inspected.error]
      : inspected.value;
    for (const finding of findings) {
      console.error(`${finding.path}: ${finding.field}`);
      failed = true;
    }
  }
  if (!failed) {
    console.log(`office-fixture-metadata: ${files.value.length} files checked`);
  }
  return failed ? 1 : 0;
};

if (import.meta.main) {
  process.exitCode = await main();
}
