import type { BetterAuthClientPlugin } from "better-auth/client";

import {
  SESSION_SIGN_IN_MAP_PATH,
  SESSION_SIGN_IN_REVIEW_PATH,
  SESSION_SIGN_INS_PATH,
} from "@stll/api-contract/session-sign-ins";
import type { SessionSignInReview } from "@stll/api-contract/session-sign-ins";

type ClientFetch = Parameters<
  NonNullable<BetterAuthClientPlugin["getActions"]>
>[0];

/** The revocation endpoint the API's session-lifetime plugin mounts. */
export const REVOKE_SESSION_BY_ID_PATH = "/revoke-session-by-id";

/** The routes this client's actions write to; resource contracts name them. */
export type SessionSignInsWriteRoute =
  typeof REVOKE_SESSION_BY_ID_PATH | typeof SESSION_SIGN_IN_REVIEW_PATH;

type ReviewSessionSignInBody = {
  sessionId: string;
  review: Exclude<SessionSignInReview, "not_required">;
};

/**
 * The account's own session endpoints the API adds beside Better Auth's, as
 * client actions: `authClient.revokeSessionById` and
 * `authClient.sessionSignIns.*`. Naming them as actions keeps each write a
 * typed call whose route its resource contract can declare.
 */
export const sessionSignInsClient = () =>
  ({
    id: "session-sign-ins",
    getActions: ($fetch: ClientFetch) => ({
      revokeSessionById: async (body: { sessionId: string }) =>
        await $fetch<unknown>(REVOKE_SESSION_BY_ID_PATH, {
          method: "POST",
          body,
        }),
      sessionSignIns: {
        list: async () =>
          await $fetch<unknown>(SESSION_SIGN_INS_PATH, { method: "GET" }),
        // The PNG answer arrives as a `Blob`.
        map: async (query: { sessionId: string }) =>
          await $fetch<unknown>(SESSION_SIGN_IN_MAP_PATH, {
            method: "GET",
            query,
          }),
        review: async (body: ReviewSessionSignInBody) =>
          await $fetch<unknown>(SESSION_SIGN_IN_REVIEW_PATH, {
            method: "POST",
            body,
          }),
      },
    }),
  }) satisfies BetterAuthClientPlugin;
