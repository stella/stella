import { describe, expect, test } from "bun:test";

import {
  type GithubSkillContentResult,
  loadGithubSkillMarkdown,
  NEGATIVE_CACHE_TTL_MS,
  readCappedBody,
  resolveGithubSkillContent,
  resolveWithCache,
} from "@/lib/public-tools-github-content";

const streamOf = (chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });

const encoder = new TextEncoder();

describe("readCappedBody", () => {
  test("decodes a within-cap body", async () => {
    const body = streamOf([encoder.encode("hello "), encoder.encode("world")]);
    expect(await readCappedBody(body, 1024)).toBe("hello world");
  });

  test("returns null once accumulated bytes exceed the cap", async () => {
    const body = streamOf([
      encoder.encode("a".repeat(6)),
      encoder.encode("b".repeat(6)),
    ]);
    // Cap of 8 is blown by the second chunk (12 bytes total).
    expect(await readCappedBody(body, 8)).toBeNull();
  });

  test("does not decode per chunk (multi-byte char split across chunks)", async () => {
    // "é" is 0xC3 0xA9 in UTF-8; split it across two chunks to prove the
    // reader concatenates before decoding rather than corrupting the
    // boundary byte.
    const body = streamOf([new Uint8Array([0xc3]), new Uint8Array([0xa9])]);
    expect(await readCappedBody(body, 1024)).toBe("é");
  });
});

describe("loadGithubSkillMarkdown", () => {
  test("degrades a rejected RPC to unavailable content", async () => {
    const markdown = await loadGithubSkillMarkdown(
      "broken",
      async () => await Promise.reject(new Error("RPC unavailable")),
    );

    expect(markdown).toBeNull();
  });
});

const ok = (markdown: string): GithubSkillContentResult => ({
  status: "ok",
  markdown,
});
const err: GithubSkillContentResult = { status: "error" };

describe("resolveWithCache", () => {
  test("deduplicates concurrent callers onto a single in-flight fetch", async () => {
    const cache = new Map();
    let calls = 0;
    let release!: (result: GithubSkillContentResult) => void;
    const fetcher = async () => {
      calls += 1;
      return await new Promise<GithubSkillContentResult>((resolve) => {
        release = resolve;
      });
    };
    const options = { cache, now: () => 0 };

    // Both calls happen before the fetch resolves: the second must reuse
    // the first's in-flight promise rather than start its own fetch.
    const first = resolveWithCache("k", fetcher, options);
    const second = resolveWithCache("k", fetcher, options);
    expect(calls).toBe(1);

    release(ok("shared"));
    expect(await first).toEqual(ok("shared"));
    expect(await second).toEqual(ok("shared"));
    expect(calls).toBe(1);
  });

  test("retains a success permanently (no refetch even far in the future)", async () => {
    const cache = new Map();
    let calls = 0;
    let clock = 0;
    const fetcher = async () => {
      calls += 1;
      return ok("immutable");
    };
    const now = () => clock;

    expect(await resolveWithCache("k", fetcher, { cache, now })).toEqual(
      ok("immutable"),
    );
    clock = NEGATIVE_CACHE_TTL_MS * 1_000_000;
    expect(await resolveWithCache("k", fetcher, { cache, now })).toEqual(
      ok("immutable"),
    );
    expect(calls).toBe(1);
  });

  test("caches an error for the TTL, then refetches once it expires", async () => {
    const cache = new Map();
    let calls = 0;
    let clock = 0;
    const fetcher = async () => {
      calls += 1;
      return err;
    };
    const now = () => clock;

    expect(await resolveWithCache("k", fetcher, { cache, now })).toEqual(err);
    expect(calls).toBe(1);

    // Within the TTL: the broken upstream is not hit again.
    clock = NEGATIVE_CACHE_TTL_MS - 1;
    expect(await resolveWithCache("k", fetcher, { cache, now })).toEqual(err);
    expect(calls).toBe(1);

    // Past the TTL: the negative entry is retried exactly once more.
    clock = NEGATIVE_CACHE_TTL_MS + 1;
    expect(await resolveWithCache("k", fetcher, { cache, now })).toEqual(err);
    expect(calls).toBe(2);
  });

  test("a rejecting fetcher lands as a TTL'd negative entry (not a poisoned slot)", async () => {
    const cache = new Map();
    let calls = 0;
    let clock = 0;
    const fetcher = async () => {
      calls += 1;
      throw new Error("boom");
    };
    const now = () => clock;

    expect(await resolveWithCache("k", fetcher, { cache, now })).toEqual(err);
    // Still cached within the TTL despite the rejection.
    clock = NEGATIVE_CACHE_TTL_MS - 1;
    expect(await resolveWithCache("k", fetcher, { cache, now })).toEqual(err);
    expect(calls).toBe(1);
    // Retried after the TTL.
    clock = NEGATIVE_CACHE_TTL_MS + 1;
    await resolveWithCache("k", fetcher, { cache, now });
    expect(calls).toBe(2);
  });
});

describe("resolveGithubSkillContent gate", () => {
  test("returns error without any outbound fetch when the launch flag is off", async () => {
    let calls = 0;
    const fetchRawSkill = async () => {
      calls += 1;
      return ok("should-not-run");
    };

    const result = await resolveGithubSkillContent("any-slug", {
      isEnabled: () => false,
      fetchRawSkill,
      cache: new Map(),
    });

    expect(result).toEqual(err);
    expect(calls).toBe(0);
  });
});
