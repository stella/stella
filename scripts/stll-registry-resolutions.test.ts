import { describe, expect, test } from "bun:test";

// Bun links an @stll dependency to a local workspace only while the workspace
// version satisfies the declared range; otherwise it installs the npm
// registry copy. That means a version drift (workspace bumped, dependent's
// range not) flips which code ships — silently, in both the web runner's
// staged closure and the compiled API binary. Pin the set of @stll packages
// that resolve from the registry so a flip in either direction fails here and
// forces a deliberate decision: widen the range, release the package, or
// update this pin with the reasoning in the PR.
const EXPECTED_REGISTRY_RESOLVED = [
  "@stll/anonymize-data",
  "@stll/anonymize-wasm",
  "@stll/docx-core",
  "@stll/folio-agents",
  "@stll/folio-core",
  "@stll/folio-react",
  "@stll/oxlint-config",
  "@stll/stdnum",
  "@stll/stdnum-darwin-arm64",
  "@stll/stdnum-darwin-x64",
  "@stll/stdnum-linux-arm64-gnu",
  "@stll/stdnum-linux-x64-gnu",
  "@stll/stdnum-wasm",
  "@stll/stdnum-win32-x64-msvc",
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const registryResolvedStllPackages = (source: unknown): string[] => {
  if (!isRecord(source) || !isRecord(source["packages"])) {
    throw new TypeError("bun.lock must contain a packages map");
  }

  return Object.entries(source["packages"])
    // Top-level entries only: "@stll/name" has exactly the scope slash.
    // Nested keys ("@stll/web/@babel/core") are per-consumer resolution
    // contexts, not packages of their own.
    .filter(
      ([key]) =>
        key.startsWith("@stll/") && !key.slice("@stll/".length).includes("/"),
    )
    .filter(([, entry]) => {
      if (!Array.isArray(entry) || typeof entry.at(0) !== "string") {
        throw new TypeError("bun.lock package entry has no resolution");
      }
      return !String(entry.at(0)).includes("@workspace:");
    })
    .map(([key]) => key)
    .sort();
};

describe("@stll dependency resolutions", () => {
  test("registry-resolved set matches the pinned expectation", async () => {
    const lock = Bun.JSONC.parse(
      await Bun.file(new URL("../bun.lock", import.meta.url)).text(),
    );
    expect(registryResolvedStllPackages(lock)).toEqual([
      ...EXPECTED_REGISTRY_RESOLVED,
    ]);
  });
});
