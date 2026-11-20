import { describe, expect, test } from "bun:test";

import { DEVICE_KIND, parseDeviceKind } from "./device-kind";

describe("parseDeviceKind", () => {
  test.each([
    [
      DEVICE_KIND.phone,
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    ],
    [
      DEVICE_KIND.phone,
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
    ],
    [
      DEVICE_KIND.tablet,
      "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    ],
    [
      DEVICE_KIND.tablet,
      "Mozilla/5.0 (Linux; Android 14; SM-X910) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    ],
    [
      DEVICE_KIND.computer,
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    ],
    [
      DEVICE_KIND.computer,
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
    ],
    [
      DEVICE_KIND.computer,
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    ],
    [DEVICE_KIND.desktopApp, "stella-desktop"],
    [DEVICE_KIND.unknown, "curl/8.4.0"],
    [DEVICE_KIND.unknown, ""],
    [DEVICE_KIND.unknown, null],
  ])("reads %s from %j", (kind, ua) => {
    expect(parseDeviceKind(ua)).toBe(kind);
  });
});
