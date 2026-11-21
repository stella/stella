import { expect, test } from "bun:test";
import {
  copyFile,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import { generateCloudSetupArtifact } from "./generate-cloud-setup";

const root = path.resolve(import.meta.dir, "..");

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
    const original = await generateCloudSetupArtifact(directory);
    expect(original.contents).toBe(
      await readFile(path.join(root, ".agents/cloud-setup.sh"), "utf-8"),
    );
    // A Node patch the shared policy does not pin needs the repository's own
    // archive checksums; these fixture values only have the required shape.
    const amd64 = "a".repeat(64);
    const arm64 = "b".repeat(64);
    const toolchainPath = path.join(directory, "stll-toolchain.json");
    const toolchain = v.parse(
      v.looseObject({ cloud: v.looseObject({}) }),
      JSON.parse(await readFile(toolchainPath, "utf-8")),
    );
    await writeFile(
      toolchainPath,
      JSON.stringify({
        ...toolchain,
        cloud: {
          ...toolchain.cloud,
          runtimeArchiveSha256: { node: { "26.10.1": { amd64, arm64 } } },
        },
      }),
    );
    await writeFile(path.join(directory, ".node-version"), "26.10.1\n");
    const changed = await generateCloudSetupArtifact(directory);
    expect(changed.contents).not.toBe(original.contents);
    expect(changed.contents).toContain("NODE_VERSION='26.10.1'");
    expect(changed.contents).toContain(`NODE_SHA256='${amd64}'`);
    expect(changed.contents).toContain(`NODE_SHA256='${arm64}'`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
