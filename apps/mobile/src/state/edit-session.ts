import type { Result } from "better-result";
import * as v from "valibot";

import type { Fetch } from "@/connection/http";
import type { AccessTokenSource } from "@/connection/session";
import { requestApi } from "@/state/api-request";
import type { ApiError } from "@/state/api-request";
import { DOCX_MIME_TYPE } from "@/state/document-file";
import { partOfType } from "@/state/form-part";
import type { FormPart } from "@/state/form-part";

/**
 * Editing a document, the web's way: opening takes the document's edit lock
 * and hands back a working copy and a session token; each checkpoint stores
 * the edited file under that token, and finishing makes the last checkpoint
 * the document's new version, or gives the lock back when nothing changed.
 */

/** Which document, and which of its file columns, is edited. */
export type EditTarget = {
  readonly workspaceId: string;
  readonly entityId: string;
  readonly propertyId: string;
};

type Caller = {
  readonly fetch: Fetch;
  readonly source: AccessTokenSource;
};

const openedSchema = v.object({
  sessionId: v.pipe(v.string(), v.minLength(1)),
  sessionToken: v.pipe(v.string(), v.minLength(1)),
  downloadUrl: v.pipe(v.string(), v.url()),
  fileName: v.pipe(v.string(), v.minLength(1)),
});

/** An open edit session; its token changes as checkpoints rotate it. */
export type EditSession = {
  readonly sessionId: string;
  readonly sessionToken: string;
  readonly fileName: string;
};

export type OpenedEditSession = EditSession & {
  /** A short-lived link to the working copy, with any earlier checkpoint. */
  readonly downloadUrl: string;
};

const lockPath = (workspaceId: string, action: "open" | "release") =>
  `/v1/entities/${encodeURIComponent(workspaceId)}/desktop-edit-sessions/${action}`;

const sessionPath = (sessionId: string, action: "checkpoint" | "finalize") =>
  `/v1/desktop-edit-sessions/${encodeURIComponent(sessionId)}/${action}`;

/** A checkpoint carries the whole document; the server allows a minute. */
const CHECKPOINT_TIMEOUT_MS = 60_000;

export const openEditSession = async ({
  fetch,
  source,
  workspaceId,
  entityId,
  propertyId,
}: Caller & EditTarget): Promise<Result<OpenedEditSession, ApiError>> =>
  await requestApi({
    fetch,
    source,
    path: lockPath(workspaceId, "open"),
    body: { entityId, propertyId },
    schema: openedSchema,
  });

const checkpointSchema = v.object({
  rotatedSessionToken: v.nullish(v.pipe(v.string(), v.minLength(1))),
});

/**
 * Stores the edited file, on the phone Expo's `File`, as a Word document,
 * the type the server checks. The session
 * the next request must use comes back: the server may rotate its token.
 */
export const checkpointEditSession = async ({
  fetch,
  source,
  session,
  file,
}: Caller & {
  readonly session: EditSession;
  readonly file: FormPart;
}): Promise<Result<EditSession, ApiError>> => {
  const form = new FormData();
  form.append("file", partOfType(file, DOCX_MIME_TYPE));
  form.append("sessionToken", session.sessionToken);
  const stored = await requestApi({
    fetch,
    source,
    path: sessionPath(session.sessionId, "checkpoint"),
    body: form,
    schema: checkpointSchema,
    timeoutMs: CHECKPOINT_TIMEOUT_MS,
  });
  return stored.map(({ rotatedSessionToken }) => ({
    ...session,
    sessionToken: rotatedSessionToken ?? session.sessionToken,
  }));
};

/** Makes the session's last checkpoint the document's new version. */
export const finalizeEditSession = async ({
  fetch,
  source,
  session,
}: Caller & {
  readonly session: EditSession;
}): Promise<Result<unknown, ApiError>> =>
  await requestApi({
    fetch,
    source,
    path: sessionPath(session.sessionId, "finalize"),
    body: { sessionToken: session.sessionToken },
    schema: v.unknown(),
  });

/**
 * Gives the edit lock back without a new version: whether it was given back.
 * A lock that was not runs out on the server by itself, so no caller has
 * more to do about it.
 */
export const releaseEditLock = async ({
  fetch,
  source,
  workspaceId,
  entityId,
  propertyId,
}: Caller & EditTarget): Promise<boolean> => {
  const released = await requestApi({
    fetch,
    source,
    path: lockPath(workspaceId, "release"),
    body: { entityId, propertyId },
    schema: v.unknown(),
  });
  return released.isOk();
};

/** The server's answer when someone else has taken the session over. */
export const sessionTakenOver = (error: ApiError): boolean =>
  error._tag === "ApiRequestError" && error.status === 409;
