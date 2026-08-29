import { toSafeId } from "./safe-id";
import type { SafeId } from "./safe-id";

export const FOLIO_COLLAB_REDIS_SCOPE = "collab";
export const FOLIO_COLLAB_FLUSH_REQUEST_TYPE = "snapshot-flush-request";
export const FOLIO_COLLAB_FLUSH_RESPONSE_TYPE = "snapshot-flush-response";
export const FOLIO_COLLAB_REDIS_RETRY_CLOSE_CODE = 4503;
export const FOLIO_COLLAB_GENERATION_RETRY_CLOSE_CODE = 4504;

export type FolioCollabFlushRequest = {
  requestId: string;
  type: typeof FOLIO_COLLAB_FLUSH_REQUEST_TYPE;
};

export type FolioCollabFlushResponse = {
  requestId: string;
  stateVectorBase64: string;
  type: typeof FOLIO_COLLAB_FLUSH_RESPONSE_TYPE;
};

/**
 * Hocuspocus appends its document name to a static Redis prefix. Keeping the
 * room UUID inside braces gives every room one Redis Cluster slot while the
 * pub/sub channel and Redlock suffix remain colocated.
 */
export const toFolioCollabRoomName = (roomId: SafeId<"folioCollabRoom">) =>
  `{${roomId}}`;

const FOLIO_COLLAB_ROOM_NAME_PATTERN =
  /^\{(?<roomId>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}$/u;

export const parseFolioCollabRoomName = (roomName: string) => {
  const roomId =
    FOLIO_COLLAB_ROOM_NAME_PATTERN.exec(roomName)?.groups?.["roomId"];
  return roomId === undefined ? null : toSafeId<"folioCollabRoom">(roomId);
};
