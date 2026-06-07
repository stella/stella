import { describe, expect, test } from "bun:test";

import { frontendOrigins } from "@/api/lib/dev-origins";

describe("frontend origins", () => {
  test("keeps production origins exact", () => {
    expect(
      frontendOrigins({
        frontendUrl: "http://localhost:3000",
        isDev: false,
      }),
    ).toEqual(["http://localhost:3000"]);
  });

  test("adds a 127.0.0.1 dev alias for localhost", () => {
    expect(
      frontendOrigins({
        frontendUrl: "http://localhost:3000",
        isDev: true,
      }),
    ).toEqual(["http://localhost:3000", "http://127.0.0.1:3000"]);
  });

  test("adds a localhost dev alias for 127.0.0.1", () => {
    expect(
      frontendOrigins({
        frontendUrl: "http://127.0.0.1:3000",
        isDev: true,
      }),
    ).toEqual(["http://127.0.0.1:3000", "http://localhost:3000"]);
  });

  test("normalizes a trailing slash on a loopback origin", () => {
    expect(
      frontendOrigins({
        frontendUrl: "http://localhost:3000/",
        isDev: true,
      }),
    ).toEqual(["http://localhost:3000", "http://127.0.0.1:3000"]);
  });

  test("only swaps exact loopback hostnames", () => {
    expect(
      frontendOrigins({
        frontendUrl: "http://app.localhost:3000",
        isDev: true,
      }),
    ).toEqual(["http://app.localhost:3000"]);
    expect(
      frontendOrigins({
        frontendUrl: "http://localhost.example:3000",
        isDev: true,
      }),
    ).toEqual(["http://localhost.example:3000"]);
  });

  test("leaves non-parseable origins unchanged", () => {
    expect(
      frontendOrigins({
        frontendUrl: "localhost:3000",
        isDev: true,
      }),
    ).toEqual(["localhost:3000"]);
  });
});
