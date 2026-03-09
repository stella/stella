import { panic } from "better-result";

import type { ScopedDb } from "@/api/db";
import type { BoundingBoxes } from "@/api/db/schema-validators";
import type { SafeId } from "@/api/lib/branded-types";

type ReadJustificationsHandlerProps = {
  scopedDb: ScopedDb;
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

// TODO DAMIAN: please add it to the general pagination issue,
// it is inconsistent across repo + here the issue is that
// findMany loads ALL entities in a workspace with nested
// relations (currentVersion → fields → justifications) and
// no limit. A workspace with 10k entities loads everything
// into memory.
export const readJustificationsHandler = async ({
  scopedDb,
  workspaceId,
}: ReadJustificationsHandlerProps) => {
  const result = await scopedDb((tx) =>
    tx.query.entities.findMany({
      where: { workspaceId: { eq: workspaceId } },
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
    }),
  );

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
