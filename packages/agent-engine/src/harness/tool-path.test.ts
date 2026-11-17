import { describe, expect, test } from "bun:test";
import path from "node:path";

import { toolPathEnvironment } from "./tool-path";

const TOOL = path.resolve("managed", "bun", "bin");

describe("toolPathEnvironment", () => {
  test("puts tools ahead of the inherited value, which stays", () => {
    expect(toolPathEnvironment({ PATH: "/usr/bin:/bin" }, [TOOL], ":")).toEqual(
      {
        PATH: `${TOOL}:/usr/bin:/bin`,
      },
    );
  });

  test("sets nothing without tools, so the inherited value stands", () => {
    expect(toolPathEnvironment({ PATH: "/usr/bin" }, [], ":")).toEqual({});
  });

  test("works with nothing inherited", () => {
    expect(toolPathEnvironment({}, [TOOL], ":")).toEqual({ PATH: TOOL });
  });

  test("on Windows it keeps the name the environment already uses", () => {
    expect(toolPathEnvironment({ Path: "C:\\Windows" }, [TOOL], ";")).toEqual({
      Path: `${TOOL};C:\\Windows`,
    });
  });

  test("a name in another case is not PATH outside Windows", () => {
    expect(toolPathEnvironment({ Path: "/elsewhere" }, [TOOL], ":")).toEqual({
      PATH: TOOL,
    });
  });
});
