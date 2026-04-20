import { Result } from "better-result";
import { t } from "elysia";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { getS3 } from "@/api/lib/s3";

const readUserFileContent = createSafeRootHandler(
  {
    permissions: { chat: ["create"] },
    params: t.Object({ fileId: tNanoid }),
  },
  async function* ({ params: { fileId }, safeDb, user }) {
    const file = yield* Result.await(
      safeDb((tx) =>
        tx.query.userFiles.findFirst({
          where: {
            id: { eq: fileId },
            userId: { eq: user.id },
          },
        }),
      ),
    );

    if (!file) {
      return Result.err(
        new HandlerError({
          status: 404,
          message: "User file not found",
        }),
      );
    }

    return Result.ok(
      Response.redirect(getS3().presign(file.s3Key, { expiresIn: 900 }), 302),
    );
  },
);

export default readUserFileContent;
