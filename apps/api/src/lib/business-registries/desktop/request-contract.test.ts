import { expect, test } from "bun:test";
import { Value } from "typebox/value";

import {
  DESKTOP_REGISTRY_REQUEST_AUTHORIZATION_PREFIX,
  DESKTOP_REGISTRY_REQUEST_USER_AGENT,
  desktopRegistryRequestHeaders,
} from "@/api/lib/business-registries/desktop/request-contract";

const headers = (contentType: string) => ({
  authorization: `${DESKTOP_REGISTRY_REQUEST_AUTHORIZATION_PREFIX}token`,
  "content-type": contentType,
  "user-agent": DESKTOP_REGISTRY_REQUEST_USER_AGENT,
});

test("desktop registry request content type remains case-insensitive", () => {
  expect(
    Value.Check(desktopRegistryRequestHeaders, headers("APPLICATION/JSON")),
  ).toBe(true);
  expect(
    Value.Check(
      desktopRegistryRequestHeaders,
      headers("Application/Json; Charset=UTF-8"),
    ),
  ).toBe(true);
  expect(Value.Check(desktopRegistryRequestHeaders, headers("text/json"))).toBe(
    false,
  );
});
