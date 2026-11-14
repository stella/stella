import { Result } from "better-result";
import * as v from "valibot";

import type { ChatToolGrantScope } from "@stll/api-contract/chat-tool-grants";

import type { Fetch } from "@/connection/http";
import type { AccessTokenSource } from "@/connection/session";
import { requestApi } from "@/state/api-request";
import type { ApiError } from "@/state/api-request";

/** What the server answers a stored grant with; the phone reads only that it took it. */
const storedGrantSchema = v.looseObject({ scope: v.string() });

/**
 * Stores a standing approval for `toolName`: for this conversation, or for
 * every conversation, as the web's approval card stores it. The server
 * decides what it covers (an external connector's tool covers its whole
 * connector) and refuses a tool that asks on every call.
 */
export const storeToolGrant = async ({
  fetch,
  scope,
  source,
  threadId,
  toolName,
}: {
  readonly fetch: Fetch;
  readonly scope: ChatToolGrantScope;
  readonly source: AccessTokenSource;
  readonly threadId: string;
  readonly toolName: string;
}): Promise<Result<void, ApiError>> =>
  await Result.gen(async function* () {
    yield* Result.await(
      requestApi({
        body: { scope, threadId, toolName },
        fetch,
        path: "/v1/chat/tool-grants",
        schema: storedGrantSchema,
        source,
      }),
    );
    return Result.ok(undefined);
  });
