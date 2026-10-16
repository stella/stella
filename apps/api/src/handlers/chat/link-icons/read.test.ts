import { Result } from "better-result";
import { expect, test } from "bun:test";
import Elysia from "elysia";

import { isValidLinkIconImage } from "@/api/handlers/chat/link-icons/image";
import { createLinkIconOrigin } from "@/api/handlers/chat/link-icons/origin";
import type { CacheableLinkIconOutcome } from "@/api/handlers/chat/link-icons/outcome";
import { readLinkIcon } from "@/api/handlers/chat/link-icons/read";
import { linkIconBody } from "@/api/handlers/chat/link-icons/response";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import { toSafeId } from "@/api/lib/branded-types";
import { SafeOutboundFetchError } from "@/api/lib/safe-outbound-fetch";

const ICON_BYTES = Uint8Array.fromBase64(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=",
);

for (const failure of ["timeout", "deadline", 503] as const) {
  test(`a ${failure} followed by a valid icon recovers without a negative cache entry`, async () => {
    expect(isValidLinkIconImage(ICON_BYTES, "image/png")).toBe(true);
    let now = 0;
    let requests = 0;
    let leaseUntil = 0;
    let stored: CacheableLinkIconOutcome | undefined;
    const origin = createLinkIconOrigin({
      now: () => now,
      fetchBytes: async () => {
        requests += 1;
        if (requests === 1 && failure === "timeout") {
          return Result.err(
            new SafeOutboundFetchError({ message: "Request timed out" }),
          );
        }
        if (requests === 1 && failure === "deadline") {
          now += 3000;
        }
        const status =
          requests === 1 && typeof failure === "number" ? failure : 200;
        return Result.ok({
          status,
          ok: status === 200,
          body: new Uint8Array(ICON_BYTES).buffer,
          headers: new Headers({ "content-type": "image/png" }),
        });
      },
    });
    const cache = {
      readOrLease: async () => {
        if (stored !== undefined) {
          return stored;
        }
        if (now < leaseUntil) {
          return { type: "temporary" } as const;
        }
        leaseUntil = now + 10_000;
        return { type: "lease", token: "test-lease" } as const;
      },
      store: async ({ outcome }) => {
        stored = outcome;
        return true;
      },
    } satisfies Parameters<typeof readLinkIcon>[0]["cache"];
    const permit = grantThirdPartyOutboundPermit();
    const app = new Elysia().get("/icon", async ({ set }) =>
      linkIconBody(
        await readLinkIcon({
          hostname: "example.com",
          userId: toSafeId<"user">("retry-user"),
          ip: "192.0.2.1",
          cache,
          readOrigin: async (hostname) => await origin(hostname, permit),
        }),
        set,
      ),
    );
    const request = () => new Request("http://localhost/icon");
    const first = await app.handle(request());
    expect(await first.json()).toEqual({ type: "temporary" });
    expect(first.headers.get("cache-control")).toContain("no-store");
    expect(stored).toBeUndefined();
    expect(requests).toBe(1);
    // Pass the short lease while staying well inside the one-hour negative TTL.
    now = 11_000;
    const recovered = await app.handle(request());
    expect(recovered.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await recovered.arrayBuffer())).toEqual(ICON_BYTES);
    expect(requests).toBe(2);
    const cached = await app.handle(request());
    expect(cached.headers.get("cache-control")).toContain("max-age=3600");
    expect(requests).toBe(2);
  });
}
