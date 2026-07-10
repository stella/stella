import { describe, expect, test } from "bun:test";

import { openCommandFor } from "./browser-open";

describe("browser opener commands", () => {
  test("uses direct platform executables", () => {
    expect(openCommandFor("darwin")).toEqual(["open"]);
    expect(openCommandFor("linux")).toEqual(["xdg-open"]);
    expect(openCommandFor("win32")).toEqual(["explorer.exe"]);
  });
});
