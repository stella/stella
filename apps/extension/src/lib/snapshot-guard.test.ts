import { describe, expect, test } from "bun:test";

import type { BrowserControlCommand } from "@stll/api-contract/browser-control";

import { browserCommandMatchesSnapshot } from "./snapshot-guard";

const command = {
  action: "click",
  page: { revision: "revision-1", url: "https://example.com/" },
  target: { name: "Submit", ref: "e:0:1", role: "button" },
} satisfies BrowserControlCommand;

describe("browser snapshot identity", () => {
  test("requires both the stored revision and current tab URL", () => {
    expect(
      browserCommandMatchesSnapshot(
        { revision: "revision-1", url: "https://example.com/" },
        "https://example.com/",
        command,
      ),
    ).toBe(true);
    expect(
      browserCommandMatchesSnapshot(
        { revision: "revision-2", url: "https://example.com/" },
        "https://example.com/",
        command,
      ),
    ).toBe(false);
    expect(
      browserCommandMatchesSnapshot(
        { revision: "revision-1", url: "https://example.com/" },
        "https://example.com/redirected",
        command,
      ),
    ).toBe(false);
  });
});
