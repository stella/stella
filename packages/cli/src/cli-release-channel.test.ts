import { describe, expect, test } from "bun:test";

import { fetchLatestCliVersion } from "./cli-release-channel.js";

describe("CLI npm release channel", () => {
  test("returns the stable version published under npm latest", async () => {
    let requestUrl: string | undefined;
    let requestAccept: string | null | undefined;
    const version = await fetchLatestCliVersion({
      fetcher: async (input, init) => {
        if (typeof input === "string") {
          requestUrl = input;
        } else if (input instanceof URL) {
          requestUrl = input.href;
        } else {
          requestUrl = input.url;
        }
        requestAccept = new Headers(init?.headers).get("Accept");
        return Response.json({ version: "0.4.3" });
      },
    });

    expect(version).toBe("0.4.3");
    expect(requestUrl).toBe("https://registry.npmjs.org/@stll%2Fcli/latest");
    expect(requestAccept).toBe("application/json");
  });

  test("fails silently for unavailable or malformed registry responses", async () => {
    const unavailable = await fetchLatestCliVersion({
      fetcher: async () => new Response("offline", { status: 503 }),
    });
    const malformed = await fetchLatestCliVersion({
      fetcher: async () => Response.json({ version: "next" }),
    });
    const prerelease = await fetchLatestCliVersion({
      fetcher: async () => Response.json({ version: "1.0.0-beta.1" }),
    });
    const networkError = await fetchLatestCliVersion({
      fetcher: async () => {
        throw new Error("offline");
      },
    });

    expect(unavailable).toBeUndefined();
    expect(malformed).toBeUndefined();
    expect(prerelease).toBeUndefined();
    expect(networkError).toBeUndefined();
  });
});
