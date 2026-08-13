import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { envWebClientSchema } from "@/env-schema";
import { sanitizeHref } from "@/lib/sanitize-href";

describe("desktop release URL boundary", () => {
  test("accepts only absolute HTTP(S) URLs supported by anchor sanitization", () => {
    const cases = [
      { accepted: true, value: "https://downloads.example.com/releases" },
      { accepted: true, value: "http://mirror.example.com/releases" },
      { accepted: false, value: "ftp://mirror.example.com/releases" },
      { accepted: false, value: "data:text/plain,release" },
      // eslint-disable-next-line no-script-url -- fixture: the environment boundary must reject this unsafe protocol
      { accepted: false, value: "javascript:alert(1)" },
    ] as const;

    for (const { accepted, value } of cases) {
      const result = v.safeParse(
        envWebClientSchema.VITE_DESKTOP_RELEASES_BASE_URL,
        value,
      );
      expect(result.success).toBe(accepted);
      if (accepted) {
        expect(sanitizeHref(value)).toBe(value);
      }
    }
  });
});
