import { panic } from "better-result";
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

import { compareCodeUnit } from "../packages/collation/src/collation";
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
  if (bunVersion === undefined) {
    panic("package.json packageManager must use the bun@x.y.z format");
  }
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
  ].flatMap((match) => {
    const tool = match.at(1);
    return tool === undefined ? [] : [tool];
  });
  expect(
    installed.toSorted(compareCodeUnit),
    `stll-toolchain.json cloud.tools must exactly match tools installed by .agents/cloud-setup.sh; change stll-toolchain.json or run ${regeneration}`,
  ).toEqual(Object.keys(tools).toSorted(compareCodeUnit));
  for (const [tool, version] of Object.entries(tools)) {
    const block = new RegExp(
      `install_${tool}\\(\\) \\(\\n(?<body>[\\s\\S]*?)\\n\\)`,
      "u",
    ).exec(script)?.groups?.["body"];
    // Complete install-path segments, so 8.30.10 never satisfies an 8.30.1 pin.
    const versions = [
      ...(block ?? "").matchAll(
        new RegExp(`/tools/${tool}/(?<version>[^/'"\\s]+)/`, "gu"),
      ),
    ].map((match) => match.groups?.["version"]);
    expect(
      versions.length > 0 && versions.every((found) => found === version),
      `stll-toolchain.json cloud.tools.${tool} must use its exact version in .agents/cloud-setup.sh (found ${JSON.stringify(versions)}); change stll-toolchain.json or run ${regeneration}`,
    ).toBe(true);
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

test("rejects a tool pin that is only a prefix of the installed version", async () => {
  const script = await readFile(
    path.join(root, ".agents/cloud-setup.sh"),
    "utf-8",
  );
  const manifest = await Bun.file(path.join(root, "package.json")).json();
  const nodeVersion = await readFile(path.join(root, ".node-version"), "utf-8");
  const toolchain = await Bun.file(
    path.join(root, "stll-toolchain.json"),
  ).json();
  const pinned: string = toolchain.cloud.tools.gitleaks;
  expect(() =>
    expectCloudSetupPins({
      packageManager: manifest.packageManager,
      nodeVersion,
      script: script.replaceAll(
        `/tools/gitleaks/${pinned}/`,
        () => `/tools/gitleaks/${pinned}0/`,
      ),
      tools: { gitleaks: pinned },
    }),
  ).toThrow("cloud.tools.gitleaks");
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

test("cloud setup preserves user-owned Claude settings", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cloud-settings-user-"));
  const userSettings = {
    enabledPlugins: { "typescript-lsp@claude-plugins-official": false },
    mcpServers: {
      playwright: {
        command: "npx",
        args: ["@playwright/mcp@latest", "--viewport-size", "1280x720"],
      },
    },
  };
  try {
    for (const file of [
      "package.json",
      "stll-toolchain.json",
      ".node-version",
    ]) {
      await copyFile(path.join(root, file), path.join(directory, file));
    }
    await mkdir(path.join(directory, ".claude"), { recursive: true });
    await writeFile(
      path.join(directory, ".claude/settings.json"),
      `${JSON.stringify(userSettings, undefined, 2)}\n`,
    );
    await symlink(
      path.join(root, "node_modules"),
      path.join(directory, "node_modules"),
    );

    const artifacts = await generateCloudSetupArtifacts(directory);
    const settings = artifacts.find(({ path: artifactPath }) =>
      artifactPath.endsWith(".claude/settings.json"),
    );
    const generated = JSON.parse(settings?.contents ?? "");
    expect(generated.enabledPlugins).toEqual(userSettings.enabledPlugins);
    expect(generated.mcpServers).toEqual(userSettings.mcpServers);
    expect(generated.hooks.SessionStart).toHaveLength(1);
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
