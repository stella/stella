import { panic, Result } from "better-result";

import { authorizeOperation } from "@/api/lib/proofs/checked-transaction";
import type { AiFillCollaborators } from "@/api/lib/templates/template-fill-service";

export const checkedTestAiCollaborators =
  <TRejection = never>(
    buildCollaborators: () =>
      | AiFillCollaborators
      | Promise<AiFillCollaborators>,
    check?: () => Promise<TRejection | null>,
  ) =>
  async () => {
    const rejection = (await check?.()) ?? null;
    if (rejection !== null) {
      return Result.err(rejection);
    }
    const authorization = await authorizeOperation({
      kind: "ConditionalUsageAllowed",
      input: { buildCollaborators },
      check: async () => {
        await Promise.resolve();
        return Result.ok(undefined);
      },
    });
    if (Result.isError(authorization)) {
      return panic(
        "Successful evidence fixture was refused",
        authorization.error,
      );
    }
    return Result.ok(authorization.value);
  };
