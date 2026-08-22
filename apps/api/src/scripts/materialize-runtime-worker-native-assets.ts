import { panic } from "better-result";
import { cp, mkdir } from "node:fs/promises";
import path from "node:path";

import { runtimeWorkerNativeLookups } from "@/api/lib/runtime-worker-path";

const DOCKER_TO_NODE_ARCHITECTURE = {
  amd64: "x64",
  arm64: "arm64",
} as const satisfies Record<string, NodeJS.Architecture>;

type DockerArchitecture = keyof typeof DOCKER_TO_NODE_ARCHITECTURE;

const isDockerArchitecture = (value: string): value is DockerArchitecture =>
  Object.hasOwn(DOCKER_TO_NODE_ARCHITECTURE, value);

const [dockerArchitecture, targetRoot, unexpectedArgument] = Bun.argv.slice(2);
if (!(dockerArchitecture && targetRoot) || unexpectedArgument) {
  panic(
    "usage: materialize-runtime-worker-native-assets.ts <amd64|arm64> <target-root>",
  );
}
if (!isDockerArchitecture(dockerArchitecture)) {
  panic(`unsupported runtime worker architecture: ${dockerArchitecture}`);
}

const API_ROOT = path.resolve(import.meta.dir, "../..");
const lookups = runtimeWorkerNativeLookups({
  platform: "linux",
  arch: DOCKER_TO_NODE_ARCHITECTURE[dockerArchitecture],
});

await Promise.all(
  lookups.siblingDirs.map(async ({ source, target }) => {
    const destination = path.resolve(targetRoot, target);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(API_ROOT, "node_modules", source), destination, {
      recursive: true,
      dereference: true,
    });
  }),
);
