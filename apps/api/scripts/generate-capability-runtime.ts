// Embed freshly derived contract data; only the npm package consumes shards.

import { readRuntimeMode } from "@stll/runtime-mode";

import { CAPABILITY_RUNTIME_INPUTS } from "../../../packages/scripts/src/generated-files";
import { withGeneratedOutputCache } from "../../../packages/scripts/src/generated-output-cache";
import { hasPreparedGeneratedSources } from "../../../packages/scripts/src/prepared-generated-sources";
import { buildCapabilityCatalog } from "./export-capability-catalog";
import {
  writeCapabilityCatalogRuntime,
  writeCapabilityRuntime,
} from "./lib/write-capability-runtime";

export const generateCapabilityRuntime = async (
  root = new URL("../../../", import.meta.url),
  catalog?: readonly unknown[],
): Promise<void> =>
  writeCapabilityRuntime(catalog ?? (await buildCapabilityCatalog()), root);

export const generateCapabilityCatalogRuntime = async (
  root = new URL("../../../", import.meta.url),
  catalog?: readonly unknown[],
): Promise<void> =>
  writeCapabilityCatalogRuntime(
    catalog ?? (await buildCapabilityCatalog()),
    root,
  );

if (
  import.meta.main &&
  !hasPreparedGeneratedSources(new URL("../../../", import.meta.url).pathname)
) {
  const root = new URL("../../../", import.meta.url).pathname;
  await withGeneratedOutputCache({
    root,
    name: "capability-runtime",
    environment: readRuntimeMode().nodeEnv,
    inputs: CAPABILITY_RUNTIME_INPUTS,
    outputs: ["apps/api/src/mcp/generated/**/*.ts"],
    generate: async () => {
      await generateCapabilityRuntime();
    },
  });
  process.exit(0);
}
