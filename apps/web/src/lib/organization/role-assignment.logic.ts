import * as v from "valibot";

import type { OrganizationRoleName } from "@stll/auth-model";
import { assignableRoles } from "@stll/permissions";

import { emailSchema } from "@/lib/schema";

export const roleAssignmentOptions = (
  actorRole: OrganizationRoleName | undefined,
) =>
  (actorRole === undefined ? [] : assignableRoles(actorRole)).map((value) => ({
    value,
  }));

export const inviteMemberSchema = (
  actorRole: OrganizationRoleName | undefined,
) =>
  v.strictObject({
    email: emailSchema(),
    role: v.picklist(actorRole === undefined ? [] : assignableRoles(actorRole)),
  });
