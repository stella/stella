import { describe, expect, test } from "bun:test";
import nodePath from "node:path";

import {
  apiSourceRoot,
  collectApiModuleGraph,
} from "@/api/tests/api-module-graph";

/**
 * The post-deploy smoke is an HTTP client run from CI against a deployed API,
 * with none of the server's settings. Every environment module validates at
 * import, so reaching one turns the smoke into a boot failure before it sends
 * a request.
 */
const SMOKE_ENTRYPOINTS = [
  "scripts/post-deploy-smoke.ts",
  "scripts/post-deploy-smoke-chat.ts",
];

const isEnvironmentModule = (modulePath: string): boolean =>
  nodePath.dirname(modulePath) === apiSourceRoot &&
  /^env[.-]/u.test(nodePath.basename(modulePath));

describe("the post-deploy smoke's import graph", () => {
  test.each(SMOKE_ENTRYPOINTS)(
    "%s reaches no environment module",
    async (entrypoint) => {
      const modules = await collectApiModuleGraph(
        nodePath.resolve(apiSourceRoot, entrypoint),
      );

      // Asserted first: a graph that stopped at the entrypoint would leave the
      // check below passing for the wrong reason.
      expect(modules).toContain(
        nodePath.resolve(
          apiSourceRoot,
          "handlers/chat/chat-turn-settlement.ts",
        ),
      );

      expect([...modules].filter(isEnvironmentModule)).toEqual([]);
    },
  );
});
