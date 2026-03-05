import { db } from "@/api/db";
import type { SafeId } from "@/api/lib/branded-types";
import {
  DEFAULT_MATTER_NUMBER_PADDING,
  DEFAULT_MATTER_NUMBER_PATTERN,
} from "@/api/lib/matter-reference";

type ReadOrganizationSettingsHandlerProps = {
  organizationId: SafeId<"organization">;
};

export const readOrganizationSettingsHandler = async ({
  organizationId,
}: ReadOrganizationSettingsHandlerProps) => {
  const row = await db.query.organizationSettings.findFirst({
    where: { organizationId: { eq: organizationId } },
    columns: {
      matterNumberPattern: true,
      matterNumberPadding: true,
    },
  });

  return {
    matterNumberPattern:
      row?.matterNumberPattern ?? DEFAULT_MATTER_NUMBER_PATTERN,
    matterNumberPadding:
      row?.matterNumberPadding ?? DEFAULT_MATTER_NUMBER_PADDING,
  };
};
