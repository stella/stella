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
  "@stll/anonymize",
  "@stll/anonymize-darwin-arm64",
  "@stll/anonymize-darwin-x64",
  "@stll/anonymize-data",
  "@stll/anonymize-linux-arm64-gnu",
  "@stll/anonymize-linux-x64-gnu",
  "@stll/anonymize-wasm",
  "@stll/anonymize-win32-x64-msvc",
  "@stll/conditions",
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
  "@stll/template-conditions",
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// A lockfile key is a chain of package names joined by "/", where scoped
// names contribute two segments ("@stll/web/@babel/core" is the @babel/core
// copy scoped to the @stll/web consumer). The trailing name is the package
// the entry resolves.
const trailingPackageName = (key: string): string => {
  const segments = key.split("/");
  const last = segments.at(-1) ?? key;
  const scope = segments.at(-2);
  return scope?.startsWith("@") ? `${scope}/${last}` : last;
};

const registryResolvedStllPackages = (source: unknown): string[] => {
  if (!isRecord(source) || !isRecord(source["packages"])) {
    throw new TypeError("bun.lock must contain a packages map");
  }

  const names = new Set<string>();
  for (const [key, entry] of Object.entries(source["packages"])) {
    // Consumer-scoped keys included: a registry copy of an otherwise
    // workspace-linked name can hide under "consumer/@stll/name" when one
    // consumer's range stops matching the workspace version.
    const name = trailingPackageName(key);
    if (!name.startsWith("@stll/")) {
      continue;
    }
    if (!Array.isArray(entry) || typeof entry.at(0) !== "string") {
      throw new TypeError(`bun.lock package ${key} has no resolution`);
    }
    if (!String(entry.at(0)).includes("@workspace:")) {
      names.add(name);
    }
  }
  return [...names].sort();
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
