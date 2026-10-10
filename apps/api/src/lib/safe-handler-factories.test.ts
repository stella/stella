import { Glob } from "bun";
import { describe, expect, test } from "bun:test";
import path from "node:path";

import { SAFE_HANDLER_FACTORY_NAMES } from "./safe-handler-factories";

const API_SRC = path.resolve(import.meta.dir, "..");
const FACTORY_DEFINITION =
  /^export\s+(?:const|function)\s+(?<name>createSafe\w*Handler)\b/gmu;

describe("safe-handler factory map", () => {
  // The type test binds the map to the two modules that export factories
  // today; this catches a factory exported from any other module.
  test("names exactly the factories the API source exports", async () => {
    const defined = new Set<string>();
    const glob = new Glob("**/*.ts");
    for await (const file of glob.scan({ cwd: API_SRC, absolute: true })) {
      if (file.endsWith(".test.ts") || file.endsWith(".type-test.ts")) {
        continue;
      }
      const source = await Bun.file(file).text();
      for (const match of source.matchAll(FACTORY_DEFINITION)) {
        const name = match.groups?.["name"];
        if (name !== undefined) {
          defined.add(name);
        }
      }
    }

    expect([...defined].toSorted()).toEqual(
      SAFE_HANDLER_FACTORY_NAMES.toSorted(),
    );
  });
});
