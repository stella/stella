import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import process from "node:process";

const APACHE_LICENSE = "Apache-2.0";
const LEGAL_FILES = ["LICENSE", "NOTICE"];
const IGNORED_DIRECTORIES = new Set(["dist", "node_modules", "target"]);

const root = process.cwd();
const errors = [];
const rootLegalFiles = new Map(
  LEGAL_FILES.map((file) => [file, readFileSync(join(root, file), "utf8")]),
);

assertRootLicense();
assertNpmPackages();
assertPythonPackage();
assertRustPackages();

if (errors.length > 0) {
  for (const error of errors) {
    console.error(error);
  }
  process.exit(1);
}

console.log(
  "All workspace manifests use Apache-2.0 and published packages carry the canonical legal files.",
);

function assertRootLicense() {
  const packageJson = readJson(join(root, "package.json"));
  assertEqual(packageJson.license, APACHE_LICENSE, "package.json license");

  const license = rootLegalFiles.get("LICENSE") ?? "";
  if (
    !license.includes("Apache License\n                           Version 2.0")
  ) {
    errors.push("LICENSE must contain the canonical Apache License 2.0 text");
  }

  const workspaceManifest = readFileSync(join(root, "Cargo.toml"), "utf8");
  assertIncludes(
    workspaceManifest,
    `license = "${APACHE_LICENSE}"`,
    "Cargo.toml workspace license",
  );
}

function assertNpmPackages() {
  const manifests = findFiles(join(root, "packages"), "package.json");
  for (const manifest of manifests) {
    const packageJson = readJson(manifest);
    const directory = dirname(manifest);
    const label = relative(root, directory);
    assertEqual(packageJson.license, APACHE_LICENSE, `${label} license`);

    if (packageJson.private === true) {
      continue;
    }

    if (!Array.isArray(packageJson.files)) {
      errors.push(`${label} must define an explicit package files allowlist`);
      continue;
    }

    for (const [file, rootContents] of rootLegalFiles) {
      if (!packageJson.files.includes(file)) {
        errors.push(`${label} package files must include ${file}`);
      }
      assertFileMatchesRoot(directory, file, rootContents, label);
    }
  }
}

function assertPythonPackage() {
  const directory = join(root, "crates", "anonymize-py");
  const manifest = readFileSync(join(directory, "pyproject.toml"), "utf8");
  const projectSection = readTomlSection(manifest, "project");
  assertIncludes(
    projectSection,
    `license = "${APACHE_LICENSE}"`,
    "crates/anonymize-py project license",
  );
  assertIncludes(
    projectSection,
    'license-files = ["LICENSE", "NOTICE"]',
    "crates/anonymize-py project license files",
  );
  for (const [file, rootContents] of rootLegalFiles) {
    assertFileMatchesRoot(directory, file, rootContents, "crates/anonymize-py");
  }
}

function assertRustPackages() {
  const manifests = findFiles(join(root, "crates"), "Cargo.toml");
  for (const manifest of manifests) {
    const contents = readFileSync(manifest, "utf8");
    const label = relative(root, manifest);
    assertIncludes(contents, "license.workspace = true", `${label} license`);
    assertIncludes(contents, "publish.workspace = true", `${label} publish`);
  }
}

function assertFileMatchesRoot(directory, file, rootContents, label) {
  let contents;
  try {
    contents = readFileSync(join(directory, file), "utf8");
  } catch {
    errors.push(`${label} is missing ${file}`);
    return;
  }
  if (contents !== rootContents) {
    errors.push(`${label}/${file} must match the repository root ${file}`);
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    errors.push(`${label} must be ${JSON.stringify(expected)}`);
  }
}

function assertIncludes(contents, expected, label) {
  if (!contents.includes(expected)) {
    errors.push(`${label} must include ${JSON.stringify(expected)}`);
  }
}

function findFiles(start, filename) {
  const matches = [];
  const pending = [start];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) {
      continue;
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) {
          pending.push(join(directory, entry.name));
        }
        continue;
      }
      if (entry.name === filename) {
        matches.push(join(directory, entry.name));
      }
    }
  }
  return matches.sort((left, right) => left.localeCompare(right));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readTomlSection(contents, section) {
  const lines = contents.split("\n");
  const start = lines.indexOf(`[${section}]`);
  if (start === -1) {
    return "";
  }
  const rest = lines.slice(start + 1);
  const length = rest.findIndex((line) => line.startsWith("["));
  return rest.slice(0, length === -1 ? undefined : length).join("\n");
}
