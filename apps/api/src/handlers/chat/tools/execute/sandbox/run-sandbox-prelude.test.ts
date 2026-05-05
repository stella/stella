import { describe, expect, it } from "bun:test";

import {
  SANDBOX_BLOCKED_GLOBALS,
  SANDBOX_BRIDGE_LOCAL_ALIAS,
  SANDBOX_CONSOLE_METHODS,
  SANDBOX_HOST_BRIDGE_GLOBAL,
  SANDBOX_READ_GLOBAL,
  SANDBOX_THENABLE_PROPERTY_NAMES,
  buildHostBridgePrelude,
} from "@/api/handlers/chat/tools/execute/sandbox/run-sandbox-prelude";

describe("buildHostBridgePrelude", () => {
  it("captures the bridge global before deleting it", () => {
    const prelude = buildHostBridgePrelude();
    const capture = `const ${SANDBOX_BRIDGE_LOCAL_ALIAS} = globalThis.${SANDBOX_HOST_BRIDGE_GLOBAL};`;
    const deletion = `delete globalThis.${SANDBOX_HOST_BRIDGE_GLOBAL};`;
    expect(prelude.indexOf(capture)).toBeLessThan(prelude.indexOf(deletion));
  });

  it("deletes every blocked global", () => {
    const prelude = buildHostBridgePrelude();
    for (const name of SANDBOX_BLOCKED_GLOBALS) {
      expect(prelude).toContain(`delete globalThis.${name};`);
    }
  });

  it("stubs every console method", () => {
    const prelude = buildHostBridgePrelude();
    for (const method of SANDBOX_CONSOLE_METHODS) {
      expect(prelude).toContain(`${method}: () => {},`);
    }
  });

  it("guards thenable property names on the read proxy", () => {
    const prelude = buildHostBridgePrelude();
    for (const name of SANDBOX_THENABLE_PROPERTY_NAMES) {
      expect(prelude).toContain(`name === "${name}"`);
    }
    expect(prelude).toContain(`globalThis.${SANDBOX_READ_GLOBAL} = new Proxy`);
  });
});
