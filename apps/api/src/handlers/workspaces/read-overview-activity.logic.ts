import { isUuid } from "@/api/lib/custom-schema";
import {
  brandPersistedEntityVersionId,
  brandPersistedFieldId,
} from "@/api/lib/safe-id-boundaries";

export type FieldAuditResource =
  | { type: "field"; fieldId: ReturnType<typeof brandPersistedFieldId> }
  | {
      type: "cell";
      entityVersionId: ReturnType<typeof brandPersistedEntityVersionId>;
    };

export const parseFieldAuditResourceId = (
  resourceId: string,
): FieldAuditResource | null => {
  if (isUuid(resourceId)) {
    return { fieldId: brandPersistedFieldId(resourceId), type: "field" };
  }

  const parts = resourceId.split(":");
  const entityVersionId = parts.at(0);
  const propertyId = parts.at(1);
  if (
    parts.length !== 2 ||
    entityVersionId === undefined ||
    propertyId === undefined ||
    !isUuid(entityVersionId) ||
    !isUuid(propertyId)
  ) {
    return null;
  }

  return {
    entityVersionId: brandPersistedEntityVersionId(entityVersionId),
    type: "cell",
  };
};
