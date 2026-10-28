#!/usr/bin/env bash
set -euo pipefail

artifact_root="$1"
consumer_directory="$2"
retry_script="$3"
shopt -s nullglob
tarballs=("$artifact_root"/*/*.tgz)
if (( ${#tarballs[@]} == 0 )); then
  echo "No packed npm packages found in $artifact_root" >&2
  exit 1
fi

# Only declared runtime dependencies may expose same-release artifacts to the
# consumer. Installing every artifact directly would hide undeclared CLI imports.
node --input-type=module - "$consumer_directory" "${tarballs[@]}" <<'NODE'
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";

const [consumer, ...tarballs] = process.argv.slice(2);
const packages = new Map();
for (const tarball of tarballs) {
  const file = path.resolve(tarball);
  const manifest = JSON.parse(execFileSync("tar", ["-xOf", file, "package/package.json"], {
    encoding: "utf-8",
    maxBuffer: 1024 * 1024,
  }));
  if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
    throw new Error(`Invalid packed package manifest: ${file}`);
  }
  if (packages.has(manifest.name)) {
    throw new Error(`Duplicate packed package: ${manifest.name}`);
  }
  packages.set(manifest.name, { manifest, spec: `file:${file}` });
}
const cli = packages.get("@stll/cli");
if (!cli) throw new Error("Missing packed @stll/cli");
const visited = new Set(["@stll/cli"]);
const pending = [cli];
const overrides = new Map();
for (const { manifest } of pending) {
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      if (visited.has(name)) continue;
      visited.add(name);
      const dependency = packages.get(name);
      if (!dependency) continue;
      overrides.set(name, dependency.spec);
      pending.push(dependency);
    }
  }
}
writeFileSync(path.join(consumer, "package.json"), JSON.stringify({
  private: true,
  dependencies: { "@stll/cli": cli.spec },
  overrides: Object.fromEntries(overrides),
}, null, 2));
NODE
cd "$consumer_directory"
bash "$retry_script" npm install --ignore-scripts --no-audit --no-fund
