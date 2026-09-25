import { describe, expect, test } from "bun:test";

import { browserControlCommandJsonSchema } from "./browser-control-json-schema";

describe("browser control JSON Schema", () => {
  test("exports the element ref pattern without its regex flag", () => {
    const jsonSchema = browserControlCommandJsonSchema[
      "~standard"
    ].jsonSchema.input({ target: "draft-07" });

    expect(JSON.stringify(jsonSchema)).toContain(
      String.raw`"pattern":"^e:(\\d+):(\\d+(?:\\.(?:s\\.)?\\d+)*)$"`,
    );
  });
});
