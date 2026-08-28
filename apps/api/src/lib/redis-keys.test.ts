import { describe, expect, test } from "bun:test";

import {
  FOLIO_COLLAB_REDIS_SCOPE,
  toFolioCollabRoomName,
} from "@stll/api-contract/folio-collab";
import { toSafeId } from "@stll/api-contract/safe-id";

import {
  COORDINATION_KEY_EXPIRY,
  coordinationExpireArguments,
  coordinationKey,
  coordinationSetArguments,
  unboundedCoordinationKey,
  type CoordinationScope,
} from "@/api/lib/redis-keys";

const isCoordinationScope = (value: string): value is CoordinationScope =>
  value in COORDINATION_KEY_EXPIRY;

const SCOPES = Object.keys(COORDINATION_KEY_EXPIRY).filter(isCoordinationScope);

/** Widen a built key so it can be compared against an expected literal. */
const text = (key: string): string => key;

const HASHTAG = /\{(?<slot>[^{}]*)\}/u;

const hashtagOf = (key: string): string => {
  const match = HASHTAG.exec(key);
  expect(match?.groups?.["slot"]).toBeDefined();
  return match?.groups?.["slot"] ?? "";
};

const occurrences = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1;

const buildFor = (scope: CoordinationScope, slot: string, suffix?: string) =>
  COORDINATION_KEY_EXPIRY[scope] === "unbounded"
    ? unboundedCoordinationKey({ scope, slot, suffix })
    : coordinationKey({ scope, slot, suffix });

describe("coordination key layout", () => {
  test("Hocuspocus room channels and locks use the room UUID hashtag", () => {
    const roomId = toSafeId<"folioCollabRoom">(
      "01993f60-b9d0-7000-8000-000000000001",
    );
    const roomName = toFolioCollabRoomName(roomId);

    expect(`${FOLIO_COLLAB_REDIS_SCOPE}:${roomName}`).toBe(
      coordinationKey({ scope: FOLIO_COLLAB_REDIS_SCOPE, slot: roomId }),
    );
    expect(`${FOLIO_COLLAB_REDIS_SCOPE}:${roomName}:lock`).toBe(
      coordinationKey({
        scope: FOLIO_COLLAB_REDIS_SCOPE,
        slot: roomId,
        suffix: "lock",
      }),
    );
  });

  test("every declared scope builds a scope-prefixed, single-hashtag key", () => {
    // The guard above must not have dropped a scope on the way in.
    expect(SCOPES).toHaveLength(Object.keys(COORDINATION_KEY_EXPIRY).length);
    const built = new Set<string>();
    for (const scope of SCOPES) {
      const key = buildFor(scope, "slot-a", "field");
      built.add(scope);
      expect(key.startsWith(`${scope}:`)).toBe(true);
      expect(text(key)).toBe(`${scope}:{slot-a}:field`);
      // Exactly one hashtag: a second pair would leave the cluster routing on
      // the first one while the reader assumes the last.
      expect(occurrences(key, "{")).toBe(1);
      expect(occurrences(key, "}")).toBe(1);
    }
    // Declared set equals exercised set, in both directions.
    expect([...built].sort()).toEqual([...SCOPES].sort());
  });

  test("keys sharing a slot colocate and keys with distinct slots do not", () => {
    const running = coordinationKey({
      scope: "workflow-run",
      slot: "ws-1",
      suffix: "running",
    });
    const total = coordinationKey({
      scope: "workflow-run",
      slot: "ws-1",
      suffix: "total",
    });
    const otherWorkspace = coordinationKey({
      scope: "workflow-run",
      slot: "ws-2",
      suffix: "running",
    });

    expect(hashtagOf(running)).toBe(hashtagOf(total));
    expect(hashtagOf(running)).not.toBe(hashtagOf(otherWorkspace));
  });

  test("the suffix stays outside the hashtag", () => {
    const key = coordinationKey({
      scope: "api-ratelimit",
      slot: "scope:1.2.3.4",
      suffix: "extra",
    });
    expect(hashtagOf(key)).toBe("scope:1.2.3.4");
  });
});

describe("slot escaping", () => {
  // Slots carry externally-derived values (client addresses, better-auth keys,
  // content digests). A brace inside one would silently re-route the key, and
  // a lossy escape would merge two clients into one counter.
  const adversarialSlots = [
    "plain",
    "{",
    "}",
    "{}",
    "%",
    "%7B",
    "%7D",
    "a{b}c",
    "a%7Bb%7Dc",
    "{nested{deep}}",
  ];

  test("no escaped slot reintroduces a hashtag delimiter", () => {
    for (const slot of adversarialSlots) {
      expect(hashtagOf(coordinationKey({ scope: "api-ratelimit", slot }))).toBe(
        hashtagOf(coordinationKey({ scope: "api-ratelimit", slot })),
      );
      expect(
        hashtagOf(coordinationKey({ scope: "api-ratelimit", slot })),
      ).not.toMatch(/[{}]/u);
    }
  });

  test("escaping is injective, so distinct slots keep distinct keys", () => {
    const keys = adversarialSlots.map((slot) =>
      coordinationKey({ scope: "api-ratelimit", slot }),
    );
    expect(new Set(keys).size).toBe(adversarialSlots.length);
  });

  test("an empty slot is a programmer error, not an unrouted key", () => {
    expect(() => coordinationKey({ scope: "api-ratelimit", slot: "" })).toThrow(
      /empty slot/u,
    );
  });
});

describe("expiry discipline", () => {
  test("a TTL scope cannot be built as unbounded and the reverse", () => {
    expect(() =>
      unboundedCoordinationKey({ scope: "api-ratelimit", slot: "x" }),
    ).toThrow(/requires a TTL/u);
    expect(() =>
      coordinationKey({ scope: "ocr-repair-cursor", slot: "x" }),
    ).toThrow(/unbounded/u);
  });

  test("SET arguments always carry an expiry token", () => {
    const key = coordinationKey({ scope: "auth-ratelimit", slot: "ip" });
    expect(
      coordinationSetArguments({
        key,
        value: "v",
        ttl: { unit: "seconds", value: 60 },
      }),
    ).toEqual([key, "v", "EX", "60"]);
    expect(
      coordinationSetArguments({
        key,
        value: "v",
        ttl: { unit: "milliseconds", value: 500 },
        onlyIfAbsent: true,
      }),
    ).toEqual([key, "v", "PX", "500", "NX"]);
    expect(coordinationExpireArguments(key, 30)).toEqual([key, "30"]);
  });
});

describe("scan globs", () => {
  // The running-lock scan derives its glob from the same builder, so a key
  // layout change cannot leave the scan matching the old shape.
  test("a glob slot passes through unescaped and matches real keys", () => {
    const pattern = coordinationKey({
      scope: "workflow-run",
      slot: "*",
      suffix: "running",
    });
    expect(text(pattern)).toBe("workflow-run:{*}:running");

    const lock = coordinationKey({
      scope: "workflow-run",
      slot: "ws-1",
      suffix: "running",
    });
    expect(new Bun.Glob(pattern).match(lock)).toBe(true);
    expect(
      new Bun.Glob(pattern).match(
        coordinationKey({
          scope: "workflow-run",
          slot: "ws-1",
          suffix: "total",
        }),
      ),
    ).toBe(false);
  });
});
