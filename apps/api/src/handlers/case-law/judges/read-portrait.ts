import { Result } from "better-result";
import { t } from "elysia";

import {
  PORTRAIT_CACHE_CONTROL,
  readJudgePortraitObject,
  readJudgePortraitPointer,
} from "@/api/handlers/case-law/judges/portrait";
import type { PublicHandlerConfig } from "@/api/lib/api-handlers";
import { createSafePublicHandler } from "@/api/lib/api-handlers";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  mcp: { type: "internal", reason: "public_indexing" },
  params: t.Object({ judgeId: tSafeId("caseLawJudge") }),
} satisfies PublicHandlerConfig;

/**
 * A judge's portrait, as the reader renders it beside the decision.
 *
 * Public corpus data on a public route, so the answer is cacheable and
 * carries the store's own validator. A judge with no portrait and a judge
 * that does not exist answer alike: the route says nothing about which.
 */
const readJudgePortrait = createSafePublicHandler(
  config,
  async function* ({ params: { judgeId }, request }) {
    const pointer = yield* Result.await(
      Result.tryPromise(
        async () =>
          await caseLawPublicReadDb(
            async (tx) => await readJudgePortraitPointer(tx, judgeId),
          ),
      ),
    );
    if (pointer === null) {
      return Result.err(
        new HandlerError({ status: 404, message: "Portrait not found" }),
      );
    }

    // Outside the read transaction: object storage must never hold one open.
    const portrait = yield* Result.await(
      readJudgePortraitObject(pointer, request.signal),
    );
    if (portrait === null) {
      return Result.err(
        new HandlerError({ status: 404, message: "Portrait not found" }),
      );
    }

    return Result.ok(
      new Response(portrait.bytes, {
        headers: {
          "Cache-Control": PORTRAIT_CACHE_CONTROL,
          "Content-Disposition": "inline",
          "Content-Type": pointer.contentType,
          "X-Content-Type-Options": "nosniff",
          ...(portrait.etag === null ? {} : { ETag: portrait.etag }),
        },
      }),
    );
  },
);

export default readJudgePortrait;
