import process from "node:process";
import { execFileSync } from "node:child_process";

import {
  assertWasmArtifactSize,
  WASM_RUNTIME_ARTIFACTS,
} from "../../packages/anonymize/scripts/wasm-artifact-policy.mjs";

const PACKAGES = [
  {
    dir: "packages/anonymize",
    expected: [
      "dist/index.d.mts",
      "dist/index.mjs",
      "dist/native.d.mts",
      "dist/native.mjs",
      "dist/native-node.d.mts",
      "dist/native-node.mjs",
      "index.cjs",
      "native-pipeline.stlanonpkg",
      "native-pipeline.cs.stlanonpkg",
      "native-pipeline.de.stlanonpkg",
      "native-pipeline.en.stlanonpkg",
      "README.md",
      "LICENSE",
      "ATTRIBUTION.md",
      "package.json",
    ],
    forbidden: ["stella_anonymize_napi.node"],
  },
  {
    dir: "packages/data",
    expected: [
      "dist/index.d.mts",
      "dist/index.mjs",
      "README.md",
      "LICENSE",
      "ATTRIBUTION.md",
      "CHANGELOG.md",
      "package.json",
      "config/manifest.json",
      "dictionaries/names/global.json",
      "dictionaries/names/first/cs.json",
      "dictionaries/names/surnames/cs.json",
      "dictionaries/cities/CZ.json",
      "dictionaries/banks/US.json",
      "dictionaries/courts/US.json",
      "dictionaries/insurance/CZ.json",
      "dictionaries/education/universities-CZ.json",
      "dictionaries/government/ministries-CZ.json",
      "dictionaries/healthcare/hospitals-CZ.json",
      "dictionaries/international/eu-institutions.json",
    ],
  },
  {
    dir: "packages/document-docx",
    expected: [
      "dist/index.d.mts",
      "dist/index.mjs",
      "README.md",
      "LICENSE",
      "ATTRIBUTION.md",
      "package.json",
    ],
  },
  {
    dir: "packages/document-pdf",
    expected: [
      "dist/index.d.mts",
      "dist/index.mjs",
      "README.md",
      "LICENSE",
      "ATTRIBUTION.md",
      "package.json",
    ],
  },
  {
    dir: "packages/mcp",
    expected: [
      "dist/index.d.mts",
      "dist/index.mjs",
      "dist/server.d.mts",
      "dist/server.mjs",
      "README.md",
      "LICENSE",
      "package.json",
    ],
  },
  {
    dir: "packages/anonymize/wasm",
    closedDirectories: ["dist/native/"],
    expected: [
      "dist/wasm.d.mts",
      "dist/wasm.mjs",
      "dist/constants.mjs",
      "dist/vite.d.mts",
      "dist/vite.mjs",
      // Runtime wasm binding + wasm-bindgen ESM glue the entry loads
      // from its own `native/` asset directory. Missing any of these means
      // build:wasm-assets did not run after tsdown wiped wasm/dist/native.
      ...WASM_RUNTIME_ARTIFACTS.map((artifact) => artifact.packagePath),
      // Bundled default package plus the per-language compressed packages
      // (cs, de, en) that loadDefaultPipeline(language) resolves to.
      "dist/native/native-pipeline.stlanonpkg",
      "dist/native/native-pipeline.cs.stlanonpkg",
      "dist/native/native-pipeline.de.stlanonpkg",
      "dist/native/native-pipeline.en.stlanonpkg",
      "README.md",
      "LICENSE",
      "package.json",
    ],
  },
  {
    dir: "packages/cli",
    expected: ["dist/cli.mjs", "README.md", "LICENSE", "package.json"],
  },
];

const selectedPackages = selectPackages(process.argv.slice(2));

for (const {
  dir,
  expected,
  forbidden = [],
  closedDirectories = [],
} of selectedPackages) {
  const packJson = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: dir,
    encoding: "utf8",
  });
  const pack = JSON.parse(packJson)[0];

  if (!pack) {
    console.error(`No pack metadata returned for ${dir}`);
    process.exit(1);
  }

  const files = new Set(pack.files.map((entry) => entry.path));
  const missing = expected.filter((file) => !files.has(file));

  if (missing.length > 0) {
    console.error(`${dir}: missing pack files: ${missing.join(", ")}`);
    process.exit(1);
  }
  const presentForbidden = forbidden.filter((file) => files.has(file));
  if (presentForbidden.length > 0) {
    console.error(
      `${dir}: unexpected pack files: ${presentForbidden.join(", ")}`,
    );
    process.exit(1);
  }
  for (const prefix of closedDirectories) {
    const expectedInDirectory = new Set(
      expected.filter((file) => file.startsWith(prefix)),
    );
    const unexpected = [...files].filter(
      (file) => file.startsWith(prefix) && !expectedInDirectory.has(file),
    );
    if (unexpected.length > 0) {
      console.error(
        `${dir}: unexpected files under ${prefix}: ${unexpected.join(", ")}`,
      );
      process.exit(1);
    }
  }
  if (dir === "packages/anonymize/wasm") {
    for (const artifact of WASM_RUNTIME_ARTIFACTS) {
      const packed = pack.files.find(
        ({ path }) => path === artifact.packagePath,
      );
      assertWasmArtifactSize({
        file: artifact.packagePath,
        bytes: packed?.size ?? Number.POSITIVE_INFINITY,
        maxBytes: artifact.maxBytes,
      });
    }
  }
}

function selectPackages(args) {
  if (args.length === 0) return PACKAGES;
  if (args.length !== 2 || args[0] !== "--package") {
    console.error("Usage: check-packlist.mjs [--package <package-directory>]");
    process.exit(2);
  }

  const selected = PACKAGES.filter(({ dir }) => dir === args[1]);
  if (selected.length !== 1) {
    console.error(`Unknown package directory: ${args[1]}`);
    process.exit(2);
  }
  return selected;
}
