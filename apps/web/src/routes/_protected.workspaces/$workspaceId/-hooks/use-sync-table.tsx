import { useEffect } from "react";
import { useSuspenseQueries } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { produce } from "immer";

import type { WorkspaceField } from "@/lib/types";
import { entitiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import { propertiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";
import { justificationsOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/workspace";
import { useWorkspaceStore } from "@/routes/_protected.workspaces/$workspaceId/-store";
import { isInternalColId } from "@/routes/_protected.workspaces/$workspaceId/-utils";

export const useSyncTable = () => {
  const workspaceId = useParams({
    from: "/_protected/workspaces/$workspaceId",
    select: (p) => p.workspaceId,
  });
  const navigate = useNavigate();
  const syncEntities = useWorkspaceStore((s) => s.syncEntities);
  const syncJustifications = useWorkspaceStore((s) => s.syncJustifications);

  const [propertiesQuery, entitiesQuery, justificationsQuery] =
    useSuspenseQueries({
      queries: [
        { ...propertiesOptions(workspaceId), refetchOnMount: true },
        entitiesOptions(workspaceId),
        justificationsOptions(workspaceId),
      ],
    });

  const properties = propertiesQuery.data;
  const entities = entitiesQuery.data;
  const justifications = justificationsQuery.data;

  useEffect(() => {
    const propertyIds = new Set(properties.map((p) => p.id));

    // biome-ignore lint/nursery/noFloatingPromises: fire-and-forget
    navigate({
      to: ".",
      replace: true,
      search: (searchState) => {
        if (propertyIds.size === 0) {
          return {};
        }

        return produce(searchState, (s) => {
          if (s.columnSizing && s.columnPinning && s.sorting) {
            for (const propertyId of Object.keys(s.columnSizing)) {
              if (!propertyIds.has(propertyId)) {
                delete s.columnSizing[propertyId];
              }
            }

            s.columnPinning = s.columnPinning.filter(
              (id) => isInternalColId(id) || propertyIds.has(id),
            );

            // Always pin the first property (Documents) so the
            // filename column never scrolls out of view.
            const firstPropId = properties[0]?.id;
            if (firstPropId && !s.columnPinning.includes(firstPropId)) {
              s.columnPinning.push(firstPropId);
            }

            if (s.sorting.length === 0) {
              s.sorting = [
                {
                  id: properties[0].id,
                  desc: false,
                },
              ];
            } else {
              s.sorting = s.sorting.filter((sorting) =>
                propertyIds.has(sorting.id),
              );
            }
          }
        });
      },
    });
  }, [properties, navigate]);

  useEffect(() => {
    const parsedEntities = entities.map((e) => ({
      entityId: e.entityId,
      kind: e.kind,
      name: e.name,
      parentId: e.parentId,
      createdAt: e.createdAt,
      createdBy: e.createdBy,
      createdByImage: e.createdByImage,
      updatedAt: e.updatedAt,
      version: e.version,
      fields: e.fields.reduce(
        (acc, field) => {
          acc[field.propertyId] = {
            id: field.id,
            entityId: e.entityId,
            content: field.content,
          };
          return acc;
        },
        {} as Record<string, WorkspaceField>,
      ),
    }));

    syncEntities(parsedEntities);

    const entityIds = new Set<string>(entities.map((e) => e.entityId));
    const fieldIds = new Set<string>();

    for (const entity of entities) {
      for (const field of entity.fields) {
        if (field.content.type === "file") {
          fieldIds.add(field.id);
        }
      }
    }

    // biome-ignore lint/nursery/noFloatingPromises: fire-and-forget
    navigate({
      to: ".",
      replace: true,
      search: (searchState) =>
        produce(searchState, (s) => {
          if (s.rowSelection) {
            for (const entityId of Object.keys(s.rowSelection)) {
              if (!entityIds.has(entityId)) {
                delete s.rowSelection[entityId];
              }
            }
          }

          if (s.file?.fieldId && !fieldIds.has(s.file.fieldId)) {
            s.file = undefined;
          }

          if (s.entity?.id && !entityIds.has(s.entity.id)) {
            s.entity = undefined;
          }
        }),
    });
  }, [entities, syncEntities, navigate]);

  useEffect(() => {
    syncJustifications(justifications);

    const justificationIds = new Set<string>(justifications.map((j) => j.id));

    // biome-ignore lint/nursery/noFloatingPromises: fire-and-forget
    navigate({
      to: ".",
      replace: true,
      search: (searchState) =>
        produce(searchState, (s) => {
          const justificationId = s.justification?.id;
          if (justificationId && !justificationIds.has(justificationId)) {
            s.justification = undefined;
          }
        }),
    });
  }, [justifications, syncJustifications, navigate]);
};
