import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import test from "node:test";

const workflow = readFileSync(
  new URL("../workflows/release.yml", import.meta.url),
  "utf8",
);

const startMarker = "          python3 - <<'PY'\n";
const start = workflow.indexOf(startMarker);
assert.notEqual(start, -1, "release workflow has no Python wheel validator");
const validatorStart = start + startMarker.length;
const validatorEnd = workflow.indexOf("\n          PY", validatorStart);
assert.notEqual(validatorEnd, -1, "Python wheel validator has no terminator");
const validator = workflow
  .slice(validatorStart, validatorEnd)
  .split("\n")
  .map((line) => {
    if (line === "") {
      return line;
    }
    assert.ok(
      line.startsWith("          "),
      `validator line is not indented: ${line}`,
    );
    return line.slice(10);
  })
  .join("\n");

const fixtureBuilder = String.raw`
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile
import os
import re

distribution_name = "stella_anonymize_core"
version_match = re.fullmatch(
    r"([0-9]+\.[0-9]+\.[0-9]+)(?:-(alpha|beta|rc)\.([0-9]+))?",
    os.environ["FIXTURE_VERSION"],
)
if version_match is None:
    raise SystemExit("invalid fixture version")
base_version, prerelease, prerelease_number = version_match.groups()
prerelease_label = {"alpha": "a", "beta": "b", "rc": "rc"}
wheel_version = base_version
if prerelease is not None:
    wheel_version += f"{prerelease_label[prerelease]}{prerelease_number}"

expected = {
    "python-wheel-x86_64-unknown-linux-gnu": (
        f"{distribution_name}-{wheel_version}-cp311-abi3-"
        "manylinux_2_17_x86_64.manylinux2014_x86_64.whl",
        [
            "cp311-abi3-manylinux_2_17_x86_64",
            "cp311-abi3-manylinux2014_x86_64",
        ],
    ),
    "python-wheel-aarch64-unknown-linux-gnu": (
        f"{distribution_name}-{wheel_version}-cp311-abi3-"
        "manylinux_2_17_aarch64.manylinux2014_aarch64.whl",
        [
            "cp311-abi3-manylinux_2_17_aarch64",
            "cp311-abi3-manylinux2014_aarch64",
        ],
    ),
    "python-wheel-x86_64-apple-darwin": (
        f"{distribution_name}-{wheel_version}-cp311-abi3-macosx_10_12_x86_64.whl",
        ["cp311-abi3-macosx_10_12_x86_64"],
    ),
    "python-wheel-aarch64-apple-darwin": (
        f"{distribution_name}-{wheel_version}-cp311-abi3-macosx_11_0_arm64.whl",
        ["cp311-abi3-macosx_11_0_arm64"],
    ),
    "python-wheel-x86_64-pc-windows-msvc": (
        f"{distribution_name}-{wheel_version}-cp311-abi3-win_amd64.whl",
        ["cp311-abi3-win_amd64"],
    ),
}

root = Path("wheel-artifacts")
root.mkdir()
mutation = os.environ.get("FIXTURE_MUTATION", "")
first_artifact = next(iter(expected))
for artifact_name, (filename, tags) in expected.items():
    if mutation == "missing-artifact" and artifact_name == first_artifact:
        continue
    artifact_dir = root / artifact_name
    artifact_dir.mkdir()
    wheel_path = artifact_dir / filename
    metadata_name = (
        "other-project"
        if mutation == "wrong-project" and artifact_name == first_artifact
        else "stella-anonymize-core"
    )
    metadata_version = (
        "999.0.0"
        if mutation == "wrong-version" and artifact_name == first_artifact
        else wheel_version
    )
    wheel_tags = (
        ["cp311-abi3-any"]
        if mutation == "wrong-tag" and artifact_name == first_artifact
        else tags
    )
    if mutation == "duplicate-tag" and artifact_name == first_artifact:
        wheel_tags = [*wheel_tags, wheel_tags[0]]

    dist_info = f"{distribution_name}-{wheel_version}.dist-info"
    metadata_path = f"{dist_info}/METADATA"
    with ZipFile(wheel_path, "w", ZIP_DEFLATED) as wheel:
        metadata = (
            "Metadata-Version: 2.4\n"
            f"Name: {metadata_name}\n"
            f"Version: {metadata_version}\n\n"
        )
        wheel.writestr(metadata_path, metadata)
        if mutation == "duplicate-metadata" and artifact_name == first_artifact:
            wheel.writestr(metadata_path, metadata)
        wheel.writestr(
            f"{dist_info}/WHEEL",
            "Wheel-Version: 1.0\n"
            "Root-Is-Purelib: false\n"
            + "".join(f"Tag: {tag}\n" for tag in wheel_tags),
        )

    if mutation == "extra-wheel" and artifact_name == first_artifact:
        (artifact_dir / "unexpected.whl").write_bytes(b"unexpected")

if mutation == "extra-artifact":
    (root / "python-wheel-unexpected").mkdir()
`;

const runPython = ({ source, directory, version, mutation = "" }) =>
  spawnSync("python3", ["-c", source], {
    cwd: directory,
    encoding: "utf8",
    env: {
      ...process.env,
      EXPECTED_VERSION: version,
      FIXTURE_MUTATION: mutation,
      FIXTURE_VERSION: version,
    },
  });

const prepareFixture = (context, { version, mutation = "" }) => {
  const directory = mkdtempSync(join(tmpdir(), "anonymize-wheel-contract-"));
  context.after(() => rmSync(directory, { force: true, recursive: true }));
  const result = runPython({
    source: fixtureBuilder,
    directory,
    version,
    mutation,
  });
  assert.equal(result.status, 0, result.stderr);
  return directory;
};

for (const version of [
  "2.9.0",
  "3.0.0-alpha.2",
  "3.0.0-beta.3",
  "3.0.0-rc.4",
]) {
  void test(`accepts the complete ${version} wheel matrix`, (context) => {
    const directory = prepareFixture(context, { version });
    const result = runPython({ source: validator, directory, version });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Validated 5 Python wheels/);
  });
}

for (const [mutation, error] of [
  ["missing-artifact", /Unexpected Python wheel artifact set/],
  ["extra-artifact", /Unexpected Python wheel artifact set/],
  ["extra-wheel", /must contain only/],
  ["wrong-project", /unexpected project name/],
  ["wrong-version", /unexpected version/],
  ["wrong-tag", /unexpected wheel tags/],
  ["duplicate-tag", /unexpected wheel tags/],
  ["duplicate-metadata", /must contain exactly one/],
]) {
  void test(`rejects ${mutation}`, (context) => {
    const version = "2.9.0";
    const directory = prepareFixture(context, { mutation, version });
    const result = runPython({ source: validator, directory, version });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, error);
  });
}
