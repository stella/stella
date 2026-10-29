import { describe, expect, test } from "bun:test";

import { RUNTIME_MODE } from "@stll/runtime-mode";

import { ownNativeClientResourceLinks } from "@/api/lib/auth/oauth-own-client-links";
import {
  getAllowedClientResourceIdentifiers,
  getApiOAuthResourceIdentifier,
  getBetterAuthOAuthResources,
  getDefaultClientResourceIdentifiers,
  isApiResourceClient,
} from "@/api/lib/oauth-resource-policy";
import { getMcpBaseUrl } from "@/api/mcp/constants";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";

const inMode = <T>(
  mode: (typeof RUNTIME_MODE)[keyof typeof RUNTIME_MODE],
  read: () => T,
): T => {
  const restore = setRuntimeModeForTesting({ mode });
  try {
    return read();
  } finally {
    restore();
  }
};

describe("which resources a client registration reaches", () => {
  test("every registration receives the MCP audiences and never the REST API", () => {
    const api = getApiOAuthResourceIdentifier();
    expect(getDefaultClientResourceIdentifiers()).toEqual(
      getBetterAuthOAuthResources()
        .map(({ identifier }) => identifier)
        .filter((identifier) => identifier !== api),
    );
  });

  test("outside local development the REST API answers no client but stella's own app", () => {
    const ownApps = ownNativeClientResourceLinks(getMcpBaseUrl()).map(
      ({ clientId }) => clientId,
    );
    expect(
      inMode(RUNTIME_MODE.strict, () =>
        isApiResourceClient("https://client.example.test/metadata.json"),
      ),
    ).toBe(false);
    for (const clientId of ownApps) {
      expect(
        inMode(RUNTIME_MODE.strict, () => isApiResourceClient(clientId)),
      ).toBe(true);
    }
    // A local server has no document client; the app registers there.
    expect(
      inMode(RUNTIME_MODE.open, () => isApiResourceClient("registered-client")),
    ).toBe(true);
  });

  test("a registration may ask for the REST API only on a local development server", () => {
    const api = getApiOAuthResourceIdentifier();
    expect(
      inMode(RUNTIME_MODE.strict, getAllowedClientResourceIdentifiers),
    ).toEqual(getDefaultClientResourceIdentifiers());
    expect(
      inMode(RUNTIME_MODE.open, getAllowedClientResourceIdentifiers),
    ).toEqual([...getDefaultClientResourceIdentifiers(), api]);
  });
});
