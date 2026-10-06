import { Result } from "better-result";
import { expect, test } from "bun:test";

import firmMonitoring from "@/api/handlers/organization-settings/sanctions-monitoring/update";
import { DatabaseError } from "@/api/lib/errors/tagged-errors";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";

import contactMonitoring from "./monitoring/update";
import review from "./reviews/update";

// Exercise the real safe-handler permission gate, before any database access.
test.each([review, contactMonitoring, firmMonitoring])(
  "denies external members before sanctions writes",
  async (endpoint) => {
    let reads = 0;
    const result = await endpoint.handler(
      createTestHandlerContext({
        memberRole: sessionMemberRole("external"),
        safeDb: async () => {
          reads += 1;
          return Result.err(
            new DatabaseError({
              message: "Database must not be read on denial",
            }),
          );
        },
      }),
    );
    expect(reads).toBe(0);
    expect(result).toMatchObject({
      code: 403,
      response: { code: "forbidden" },
    });
  },
);
