import { expect, test } from "bun:test";

import { assertLazyChatRuntime } from "../chat-runtime-build-guard";

const entry = {
  fileName: "entry.js",
  isEntry: true,
  imports: ["vendor.js"],
  modules: {},
};
const vendor = {
  fileName: "vendor.js",
  isEntry: false,
  imports: [],
  modules: {},
};

test("AI runtime stays behind a lazy boundary regardless of vendor splitting", () => {
  for (const packageName of ["ai", "ai-client", "ai-react"]) {
    for (const separator of ["/", "\\"]) {
      const id = [
        "",
        "app",
        "node_modules",
        "@tanstack",
        packageName,
        "index.js",
      ].join(separator);
      const runtime = {
        fileName: "chat.js",
        isEntry: false,
        imports: ["vendor.js"],
        modules: {
          [id]: { code: null, renderedLength: 1, renderedExports: [] },
        },
      };
      expect(() =>
        assertLazyChatRuntime([entry, vendor, runtime]),
      ).not.toThrow();
      expect(() =>
        assertLazyChatRuntime([
          entry,
          { ...vendor, imports: ["chat.js"] },
          runtime,
        ]),
      ).toThrow("contains the chat AI runtime");
      expect(() =>
        assertLazyChatRuntime([{ ...entry, modules: runtime.modules }, vendor]),
      ).toThrow("contains the chat AI runtime");
    }
  }
});
