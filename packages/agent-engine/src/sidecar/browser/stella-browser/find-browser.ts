import { Result } from "better-result";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Which browser the stella browser runs on this computer: the member's
 * installed Google Chrome, else Microsoft Edge, each its stable build.
 * Beta, Dev and Canary builds are never used. A bundle counts only when
 * its `Info.plist` names the expected bundle identifier, so a folder that
 * merely carries the name is passed over. Windows comes in a later slice;
 * Linux has no member builds, and tests name their browser through the
 * test hooks (`test-hooks.ts`).
 */

export type InstalledBrowser = {
  kind: "chrome" | "edge";
  executable: string;
};

const MAC_BUNDLES = [
  {
    kind: "chrome",
    bundle: "Google Chrome.app",
    binary: "Google Chrome",
    identifier: "com.google.Chrome",
  },
  {
    kind: "edge",
    bundle: "Microsoft Edge.app",
    binary: "Microsoft Edge",
    identifier: "com.microsoft.edgemac",
  },
] as const satisfies readonly {
  kind: InstalledBrowser["kind"];
  bundle: string;
  binary: string;
  identifier: string;
}[];

/** What finding a browser reads of the file system. */
export type BrowserFileSystem = {
  exists: (file: string) => boolean;
  /** The bundle identifier an `Info.plist` names; null when it names none. */
  bundleIdentifier: (plist: string) => string | null;
};

const XML_IDENTIFIER =
  /<key>CFBundleIdentifier<\/key>\s*<string>([^<]{1,200})<\/string>/u;

/** A binary plist starts with these bytes; `plutil` reads it. */
const BINARY_PLIST_MAGIC = "bplist";

const plutilIdentifier = (plist: string): string | null => {
  const read = spawnSync(
    "/usr/bin/plutil",
    ["-extract", "CFBundleIdentifier", "raw", "-o", "-", plist],
    { encoding: "utf-8", maxBuffer: 64 * 1024, timeout: 5000 },
  );
  return read.status === 0 ? read.stdout.trim() : null;
};

/** The file system as it is: `Info.plist` read as XML, or through `plutil`. */
export const realBrowserFileSystem: BrowserFileSystem = {
  exists: existsSync,
  bundleIdentifier: (plist) => {
    const text = Result.try(() => readFileSync(plist, "utf-8"));
    if (Result.isError(text)) {
      return null;
    }
    if (text.value.startsWith(BINARY_PLIST_MAGIC)) {
      return plutilIdentifier(plist);
    }
    return XML_IDENTIFIER.exec(text.value)?.[1] ?? null;
  },
};

/** The installed browser the stella browser uses, or null when there is none. */
export const findInstalledBrowser = ({
  fs,
  home,
  platform,
}: {
  fs: BrowserFileSystem;
  home: string | null;
  platform: NodeJS.Platform;
}): InstalledBrowser | null => {
  if (platform !== "darwin") {
    return null;
  }
  const folders = [
    "/Applications",
    ...(home === null ? [] : [path.join(home, "Applications")]),
  ];
  for (const candidate of MAC_BUNDLES) {
    for (const folder of folders) {
      const app = path.join(folder, candidate.bundle);
      const executable = path.join(app, "Contents", "MacOS", candidate.binary);
      if (
        fs.exists(executable) &&
        fs.bundleIdentifier(path.join(app, "Contents", "Info.plist")) ===
          candidate.identifier
      ) {
        return { executable, kind: candidate.kind };
      }
    }
  }
  return null;
};
