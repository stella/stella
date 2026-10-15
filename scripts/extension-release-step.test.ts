import { panic } from "better-result";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

const workflow = v.parse(
  v.object({
    jobs: v.object({
      manifest: v.object({
        steps: v.array(
          v.object({
            id: v.optional(v.string()),
            run: v.optional(v.string()),
          }),
        ),
      }),
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
