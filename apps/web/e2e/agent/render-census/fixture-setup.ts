import type { APIRequestContext } from "@playwright/test";
import * as v from "valibot";

import { apiGet, apiPut } from "../../helpers/api";
import {
  createTestWorkspaceWithOperations,
  deleteTestWorkspace,
} from "../../helpers/workspace";

export const createLegalMatter = async (
  request: APIRequestContext,
  name: string,
) =>
  await createTestWorkspaceWithOperations(
    {
      create: async ({ id }) => {
        await apiPut(request, "/workspaces", {
          id,
          name,
          filePropertyName: "Podklady",
        });
      },
      delete: async (id) => {
        await deleteTestWorkspace(request, id);
      },
      properties: async (id) =>
        v.parse(
          v.array(
            v.object({
              id: v.string(),
              content: v.object({ type: v.string() }),
            }),
          ),
          await apiGet(request, `/properties/${id}`),
        ),
      views: async (id) =>
        v.parse(
          v.array(v.object({ id: v.string() })),
          await apiGet(request, `/views/${id}`),
        ),
    },
    name,
  );
