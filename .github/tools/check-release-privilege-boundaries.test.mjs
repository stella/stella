import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

const workflow = readFileSync(
  new URL("../workflows/release.yml", import.meta.url),
  "utf8",
);

const DOWNLOAD_ARTIFACT =
  "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c";
const SETUP_NODE =
  "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020";
const HARDENED_NPM_PUBLISH =
  "stella/.github/.github/actions/npm-publish-hardened@48aacae31829ce15216a6b766b03a92fd2e84da3";
const PYPI_PUBLISH =
  "pypa/gh-action-pypi-publish@dc37677b2e1c63e2034f94d8a5b11f265b73ba33";
const NPM_FINALIZER =
  "stella/.github/.github/workflows/npm-version-finalize.yml@1ce0079bbdbf93a4c1917d2857496b89aedcec14";

const EXPECTED_PERMISSIONS = new Map([
  ["verify", { contents: "read" }],
  ["pack-native", { contents: "read" }],
  ["pack-runtime", { contents: "read" }],
  ["pack-data", { contents: "read" }],
  ["publish-data", { contents: "read", "id-token": "write" }],
  ["build-wheels", { contents: "read" }],
  ["publish-pypi", { "id-token": "write" }],
  ["github-release", { contents: "write", "id-token": "write" }],
]);

const EXPECTED_PRIVILEGED_JOBS = [
  "github-release",
  "publish-data",
  "publish-pypi",
];

const EXPECTED_RELEASE_SECRETS = {
  CHANGELOG_APP_ID: "${{ secrets.CHANGELOG_APP_ID }}",
  CHANGELOG_APP_PRIVATE_KEY: "${{ secrets.CHANGELOG_APP_PRIVATE_KEY }}",
  RELEASE_APP_ID: "${{ secrets.RELEASE_APP_ID }}",
  RELEASE_APP_PRIVATE_KEY: "${{ secrets.RELEASE_APP_PRIVATE_KEY }}",
};

// Privileged shell bodies are exact allowlists. The Python validator also has
// fixture-based behavior coverage in check-python-release-wheels.test.mjs.
const DATA_TARBALL_VALIDATION_HASH =
  "b1d21b0f5aaac74d5780c1b6c9cea249166a7c648025bcf4945640cbf13a5d28";
const PYTHON_WHEEL_VALIDATION_HASH =
  "5c68b955640ddbadd93b12a485d2e68613f0c426ebd40e6d99b2b6406674871b";
const PRIVILEGED_JOB_HASHES = {
  "github-release":
    "2c524ff8b2d3eaeb37a974c74996e9b8c8bf7c89e15455b639101a0c21eb39d4",
  "publish-data":
    "2df7509cbb72ebcc3803575cc282332363b2b68ea96d847175da34f437a80ffe",
  "publish-pypi":
    "32b512ef72ad75821c022c395e5f54e214707eb597d9a53f43adcf7652588664",
};
const byName = (left, right) => left.localeCompare(right);

const normalizeScalar = (value) => {
  const withoutComment = value.replace(/\s+#.*$/, "").trim();
  if (
    (withoutComment.startsWith('"') && withoutComment.endsWith('"')) ||
    (withoutComment.startsWith("'") && withoutComment.endsWith("'"))
  ) {
    return withoutComment.slice(1, -1);
  }
  return withoutComment;
};

const parseJobs = (source) => {
  const jobsStart = source.indexOf("\njobs:\n");
  assert.notEqual(jobsStart, -1, "release workflow has no jobs section");
  const jobsText = source.slice(jobsStart + "\njobs:\n".length);
  const headers = [
    ...jobsText.matchAll(
      /^  (?:(?:"([A-Za-z_][A-Za-z0-9_-]*)")|(?:'([A-Za-z_][A-Za-z0-9_-]*)')|([A-Za-z_][A-Za-z0-9_-]*)):\s*$/gm,
    ),
  ];
  return new Map(
    headers.map((header, index) => [
      header[1] ?? header[2] ?? header[3],
      jobsText.slice(
        header.index,
        headers[index + 1]?.index ?? jobsText.length,
      ),
    ]),
  );
};

const parseMap = (text, key, indentation) => {
  const lines = text.split("\n");
  const prefix = " ".repeat(indentation);
  const childPrefix = " ".repeat(indentation + 2);
  const start = lines.findIndex((line) => line === `${prefix}${key}:`);
  assert.notEqual(start, -1, `${key} map is missing`);

  const entries = {};
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) {
      continue;
    }
    const leadingSpaces = line.length - line.trimStart().length;
    if (leadingSpaces <= indentation) {
      break;
    }
    const match = line.match(
      new RegExp(`^${childPrefix}([A-Za-z0-9_-]+):\\s*(.+)$`),
    );
    assert.ok(match, `${key} contains a nested or malformed entry: ${line}`);
    assert.equal(
      entries[match[1]],
      undefined,
      `${key}.${match[1]} is duplicated`,
    );
    entries[match[1]] = normalizeScalar(match[2]);
  }
  return entries;
};

const parseScalar = (text, key, indentation) => {
  const prefix = " ".repeat(indentation);
  const match = text.match(new RegExp(`^${prefix}${key}:\\s*(.+)$`, "m"));
  assert.ok(match, `${key} is missing`);
  return normalizeScalar(match[1]);
};

const parseSteps = (jobBody) => {
  const lines = jobBody.split("\n");
  const stepsStart = lines.findIndex((line) => line === "    steps:");
  assert.notEqual(stepsStart, -1, "steps are missing");
  const starts = [];
  for (let index = stepsStart + 1; index < lines.length; index += 1) {
    if (/^      - (?:name|uses):/.test(lines[index])) {
      starts.push(index);
    }
  }

  return starts.map((start, index) => {
    const block = lines.slice(start, starts[index + 1] ?? lines.length);
    const first = block[0].match(/^      - (name|uses):\s*(.+)$/);
    assert.ok(first, `malformed step: ${block[0]}`);
    const name =
      first[1] === "name"
        ? normalizeScalar(first[2])
        : block
            .find((line) => line.startsWith("        name:"))
            ?.replace(/^        name:\s*/, "");
    const uses =
      first[1] === "uses"
        ? normalizeScalar(first[2])
        : block
            .find((line) => line.startsWith("        uses:"))
            ?.replace(/^        uses:\s*/, "");
    const runIndex = block.findIndex((line) => line.startsWith("        run:"));
    let run;
    if (runIndex !== -1) {
      const runHeader = block[runIndex].replace(/^        run:\s*/, "");
      if (runHeader === "|") {
        run = block
          .slice(runIndex + 1)
          .filter((line) => line.trim() !== "" || line.startsWith("          "))
          .map((line) => {
            assert.ok(
              line === "" || line.startsWith("          "),
              `run block contains an unexpected sibling: ${line}`,
            );
            return line.slice(10);
          })
          .join("\n")
          .trimEnd();
      } else {
        run = normalizeScalar(runHeader);
      }
    }

    return {
      env: block.includes("        env:")
        ? parseMap(block.join("\n"), "env", 8)
        : {},
      name: name === undefined ? undefined : normalizeScalar(name),
      run,
      uses: uses === undefined ? undefined : normalizeScalar(uses),
      with: block.includes("        with:")
        ? parseMap(block.join("\n"), "with", 8)
        : {},
    };
  });
};

const hashRun = (run) =>
  createHash("sha256")
    .update(run ?? "")
    .digest("hex");

const assertSteps = (jobName, actual, expected) => {
  assert.equal(actual.length, expected.length, `${jobName} step count changed`);
  for (const [index, contract] of expected.entries()) {
    const step = actual[index];
    assert.equal(
      step.name,
      contract.name,
      `${jobName} step ${index} name changed`,
    );
    assert.equal(
      step.uses,
      contract.uses,
      `${jobName} step ${index} action changed`,
    );
    assert.deepEqual(
      step.with,
      contract.with ?? {},
      `${jobName} step ${index} inputs changed`,
    );
    assert.deepEqual(
      step.env,
      contract.env ?? {},
      `${jobName} step ${index} environment changed`,
    );
    if (contract.run !== undefined) {
      assert.equal(
        step.run,
        contract.run,
        `${jobName} step ${index} run changed`,
      );
    } else if (contract.runHash !== undefined) {
      assert.equal(
        hashRun(step.run),
        contract.runHash,
        `${jobName} step ${index} run contract changed: ${hashRun(step.run)}`,
      );
    } else {
      assert.equal(
        step.run,
        undefined,
        `${jobName} step ${index} gained a run`,
      );
    }
  }
};

const assertRuntimePackageBinding = (jobs) => {
  const body = jobs.get("github-release");
  assert.ok(body, "release workflow is missing github-release");
  assert.equal(parseScalar(body, "uses", 4), NPM_FINALIZER);
  assert.match(
    body,
    /^    needs: \[verify, pack-native, pack-runtime, publish-pypi\]$/m,
  );
  assert.match(body, /^      artifact-pattern: npm-tarball-\*$/m);
  assert.match(body, /^      publish-to-npm: true$/m);
  assert.match(body, /^      update-changelog: false$/m);
  assert.deepEqual(parseMap(body, "secrets", 4), EXPECTED_RELEASE_SECRETS);

  const packageFiles = [
    ...body.matchAll(/^        (packages\/.+\/package\.json)$/gm),
  ].map((match) => match[1]);
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
    ...jobs
      .get("pack-native")
      .matchAll(/^          - package: (packages\/.+)$/gm),
    ...jobs.get("pack-runtime").matchAll(/^          - (packages\/.+)$/gm),
  ].map((match) => match[1]);
  assert.deepEqual(
    packedDirectories
      .map((directory) => `${directory}/package.json`)
      .toSorted(byName),
    packageFiles.toSorted(byName),
  );
};

const auditWorkflow = (source) => {
  const jobsStart = source.indexOf("\njobs:\n");
  const workflowScope = source.slice(0, jobsStart);
  assert.equal(
    [...workflowScope.matchAll(/^permissions:\s*\{\}\s*$/gm)].length,
    1,
    "workflow must define one default-deny permissions map",
  );
  assert.deepEqual(parseMap(workflowScope, "env", 0), {
    NPM_VERSION: "11.11.1",
    UV_VERSION: "0.10.1",
  });

  const jobs = parseJobs(source);
  assert.deepEqual([...jobs.keys()], [...EXPECTED_PERMISSIONS.keys()]);
  for (const [name, permissions] of EXPECTED_PERMISSIONS) {
    assert.deepEqual(
      parseMap(jobs.get(name), "permissions", 4),
      permissions,
      `${name} permissions changed`,
    );
  }

  const privilegedJobs = [...jobs]
    .filter(
      ([, body]) => parseMap(body, "permissions", 4)["id-token"] === "write",
    )
    .map(([name]) => name)
    .toSorted(byName);
  assert.deepEqual(privilegedJobs, EXPECTED_PRIVILEGED_JOBS);
  assert.deepEqual(parseMap(jobs.get("verify"), "outputs", 4), {
    dist_tag: "${{ steps.dist-tag.outputs.dist_tag }}",
    publish_data: "${{ steps.release-scope.outputs.publish_data }}",
    publish_runtime: "${{ steps.release-scope.outputs.publish_runtime }}",
    version: "${{ steps.dist-tag.outputs.version }}",
  });
  assert.match(
    jobs.get("verify"),
    /echo "version=\$version" >> "\$GITHUB_OUTPUT"/,
  );

  assertSteps("publish-data", parseSteps(jobs.get("publish-data")), [
    {
      uses: DOWNLOAD_ARTIFACT,
      with: {
        name: "data-package-stll-anonymize-data",
        path: "data-tarball",
      },
    },
    {
      uses: SETUP_NODE,
      with: {
        "node-version": "22",
        "registry-url": "https://registry.npmjs.org",
      },
    },
    {
      name: "Install npm for trusted publishing",
      run: 'npm install --global --ignore-scripts "npm@${NPM_VERSION}"',
    },
    {
      name: "Find data package tarball",
      runHash: DATA_TARBALL_VALIDATION_HASH,
    },
    {
      name: "Publish data package",
      uses: HARDENED_NPM_PUBLISH,
      with: {
        tag: "${{ needs.pack-data.outputs.dist_tag }}",
        tarball: "${{ steps.tarball.outputs.path }}",
      },
    },
  ]);

  assertSteps("publish-pypi", parseSteps(jobs.get("publish-pypi")), [
    {
      uses: DOWNLOAD_ARTIFACT,
      with: {
        path: "wheel-artifacts",
        pattern: "python-wheel-*",
      },
    },
    {
      env: { EXPECTED_VERSION: "${{ needs.verify.outputs.version }}" },
      name: "Validate Python wheel artifacts",
      runHash: PYTHON_WHEEL_VALIDATION_HASH,
    },
    {
      name: "Publish to PyPI",
      uses: PYPI_PUBLISH,
      with: { "packages-dir": "dist", "skip-existing": "true" },
    },
  ]);

  assertRuntimePackageBinding(jobs);
  for (const name of EXPECTED_PRIVILEGED_JOBS) {
    assert.equal(
      createHash("sha256").update(jobs.get(name)).digest("hex"),
      PRIVILEGED_JOB_HASHES[name],
      `${name} complete privileged job contract changed`,
    );
  }
};

const mutateJob = (source, name, mutate) => {
  const jobs = parseJobs(source);
  const body = jobs.get(name);
  assert.ok(body, `cannot mutate missing ${name}`);
  return source.replace(body, mutate(body));
};

void test("release workflow matches the exact privilege contract", () => {
  auditWorkflow(workflow);
});

void test("permission and secret mutations fail closed", () => {
  assert.throws(
    () => auditWorkflow(workflow.replace("\npermissions: {}\n", "\n")),
    /default-deny permissions/,
  );
  assert.throws(
    () =>
      auditWorkflow(
        mutateJob(workflow, "publish-data", (body) =>
          body.replace("      contents: read\n", "      actions: write\n"),
        ),
      ),
    /publish-data permissions changed/,
  );
  assert.throws(
    () =>
      auditWorkflow(
        mutateJob(workflow, "pack-runtime", (body) =>
          body.replace("      contents: read\n", "      id-token: write\n"),
        ),
      ),
    /pack-runtime permissions changed/,
  );
  assert.throws(
    () =>
      auditWorkflow(
        mutateJob(workflow, "github-release", (body) =>
          body.replace(
            "      RELEASE_APP_ID:",
            "      NPM_TOKEN: ${{ secrets.NPM_TOKEN }}\n      RELEASE_APP_ID:",
          ),
        ),
      ),
    /Expected values to be strictly deep-equal/,
  );
});

void test("complete privileged jobs and all valid job IDs fail closed", () => {
  for (const mutation of [
    mutateJob(workflow, "publish-pypi", (body) =>
      body.replace(
        "          pattern: python-wheel-*",
        "          repository: attacker/repository\n          pattern: python-wheel-*",
      ),
    ),
    mutateJob(workflow, "publish-pypi", (body) =>
      body.replace(
        "      - name: Validate Python wheel artifacts\n        env:",
        "      - name: Validate Python wheel artifacts\n        shell: bash -c 'echo unreviewed; {0}'\n        env:",
      ),
    ),
  ]) {
    assert.throws(
      () => auditWorkflow(mutation),
      /inputs changed|complete privileged job contract changed/,
    );
  }

  const hiddenJob = `${workflow}\n  '_publish':\n    permissions:\n      id-token: write\n    steps:\n      - run: make\n`;
  assert.throws(() => auditWorkflow(hiddenJob));
});

void test("privileged step mutations fail closed", () => {
  assert.throws(
    () =>
      auditWorkflow(
        mutateJob(workflow, "publish-data", (body) =>
          body.replace(
            'npm install --global --ignore-scripts "npm@${NPM_VERSION}"',
            "npm ci",
          ),
        ),
      ),
    /run changed/,
  );
  assert.throws(
    () =>
      auditWorkflow(
        mutateJob(workflow, "publish-pypi", (body) =>
          body.replace(
            'project_name = "stella-anonymize-core"',
            'project_name = "other-project"',
          ),
        ),
      ),
    /run contract changed/,
  );
  assert.throws(
    () =>
      auditWorkflow(
        mutateJob(workflow, "publish-pypi", (body) =>
          body.replace(
            "          path: wheel-artifacts",
            "          path: wheel-artifacts\n          merge-multiple: true",
          ),
        ),
      ),
    /inputs changed/,
  );
  assert.throws(
    () =>
      auditWorkflow(
        mutateJob(workflow, "publish-pypi", (body) =>
          body.replace("          skip-existing: true\n", ""),
        ),
      ),
    /inputs changed/,
  );
  assert.throws(
    () =>
      auditWorkflow(
        mutateJob(workflow, "publish-pypi", (body) =>
          body.replace(
            "      - name: Publish to PyPI",
            "      - name: Build again\n        run: node scripts/build-release.mjs\n\n      - name: Publish to PyPI",
          ),
        ),
      ),
    /step count changed/,
  );
});
