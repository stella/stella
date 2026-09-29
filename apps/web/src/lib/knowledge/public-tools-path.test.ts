import { describe, expect, test } from "bun:test";

import {
  legacyToolsRoutesServed,
  publicToolDownloadPath,
  publicToolInstallPath,
  publicToolPath,
  publicToolsBasePath,
  publicToolsContributePath,
} from "@/lib/knowledge/public-tools-path";

describe("published tools' addresses", () => {
  test("under Knowledge when it is readable without an account", () => {
    const options = { publicKnowledge: true };
    expect(publicToolsBasePath(options)).toBe("/knowledge/tools");
    expect(publicToolPath("sanctions", options)).toBe(
      "/knowledge/tools/sanctions",
    );
    expect(publicToolInstallPath("sanctions", options)).toBe(
      "/knowledge/tools/sanctions?install=1",
    );
    expect(publicToolDownloadPath("sanctions", options)).toBe(
      "/knowledge/tools/sanctions/download",
    );
    expect(publicToolsContributePath(options)).toBe(
      "/knowledge/tools/contribute",
    );
    expect(legacyToolsRoutesServed(options)).toBe(false);
  });

  test("at the top-level pages otherwise", () => {
    const options = { publicKnowledge: false };
    expect(publicToolsBasePath(options)).toBe("/tools");
    expect(publicToolPath("sanctions", options)).toBe("/tools/sanctions");
    expect(publicToolInstallPath("sanctions", options)).toBe(
      "/tools/sanctions?install=1",
    );
    expect(publicToolDownloadPath("sanctions", options)).toBe(
      "/tools/sanctions/download",
    );
    expect(publicToolsContributePath(options)).toBe("/tools/contribute");
  });
});
