import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const syncScript = join(
  repoRoot,
  ".github",
  "tools",
  "sync-runtime-version.mjs",
);
let workspace;
// Windows runners check out with CRLF line endings; the sync script must
// handle both, so the whole scenario runs once per line ending.
let lineEnding = "\n";
const version = "9.8.7";
const staleVersion = "9.8.6";

const releaseWorkflow = readFileSync(
  join(repoRoot, ".github", "workflows", "release.yml"),
  "utf8",
);
const releaseSyncCommands = [
  ...releaseWorkflow.matchAll(/^\s+run: (bun run sync:version.*)$/gm),
].map((match) => match[1]);
if (
  releaseSyncCommands.length === 0 ||
  releaseSyncCommands.some(
    (command) => command !== "bun run sync:version -- --release",
  )
) {
  throw new Error(
    "every release job must resolve workspace dependencies with sync:version -- --release",
  );
}

const jobsStart = releaseWorkflow.indexOf("\njobs:\n");
if (jobsStart === -1) {
  throw new Error("release workflow has no jobs section");
}
const jobsText = releaseWorkflow.slice(jobsStart + "\njobs:\n".length);
const jobHeaders = [...jobsText.matchAll(/^  ([A-Za-z0-9_-]+):\s*$/gm)];
const releaseJobs = jobHeaders.map((header, index) => ({
  name: header[1],
  body: jobsText.slice(
    header.index,
    jobHeaders[index + 1]?.index ?? jobsText.length,
  ),
}));
const npmPackingCommands = [
  "npm pack ",
  "node .github/tools/check-packlist.mjs",
];
const packingJobs = releaseJobs.filter(({ body }) =>
  npmPackingCommands.some((command) => body.includes(command)),
);
if (packingJobs.length === 0) {
  throw new Error("release workflow has no npm-packing jobs");
}
const independentlyVersionedPackingJobs = new Set(["pack-data"]);
for (const { name, body } of packingJobs) {
  const syncIndex = body.indexOf("run: bun run sync:version -- --release");
  if (independentlyVersionedPackingJobs.has(name)) {
    if (syncIndex !== -1) {
      throw new Error(
        `independently versioned release job ${name} must not sync runtime versions`,
      );
    }
    continue;
  }
  const packIndex = Math.min(
    ...npmPackingCommands
      .map((command) => body.indexOf(command))
      .filter((index) => index !== -1),
  );
  if (syncIndex === -1 || syncIndex > packIndex) {
    throw new Error(
      `release job ${name} must resolve workspace dependencies before npm pack`,
    );
  }
}

const packageFiles = [
  "packages/anonymize/package.json",
  "packages/anonymize-darwin-arm64/package.json",
  "packages/anonymize-darwin-x64/package.json",
  "packages/anonymize-linux-arm64-gnu/package.json",
  "packages/anonymize-linux-x64-gnu/package.json",
  "packages/anonymize-win32-x64-msvc/package.json",
  "packages/anonymize/wasm/package.json",
  "packages/cli/package.json",
  "packages/document-docx/package.json",
  "packages/document-pdf/package.json",
  "packages/mcp/package.json",
];

const changesetConfig = JSON.parse(
  readFileSync(join(repoRoot, ".changeset", "config.json"), "utf8"),
);
const fixedRuntimePackages = changesetConfig.fixed?.at(0) ?? [];
const synchronizedRuntimePackages = packageFiles.map(
  (packageFile) =>
    JSON.parse(readFileSync(join(repoRoot, packageFile), "utf8")).name,
);
if (
  changesetConfig.fixed?.length !== 1 ||
  fixedRuntimePackages.length !== synchronizedRuntimePackages.length ||
  synchronizedRuntimePackages.some(
    (packageName) => !fixedRuntimePackages.includes(packageName),
  )
) {
  throw new Error(
    "the Changesets fixed group must exactly match the synchronized runtime packages",
  );
}

const sidecars = [
  "@stll/anonymize-darwin-arm64",
  "@stll/anonymize-darwin-x64",
  "@stll/anonymize-linux-arm64-gnu",
  "@stll/anonymize-linux-x64-gnu",
  "@stll/anonymize-win32-x64-msvc",
];

for (const scenarioLineEnding of ["\n", "\r\n"]) {
  lineEnding = scenarioLineEnding;
  workspace = mkdtempSync(join(tmpdir(), "stella-version-sync-"));
  try {
    writeFixture();

    const staleCheck = spawnSync("node", [syncScript, "--check"], {
      cwd: workspace,
      encoding: "utf8",
    });
    if (staleCheck.status === 0 || !staleCheck.stderr.includes(sidecars[0])) {
      throw new Error(
        `stale synchronized versions were not reported (${JSON.stringify(lineEnding)})`,
      );
    }

    execFileSync("node", [syncScript], { cwd: workspace, stdio: "pipe" });
    execFileSync("node", [syncScript, "--check"], {
      cwd: workspace,
      stdio: "pipe",
    });

    const rootPackage = JSON.parse(
      readFileSync(join(workspace, "packages/anonymize/package.json"), "utf8"),
    );
    for (const sidecar of sidecars) {
      if (rootPackage.optionalDependencies?.[sidecar] !== version) {
        throw new Error(`package.json did not sync ${sidecar}`);
      }
    }

    const cliPackage = JSON.parse(
      readFileSync(join(workspace, "packages/cli/package.json"), "utf8"),
    );
    for (const dependency of [
      "@stll/anonymize",
      "@stll/anonymize-docx",
      "@stll/anonymize-pdf",
    ]) {
      if (cliPackage.dependencies?.[dependency] !== `^${version}`) {
        throw new Error(`CLI package did not sync ${dependency}`);
      }
    }

    const docxPackage = JSON.parse(
      readFileSync(
        join(workspace, "packages/document-docx/package.json"),
        "utf8",
      ),
    );
    if (docxPackage.dependencies?.["@stll/anonymize"] !== `^${version}`) {
      throw new Error("DOCX package did not sync @stll/anonymize");
    }

    const pdfPackage = JSON.parse(
      readFileSync(
        join(workspace, "packages/document-pdf/package.json"),
        "utf8",
      ),
    );
    if (pdfPackage.dependencies?.["@stll/anonymize"] !== "workspace:*") {
      throw new Error("PDF source package did not preserve workspace:*");
    }

    const mcpPackage = JSON.parse(
      readFileSync(join(workspace, "packages/mcp/package.json"), "utf8"),
    );
    if (mcpPackage.dependencies?.["@stll/anonymize"] !== "workspace:*") {
      throw new Error("MCP source package did not preserve workspace:*");
    }
    if (mcpPackage.dependencies?.["@stll/anonymize-docx"] !== `^${version}`) {
      throw new Error("MCP package did not sync @stll/anonymize-docx");
    }
    if (mcpPackage.dependencies?.["@stll/anonymize-pdf"] !== "workspace:*") {
      throw new Error("MCP source package did not preserve PDF workspace:*");
    }

    mcpPackage.dependencies["@stll/anonymize"] = `^${version}`;
    writeText(
      "packages/mcp/package.json",
      `${JSON.stringify(mcpPackage, null, 2)}\n`,
    );
    const legacyCheck = spawnSync("node", [syncScript, "--check"], {
      cwd: workspace,
      encoding: "utf8",
    });
    if (
      legacyCheck.status === 0 ||
      !legacyCheck.stderr.includes(`workspace:* or ${version}`)
    ) {
      throw new Error("MCP legacy dependency range was not rejected");
    }
    mcpPackage.dependencies["@stll/anonymize"] = "workspace:*";
    writeText(
      "packages/mcp/package.json",
      `${JSON.stringify(mcpPackage, null, 2)}\n`,
    );

    pdfPackage.dependencies["@stll/anonymize"] = `^${version}`;
    writeText(
      "packages/document-pdf/package.json",
      `${JSON.stringify(pdfPackage, null, 2)}\n`,
    );
    const pdfLegacyCheck = spawnSync("node", [syncScript, "--check"], {
      cwd: workspace,
      encoding: "utf8",
    });
    if (
      pdfLegacyCheck.status === 0 ||
      !pdfLegacyCheck.stderr.includes(`workspace:* or ${version}`)
    ) {
      throw new Error("PDF legacy dependency range was not rejected");
    }
    pdfPackage.dependencies["@stll/anonymize"] = "workspace:*";
    writeText(
      "packages/document-pdf/package.json",
      `${JSON.stringify(pdfPackage, null, 2)}\n`,
    );

    execFileSync("node", [syncScript, "--release"], {
      cwd: workspace,
      stdio: "pipe",
    });
    execFileSync("node", [syncScript, "--release", "--check"], {
      cwd: workspace,
      stdio: "pipe",
    });
    const releasedMcpPackage = JSON.parse(
      readFileSync(join(workspace, "packages/mcp/package.json"), "utf8"),
    );
    if (releasedMcpPackage.dependencies?.["@stll/anonymize"] !== version) {
      throw new Error("MCP release package did not resolve the exact version");
    }
    if (releasedMcpPackage.dependencies?.["@stll/anonymize-pdf"] !== version) {
      throw new Error(
        "MCP release package did not resolve the exact PDF version",
      );
    }

    const releasedPdfPackage = JSON.parse(
      readFileSync(
        join(workspace, "packages/document-pdf/package.json"),
        "utf8",
      ),
    );
    if (releasedPdfPackage.dependencies?.["@stll/anonymize"] !== version) {
      throw new Error("PDF release package did not resolve the exact version");
    }

    const lockText = readFileSync(join(workspace, "bun.lock"), "utf8");
    if (lockText.includes(staleVersion)) {
      throw new Error("bun.lock still contains stale sidecar versions");
    }
    const releasedLock = JSON.parse(lockText);
    if (
      releasedLock.workspaces?.["packages/mcp"]?.dependencies?.[
        "@stll/anonymize"
      ] !== version ||
      releasedLock.workspaces?.["packages/mcp"]?.dependencies?.[
        "@stll/anonymize-pdf"
      ] !== version
    ) {
      throw new Error("MCP release lock did not resolve the exact version");
    }
    if (
      releasedLock.workspaces?.["packages/document-pdf"]?.dependencies?.[
        "@stll/anonymize"
      ] !== version
    ) {
      throw new Error("PDF release lock did not resolve the exact version");
    }

    const sentinelRange = "SENTINEL_DO_NOT_MUTATE";
    releasedMcpPackage.dependencies["@stll/anonymize"] = "workspace:*";
    writeText(
      "packages/mcp/package.json",
      `${JSON.stringify(releasedMcpPackage, null, 2)}\n`,
    );
    delete releasedLock.workspaces["packages/mcp"].dependencies[
      "@stll/anonymize"
    ];
    releasedLock.workspaces["packages/z"] = {
      name: "@stll/z-sentinel",
      version,
      dependencies: { "@stll/anonymize": sentinelRange },
    };
    writeText("bun.lock", `${JSON.stringify(releasedLock, null, 2)}\n`);

    for (const arguments_ of [["--check"], ["--release"]]) {
      const missingDependency = spawnSync("node", [syncScript, ...arguments_], {
        cwd: workspace,
        encoding: "utf8",
      });
      if (
        missingDependency.status === 0 ||
        !missingDependency.stderr.includes(
          'expected exactly one direct "@stll/anonymize" property',
        )
      ) {
        throw new Error(
          `missing MCP lock dependency did not fail closed in ${arguments_.join(" ")} mode`,
        );
      }
      const sentinelLock = JSON.parse(
        readFileSync(join(workspace, "bun.lock"), "utf8"),
      );
      if (
        sentinelLock.workspaces?.["packages/z"]?.dependencies?.[
          "@stll/anonymize"
        ] !== sentinelRange
      ) {
        throw new Error("later-workspace sentinel dependency was mutated");
      }
    }
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
}

function writeFixture() {
  writeText("VERSION", `${version}\n`);
  writeText("Cargo.toml", `[workspace.package]\nversion = "${version}"\n`);
  writeText(
    "crates/anonymize-py/pyproject.toml",
    '[project]\ndynamic = ["version"]\n',
  );

  for (const file of packageFiles) {
    const name = packageNameFor(file);
    const pkg = { name, version };
    if (file === "packages/anonymize/package.json") {
      pkg.optionalDependencies = Object.fromEntries(
        sidecars.map((sidecar) => [sidecar, staleVersion]),
      );
    }
    if (file === "packages/cli/package.json") {
      pkg.dependencies = {
        "@stll/anonymize": `^${staleVersion}`,
        "@stll/anonymize-docx": `^${staleVersion}`,
        "@stll/anonymize-pdf": `^${staleVersion}`,
      };
    }
    if (file === "packages/document-docx/package.json") {
      pkg.dependencies = { "@stll/anonymize": `^${staleVersion}` };
    }
    if (file === "packages/document-pdf/package.json") {
      pkg.dependencies = { "@stll/anonymize": "workspace:*" };
    }
    if (file === "packages/mcp/package.json") {
      pkg.dependencies = {
        "@stll/anonymize": "workspace:*",
        "@stll/anonymize-docx": `^${staleVersion}`,
        "@stll/anonymize-pdf": "workspace:*",
      };
    }
    writeText(file, `${JSON.stringify(pkg, null, 2)}\n`);
  }

  writeText("bun.lock", bunLockFixture());
}

function packageNameFor(file) {
  if (file === "packages/anonymize/package.json") {
    return "@stll/anonymize";
  }
  if (file === "packages/anonymize/wasm/package.json") {
    return "@stll/anonymize-wasm";
  }
  if (file === "packages/cli/package.json") {
    return "@stll/anonymize-cli";
  }
  if (file === "packages/document-docx/package.json") {
    return "@stll/anonymize-docx";
  }
  if (file === "packages/document-pdf/package.json") {
    return "@stll/anonymize-pdf";
  }
  if (file === "packages/mcp/package.json") {
    return "@stll/anonymize-mcp";
  }
  return `@stll/${file.replace("packages/", "").replace("/package.json", "")}`;
}

function bunLockFixture() {
  return `${JSON.stringify(
    {
      lockfileVersion: 1,
      workspaces: {
        "packages/anonymize": {
          name: "@stll/anonymize",
          version,
          optionalDependencies: Object.fromEntries(
            sidecars.map((sidecar) => [sidecar, staleVersion]),
          ),
        },
        "packages/anonymize-darwin-arm64": {
          name: "@stll/anonymize-darwin-arm64",
          version,
        },
        "packages/anonymize-darwin-x64": {
          name: "@stll/anonymize-darwin-x64",
          version,
        },
        "packages/anonymize-linux-arm64-gnu": {
          name: "@stll/anonymize-linux-arm64-gnu",
          version,
        },
        "packages/anonymize-linux-x64-gnu": {
          name: "@stll/anonymize-linux-x64-gnu",
          version,
        },
        "packages/anonymize-win32-x64-msvc": {
          name: "@stll/anonymize-win32-x64-msvc",
          version,
        },
        "packages/anonymize/wasm": {
          name: "@stll/anonymize-wasm",
          version,
        },
        "packages/cli": {
          name: "@stll/anonymize-cli",
          version,
          dependencies: {
            "@stll/anonymize": `^${staleVersion}`,
            "@stll/anonymize-docx": `^${staleVersion}`,
            "@stll/anonymize-pdf": `^${staleVersion}`,
          },
        },
        "packages/document-docx": {
          name: "@stll/anonymize-docx",
          version,
          dependencies: { "@stll/anonymize": `^${staleVersion}` },
        },
        "packages/document-pdf": {
          name: "@stll/anonymize-pdf",
          version,
          dependencies: { "@stll/anonymize": "workspace:*" },
        },
        "packages/mcp": {
          name: "@stll/anonymize-mcp",
          version,
          dependencies: {
            "@stll/anonymize": "workspace:*",
            "@stll/anonymize-docx": `^${staleVersion}`,
            "@stll/anonymize-pdf": "workspace:*",
          },
        },
      },
    },
    null,
    2,
  )}\n`;
}

function writeText(file, text) {
  const path = join(workspace, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text.replaceAll("\n", lineEnding));
}
