import { Panic } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  buildTrustsLoopback,
  createStellaOriginTrust,
  parseTrustedOriginList,
  STELLA_CONTENT_SCRIPT_MATCHES,
  STELLA_HOSTNAMES,
  trustedStellaOriginFromUrl,
} from "./trusted-origin";

describe("build-time origin list", () => {
  test("release and local builds default to production only", () => {
    for (const mode of ["production", "development", "e2e", undefined]) {
      expect(parseTrustedOriginList(undefined, mode)).toEqual([
        "https://app.stll.app",
        "https://my.stll.app",
      ]);
      expect(parseTrustedOriginList(" ", mode)).toEqual([
        "https://app.stll.app",
        "https://my.stll.app",
      ]);
    }
  });

  test("the staging build defaults to the staging origin only", () => {
    expect(parseTrustedOriginList(undefined, "staging")).toEqual([
      "https://staging.stll.app",
    ]);
  });

  test("an explicit list replaces the default in every build mode", () => {
    for (const mode of ["production", "staging"]) {
      expect(
        parseTrustedOriginList(
          " https://stella.example.org, https://law.example.net ",
          mode,
        ),
      ).toEqual(["https://stella.example.org", "https://law.example.net"]);
    }
  });

  test("fails the build on non-origin or non-HTTPS entries", () => {
    expect(() =>
      parseTrustedOriginList("http://stella.example.org", "production"),
    ).toThrow(Panic);
    expect(() =>
      parseTrustedOriginList("https://stella.example.org/app", "production"),
    ).toThrow(Panic);
  });
});

describe("stella extension origin trust", () => {
  test("accepts only exact hosted app origins", () => {
    expect(trustedStellaOriginFromUrl("https://my.stll.app/chat")).toBe(
      "https://my.stll.app",
    );
    expect(
      trustedStellaOriginFromUrl("https://staging.stll.app/chat"),
    ).toBeNull();
    expect(trustedStellaOriginFromUrl("https://evil.stll.app/chat")).toBeNull();
    expect(trustedStellaOriginFromUrl("https://stll.app/chat")).toBeNull();
  });

  test("a build outside a WXT dev or e2e run trusts no loopback origin", () => {
    expect(STELLA_CONTENT_SCRIPT_MATCHES).toEqual([
      "https://app.stll.app/*",
      "https://my.stll.app/*",
    ]);
    expect(trustedStellaOriginFromUrl("http://localhost:3210/chat")).toBeNull();
    expect(trustedStellaOriginFromUrl("http://127.0.0.1:3210/chat")).toBeNull();
  });
});

describe("stella hosts the controlled tab never loads", () => {
  test("cover staging even where the bridge does not trust it", () => {
    expect(STELLA_HOSTNAMES).toEqual([
      "app.stll.app",
      "my.stll.app",
      "staging.stll.app",
    ]);
  });

  test("add a self-hosted origin to the hosted ones", () => {
    const trust = createStellaOriginTrust({
      hostedOrigins: ["https://stella.example.org"],
      trustLoopback: false,
    });
    expect(trust.hostnames).toEqual([
      "stella.example.org",
      "app.stll.app",
      "my.stll.app",
      "staging.stll.app",
    ]);
    expect(trust.originFromUrl("https://my.stll.app/chat")).toBeNull();
  });
});

describe("loopback stella origins", () => {
  test("only development and e2e builds trust them", () => {
    expect(buildTrustsLoopback("development")).toBe(true);
    expect(buildTrustsLoopback("e2e")).toBe(true);
    expect(buildTrustsLoopback("production")).toBe(false);
    expect(buildTrustsLoopback("staging")).toBe(false);
    expect(buildTrustsLoopback(undefined)).toBe(false);
  });

  test("keeps each loopback port as a distinct origin", () => {
    const trust = createStellaOriginTrust({
      hostedOrigins: ["https://my.stll.app"],
      trustLoopback: true,
    });
    expect(trust.contentScriptMatches).toEqual([
      "https://my.stll.app/*",
      "http://localhost/*",
      "http://127.0.0.1/*",
    ]);
    expect(trust.originFromUrl("http://localhost:3210/chat")).toBe(
      "http://localhost:3210",
    );
    expect(trust.originFromUrl("http://127.0.0.1:3210/chat")).toBe(
      "http://127.0.0.1:3210",
    );
    expect(trust.originFromUrl("http://localhost.example/chat")).toBeNull();
    expect(trust.originFromUrl("https://localhost:3210/chat")).toBeNull();
  });
});
