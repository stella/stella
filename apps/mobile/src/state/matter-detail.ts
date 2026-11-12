import { panic, Result } from "better-result";
import * as v from "valibot";

import {
  CONTACT_TYPES,
  WORKSPACE_CONTACT_ROLES,
} from "@stll/api-contract/workspace-contacts";
import type { WorkspaceContactRole } from "@stll/api-contract/workspace-contacts";
import { WORKSPACE_STATUSES } from "@stll/api-contract/workspace-status";

import type { Fetch } from "@/connection/http";
import type { AccessTokenSource } from "@/connection/session";
import { requestApi } from "@/state/api-request";
import type { ApiError } from "@/state/api-request";

/** One matter's own REST route, as the web's matter info reads it. */
const matterPath = (matterId: string) =>
  `/v1/workspaces/${encodeURIComponent(matterId)}`;

type MatterRequest = {
  readonly fetch: Fetch;
  readonly matterId: string;
  readonly source: AccessTokenSource;
};

const matterDetailSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  name: v.string(),
  reference: v.string(),
  color: v.nullish(v.string()),
  status: v.picklist(WORKSPACE_STATUSES),
  leadUserId: v.nullish(v.string()),
  client: v.nullish(
    v.object({
      id: v.pipe(v.string(), v.minLength(1)),
      type: v.picklist(CONTACT_TYPES),
      displayName: v.string(),
    }),
  ),
  /**
   * How many document versions carry the matter's number in a stamp, which
   * a new number cannot rewrite.
   */
  stampedVersionCount: v.number(),
});

export type MatterDetail = v.InferOutput<typeof matterDetailSchema>;

/** What the matter's info screen shows of it. */
export const readMatter = async ({
  fetch,
  matterId,
  source,
}: MatterRequest): Promise<Result<MatterDetail, ApiError>> =>
  await requestApi({
    fetch,
    path: matterPath(matterId),
    schema: matterDetailSchema,
    source,
  });

/**
 * One change to a matter, as the web's matter info makes them: a field at a
 * time. A new client is sent with the one it replaces, so a client someone
 * else changed meanwhile is not overwritten.
 */
export type MatterChange =
  | { readonly type: "name"; readonly value: string }
  | { readonly type: "reference"; readonly value: string }
  | { readonly type: "leadUserId"; readonly value: string | null }
  | {
      readonly type: "clientId";
      readonly value: string;
      readonly expectedClientId: string | null;
    };

/** The body of the matter update for `change`. */
export const matterChangeBody = (change: MatterChange) => {
  switch (change.type) {
    case "name":
      return { name: change.value };
    case "reference":
      return { reference: change.value };
    case "leadUserId":
      return { leadUserId: change.value };
    case "clientId":
      return {
        clientId: change.value,
        expectedClientId: change.expectedClientId,
      };
    default:
      change satisfies never;
      return panic(`Unhandled matter change: ${String(change)}`);
  }
};

const emptySchema = v.looseObject({});

export const updateMatter = async ({
  change,
  ...request
}: MatterRequest & {
  readonly change: MatterChange;
}): Promise<Result<void, ApiError>> =>
  await Result.gen(async function* () {
    yield* Result.await(
      requestApi({
        body: matterChangeBody(change),
        fetch: request.fetch,
        path: matterPath(request.matterId),
        schema: emptySchema,
        source: request.source,
      }),
    );
    return Result.ok(undefined);
  });

/** A matter's state change that takes no fields. */
const matterAction = async (
  { fetch, matterId, source }: MatterRequest,
  action: "archive" | "unarchive",
): Promise<Result<void, ApiError>> =>
  await Result.gen(async function* () {
    yield* Result.await(
      requestApi({
        body: {},
        fetch,
        path: `${matterPath(matterId)}/${action}`,
        schema: emptySchema,
        source,
      }),
    );
    return Result.ok(undefined);
  });

/** Closes the matter to changes; nothing in it is deleted. */
export const archiveMatter = async (request: MatterRequest) =>
  await matterAction(request, "archive");

/** Opens an archived matter to changes again. */
export const unarchiveMatter = async (request: MatterRequest) =>
  await matterAction(request, "unarchive");

/** Deletes the matter and everything in it. */
export const deleteMatter = async ({
  fetch,
  matterId,
  source,
}: MatterRequest): Promise<Result<void, ApiError>> =>
  await Result.gen(async function* () {
    yield* Result.await(
      requestApi({
        fetch,
        method: "DELETE",
        path: matterPath(matterId),
        schema: emptySchema,
        source,
      }),
    );
    return Result.ok(undefined);
  });

const duplicatedSchema = v.object({
  workspaceId: v.pipe(v.string(), v.minLength(1)),
});

/**
 * Copies the matter into a new one with its client, members, parties and
 * views, and with `includeContent` its documents and tasks too. Resolves to
 * the copy's id.
 */
export const duplicateMatter = async ({
  includeContent,
  ...request
}: MatterRequest & {
  readonly includeContent: boolean;
}): Promise<Result<string, ApiError>> =>
  await Result.gen(async function* () {
    const { workspaceId } = yield* Result.await(
      requestApi({
        body: { includeContent },
        fetch: request.fetch,
        path: `${matterPath(request.matterId)}/duplicate`,
        schema: duplicatedSchema,
        source: request.source,
      }),
    );
    return Result.ok(workspaceId);
  });

/** Shares the matter with one more person of the organization. */
export const addMatterMember = async ({
  userId,
  ...request
}: MatterRequest & {
  readonly userId: string;
}): Promise<Result<void, ApiError>> =>
  await Result.gen(async function* () {
    yield* Result.await(
      requestApi({
        body: { userId },
        fetch: request.fetch,
        method: "PUT",
        path: `${matterPath(request.matterId)}/members`,
        schema: emptySchema,
        source: request.source,
      }),
    );
    return Result.ok(undefined);
  });

/**
 * Takes the matter away from one member. Their open work on it is left
 * unassigned, as on the web; the server refuses to remove the last member.
 */
export const removeMatterMember = async ({
  userId,
  ...request
}: MatterRequest & {
  readonly userId: string;
}): Promise<Result<void, ApiError>> =>
  await Result.gen(async function* () {
    yield* Result.await(
      requestApi({
        fetch: request.fetch,
        method: "DELETE",
        path: `${matterPath(request.matterId)}/members/${encodeURIComponent(userId)}`,
        schema: emptySchema,
        source: request.source,
      }),
    );
    return Result.ok(undefined);
  });

const partySchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  role: v.picklist(WORKSPACE_CONTACT_ROLES),
  contact: v.object({
    id: v.pipe(v.string(), v.minLength(1)),
    type: v.picklist(CONTACT_TYPES),
    displayName: v.string(),
  }),
});

export type MatterParty = v.InferOutput<typeof partySchema>;

const partiesResponseSchema = v.object({ contacts: v.array(partySchema) });

/** The matter's parties besides its client, each in their role. */
export const listMatterParties = async ({
  fetch,
  matterId,
  source,
}: MatterRequest): Promise<Result<MatterParty[], ApiError>> =>
  await Result.gen(async function* () {
    const { contacts } = yield* Result.await(
      requestApi({
        fetch,
        path: `${matterPath(matterId)}/contacts`,
        schema: partiesResponseSchema,
        source,
      }),
    );
    return Result.ok(contacts);
  });

/**
 * Links an address-book contact to the matter in `role`. `requestId` names
 * the write, so pressing again after a lost answer links it once.
 */
export const addMatterParty = async ({
  contactId,
  requestId,
  role,
  ...request
}: MatterRequest & {
  readonly contactId: string;
  readonly requestId: string;
  readonly role: WorkspaceContactRole;
}): Promise<Result<void, ApiError>> =>
  await Result.gen(async function* () {
    yield* Result.await(
      requestApi({
        body: { contactId, role },
        fetch: request.fetch,
        idempotencyKey: requestId,
        method: "PUT",
        path: `${matterPath(request.matterId)}/contacts`,
        schema: emptySchema,
        source: request.source,
      }),
    );
    return Result.ok(undefined);
  });

/** Unlinks one party from the matter; the contact stays in the address book. */
export const removeMatterParty = async ({
  partyId,
  ...request
}: MatterRequest & {
  readonly partyId: string;
}): Promise<Result<void, ApiError>> =>
  await Result.gen(async function* () {
    yield* Result.await(
      requestApi({
        fetch: request.fetch,
        method: "DELETE",
        path: `${matterPath(request.matterId)}/contacts/${encodeURIComponent(partyId)}`,
        schema: emptySchema,
        source: request.source,
      }),
    );
    return Result.ok(undefined);
  });
