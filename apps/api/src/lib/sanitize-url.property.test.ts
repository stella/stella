import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  propertyConfig,
  propertySeed,
  propertyTestTimeout,
} from "@stll/property-testing";

import { sanitizeUrl } from "./sanitize-url";

const url = fc.oneof(
  fc.string({ maxLength: 512 }),
  fc
    .tuple(
      fc.constantFrom(
        "https",
        "http",
        "javascript",
        "vbscript",
        "data",
        "file",
      ),
      fc.constantFrom("", "\t", "\n", "\r", "\0", " "),
      fc.boolean(),
      fc.string({ maxLength: 100 }),
    )
    .map(([scheme, gap, upper, path]) => {
      const protocol = upper ? scheme.toUpperCase() : scheme;
      return ` \t${protocol.slice(0, 2)}${gap}${protocol.slice(2)}://example.test/${path}\r\n`;
    }),
);

describe("URL sanitization properties", () => {
  test(
    "accepted URLs have a web protocol and are fixed points",
    () => {
      fc.assert(
        fc.property(url, (input) => {
          const output = sanitizeUrl(input);
          if (output === undefined) {
            return;
          }
          expect(URL.canParse(output)).toBe(true);
          expect(["http:", "https:"]).toContain(new URL(output).protocol);
          expect(sanitizeUrl(output)).toBe(output);
        }),
        propertyConfig({ seed: propertySeed() }),
      );
    },
    propertyTestTimeout(5000),
  );

  test(
    "web URLs survive formatting whitespace",
    () => {
      fc.assert(
        fc.property(
          fc.webUrl(),
          fc.constantFrom("", " ", "\t\r\n"),
          (input, whitespace) => {
            expect(sanitizeUrl(`${whitespace}${input}${whitespace}`)).toBe(
              input,
            );
          },
        ),
        propertyConfig({ seed: propertySeed() }),
      );
    },
    propertyTestTimeout(5000),
  );
});
