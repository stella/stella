#!/usr/bin/env bun

import { Result, TaggedError } from "better-result";
import JSZip from "jszip";
import path from "node:path";
import { parseXmlDocument } from "slimdom";

import { OFFICE_ARCHIVE_FORMATS } from "../src/office-formats";
import {
  isOfficeIdentityPart,
  officeIdentityFields,
} from "../src/office-metadata";
import allowedValues from "./office-fixture-metadata-allowlist.json";

export const OFFICE_FIXTURE_EXTENSIONS = Object.keys(
  OFFICE_ARCHIVE_FORMATS,
).map((extension) => `.${extension}`);
const OFFICE_EXTENSIONS = new Set(OFFICE_FIXTURE_EXTENSIONS);
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
  const findings = new Map<string, OfficeFixtureMetadataError>();
  for (const part of Object.keys(loaded.value.files).filter(
    (candidate) =>
      isOfficeIdentityPart(candidate) || candidate === "META-INF/manifest.xml",
  )) {
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
    if (part === "META-INF/manifest.xml") {
      if (
        [...parsed.value.getElementsByTagNameNS("*", "*")].some(
          (element) => element.localName === "encryption-data",
        )
      ) {
        return Result.err(
          failure({ filePath, field: part, reason: "encrypted" }),
        );
      }
      continue;
    }
    for (const identity of officeIdentityFields(parsed.value, part)) {
      const value =
        identity.type === "text"
          ? (identity.node.textContent ?? "")
          : identity.node.value;
      if (ALLOWED_VALUES.has(value)) {
        continue;
      }
      const field = `${part}:${identity.field}`;
      findings.set(field, failure({ filePath, field, reason: "not-allowed" }));
    }
  }

  return Result.ok([...findings.values()]);
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
  const rootDir = path.resolve(import.meta.dir, "../../..");
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
