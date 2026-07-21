import { describe, expect, test } from "bun:test";

import { createAuthTransportOptions } from "./auth-transport";

describe("createAuthTransportOptions", () => {
  test("uses the current stored cookie for every native request", () => {
    let cookie = "session=first";
    const options = createAuthTransportOptions("native", () => cookie);

    expect(options.fetch.credentials).toBe("omit");
    expect(options.headers()).toEqual({ Cookie: "session=first" });

    cookie = "session=second";
    expect(options.headers()).toEqual({ Cookie: "session=second" });
  });

  test("omits an empty native cookie header", () => {
    const options = createAuthTransportOptions("native", () => "");

    expect(options.headers()).toEqual({});
  });

  test("leaves cookies to the browser on web", () => {
    let cookieReads = 0;
    const options = createAuthTransportOptions("web", () => {
      cookieReads += 1;
      return "session=native-only";
    });

    expect(options.fetch.credentials).toBe("include");
    expect(options.headers()).toEqual({});
    expect(cookieReads).toBe(0);
  });
});
