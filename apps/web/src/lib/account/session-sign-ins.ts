import { queryOptions } from "@tanstack/react-query";
import { Result } from "better-result";
import * as v from "valibot";

import { RESOURCE_TYPE } from "@stll/api-contract";
import {
  sessionSignInReviewResultSchema,
  sessionSignInsSchema,
} from "@stll/api-contract/session-sign-ins";
import type { SessionSignInReview } from "@stll/api-contract/session-sign-ins";

import { authClient } from "@/lib/auth-client";
import { STALE_TIME } from "@/lib/consts";
import { AuthClientError, toAuthClientError } from "@/lib/errors/auth";
import { readQueryResult } from "@/lib/errors/query-result";
import { resourceQueryOptions } from "@/lib/workspace-realtime";

const invalidResponse = (message: string) =>
  new AuthClientError({ message, status: 502, statusText: "Bad Gateway" });

export const sessionSignInsKeys = {
  all: ["session-sign-ins"] as const,
  list: (userId: string) => [...sessionSignInsKeys.all, userId] as const,
  map: ({ userId, sessionId }: SessionSignInMapOptions) =>
    [...sessionSignInsKeys.all, userId, "map", sessionId] as const,
};

/**
 * Where each of the account holder's live sessions signed in from. The
 * account's own data: a write to the account's sessions refreshes it.
 */
export const sessionSignInsOptions = (userId: string) =>
  resourceQueryOptions(
    queryOptions({
      queryKey: sessionSignInsKeys.list(userId),
      queryFn: async () => {
        const result = await authClient.sessionSignIns.list();
        if (result.error) {
          return readQueryResult(Result.err(toAuthClientError(result.error)));
        }
        const parsed = v.safeParse(sessionSignInsSchema, result.data);
        return readQueryResult(
          parsed.success
            ? Result.ok(parsed.output.sessions)
            : Result.err(invalidResponse("Invalid sign-in list response")),
        );
      },
    }),
    { resources: [RESOURCE_TYPE.USER], scope: { type: "user", userId } },
  );

type ReviewSessionSignInOptions = {
  sessionId: string;
  review: Exclude<SessionSignInReview, "not_required">;
};

/** Confirms a sign-in waiting for review, or undoes the confirmation. */
export const reviewSessionSignIn = async ({
  sessionId,
  review,
}: ReviewSessionSignInOptions): Promise<SessionSignInReview> => {
  const result = await authClient.sessionSignIns.review({ sessionId, review });
  if (result.error) {
    return readQueryResult(Result.err(toAuthClientError(result.error)));
  }
  const parsed = v.safeParse(sessionSignInReviewResultSchema, result.data);
  return readQueryResult(
    parsed.success
      ? Result.ok(parsed.output.review)
      : Result.err(invalidResponse("Invalid sign-in review response")),
  );
};

type SessionSignInMapOptions = { userId: string; sessionId: string };

/**
 * The map of one session's sign-in place, read through the auth client like
 * every other account read. A place does not move, so the map stays fresh
 * for as long as it is shown.
 */
export const sessionSignInMapOptions = ({
  userId,
  sessionId,
}: SessionSignInMapOptions) =>
  resourceQueryOptions(
    queryOptions({
      queryKey: sessionSignInsKeys.map({ userId, sessionId }),
      queryFn: async () => {
        const result = await authClient.sessionSignIns.map({ sessionId });
        if (result.error) {
          return readQueryResult(Result.err(toAuthClientError(result.error)));
        }
        return readQueryResult(
          result.data instanceof Blob
            ? Result.ok(result.data)
            : Result.err(invalidResponse("Invalid sign-in map response")),
        );
      },
      staleTime: STALE_TIME.INFINITE,
    }),
    // A write to the account never redraws a map; signing a session out
    // only stops its map from being shown.
    { type: "independent" },
  );
