import { describe, expect, test } from "bun:test";
import nodePath from "node:path";

import {
  apiSourceRoot,
  collectApiModuleGraph,
} from "@/api/tests/api-module-graph";

/**
 * Environment modules that validate settings a base-environment process is
 * never given: the API server environment (auth, email, rendering) and the
 * document-processing environment (a Redis endpoint it requires, the content
 * encryption key). Both validate at import, so reaching either from the
 * entrypoints below turns the first request into a boot failure.
 */
const FORBIDDEN_ENV_MODULES = ["env.ts", "env-document-processing-worker.ts"];

/**
 * What an entrypoint that boots with the base environment alone reaches
 * through case-law ingestion. The publisher gate imports the Redis client
 * dynamically, and a dynamic edge is still an edge: the module it names
 * validates its environment the first time the gate reserves a slot.
 */
const BASE_ENVIRONMENT_ENTRYPOINTS = [
  "lib/redis-client.ts",
  "handlers/case-law/ingestion/adapters/publisher-request-gate.ts",
];

describe("modules reachable with the base environment only", () => {
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
