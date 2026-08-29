import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(
  new URL("../workflows/release.yml", import.meta.url),
  "utf8",
);
const byName = (left, right) => left.localeCompare(right);

const parseJobs = (source) => {
  const marker = source.match(/^jobs:\n/m);
  assert.ok(marker, "release workflow has no jobs section");
  const jobsSource = source.slice(marker.index + marker[0].length);
  const matches = [...jobsSource.matchAll(/^  ([A-Za-z_][A-Za-z0-9_-]*):\n/gm)];
  return Object.fromEntries(
    matches.map((match, index) => [
      match[1],
      jobsSource.slice(
        match.index,
        matches.at(index + 1)?.index ?? jobsSource.length,
      ),
    ]),
  );
};

const jobs = parseJobs(workflow);

const finalizerPackageFiles = (source) => {
  const block = source.match(/^      package-files: \|\n((?:        .+\n)+)/m);
  assert.ok(block, "finalizer package-files input is missing");
  return block[1]
    .trim()
    .split("\n")
    .map((line) => line.trim());
};

void test("finalizer package manifests equal the fixed release group and pack matrices", () => {
  const packageFiles = finalizerPackageFiles(jobs["github-release"]);
  const configuredPackages = JSON.parse(
    readFileSync(
      new URL("../../.changeset/config.json", import.meta.url),
      "utf8",
    ),
  ).fixed.at(0);
  const finalizedPackages = packageFiles.map(
    (packageFile) =>
      JSON.parse(
        readFileSync(new URL(`../../${packageFile}`, import.meta.url), "utf8"),
      ).name,
  );
  assert.deepEqual(
    finalizedPackages.toSorted(byName),
    configuredPackages.toSorted(byName),
  );

  const packedDirectories = [
    ...jobs["pack-native"].matchAll(/^          - package: (packages\/.+)$/gm),
    ...jobs["pack-runtime"].matchAll(/^          - (packages\/.+)$/gm),
  ].map((match) => match[1]);
  assert.deepEqual(
    packedDirectories
      .map((directory) => `${directory}/package.json`)
      .toSorted(byName),
    packageFiles.toSorted(byName),
  );
});

void test("caller binds finalization and data publishing to its exact artifacts", () => {
  assert.match(
    jobs["github-release"],
    /^      artifact-pattern: npm-tarball-\*$/m,
  );
  assert.match(jobs["github-release"], /^      publish-to-npm: true$/m);
  assert.match(jobs["github-release"], /^      update-changelog: false$/m);
  assert.match(
    jobs["publish-data"],
    /^      artifact-name: data-package-stll-anonymize-data$/m,
  );
  assert.match(
    jobs["publish-data"],
    /^      package-name: "@stll\/anonymize-data"$/m,
  );
  assert.match(
    jobs["publish-data"],
    /^      version: \$\{\{ needs\.pack-data\.outputs\.version \}\}$/m,
  );
  assert.match(
    jobs["publish-data"],
    /^      dist-tag: \$\{\{ needs\.pack-data\.outputs\.dist_tag \}\}$/m,
  );
});

void test("manual publishing fails closed outside main", () => {
  assert.match(jobs.verify, /github\.ref != 'refs\/heads\/main'/);
  assert.match(jobs.verify, /inputs\.publish_to_npm/);
});
