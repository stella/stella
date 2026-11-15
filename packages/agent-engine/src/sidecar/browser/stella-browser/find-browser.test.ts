import { describe, expect, test } from "bun:test";

import { type BrowserFileSystem, findInstalledBrowser } from "./find-browser";

const CHROME = "Google Chrome.app/Contents";
const EDGE = "Microsoft Edge.app/Contents";

/** A file system holding these bundles, each with the identifier its plist names. */
const fakeFileSystem = (bundles: Record<string, string>): BrowserFileSystem => {
  const files = new Map<string, string | null>();
  for (const [contents, identifier] of Object.entries(bundles)) {
    const binary = contents.includes("Edge")
      ? "Microsoft Edge"
      : "Google Chrome";
    files.set(`${contents}/MacOS/${binary}`, null);
    files.set(`${contents}/Info.plist`, identifier);
  }
  return {
    bundleIdentifier: (plist) => files.get(plist) ?? null,
    exists: (file) => files.has(file),
  };
};

const find = (
  bundles: Record<string, string>,
  platform: NodeJS.Platform = "darwin",
) =>
  findInstalledBrowser({
    fs: fakeFileSystem(bundles),
    home: "/Users/member",
    platform,
  });

describe("finding the browser the stella browser runs on", () => {
  test("takes Chrome in Applications first", () => {
    expect(
      find({
        [`/Applications/${CHROME}`]: "com.google.Chrome",
        [`/Users/member/Applications/${CHROME}`]: "com.google.Chrome",
        [`/Applications/${EDGE}`]: "com.microsoft.edgemac",
      }),
    ).toEqual({
      executable:
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      kind: "chrome",
    });
  });

  test("then Chrome in the member's own Applications, then Edge", () => {
    expect(
      find({
        [`/Users/member/Applications/${CHROME}`]: "com.google.Chrome",
        [`/Applications/${EDGE}`]: "com.microsoft.edgemac",
      }),
    ).toMatchObject({ kind: "chrome" });
    expect(
      find({ [`/Users/member/Applications/${EDGE}`]: "com.microsoft.edgemac" }),
    ).toEqual({
      executable:
        "/Users/member/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      kind: "edge",
    });
  });

  test("passes over a bundle whose identifier is another build's or none", () => {
    expect(
      find({
        [`/Applications/${CHROME}`]: "com.google.Chrome.canary",
        [`/Applications/${EDGE}`]: "com.microsoft.edgemac.Beta",
      }),
    ).toBeNull();
    expect(find({ [`/Applications/${CHROME}`]: "" })).toBeNull();
  });

  test("finds nothing on Linux or Windows: tests name their browser, and Windows comes later", () => {
    const installed = { [`/Applications/${CHROME}`]: "com.google.Chrome" };
    expect(find(installed, "linux")).toBeNull();
    expect(find(installed, "win32")).toBeNull();
  });
});
