import { panic } from "better-result";

import { db } from "@/api/db";
import type { BoundingBoxes } from "@/api/db/schema-validators";
import type { SafeId } from "@/api/lib/branded-types";

type ReadJustificationsHandlerProps = {
  workspaceId: SafeId<"workspace">;
};

type JustificationResponse = {
  id: string;
  fieldId: string;
  htmlVersion: number;
  htmlContent: string;
  boundingBoxes: BoundingBoxes | null;
  fileFieldIds: string[];
};

export const readJustificationsHandler = async ({
  workspaceId,
}: ReadJustificationsHandlerProps) => {
  const result = await db.query.entities.findMany({
    where: { workspaceId },
    columns: {},
    with: {
      currentVersion: {
        columns: {},
        with: {
          fields: {
            columns: {},
            with: {
              justification: true,
            },
          },
        },
      },
    },
  });

  const justificationList: JustificationResponse[] = [];

  for (const entity of result) {
    if (!entity.currentVersion) {
      panic("Entity has no currentVersion");
    }

    for (const field of entity.currentVersion.fields) {
      if (!field.justification) {
        continue;
      }

      justificationList.push(field.justification);
    }
  }

  return justificationList;
};
