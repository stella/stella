import { expect, test } from "bun:test";

import { SAFE_HANDLER_FACTORIES } from "../../src/lib/safe-handler-factories";
import { inspectSafeHandlerCalls } from "./enumerate-safe-handlers";

test("enumerates factory calls while excluding types and inert source text", () => {
  for (const [factory, { kind }] of Object.entries(SAFE_HANDLER_FACTORIES)) {
    const inertSource = `
      import { ${factory} } from "@/api/lib/api-handlers";
      type Handler = Parameters<typeof ${factory}<Config, Response>>[1];
      const instantiated = ${factory}<Config, Response>;
      const text = "${factory}(config, handler)";
      // ${factory}(config, handler)
    `;
    expect(inspectSafeHandlerCalls(inertSource)).toEqual({
      callCount: 0,
      kinds: [],
    });
    expect(
      inspectSafeHandlerCalls(`${inertSource}
        const first = ${factory}(config, handler);
        const second = ${factory}<Config, Response>(config, handler);
        const third = ${factory}
          (config, handler);
      `),
    ).toEqual({ callCount: 3, kinds: [kind] });
  }
});
