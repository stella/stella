import Elysia from "elysia";
import type { Context } from "elysia";
import { timingSafeEqual } from "node:crypto";

import { sha256Bytes } from "@stll/sha256/bun";
import { Temporal } from "@stll/time";

import { bindOwnerSyntheticSessionStore } from "@/api/db/root";
import { env } from "@/api/env";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { getRequestId } from "@/api/lib/observability/request-context";
import { reserveSyntheticSessionBudget } from "@/api/lib/rate-limit/synthetic-session-budget";
import { createSyntheticSessionStore } from "@/api/lib/synthetic-principal/store";

type SyntheticRouteOptions = {
  keys: typeof env.SYNTHETIC_SESSION_KEYS;
  mintSession: ReturnType<
    typeof createSyntheticSessionStore
  >["mintSyntheticSession"];
  reserveBudget?: () => Promise<boolean>;
  nowMs?: () => number;
};

const authorizedKeyLabel = (
  header: string | null,
  {
    keys,
    nowMs,
  }: { keys: NonNullable<SyntheticRouteOptions["keys"]>; nowMs: () => number },
): string | undefined => {
  if (header === null || !/^stl_syn_[A-Za-z0-9_-]{43}$/u.test(header)) {
    return undefined;
  }
  const digest = sha256Bytes(header);
  let label: string | undefined;
  const now = nowMs();
  for (const key of keys) {
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

const createSyntheticSessionHandler = ({
  keys,
  mintSession,
  reserveBudget = reserveSyntheticSessionBudget,
  nowMs = () => Temporal.Now.instant().epochMilliseconds,
}: SyntheticRouteOptions) => {
  const createSession = async ({
    request,
    status,
  }: Pick<Context, "request" | "status">) => {
    if (keys === undefined) {
      return new Response(null, { status: 404 });
    }
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
  };
  declareAggregateMutation(createSession, {
    type: "independent",
    reason:
      "The dedicated session store serializes its singleton control row and owns the account, session, and audit writes in one transaction.",
  });
  return createSession;
};

export const createSyntheticRoute = (options: SyntheticRouteOptions) => {
  const createSession = createSyntheticSessionHandler(options);
  return new Elysia({ name: "synthetic-session", prefix: "/synthetic" }).post(
    "/session",
    createSession,
    { parse: "none" },
  );
};

const syntheticSessionStore = bindOwnerSyntheticSessionStore(
  createSyntheticSessionStore,
);
export const syntheticRoute = createSyntheticRoute({
  keys: env.SYNTHETIC_SESSION_KEYS,
  mintSession: syntheticSessionStore.mintSyntheticSession,
});
