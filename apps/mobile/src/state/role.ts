import { Result } from "better-result";
import * as v from "valibot";

import { roleAllows } from "@stll/permissions/role-grants";
import type { PermissionInput } from "@stll/permissions/role-grants";

import type { Fetch } from "@/connection/http";
import type { AccessTokenSource } from "@/connection/session";
import { requestApi } from "@/state/api-request";
import type { ApiError } from "@/state/api-request";

const roleSchema = v.object({ role: v.pipe(v.string(), v.minLength(1)) });

/** The person's role in their organization, such as member or intern. */
export const readMyRole = async ({
  fetch,
  source,
}: {
  readonly fetch: Fetch;
  readonly source: AccessTokenSource;
}): Promise<Result<string, ApiError>> =>
  await Result.gen(async function* () {
    const { role } = yield* Result.await(
      requestApi({ fetch, path: "/v1/me/role", schema: roleSchema, source }),
    );
    return Result.ok(role);
  });

/**
 * Whether the person may do what `permissions` asks, by the grants the
 * server enforces and the web decides with. A role not known yet, or not
 * read, allows nothing: an action the server would refuse is not offered.
 */
export const roleCan = (
  role: string | null,
  permissions: PermissionInput,
): boolean => role !== null && roleAllows(role, permissions);
