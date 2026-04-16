import { describe, expect, test } from "bun:test";

import { parseUserAgent } from "./parse-user-agent";

const IPHONE_SAFARI_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1";

describe("parseUserAgent", () => {
  test("classifies iPhone Safari as iOS instead of macOS", () => {
    expect(parseUserAgent(IPHONE_SAFARI_UA)).toEqual({
      browser: "Safari",
      os: "iOS",
    });
  });
});
