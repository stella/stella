import { panic } from "better-result";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

const stepSchema = v.object({
  id: v.optional(v.string()),
  if: v.optional(v.string()),
  name: v.optional(v.string()),
  run: v.optional(v.string()),
  uses: v.optional(v.string()),
  with: v.optional(v.record(v.string(), v.unknown())),
});

const workflow = v.parse(
  v.object({
    jobs: v.object({
      manifest: v.object({ steps: v.array(stepSchema) }),
      "publish-chrome-extension": v.object({
        concurrency: v.object({
          group: v.string(),
          "cancel-in-progress": v.boolean(),
        }),
        environment: v.string(),
        if: v.string(),
        needs: v.array(v.string()),
        permissions: v.record(v.string(), v.string()),
        steps: v.array(stepSchema),
      }),
      "release-complete": v.object({ needs: v.array(v.string()) }),
    }),
  }),
  Bun.YAML.parse(
    await Bun.file(
      new URL("../.github/workflows/release.yml", import.meta.url),
    ).text(),
  ),
);
const packagingStep =
  workflow.jobs.manifest.steps.find(({ id }) => id === "extension-zip")?.run ??
  panic("Release workflow must declare the extension packaging step");
const storeJob = workflow.jobs["publish-chrome-extension"];
const storeDownloadStep =
  storeJob.steps.find(({ id }) => id === "package")?.run ??
  panic("The store job must declare the package download step");
const storeAttestationStep =
  storeJob.steps.find(({ id }) => id === "verify-extension")?.run ??
  panic("The store job must verify the package build attestation");

test("the store job federates only from its environment, after publication", () => {
  expect(storeJob.environment).toBe("chrome-web-store");
  expect(storeJob.concurrency).toEqual({
    group: "chrome-web-store-submit",
    "cancel-in-progress": false,
  });
  expect(storeJob.permissions).toEqual({
    contents: "read",
    "id-token": "write",
  });
  expect(storeJob.needs).toContain("publish-release");
  expect(storeJob.if).toContain("needs.resolve.outputs.channel == 'final'");
  expect(storeJob.if).toContain("needs.publish-release.result == 'success'");
  // A store refusal must never hold back the release receipts.
  expect(workflow.jobs["release-complete"].needs).not.toContain(
    "publish-chrome-extension",
  );
  const auth = storeJob.steps.find(({ id }) => id === "google");
  expect(auth?.uses).toMatch(/^google-github-actions\/auth@[0-9a-f]{40}$/u);
  expect(auth?.with).toMatchObject({
    access_token_scopes: "https://www.googleapis.com/auth/chromewebstore",
    create_credentials_file: false,
    token_format: "access_token",
  });
  expect(storeJob.steps.at(-1)?.run).toContain(
    "apps/extension/scripts/publish-store.ts",
  );
});

test("the built ZIP is attested and verified before minting the store token", () => {
  const attestation = workflow.jobs.manifest.steps.find(({ uses }) =>
    uses?.startsWith("actions/attest@"),
  );
  expect(attestation?.uses).toMatch(/^actions\/attest@[0-9a-f]{40}$/u);
  expect(attestation?.if).toBe(
    "steps.extension-zip.outputs.packaged == 'true'",
  );
  expect(attestation?.with).toEqual({
    "subject-path": `apps/extension/.output/stella-extension-chrome-\${{ needs.resolve.outputs.version }}.zip`,
    "predicate-type": "https://stll.app/attestations/extension-publication/v1",
    "predicate-path": "extension-publication.json",
  });
  const verificationIndex = storeJob.steps.findIndex(
    ({ id }) => id === "verify-extension",
  );
  expect(verificationIndex).toBeGreaterThan(
    storeJob.steps.findIndex(({ id }) => id === "package"),
  );
  expect(verificationIndex).toBeLessThan(
    storeJob.steps.findIndex(({ id }) => id === "google"),
  );
  expect(storeJob.steps.at(verificationIndex)?.if).toBe(
    "steps.package.outputs.zip != ''",
  );
});

test.each([
  {
    name: "a release without a package submits nothing",
    assets: "",
    zip: "",
    queryExit: 0,
  },
  {
    name: "a release with its package hands it to the store steps",
    assets: "release-manifest.json\nstella-extension-chrome-1.2.3.zip\n",
    zip: "stella-extension-chrome-1.2.3.zip",
    queryExit: 0,
  },
  {
    name: "a failed asset query fails the submission job",
    assets: "stella-extension-chrome-1.2.3.zip\n",
    zip: "",
    queryExit: 42,
  },
])("$name", async ({ assets, zip, queryExit }) => {
  const directory = await mkdtemp(path.join(tmpdir(), "extension-store-"));
  const outputPath = path.join(directory, "github-output");
  const runnerTemp = path.join(directory, "runner");
  await Bun.write(outputPath, "");
  // Stands in for the GitHub CLI: lists the assets, records a download.
  await Bun.write(
    path.join(directory, "scripts/gh-retry.sh"),
    `case "$2" in view) printf '%s' "$ASSETS"; exit "$QUERY_EXIT" ;; download) echo "$@" > "$RUNNER_TEMP/download" ;; esac\n`,
  );
  try {
    await mkdir(runnerTemp);
    const result = Bun.spawnSync(["bash", "-e", "-c", storeDownloadStep], {
      cwd: directory,
      env: {
        ...process.env,
        ASSETS: assets,
        QUERY_EXIT: String(queryExit),
        GITHUB_OUTPUT: outputPath,
        RELEASE_REF: "v1.2.3",
        RUNNER_TEMP: runnerTemp,
        VERSION: "1.2.3",
      },
    });
    expect(result.exitCode).toBe(queryExit);
    const output = await Bun.file(outputPath).text();
    if (queryExit !== 0) {
      expect(output).toBe("");
      expect(result.stdout.toString()).not.toContain("no extension package");
      expect(await Bun.file(path.join(runnerTemp, "download")).exists()).toBe(
        false,
      );
      return;
    }
    if (zip === "") {
      expect(output).toBe("");
      expect(result.stdout.toString()).toContain("no extension package");
    } else {
      expect(output).toBe(`zip=${runnerTemp}/extension/${zip}\n`);
      expect(
        await Bun.file(path.join(runnerTemp, "download")).text(),
      ).toContain(`release download v1.2.3 --pattern ${zip}`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.each([
  {
    name: "the release candidate's verified ZIP is accepted",
    releaseRef: "v1.2.3-rc.4",
    version: "1.2.3",
    verificationExit: 0,
    accepted: true,
  },
  {
    name: "another candidate's verified ZIP is refused",
    releaseRef: "v1.2.3-rc.3",
    version: "1.2.3",
    verificationExit: 0,
    accepted: false,
  },
  {
    name: "another version's verified ZIP is refused",
    releaseRef: "v1.2.3-rc.4",
    version: "1.2.2",
    verificationExit: 0,
    accepted: false,
  },
  {
    name: "failed attestation verification is refused even with a matching predicate",
    releaseRef: "v1.2.3-rc.4",
    version: "1.2.3",
    verificationExit: 42,
    accepted: false,
  },
])("$name", async ({ releaseRef, version, verificationExit, accepted }) => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "extension-attestation-"),
  );
  const argumentsPath = path.join(directory, "arguments");
  const zip = path.join(directory, "extension.zip");
  await Bun.write(
    path.join(directory, "scripts/retry.sh"),
    `printf '%s\\n' "$@" > "$ARGUMENTS_PATH"\nprintf '%s' "$VERIFICATION"\nexit "$VERIFICATION_EXIT"\n`,
  );
  try {
    const result = Bun.spawnSync(["bash", "-e", "-c", storeAttestationStep], {
      cwd: directory,
      env: {
        ...process.env,
        ARGUMENTS_PATH: argumentsPath,
        GITHUB_REPOSITORY: "stella/stella",
        RC_REF: "v1.2.3-rc.4",
        VERSION: "1.2.3",
        ZIP: zip,
        VERIFICATION: JSON.stringify([
          {
            verificationResult: {
              statement: { predicate: { releaseRef, version } },
            },
          },
        ]),
        VERIFICATION_EXIT: String(verificationExit),
      },
    });
    expect(result.exitCode === 0).toBe(accepted);
    const args = (await Bun.file(argumentsPath).text()).trimEnd().split("\n");
    expect(args).toEqual([
      "gh",
      "attestation",
      "verify",
      zip,
      "--repo",
      "stella/stella",
      "--cert-identity-regex",
      "^https://github\\.com/stella/stella/\\.github/workflows/release\\.yml@(refs/tags/v1\\.2\\.3-rc\\.4|refs/heads/main)$",
      "--predicate-type",
      "https://stll.app/attestations/extension-publication/v1",
      "--deny-self-hosted-runners",
      "--format",
      "json",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.each([
  {
    name: "historical release sources skip extension packaging",
    script: null,
    exitCode: 0,
    receipt: "",
    notice: "predates Chrome extension packaging",
  },
  {
    name: "supported release sources produce an upload receipt",
    script: "printf 'source package built\\n'\n",
    exitCode: 0,
    receipt: "packaged=true\n",
    notice: "source package built",
  },
  {
    name: "a supported source build failure blocks the release",
    script: "exit 42\n",
    exitCode: 42,
    receipt: "",
    notice: "",
  },
])("$name", async ({ script, exitCode, receipt, notice }) => {
  const directory = await mkdtemp(path.join(tmpdir(), "extension-release-"));
  const outputPath = path.join(directory, "github-output");
  await Bun.write(outputPath, "");
  try {
    if (script !== null) {
      await mkdir(path.join(directory, "apps/extension/scripts"), {
        recursive: true,
      });
      await Bun.write(
        path.join(directory, "apps/extension/scripts/release-zip.sh"),
        script,
      );
    }
    const result = Bun.spawnSync(["bash", "-e", "-c", packagingStep], {
      cwd: directory,
      env: { ...process.env, GITHUB_OUTPUT: outputPath },
    });
    expect(result.exitCode).toBe(exitCode);
    expect(await Bun.file(outputPath).text()).toBe(receipt);
    if (notice !== "") {
      expect(result.stdout.toString()).toContain(notice);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
