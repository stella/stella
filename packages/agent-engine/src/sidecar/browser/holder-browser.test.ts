import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { browserEndpointFor, startHolderBrowser } from "./holder-browser";

test("the browser socket sits beside the holder's and is never longer", () => {
  const holder = path.join("/tmp/stella-501", "stella-holder-1.4.0.sock");
  const browser = browserEndpointFor(holder);
  expect(path.dirname(browser)).toBe(path.dirname(holder));
  expect(Buffer.byteLength(browser)).toBeLessThanOrEqual(
    Buffer.byteLength(holder),
  );
  expect(browserEndpointFor(holder)).toBe(browser);
  expect(
    browserEndpointFor(
      path.join("/tmp/stella-501", "stella-holder-1.5.0.sock"),
    ),
  ).not.toBe(browser);
});

const place = () => {
  const root = mkdtempSync(path.join(tmpdir(), "stella-holder-browser-"));
  const dir = path.join(root, "holder");
  mkdirSync(dir, { mode: 0o700 });
  return {
    dir,
    endpoint: path.join(root, "stella-holder-1.4.0.sock"),
    home: path.join(root, "home"),
    root,
  };
};

const start = async (at: ReturnType<typeof place>, platform: NodeJS.Platform) =>
  await startHolderBrowser({
    command: ["/usr/bin/true"],
    dir: at.dir,
    endpoint: at.endpoint,
    extraExtensionIds: [],
    home: at.home,
    log: () => undefined,
    platform,
    version: "1.4.0",
  });

test("offers no browser where no host can be registered, and leaves no socket", async () => {
  const at = place();
  try {
    mkdirSync(path.join(at.home, ".config", "google-chrome"), {
      recursive: true,
    });
    const started = await start(at, "freebsd");
    expect(started).toMatchObject({ type: "unavailable" });
    expect(existsSync(browserEndpointFor(at.endpoint))).toBe(false);
    expect(existsSync(path.join(at.dir, "browser.secret"))).toBe(false);
    // Chrome never installed: the same.
    expect(await start(at, "darwin")).toMatchObject({ type: "unavailable" });
  } finally {
    rmSync(at.root, { force: true, recursive: true });
  }
});

test("offers the browser once Chrome can start the host", async () => {
  const at = place();
  try {
    mkdirSync(path.join(at.home, ".config", "google-chrome"), {
      recursive: true,
    });
    const started = await start(at, "linux");
    if (started.type !== "started") {
      throw new TypeError(`The browser did not start: ${started.reason}`);
    }
    expect(
      existsSync(
        path.join(
          at.home,
          ".config",
          "google-chrome",
          "NativeMessagingHosts",
          "app.stll.browser.json",
        ),
      ),
    ).toBe(true);
    await started.browser.stop();
  } finally {
    rmSync(at.root, { force: true, recursive: true });
  }
});
