import { Result } from "better-result";
import { expect, test } from "bun:test";

import { createLatestDesktopRelease, type FeedFetch } from "./latest-release";

const present = (value: string) => ({ type: "present", value });

/** A feed that answers `bodies` in turn and counts its reads. */
const scriptedFeed = (bodies: readonly (string | null)[]) => {
  let reads = 0;
  const fetchFeed: FeedFetch = async () => {
    const body = bodies[Math.min(reads, bodies.length - 1)] ?? null;
    reads += 1;
    await Promise.resolve();
    return Result.ok({
      ok: body !== null,
      status: body === null ? 503 : 200,
      headers: new Headers(),
      body: new TextEncoder().encode(body ?? ""),
    } as never);
  };
  return { fetchFeed, reads: () => reads };
};

test("a feed version answers every report until it is stale, read once", async () => {
  let now = 0;
  const latest = createLatestDesktopRelease(() => now);
  const feed = scriptedFeed([
    JSON.stringify({ version: "0.9.91", platforms: {} }),
    JSON.stringify({ version: "0.9.92", platforms: {} }),
  ]);

  const concurrent = await Promise.all([
    latest(feed.fetchFeed),
    latest(feed.fetchFeed),
  ]);
  expect(concurrent).toEqual([present("0.9.91"), present("0.9.91")]);
  expect(feed.reads()).toBe(1);

  now = 4 * 60 * 1000;
  expect(await latest(feed.fetchFeed)).toEqual(present("0.9.91"));
  expect(feed.reads()).toBe(1);

  now = 5 * 60 * 1000;
  expect(await latest(feed.fetchFeed)).toEqual(present("0.9.92"));
  expect(feed.reads()).toBe(2);
});

test("an unreadable or malformed feed is unknown, and is tried again sooner", async () => {
  let now = 0;
  const latest = createLatestDesktopRelease(() => now);
  const feed = scriptedFeed([
    null,
    JSON.stringify({ version: "latest" }),
    "not json",
    JSON.stringify({ version: "0.9.91" }),
  ]);

  expect((await latest(feed.fetchFeed)).type).toBe("unavailable");
  now += 60 * 1000;
  expect((await latest(feed.fetchFeed)).type).toBe("unavailable");
  now += 60 * 1000;
  expect((await latest(feed.fetchFeed)).type).toBe("unavailable");
  now += 30 * 1000;
  // Still within the retry pause: no read.
  expect((await latest(feed.fetchFeed)).type).toBe("unavailable");
  expect(feed.reads()).toBe(3);
  now += 30 * 1000;
  expect(await latest(feed.fetchFeed)).toEqual(present("0.9.91"));
});
