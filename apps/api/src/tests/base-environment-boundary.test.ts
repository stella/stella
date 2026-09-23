import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import nodePath from "node:path";

import {
  apiSourceRoot,
  collectApiModuleGraph,
} from "@/api/tests/api-module-graph";

/**
 * What a base-environment process must not reach: the API server environment
 * (auth, email, rendering), the document-processing environment (a Redis
 * endpoint it requires, the content encryption key), and the content cipher
 * that reads the latter. Each validates at import, so reaching one from the
 * entrypoints below turns the first request into a boot failure.
 */
const FORBIDDEN_ENV_MODULES = [
  "env.ts",
  "env-document-processing-worker.ts",
  "lib/content-encryption.ts",
];

const ADAPTER_DIRECTORY = "handlers/case-law/ingestion/adapters";
const PUBLISHER_REQUEST_GATE = `${ADAPTER_DIRECTORY}/publisher-request-gate.ts`;

/**
 * The adapters that reserve a publisher slot, read off the gate's reachability
 * rather than listed here: an adapter added to the gate is covered by the
 * assertions below without anyone remembering to extend a list. Reachability
 * is transitive, because an adapter reaches the gate through its publisher's
 * throttle rather than importing it directly.
 */
const gatedAdapterEntrypoints = async (): Promise<string[]> => {
  const gateModule = nodePath.resolve(apiSourceRoot, PUBLISHER_REQUEST_GATE);
  const directory = nodePath.resolve(apiSourceRoot, ADAPTER_DIRECTORY);
  const candidates = (await readdir(directory)).filter(
    (entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"),
  );
  const gated = await Promise.all(
    candidates.map(async (entry) => {
      const modulePath = nodePath.resolve(directory, entry);
      if (modulePath === gateModule) {
        return null;
      }
      const modules = await collectApiModuleGraph(modulePath);
      return modules.has(gateModule) ? `${ADAPTER_DIRECTORY}/${entry}` : null;
    }),
  );
  return gated.filter((entry): entry is string => entry !== null).toSorted();
};

const GATED_ADAPTER_ENTRYPOINTS = await gatedAdapterEntrypoints();

/**
 * What an entrypoint that boots with the base environment alone reaches
 * through case-law ingestion. The publisher gate imports the Redis client
 * dynamically, and a dynamic edge is still an edge: the module it names
 * validates its environment the first time the gate reserves a slot.
 */
const BASE_ENVIRONMENT_ENTRYPOINTS = [
  "lib/redis-client.ts",
  PUBLISHER_REQUEST_GATE,
  // Every gated request resolves its budget through here, so whatever this
  // module reaches is reached by every adapter the first time it fetches.
  `${ADAPTER_DIRECTORY}/publisher-policy.ts`,
  ...GATED_ADAPTER_ENTRYPOINTS,
];

describe("modules reachable with the base environment only", () => {
  // Asserted on its own: a derivation that found no gated adapter would leave
  // every case below passing while covering nothing.
  test("the gated adapters are derived from the publisher gate", () => {
    expect(GATED_ADAPTER_ENTRYPOINTS.length).toBeGreaterThan(0);
  });

  test.each(BASE_ENVIRONMENT_ENTRYPOINTS)(
    "%s requires neither the API nor the document-processing environment",
    async (entrypoint) => {
      const modules = await collectApiModuleGraph(
        nodePath.resolve(apiSourceRoot, entrypoint),
      );

      // Asserted first: a graph that never reaches the Redis client would
      // leave everything below passing for the wrong reason.
      expect(modules).toContain(nodePath.resolve(apiSourceRoot, "env-base.ts"));

      for (const forbidden of FORBIDDEN_ENV_MODULES) {
        expect(modules).not.toContain(
          nodePath.resolve(apiSourceRoot, forbidden),
        );
      }
    },
  );
});
