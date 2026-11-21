import type { BetterAuthPlugin } from "better-auth";
import {
  createAuthEndpoint,
  sensitiveSessionMiddleware,
  sessionMiddleware,
} from "better-auth/api";
import { panic, Result, TaggedError } from "better-result";
import * as v from "valibot";

import {
  SESSION_SIGN_IN_MAP_PATH,
  SESSION_SIGN_IN_REVIEW_PATH,
  SESSION_SIGN_INS_PATH,
  sessionSignInReviewBodySchema,
} from "@stll/api-contract/session-sign-ins";
import {
  LOCATION_MAP_CONTENT_TYPE,
  renderLocationMap,
} from "@stll/transactional/map/location-map";

import {
  CACHE_CONTROL_HEADER,
  PRIVATE_CACHE_CONTROL,
  privateCacheControl,
} from "@/api/http/cache";
import {
  SESSION_SIGN_IN_REVIEW_REFUSAL,
  type SessionSignInStore,
} from "@/api/lib/auth/session-sign-ins";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";

/**
 * A session's sign-in place never changes, so its map may stay in the
 * account holder's own browser cache for a day; no shared cache keeps it.
 */
const SIGN_IN_MAP_MAX_AGE_SECONDS = 24 * 60 * 60;

const signInMapCountryUnresolved = failureSink({
  event: "auth.session_sign_in_map.country_unresolved",
  expected: [],
});

class SignInMapCountryUnresolvedError extends TaggedError(
  "SignInMapCountryUnresolvedError",
)<{ message: string; countryCode: string }> {}

const sessionIdQuery = v.strictObject({
  sessionId: sessionSignInReviewBodySchema.entries.sessionId,
});

/**
 * The account holder's own sign-in details, beside Better Auth's session
 * list: where each live session signed in from, whether it waits for review,
 * and its map. Every read and write is scoped to the authenticated user's own
 * live sessions in the query that touches them.
 */
export const createSessionSignInsPlugin = (store: () => SessionSignInStore) =>
  ({
    id: "session-sign-ins",
    endpoints: {
      listSessionSignIns: createAuthEndpoint(
        SESSION_SIGN_INS_PATH,
        { method: "GET", requireHeaders: true, use: [sessionMiddleware] },
        async (ctx) => {
          ctx.setHeader(CACHE_CONTROL_HEADER, PRIVATE_CACHE_CONTROL);
          const sessions = await store().list(
            brandPersistedUserId(ctx.context.session.user.id),
          );
          return ctx.json({ sessions });
        },
      ),
      reviewSessionSignIn: createAuthEndpoint(
        SESSION_SIGN_IN_REVIEW_PATH,
        {
          method: "POST",
          body: sessionSignInReviewBodySchema,
          requireHeaders: true,
          use: [sensitiveSessionMiddleware],
        },
        async (ctx) => {
          ctx.setHeader(CACHE_CONTROL_HEADER, PRIVATE_CACHE_CONTROL);
          const decided = await store().decide({
            userId: brandPersistedUserId(ctx.context.session.user.id),
            sessionId: ctx.body.sessionId,
            review: ctx.body.review,
            request: ctx.request,
          });
          if (Result.isOk(decided)) {
            return ctx.json({ review: decided.value });
          }
          switch (decided.error) {
            case SESSION_SIGN_IN_REVIEW_REFUSAL.notFound:
              ctx.setStatus(404);
              return ctx.json({
                code: "SESSION_NOT_FOUND",
                message: "Session not found",
              });
            case SESSION_SIGN_IN_REVIEW_REFUSAL.notUnderReview:
              ctx.setStatus(409);
              return ctx.json({
                code: "SIGN_IN_NOT_UNDER_REVIEW",
                message: "This sign-in is not waiting for review",
              });
            default:
              decided.error satisfies never;
              return panic("Unknown sign-in review refusal");
          }
        },
      ),
      sessionSignInMap: createAuthEndpoint(
        SESSION_SIGN_IN_MAP_PATH,
        {
          method: "GET",
          query: sessionIdQuery,
          requireHeaders: true,
          use: [sessionMiddleware],
        },
        async (ctx) => {
          const place = await store().mapPlace({
            userId: brandPersistedUserId(ctx.context.session.user.id),
            sessionId: ctx.query.sessionId,
          });
          if (place === null) {
            ctx.setHeader(CACHE_CONTROL_HEADER, PRIVATE_CACHE_CONTROL);
            ctx.setStatus(404);
            return ctx.json({
              code: "SIGN_IN_MAP_NOT_FOUND",
              message: "No map for this session",
            });
          }
          const { png, highlight } = await renderLocationMap(place);
          if (highlight.type === "unresolved") {
            observeFailure(
              new SignInMapCountryUnresolvedError({
                message: "The location map has no feature for the country",
                countryCode: highlight.countryCode,
              }),
              { sink: signInMapCountryUnresolved },
            );
          }
          return new Response(png, {
            headers: {
              "Content-Type": LOCATION_MAP_CONTENT_TYPE,
              [CACHE_CONTROL_HEADER]: privateCacheControl(
                SIGN_IN_MAP_MAX_AGE_SECONDS,
              ),
            },
          });
        },
      ),
    },
  }) satisfies BetterAuthPlugin;
