import { describe, expect, test } from "bun:test";

import { RUNTIME_MODE } from "@stll/runtime-mode";

import { frontendOrigins } from "@/api/lib/dev-origins";

const STRICT = { mode: RUNTIME_MODE.strict } as const;
const OPEN = { mode: RUNTIME_MODE.open } as const;

describe("frontend origins", () => {
  test("keeps origins exact outside local development", () => {
    expect(
      frontendOrigins({
        frontendUrl: "http://localhost:3000",
        runtimeMode: STRICT,
      }),
    ).toEqual(["http://localhost:3000"]);
  });

  test("adds a 127.0.0.1 alias for localhost in local development", () => {
    expect(
      frontendOrigins({
        frontendUrl: "http://localhost:3000",
        runtimeMode: OPEN,
      }),
    ).toEqual(["http://localhost:3000", "http://127.0.0.1:3000"]);
  });

  test("adds a localhost dev alias for 127.0.0.1", () => {
    expect(
      frontendOrigins({
        frontendUrl: "http://127.0.0.1:3000",
        runtimeMode: OPEN,
      }),
    ).toEqual(["http://127.0.0.1:3000", "http://localhost:3000"]);
  });

  test("normalizes a trailing slash on a loopback origin", () => {
    expect(
      frontendOrigins({
        frontendUrl: "http://localhost:3000/",
        runtimeMode: OPEN,
      }),
    ).toEqual(["http://localhost:3000", "http://127.0.0.1:3000"]);
  });

  test("only swaps exact loopback hostnames", () => {
    expect(
      frontendOrigins({
        frontendUrl: "http://app.localhost:3000",
        runtimeMode: OPEN,
      }),
    ).toEqual(["http://app.localhost:3000"]);
    expect(
      frontendOrigins({
        frontendUrl: "http://localhost.example:3000",
        runtimeMode: OPEN,
      }),
    ).toEqual(["http://localhost.example:3000"]);
  });

  test("leaves non-parseable origins unchanged", () => {
    expect(
      frontendOrigins({
        frontendUrl: "localhost:3000",
        runtimeMode: OPEN,
      }),
    ).toEqual(["localhost:3000"]);
  });
});
