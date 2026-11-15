// Where the task pane keeps its grant between sessions.
//
// The access token lives in memory only. The refresh token is kept in the
// task pane origin's localStorage so the pane does not reopen the sign-in
// dialog every time Outlook reloads it. That is acceptable because stella's
// authorization server rotates refresh tokens on every use (a replayed one
// is refused after a short idempotency window), so a copied token is good
// for at most one refresh and is invalidated when the pane refreshes first.
// Only this origin's pages can read it; the dialog pages never touch it.

import { Result } from "better-result";
import * as v from "valibot";

const STORAGE_KEY = "stella.outlook.grant.v1";

const storedGrantSchema = v.object({
  clientId: v.pipe(v.string(), v.minLength(1)),
  issuer: v.pipe(v.string(), v.url()),
  refreshToken: v.pipe(v.string(), v.minLength(1)),
  resource: v.pipe(v.string(), v.url()),
  revocationEndpoint: v.optional(v.pipe(v.string(), v.url())),
  tokenEndpoint: v.pipe(v.string(), v.url()),
});

export type StoredGrant = v.InferOutput<typeof storedGrantSchema>;

export type KeyValueStorage = Pick<
  Storage,
  "getItem" | "removeItem" | "setItem"
>;

export type GrantStore = {
  readonly clear: () => void;
  readonly read: () => StoredGrant | null;
  readonly write: (grant: StoredGrant) => void;
};

/**
 * Outlook on the web partitions an add-in's storage per mailbox host and asks
 * add-ins to prefix keys with `Office.context.partitionKey` when it is set.
 */
export const grantStorageKey = (partitionKey: string | undefined): string =>
  partitionKey ? `${partitionKey}:${STORAGE_KEY}` : STORAGE_KEY;

export const createGrantStore = ({
  partitionKey,
  storage,
}: {
  readonly partitionKey: string | undefined;
  readonly storage: KeyValueStorage | null;
}): GrantStore => {
  const key = grantStorageKey(partitionKey);
  return {
    // Storage that refuses a write or removal leaves the grant in memory only;
    // the add-in keeps working for this session.
    clear: () => {
      Result.try(() => storage?.removeItem(key)).unwrapOr(undefined);
    },
    read: () => {
      const raw = Result.try(() => storage?.getItem(key) ?? null);
      if (Result.isError(raw) || raw.value === null) {
        return null;
      }
      const json = Result.try((): unknown => JSON.parse(raw.value ?? ""));
      if (Result.isError(json)) {
        return null;
      }
      const grant = v.safeParse(storedGrantSchema, json.value);
      return grant.success ? grant.output : null;
    },
    write: (grant) => {
      Result.try(() => storage?.setItem(key, JSON.stringify(grant))).unwrapOr(
        undefined,
      );
    },
  };
};
