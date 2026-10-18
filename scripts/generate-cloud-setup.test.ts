import { expect, test } from "bun:test";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { generateCloudSetupArtifacts } from "./generate-cloud-setup";
import { writeOrCheckArtifacts } from "./generated-artifacts";

const root = path.resolve(import.meta.dir, "..");
const regeneration = "bun scripts/generate-cloud-setup.ts --write";

const expectCloudSetupPins = ({
  packageManager,
  nodeVersion,
  script,
  tools,
}: {
  packageManager: string;
  nodeVersion: string;
  script: string;
  tools: Record<string, string>;
}) => {
  const bunVersion = /^bun@(.+)$/u.exec(packageManager)?.at(1);
  expect(
    script,
    `package.json packageManager must match .agents/cloud-setup.sh BUN_VERSION; change package.json or run ${regeneration}`,
  ).toContain(`BUN_VERSION='${bunVersion}'`);
  expect(
    script,
    `.node-version must match .agents/cloud-setup.sh NODE_VERSION; change .node-version or run ${regeneration}`,
  ).toContain(`NODE_VERSION='${nodeVersion.trim()}'`);

  const installTools =
    /install_tools\(\) \{(?<body>[\s\S]*?)\n\}/u.exec(script)?.groups?.[
      "body"
    ] ?? "";
  const installed = [
    ...installTools.matchAll(/\binstall_([a-z0-9_]+)\b/gu),
  ].map(([, tool]) => tool);
  expect(
    installed.toSorted(),
    `stll-toolchain.json cloud.tools must exactly match tools installed by .agents/cloud-setup.sh; change stll-toolchain.json or run ${regeneration}`,
  ).toEqual(Object.keys(tools).toSorted());
  for (const [tool, version] of Object.entries(tools)) {
    const block = new RegExp(
      `install_${tool}\\(\\) \\(\\n(?<body>[\\s\\S]*?)\\n\\)`,
      "u",
    ).exec(script)?.groups?.["body"];
    expect(
      block,
      `stll-toolchain.json cloud.tools.${tool} must use its exact version in .agents/cloud-setup.sh; change stll-toolchain.json or run ${regeneration}`,
    ).toContain(version);
  }
};

test("committed cloud setup pins the repository toolchain sources", async () => {
  const manifest = await Bun.file(path.join(root, "package.json")).json();
  const toolchain = await Bun.file(
    path.join(root, "stll-toolchain.json"),
  ).json();
  expectCloudSetupPins({
    packageManager: manifest.packageManager,
    nodeVersion: await readFile(path.join(root, ".node-version"), "utf-8"),
    script: await readFile(path.join(root, ".agents/cloud-setup.sh"), "utf-8"),
    tools: toolchain.cloud.tools,
  });
});

test("rejects a packageManager pin that differs from BUN_VERSION", async () => {
  const script = await readFile(
    path.join(root, ".agents/cloud-setup.sh"),
    "utf-8",
  );
  const nodeVersion = await readFile(path.join(root, ".node-version"), "utf-8");
  expect(() =>
    expectCloudSetupPins({
      packageManager: "bun@0.0.1",
      nodeVersion,
      script,
      tools: { gitleaks: "8.30.1" },
    }),
  ).toThrow("package.json packageManager");
});

test("cloud setup bytes come from the shared generator and bind the Node selector", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cloud-setup-guard-"));
  try {
    for (const file of [
      "package.json",
      "stll-toolchain.json",
      ".node-version",
    ]) {
      await copyFile(path.join(root, file), path.join(directory, file));
    }
    await symlink(
      path.join(root, "node_modules"),
      path.join(directory, "node_modules"),
    );
    const original = await generateCloudSetupArtifacts(directory);
    expect(original.at(0)?.contents).toBe(
      await readFile(path.join(root, ".agents/cloud-setup.sh"), "utf-8"),
    );
    await writeFile(path.join(directory, ".node-version"), "26.10.1\n");
    const changed = await generateCloudSetupArtifacts(directory);
    expect(changed.at(0)?.contents).not.toBe(original.at(0)?.contents);
    expect(changed.at(0)?.contents).toContain("NODE_VERSION='26.10.1'");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a stale .claude/settings.json fails the generated-files check", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cloud-settings-drift-"));
  try {
    for (const file of [
      "package.json",
      "stll-toolchain.json",
      ".node-version",
      ".agents/cloud-setup.sh",
      ".claude/settings.json",
    ]) {
      const destination = path.join(directory, file);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(path.join(root, file), destination);
    }
    await symlink(
      path.join(root, "node_modules"),
      path.join(directory, "node_modules"),
    );
    await writeFile(path.join(directory, ".claude/settings.json"), "{}\n");
    expect(
      await writeOrCheckArtifacts(
        await generateCloudSetupArtifacts(directory),
        { matched: "shared cloud setup policy", write: false },
      ),
    ).toBe(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
