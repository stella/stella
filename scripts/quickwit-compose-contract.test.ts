import { describe, expect, test } from "bun:test";

import { QUICKWIT_V09_BINARY_VERSION } from "@/api/lib/legal-search/corpus-index-engine-version";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const recordField = (
  value: Record<string, unknown>,
  field: string,
): Record<string, unknown> => {
  const candidate = value[field];
  if (!isRecord(candidate)) {
    throw new TypeError(`${field} must be an object`);
  }
  return candidate;
};

const stringField = (value: Record<string, unknown>, field: string): string => {
  const candidate = value[field];
  if (typeof candidate !== "string") {
    throw new TypeError(`${field} must be a string`);
  }
  return candidate;
};

const stringArrayField = (
  value: Record<string, unknown>,
  field: string,
): readonly string[] => {
  const candidate = value[field];
  if (
    !Array.isArray(candidate) ||
    !candidate.every((entry) => typeof entry === "string")
  ) {
    throw new TypeError(`${field} must be an array of strings`);
  }
  return candidate;
};

describe("local Quickwit generations", () => {
  test("keeps q09 isolated and aligned with the final manifest", async () => {
    const compose: unknown = Bun.YAML.parse(
      await Bun.file(new URL("../docker-compose.yml", import.meta.url)).text(),
    );
    if (!isRecord(compose)) {
      throw new TypeError("Compose must be an object");
    }
    const services = recordField(compose, "services");
    const rustfsSetup = recordField(services, "rustfs-setup");
    const q08 = recordField(services, "quickwit");
    const q09 = recordField(services, "quickwit09");
    const q09Setup = recordField(services, "quickwit09-postgres-setup");
    const q08Environment = recordField(q08, "environment");
    const q09Environment = recordField(q09, "environment");
    const rustfsSetupEnvironment = recordField(rustfsSetup, "environment");

    expect(stringField(q08, "image")).toStartWith(
      "quickwit/quickwit:0.8.2@sha256:",
    );
    expect(stringField(q09, "image")).toStartWith(
      `quickwit/quickwit:${QUICKWIT_V09_BINARY_VERSION}@sha256:`,
    );
    expect(stringField(q09Environment, "QW_METASTORE_URI")).toBe(
      "postgres://postgres:postgres@postgres:5432/stella_quickwit_09",
    );
    expect(stringField(q09Environment, "QW_METASTORE_URI")).not.toBe(
      stringField(q08Environment, "QW_METASTORE_URI"),
    );
    expect(stringField(q09Environment, "QW_DEFAULT_INDEX_ROOT_URI")).not.toBe(
      stringField(q08Environment, "QW_DEFAULT_INDEX_ROOT_URI"),
    );
    expect(stringField(q09Environment, "QW_DEFAULT_INDEX_ROOT_URI")).toBe(
      stringField(rustfsSetupEnvironment, "QUICKWIT09_INDEX_ROOT_URI"),
    );
    expect(stringField(rustfsSetup, "entrypoint")).toMatch(
      /quickwit09_bucket=\$\$\{QUICKWIT09_INDEX_ROOT_URI#s3:\/\/\}/,
    );
    expect(stringArrayField(q09, "ports")).not.toEqual(
      stringArrayField(q08, "ports"),
    );
    expect(stringArrayField(q09, "profiles")).toEqual(["quickwit09"]);
    expect(stringArrayField(q09Setup, "profiles")).toEqual(["quickwit09"]);
  });
});
