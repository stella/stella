import { describe, expect, test } from "bun:test";

import { fetchLatestCliVersion } from "./cli-release-channel.js";

describe("CLI npm release channel", () => {
  test("returns the stable version published under npm latest", async () => {
    const version = await fetchLatestCliVersion({
      fetcher: async () => Response.json({ version: "0.4.3" }),
    });

    expect(version).toBe("0.4.3");
  });

  test("fails silently for unavailable or malformed registry responses", async () => {
    const unavailable = await fetchLatestCliVersion({
      fetcher: async () => new Response("offline", { status: 503 }),
    });
    const malformed = await fetchLatestCliVersion({
      fetcher: async () => Response.json({ version: "next" }),
    });
    const networkError = await fetchLatestCliVersion({
      fetcher: async () => {
        throw new Error("offline");
      },
    });

    expect(unavailable).toBeUndefined();
    expect(malformed).toBeUndefined();
    expect(networkError).toBeUndefined();
  });
});
