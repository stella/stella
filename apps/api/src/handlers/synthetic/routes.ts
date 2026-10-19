import Elysia from "elysia";
import { timingSafeEqual } from "node:crypto";

import { sha256Bytes } from "@stll/sha256/bun";
import { Temporal } from "@stll/time";

import { env } from "@/api/env";
import { getRequestId } from "@/api/lib/observability/request-context";
import { reserveSyntheticSessionBudget } from "@/api/lib/rate-limit/synthetic-session-budget";
import { mintSyntheticSession } from "@/api/lib/synthetic-principal/store";

type SyntheticRouteOptions = {
  keys: typeof env.SYNTHETIC_SESSION_KEYS;
  mintSession: typeof mintSyntheticSession;
  reserveBudget?: () => Promise<boolean>;
  nowMs?: () => number;
};

const authorizedKeyLabel = (
  header: string | null,
  { keys, nowMs }: Pick<SyntheticRouteOptions, "keys" | "nowMs">,
): string | undefined => {
  if (header === null || !/^stl_syn_[A-Za-z0-9_-]{43}$/u.test(header)) {
    return undefined;
  }
  const digest = sha256Bytes(header);
  let label: string | undefined;
  const now = (nowMs ?? (() => Temporal.Now.instant().epochMilliseconds))();
  for (const key of keys ?? []) {
    const matches = timingSafeEqual(digest, Buffer.from(key.sha256, "hex"));
    if (
      matches &&
      Temporal.Instant.from(key.notAfter).epochMilliseconds > now
    ) {
      label = key.label;
    }
  }
  return label;
};

export const createSyntheticRoute = ({
  keys,
  mintSession,
  reserveBudget = reserveSyntheticSessionBudget,
  nowMs,
}: SyntheticRouteOptions) => {
  const route = new Elysia({ name: "synthetic-session", prefix: "/synthetic" });
  if (keys === undefined) {
    return route;
  }
  return route.post(
    "/session",
    async ({ request, status }) => {
      const keyLabel = authorizedKeyLabel(
        request.headers.get("x-stella-synthetic-key"),
        { keys, nowMs },
      );
      if (keyLabel === undefined) {
        return new Response(null, { status: 404 });
      }
      if (!(await reserveBudget())) {
        return status(429, { error: "Try again later." });
      }
      const session = await mintSession({
        keyLabel,
        requestId: getRequestId(request),
        userAgent: request.headers.get("user-agent"),
      });
      if (session === null) {
        return new Response(null, { status: 404 });
      }
      return session;
    },
    { parse: "none" },
  );
};

export const syntheticRoute = createSyntheticRoute({
  keys: env.SYNTHETIC_SESSION_KEYS,
  mintSession: mintSyntheticSession,
});
