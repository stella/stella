import { describe, expect, test } from "bun:test";

import { createPythonAdapter } from "../adapters/python";
import { PRESIDIO_PROVIDER } from "../adapters/python-providers";

describe("Python adapter language capabilities", () => {
  test("reports a mixed-language corpus as unsupported before invocation", async () => {
    const outcome = await createPythonAdapter(PRESIDIO_PROVIDER).run([
      {
        id: "supported",
        language: "en",
        title: "supported language",
        text: "Example",
        entities: [],
      },
      {
        id: "unsupported-ja",
        language: "ja",
        title: "unsupported language",
        text: "例",
        entities: [],
      },
      {
        id: "unsupported-fr",
        language: "fr",
        title: "another unsupported language",
        text: "Exemple",
        entities: [],
      },
    ]);

    expect(outcome).toEqual({
      status: "unavailable",
      reasonCode: "language-unsupported",
      reason: "presidio does not support corpus languages: fr, ja",
    });
  });
});
