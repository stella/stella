import { useLayoutEffect, useState } from "react";

import { useQuery } from "@tanstack/react-query";

import {
  resolveFileFieldPropertyId,
  shouldReplaceFileFieldAfterSync,
} from "@/components/inspector/inspector-panel.logic";
import {
  closeInspectorTabsForEntities,
  type FileTab,
  useInspectorTabsStore,
} from "@/components/inspector/inspector-tabs-store";
import { useSelectedFileVersionMissing } from "@/components/inspector/versions-facet";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { APIError } from "@/lib/errors/api";
import { entityOptions } from "@/lib/workspaces/queries/entities";

export const CurrentFileFieldSync = ({
  isFieldIdPinned,
  isActive,
  tab,
}: {
  isFieldIdPinned: boolean;
  isActive: boolean;
  tab: FileTab;
}) => {
  const replaceFileFieldId = useInspectorTabsStore((s) => s.replaceFileFieldId);
  const closeTab = useInspectorTabsStore((s) => s.closeTab);
  const [currentFileFieldIdsByProperty] = useState(
    () => new Map<string, string>(),
  );
  const {
    data: entity,
    error,
    isFetching: isEntityFetching,
  } = useQuery(entityOptions(tab.workspaceId, tab.entityId));

  useExternalSyncEffect(() => {
    if (APIError.is(error) && error.status === 404) {
      closeInspectorTabsForEntities([tab.entityId]);
    }
  }, [error, tab.entityId]);

  const activeFileField = entity?.fields.find((field) => {
    if (field.content.type !== "file") {
      return false;
    }
    return field.id === tab.id;
  });
  const filePropertyId = resolveFileFieldPropertyId({
    activeFilePropertyId: activeFileField?.propertyId,
    currentFileFieldIdsByProperty,
    fieldId: tab.id,
    tabPropertyId: tab.propertyId,
  });
  const latestFileFieldForProperty =
    filePropertyId === undefined
      ? undefined
      : entity?.fields.findLast(
          (field) =>
            field.propertyId === filePropertyId &&
            field.content.type === "file",
        );
  const isSelectedFieldMissing = useSelectedFileVersionMissing({
    enabled: isActive && activeFileField === undefined,
    fieldId: tab.id,
    workspaceId: tab.workspaceId,
  });

  // The field went away and left nothing to move to, so the tab has nothing to
  // show. An older version also has no field on the entity, but its file loads.
  // A refresh in flight may bring the replacement. Without a known property any
  // file on the entity could be the replacement.
  const mayHaveReplacement =
    filePropertyId === undefined
      ? entity?.fields.some((field) => field.content.type === "file")
      : latestFileFieldForProperty !== undefined;
  const hasNothingLeftToShow =
    entity !== undefined &&
    !isEntityFetching &&
    mayHaveReplacement === false &&
    isSelectedFieldMissing &&
    !isFieldIdPinned;
  useExternalSyncEffect(() => {
    if (hasNothingLeftToShow) {
      closeTab(tab.id);
    }
  }, [closeTab, hasNothingLeftToShow, tab.id]);

  useLayoutEffect(() => {
    if (activeFileField !== undefined) {
      currentFileFieldIdsByProperty.set(
        activeFileField.propertyId,
        activeFileField.id,
      );
    }

    if (
      latestFileFieldForProperty === undefined ||
      latestFileFieldForProperty.id === tab.id ||
      latestFileFieldForProperty.content.type !== "file"
    ) {
      return;
    }
    const previousCurrentFieldId = currentFileFieldIdsByProperty.get(
      latestFileFieldForProperty.propertyId,
    );
    if (
      !shouldReplaceFileFieldAfterSync({
        isFieldIdPinned,
        isSelectedFieldMissing,
        previousCurrentFieldId,
        selectedFieldId: tab.id,
      })
    ) {
      return;
    }

    const latestFileContent = latestFileFieldForProperty.content;
    currentFileFieldIdsByProperty.set(
      latestFileFieldForProperty.propertyId,
      latestFileFieldForProperty.id,
    );
    replaceFileFieldId(tab.id, {
      id: latestFileFieldForProperty.id,
      fileName: latestFileContent.fileName,
      label: latestFileContent.fileName,
      mimeType: latestFileContent.mimeType,
      pdfFileId: latestFileContent.pdfFileId,
      propertyId: latestFileFieldForProperty.propertyId,
    });
  }, [
    activeFileField,
    currentFileFieldIdsByProperty,
    isFieldIdPinned,
    isSelectedFieldMissing,
    latestFileFieldForProperty,
    replaceFileFieldId,
    tab.id,
  ]);

  return null;
};
