import { Result } from "better-result";
import * as v from "valibot";

import { CONTACT_TYPES } from "@stll/api-contract/workspace-contacts";
import type { ContactType } from "@stll/api-contract/workspace-contacts";

import type { Fetch } from "@/connection/http";
import type { AccessTokenSource } from "@/connection/session";
import { requestApi } from "@/state/api-request";
import type { ApiError } from "@/state/api-request";

/** The address book's lookup by name, the web's contact picker's own. */
const SEARCH_PATH = "/v1/contacts/search";

/** Where a new contact goes into the address book. */
const CONTACTS_PATH = "/v1/contacts";

/** A contact as a picker shows it. */
const contactSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  type: v.picklist(CONTACT_TYPES),
  displayName: v.string(),
});

export type ContactChoice = v.InferOutput<typeof contactSchema>;

const searchResponseSchema = v.object({ items: v.array(contactSchema) });

/**
 * The address book's contacts whose name holds `query`, at most twenty,
 * ordered by name. An empty query finds no one without asking.
 */
export const searchContacts = async ({
  fetch,
  query,
  source,
}: {
  readonly fetch: Fetch;
  readonly query: string;
  readonly source: AccessTokenSource;
}): Promise<Result<ContactChoice[], ApiError>> => {
  const needle = query.trim();
  if (needle === "") {
    return Result.ok([]);
  }
  return await Result.gen(async function* () {
    const { items } = yield* Result.await(
      requestApi({
        fetch,
        path: `${SEARCH_PATH}?${new URLSearchParams({ q: needle }).toString()}`,
        schema: searchResponseSchema,
        source,
      }),
    );
    return Result.ok(items);
  });
};

/**
 * Adds `displayName` to the address book as a person or an organization,
 * as the web's picker does when no contact matches. `requestId` names the
 * write, so pressing again after a lost answer gets the same contact back
 * rather than a second one.
 */
export const createContact = async ({
  displayName,
  fetch,
  requestId,
  source,
  type,
}: {
  readonly displayName: string;
  readonly fetch: Fetch;
  readonly requestId: string;
  readonly source: AccessTokenSource;
  readonly type: ContactType;
}): Promise<Result<ContactChoice, ApiError>> =>
  await requestApi({
    body: { displayName: displayName.trim(), type },
    fetch,
    idempotencyKey: requestId,
    method: "PUT",
    path: CONTACTS_PATH,
    schema: contactSchema,
    source,
  });
