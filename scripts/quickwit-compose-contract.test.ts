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

describe("local Quickwit generation", () => {
  test("pins the engine the manifest declares, on its own metastore", async () => {
    const compose: unknown = Bun.YAML.parse(
      await Bun.file(new URL("../docker-compose.yml", import.meta.url)).text(),
    );
    if (!isRecord(compose)) {
      throw new TypeError("Compose must be an object");
    }
    const services = recordField(compose, "services");
    const rustfsSetup = recordField(services, "rustfs-setup");
    const q09 = recordField(services, "quickwit09");
    const q09Setup = recordField(services, "quickwit09-postgres-setup");
    const q09Environment = recordField(q09, "environment");
    const rustfsSetupEnvironment = recordField(rustfsSetup, "environment");

    // One engine service, and it is the one the manifest declares.
    expect(
      Object.keys(services).filter((name) => name.startsWith("quickwit")),
    ).toEqual(["quickwit09-postgres-setup", "quickwit09"]);
    expect(stringField(q09, "image")).toStartWith(
      `quickwit/quickwit:${QUICKWIT_V09_BINARY_VERSION}@sha256:`,
    );
    expect(stringField(q09Environment, "QW_METASTORE_URI")).toBe(
      "postgres://postgres:postgres@postgres:5432/stella_quickwit_09",
    );
    expect(stringField(q09Environment, "QW_DEFAULT_INDEX_ROOT_URI")).toBe(
      stringField(rustfsSetupEnvironment, "QUICKWIT09_INDEX_ROOT_URI"),
    );
    expect(stringField(rustfsSetup, "entrypoint")).toMatch(
      /quickwit09_bucket=\$\$\{QUICKWIT09_INDEX_ROOT_URI#s3:\/\/\}/u,
    );
    // The published host ports are what the test environment defaults to.
    expect(stringArrayField(q09, "ports")).toEqual([
      expect.stringContaining(":-7290}:7280"),
      expect.stringContaining(":-7291}:7281"),
    ]);
    expect(stringArrayField(q09, "profiles")).toEqual(["quickwit09"]);
    expect(stringArrayField(q09Setup, "profiles")).toEqual(["quickwit09"]);
  });
});
