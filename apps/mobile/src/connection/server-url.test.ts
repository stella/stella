import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { parseServerUrl } from "./server-url";

const DEVELOPMENT = { allowPlainHttp: true };
const RELEASE = { allowPlainHttp: false };

const parsed = (input: string, policy = DEVELOPMENT) => {
  const result = parseServerUrl(input, policy);
  return result.isOk() ? result.value : result.error._tag;
};

const PLAIN_HTTP_HOSTS = ["localhost", "127.0.0.1", "[::1]", "10.0.2.2"];

describe("server address", () => {
  test("a bare host is taken as https and reduced to its origin", () => {
    expect(parsed(" stella.example.com/matters?x=1 ")).toBe(
      "https://stella.example.com",
    );
  });

  test("a release build refuses plain http to every host", () => {
    for (const host of PLAIN_HTTP_HOSTS) {
      expect(parsed(`http://${host}:3001`, RELEASE)).toBe("ServerUrlError");
    }
    expect(parsed("https://localhost:3001", RELEASE)).toBe(
      "https://localhost:3001",
    );
  });

  test("plain http reaches only a simulator or emulator host", () => {
    expect(parsed("http://localhost:3001/v1")).toBe("http://localhost:3001");
    expect(parsed("http://10.0.2.2:3001")).toBe("http://10.0.2.2:3001");
    expect(parsed("http://stella.example.com")).toBe("ServerUrlError");
    expect(parsed("http://192.168.1.20:3001")).toBe("ServerUrlError");
  });

  test("credentials and other schemes are refused", () => {
    expect(parsed("https://user:secret@stella.example.com")).toBe(
      "ServerUrlError",
    );
    expect(parsed("ftp://stella.example.com")).toBe("ServerUrlError");
    expect(parsed("app.stll://stella.example.com")).toBe("ServerUrlError");
  });

  test("an accepted address is a secure origin and parses back to itself", () => {
    assertProperty(
      "an accepted address is a secure origin and parses back to itself",
      fc.property(
        fc.oneof(
          fc.webUrl({ withQueryParameters: true, withFragments: true }),
          fc.string(),
          fc
            .tuple(
              fc.constantFrom(...PLAIN_HTTP_HOSTS, "example.com"),
              fc.integer({ min: 1, max: 65_535 }),
            )
            .map(([host, port]) => `http://${host}:${port}/path`),
        ),
        (input) => {
          const result = parseServerUrl(input, DEVELOPMENT);
          if (result.isErr()) {
            return;
          }
          const url = new URL(result.value);
          expect(url.username).toBe("");
          expect(url.password).toBe("");
          expect(
            url.protocol === "https:" ||
              (url.protocol === "http:" &&
                PLAIN_HTTP_HOSTS.includes(url.hostname)),
          ).toBe(true);
          expect(result.value).toBe(url.origin);
          expect(parsed(result.value)).toBe(result.value);
        },
      ),
    );
  });
});
