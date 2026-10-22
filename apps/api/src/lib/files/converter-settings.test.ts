import { describe, expect, test } from "bun:test";

import { gotenbergConvertTarget } from "@/api/lib/files/converter-settings";

const settings = (url: string) => ({
  GOTENBERG_PASSWORD: "password",
  GOTENBERG_URL: url,
  GOTENBERG_USERNAME: "user",
});

describe("gotenbergConvertTarget", () => {
  test.each([
    [
      "http://gotenberg:3000",
      "http://gotenberg:3000/forms/libreoffice/convert",
    ],
    [
      "http://gotenberg:3000/",
      "http://gotenberg:3000/forms/libreoffice/convert",
    ],
    [
      "https://example.test/gotenberg",
      "https://example.test/gotenberg/forms/libreoffice/convert",
    ],
    [
      "https://example.test/tools/gotenberg/",
      "https://example.test/tools/gotenberg/forms/libreoffice/convert",
    ],
  ])("appends the route to %s", (url, expected) => {
    expect(gotenbergConvertTarget(settings(url)).href).toBe(expected);
  });

  test("drops a query or fragment from the configured URL", () => {
    expect(
      gotenbergConvertTarget(settings("https://example.test/gotenberg?x=1#y"))
        .href,
    ).toBe("https://example.test/gotenberg/forms/libreoffice/convert");
  });
});
