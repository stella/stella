import { panic } from "better-result";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

const stepSchema = v.object({
  id: v.optional(v.string()),
  run: v.optional(v.string()),
  uses: v.optional(v.string()),
  with: v.optional(v.record(v.string(), v.unknown())),
});

const workflow = v.parse(
  v.object({
    jobs: v.object({
      manifest: v.object({ steps: v.array(stepSchema) }),
      "publish-chrome-extension": v.object({
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

test("the store job federates only from its environment, after publication", () => {
  expect(storeJob.environment).toBe("chrome-web-store");
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

test.each([
  { name: "a release without a package submits nothing", assets: "", zip: "" },
  {
    name: "a release with its package hands it to the store steps",
    assets: "release-manifest.json\nstella-extension-chrome-1.2.3.zip\n",
    zip: "stella-extension-chrome-1.2.3.zip",
  },
])("$name", async ({ assets, zip }) => {
  const directory = await mkdtemp(path.join(tmpdir(), "extension-store-"));
  const outputPath = path.join(directory, "github-output");
  const runnerTemp = path.join(directory, "runner");
  await Bun.write(outputPath, "");
  // Stands in for the GitHub CLI: lists the assets, records a download.
  await Bun.write(
    path.join(directory, "scripts/gh-retry.sh"),
    `case "$2" in view) printf '%s' "$ASSETS" ;; download) echo "$@" > "$RUNNER_TEMP/download" ;; esac\n`,
  );
  try {
    await mkdir(runnerTemp);
    const result = Bun.spawnSync(["bash", "-e", "-c", storeDownloadStep], {
      cwd: directory,
      env: {
        ...process.env,
        ASSETS: assets,
        GITHUB_OUTPUT: outputPath,
        RELEASE_REF: "v1.2.3",
        RUNNER_TEMP: runnerTemp,
        VERSION: "1.2.3",
      },
    });
    expect(result.exitCode).toBe(0);
    const output = await Bun.file(outputPath).text();
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
