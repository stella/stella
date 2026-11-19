import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { browserApiInvariantViolation } from "@/env-schema";
import { mcpAppSandboxUrlIn } from "@/lib/api-url";

const host = fc.stringMatching(/^[a-z][a-z0-9-]{0,14}$/u);

// A deployment the web build accepts: an app origin, a separate public API
// origin, and either no browser API mount or the app's own `/api` mount (the
// production shape, where a sandbox on the mount showed every app as
// unavailable).
const deployment = fc
  .record({
    appHost: host,
    apiHost: host,
    apiPath: fc.constantFrom("", "/v1", "/api"),
    mounted: fc.boolean(),
  })
  .filter(({ appHost, apiHost }) => appHost !== apiHost)
  .map(({ appHost, apiHost, apiPath, mounted }) => {
    const appUrl = `https://${appHost}.example.test`;
    const publicApiUrl = `https://${apiHost}.example.test${apiPath}`;
    const mount = mounted ? `${appUrl}/api` : undefined;
    return {
      appUrl,
      mount,
      // As `browserApiBaseUrl` reads it: the mount, else the public API.
      deployment: { publicApiUrl, browserApiUrl: mount ?? publicApiUrl },
    };
  });

describe("MCP App sandbox origin", () => {
  test("the sandbox never shares the web app's origin", () => {
    assertProperty(
      "the sandbox never shares the web app's origin",
      fc.property(deployment, ({ appUrl, mount, deployment: bases }) => {
        expect(
          browserApiInvariantViolation({
            browserApiUrl: mount,
            publicAppUrl: appUrl,
          }),
        ).toBeNull();
        const sandbox = mcpAppSandboxUrlIn(bases);
        expect(sandbox.origin).not.toBe(new URL(appUrl).origin);
        expect(sandbox.origin).toBe(new URL(bases.publicApiUrl).origin);
      }),
    );
  });
});
