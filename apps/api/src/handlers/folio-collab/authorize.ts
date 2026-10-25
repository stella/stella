import { Result } from "better-result";
import * as v from "valibot";

import {
  parseFolioCollabRoomName,
  toFolioCollabRoomName,
} from "@stll/api-contract/folio-collab";

import type { TokenHandlerConfig, VerifyCaller } from "@/api/lib/api-handlers";
import { ACCOUNT_ACCESS, createSafeTokenHandler } from "@/api/lib/api-handlers";
import { isRecord } from "@/api/lib/type-guards";

import type { AuthorizedFolioCollabCredentials } from "./room-credentials";
import {
  authorizeFolioCollabCredentials,
  folioCollabTokenSchema,
} from "./room-credentials";

const config = {
  contract: "patch",
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "session_token_exchange" },
  body: v.object({
    roomName: v.pipe(
      v.string(),
      v.maxLength(64),
      v.check(
        (roomName) => parseFolioCollabRoomName(roomName) !== null,
        "Expected a collaborative room name",
      ),
    ),
    token: folioCollabTokenSchema,
  }),
} satisfies TokenHandlerConfig;

/**
 * The collaboration server names the room rather than sending its id: a name
 * that does not parse is an unknown room, answered like any other.
 */
const verifyRoomNameCaller: VerifyCaller<
  AuthorizedFolioCollabCredentials
> = async ({ body }) => {
  const roomName = isRecord(body) ? body["roomName"] : undefined;
  return await authorizeFolioCollabCredentials({
    roomId:
      typeof roomName === "string" ? parseFolioCollabRoomName(roomName) : null,
    token: isRecord(body) ? body["token"] : undefined,
  });
};

const authorizeFolioCollabSessionHandler = createSafeTokenHandler(
  config,
  verifyRoomNameCaller,
  // oxlint-disable-next-line typescript/require-await -- safe handlers must remain async generators for Result.gen error capture.
  async function* ({ caller }) {
    const { room: value } = yield* Result.ok(caller);
    return Result.ok({
      canEdit: value.canEdit,
      generation: value.generation,
      roomId: value.roomId,
      roomName: toFolioCollabRoomName(value.roomId),
      tokenExpiresAt: value.tokenExpiresAt.toISOString(),
      userId: value.userId,
      userName: value.userName,
    });
  },
);

export default authorizeFolioCollabSessionHandler;
