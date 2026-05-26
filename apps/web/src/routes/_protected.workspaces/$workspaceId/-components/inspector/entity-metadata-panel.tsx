import type { PropsWithChildren } from "react";
import {
  useCallback,
  useEffect,
  useOptimistic,
  useRef,
  useState,
  useTransition,
} from "react";

import {
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { useLocale, useTranslations } from "use-intl";

import { cn } from "@stll/ui/lib/utils";

import { QuerySuspenseBoundary } from "@/components/query-suspense-boundary";
import { TOOLBAR_ROW_HEIGHT } from "@/lib/consts";
import { formatFullTimestamp, formatRelativeTime } from "@/lib/relative-time";
import type { EntityField, EntityKind, WorkspaceProperty } from "@/lib/types";
import { CreateProperty } from "@/routes/_protected.workspaces/$workspaceId/-components/create-property";
import { EditableField } from "@/routes/_protected.workspaces/$workspaceId/-components/editable-field";
import { MetadataPanelSkeleton } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/file-facets";
import { Justification } from "@/routes/_protected.workspaces/$workspaceId/-components/justification";
import {
  entitiesKeys,
  entityOptions,
} from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import { entityVersionsOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/entity-versions";
import { propertiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";
import { useIsWorkflowRunning } from "@/routes/_protected.workspaces/$workspaceId/-queries/workspace";
import { useWorkspaceStore } from "@/routes/_protected.workspaces/$workspaceId/-store";

type AiFieldClickArgs = {
  fieldId: string;
  propertyId: string;
};

type EntityMetadataPanelProps = {
  workspaceId: string;
  entityId: string;
  currentFilePropertyId?: string | null;
  /** Field id of the file this panel is anchored to. Used to scope
   *  inline justification citations to the visible PDF. */
  fileFieldId?: string | null;
  /** When set, the matching AI field is highlighted as active and
   *  its long-form justification renders inline below the value. */
  activeJustificationFieldId?: string | null;
  /** Called when a user clicks an AI-extracted field. Used by the
   *  parent to drive the PDF justification (bbox highlights). */
  onAiFieldClick?: (args: AiFieldClickArgs) => void;
};

type EntityMetadataContentProps = {
  workspaceId: string;
  entityId: string;
  currentFilePropertyId: string | null;
  fileFieldId: string | null;
  activeJustificationFieldId: string | null;
  onAiFieldClick: ((args: AiFieldClickArgs) => void) | undefined;
  entity: {
    kind: EntityKind;
    entityId: string;
    fields: EntityField[];
  };
};

type FieldInfoRow = {
  id: string;
  propertyId: string;
  content: EntityField["content"] | undefined;
};

const EMPTY_PROPERTIES: WorkspaceProperty[] = [];

export const EntityMetadataPanel = (props: EntityMetadataPanelProps) => (
  // Self-contained boundary — the inner content suspends on
  // useSuspenseQuery while the entity loads, and we don't want a
  // transient API failure here to blank the whole inspector by
  // bubbling up to a higher error boundary.
  <QuerySuspenseBoundary
    area="entity-metadata-panel"
    errorFallback={MetadataPanelErrorFallback}
    resetKeys={[props.workspaceId, props.entityId]}
    suspenseFallback={<MetadataPanelSkeleton />}
  >
    <EntityMetadataPanelSuspenseInner {...props} />
  </QuerySuspenseBoundary>
);

const EntityMetadataPanelSuspenseInner = ({
  workspaceId,
  entityId,
  currentFilePropertyId = null,
  fileFieldId = null,
  activeJustificationFieldId = null,
  onAiFieldClick,
}: EntityMetadataPanelProps) => {
  const { data: entity } = useSuspenseQuery(
    entityOptions(workspaceId, entityId),
  );

  return (
    <EntityMetadataContent
      activeJustificationFieldId={activeJustificationFieldId}
      currentFilePropertyId={currentFilePropertyId}
      entity={entity}
      entityId={entityId}
      fileFieldId={fileFieldId}
      onAiFieldClick={onAiFieldClick}
      workspaceId={workspaceId}
    />
  );
};

const MetadataPanelErrorFallback = ({ reset }: { reset: () => void }) => {
  const t = useTranslations();
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 py-8 text-center">
      <span className="text-muted-foreground text-sm">
        {t("common.somethingWentWrong")}
      </span>
      <button
        className="text-primary text-sm hover:underline"
        onClick={reset}
        type="button"
      >
        {t("common.tryAgain")}
      </button>
    </div>
  );
};

const EntityMetadataContent = ({
  workspaceId,
  currentFilePropertyId,
  fileFieldId,
  activeJustificationFieldId,
  onAiFieldClick,
  entity,
}: EntityMetadataContentProps) => {
  const t = useTranslations();
  const locale = useLocale();
  const queryClient = useQueryClient();
  const isWorkflowRunning = useIsWorkflowRunning(workspaceId);
  const sawWorkflowRunning = useRef(false);
  const propertiesQuery = useQuery(propertiesOptions(workspaceId));
  const properties = propertiesQuery.data ?? EMPTY_PROPERTIES;
  // Version metadata renders in shared chrome (sidepeek + fullscreen);
  // use a non-suspending query so a cache miss does not collapse the
  // surrounding layout.
  const { data: versionsData } = useQuery(
    entityVersionsOptions({ workspaceId, entityId: entity.entityId }),
  );
  // `useOptimistic` keeps any newly created property visible until the
  // wrapping transition completes (i.e., until the entity/property
  // queries invalidate and the server-side row shows up). React then
  // resyncs to the passthrough `properties` value.
  const [optimisticProperties, addOptimisticProperty] = useOptimistic(
    properties,
    (current, action: WorkspaceProperty) =>
      current.some((property) => property.id === action.id)
        ? current
        : [...current, action],
  );
  const [, startOptimisticTransition] = useTransition();
  // Track property ids that were just created from this panel and are
  // still awaiting their first `entity.fields` row. `properties` can
  // refetch before extraction adds the field, so we can't derive the
  // pending placeholder from `useOptimistic` alone — once the real
  // property arrives, React resyncs to the passthrough and the
  // optimistic-only set empties. The placeholder must persist until
  // `entity.fields` actually contains the property id.
  const [pendingPlaceholderIds, setPendingPlaceholderIds] = useState<
    readonly string[]
  >([]);
  const activeJustification = useWorkspaceStore((s) =>
    activeJustificationFieldId
      ? (s.justifications.find(
          (j) => j.fieldId === activeJustificationFieldId,
        ) ?? null)
      : null,
  );

  const refreshEntityFields = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: entitiesKeys.all(workspaceId),
      }),
      queryClient.invalidateQueries({
        queryKey: propertiesOptions(workspaceId).queryKey,
      }),
    ]);
  }, [queryClient, workspaceId]);

  useEffect(() => {
    if (isWorkflowRunning) {
      sawWorkflowRunning.current = true;
      return;
    }

    if (!sawWorkflowRunning.current) {
      return;
    }

    sawWorkflowRunning.current = false;
    void refreshEntityFields();
  }, [isWorkflowRunning, refreshEntityFields]);

  const entityFieldPropertyIds = new Set(
    entity.fields.map((field) => field.propertyId),
  );
  const entityFieldPropertyIdsKey = [...entityFieldPropertyIds]
    .toSorted()
    .join(",");

  useEffect(() => {
    const arrivedIds = new Set(
      entityFieldPropertyIdsKey.split(",").filter((id) => id.length > 0),
    );
    setPendingPlaceholderIds((prev) =>
      prev.every((id) => !arrivedIds.has(id))
        ? prev
        : prev.filter((id) => !arrivedIds.has(id)),
    );
  }, [entityFieldPropertyIdsKey]);

  if (propertiesQuery.isError) {
    return null;
  }
  if (propertiesQuery.data === undefined) {
    return null;
  }

  const serverPropertyIds = new Set(properties.map((property) => property.id));
  const optimisticOnlyProperties = optimisticProperties.filter(
    (property) => !serverPropertyIds.has(property.id),
  );
  const visibleProperties = [...properties, ...optimisticOnlyProperties];
  const visiblePropertyById = new Map(
    visibleProperties.map((property) => [property.id, property]),
  );
  const optimisticFields = pendingPlaceholderIds.flatMap((propertyId) => {
    if (entityFieldPropertyIds.has(propertyId)) {
      return [];
    }
    const property = visiblePropertyById.get(propertyId);
    if (!property) {
      return [];
    }

    return [
      {
        id: `optimistic:${property.id}`,
        propertyId: property.id,
        content:
          property.tool.type === "ai-model"
            ? ({
                type: "pending",
                version: 1,
              } satisfies EntityField["content"])
            : undefined,
      },
    ];
  }) satisfies FieldInfoRow[];

  const propertyIndex = new Map(visibleProperties.map((p, i) => [p.id, i]));
  const visibleFields: FieldInfoRow[] = [...entity.fields, ...optimisticFields]
    .filter((field) => field.content?.type !== "file")
    .toSorted(
      (a, b) =>
        (propertyIndex.get(a.propertyId) ?? Infinity) -
        (propertyIndex.get(b.propertyId) ?? Infinity),
    );

  const handleExtractionCreated = ({
    property,
  }: {
    property: WorkspaceProperty;
  }) => {
    // The dialog already triggered the workflow itself (entity-scoped
    // when a file source is set, whole-matter otherwise). We dispatch
    // the optimistic property inside a transition and await the
    // invalidations in the same body — React keeps the optimistic
    // property visible until the server queries refresh, then drops it
    // because the passthrough now contains the real row. The pending
    // placeholder field is tracked separately so it persists until
    // `entity.fields` actually contains the new property (extraction
    // can complete after the properties query refetches).
    setPendingPlaceholderIds((prev) =>
      prev.includes(property.id) ? prev : [...prev, property.id],
    );
    startOptimisticTransition(async () => {
      addOptimisticProperty(property);
      await refreshEntityFields();
    });
  };

  const extractionAction = (
    <CreateProperty
      extractionContext={{
        entityId: entity.entityId,
        filePropertyId: currentFilePropertyId,
      }}
      onCreated={handleExtractionCreated}
      triggerVariant="panel"
      workspaceId={workspaceId}
    />
  );

  // Resolve the current version (if loaded) for the Document info section.
  // We never block render on this — the section just shows a muted dash
  // until the versions query resolves.
  const currentVersion =
    versionsData?.versions.find(
      (v) => v.id === versionsData.currentVersionId,
    ) ?? null;
  const authorLabel = currentVersion?.author?.name ?? null;
  const versionLabel = currentVersion
    ? t("inspector.metadata.versionCurrent", {
        version: String(currentVersion.versionNumber),
      })
    : null;
  const updatedAtIso = currentVersion?.createdAt ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <SectionHeading>
          {t("inspector.metadata.documentInfoHeading")}
        </SectionHeading>
        <div className="flex flex-col gap-px px-2 pb-2">
          <ReadOnlyRow
            label={t("inspector.metadata.author")}
            value={authorLabel}
          />
          <ReadOnlyRow
            label={t("inspector.metadata.version")}
            value={versionLabel}
          />
          {updatedAtIso !== null && (
            <ReadOnlyRow
              label={t("inspector.metadata.updatedAt")}
              title={formatFullTimestamp(updatedAtIso, locale)}
              value={formatRelativeTime(updatedAtIso, locale)}
            />
          )}
        </div>

        <SectionHeading>
          {t("inspector.metadata.matterColumnsHeading")}
        </SectionHeading>
        {visibleFields.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 px-6 py-6 text-center">
            <span className="text-muted-foreground text-sm">
              {t("workspaces.noFieldsToView")}
            </span>
          </div>
        ) : (
          <div className="flex flex-col gap-px p-2 pt-0">
            {visibleFields.map((field) => {
              const property = visibleProperties.find(
                (p) => p.id === field.propertyId,
              );
              if (!property) {
                return null;
              }
              const isPending = field.content?.type === "pending";
              const isAiField = property.tool.type === "ai-model";
              const canJustify =
                isAiField &&
                onAiFieldClick !== undefined &&
                field.content !== undefined &&
                field.content.type !== "pending" &&
                field.content.type !== "error";
              const isActive =
                isAiField && field.id === activeJustificationFieldId;
              const handleJustifyClick = canJustify
                ? () =>
                    onAiFieldClick({
                      fieldId: field.id,
                      propertyId: field.propertyId,
                    })
                : undefined;
              const fieldBody = (
                <>
                  <span
                    className={cn(
                      "text-foreground-strong-muted inline-flex items-center gap-1 text-[10px] font-medium tracking-wide uppercase",
                      isPending && "opacity-60",
                    )}
                  >
                    {isAiField && (
                      <Sparkles
                        aria-hidden="true"
                        className="text-primary size-3"
                      />
                    )}
                    {property.name}
                  </span>
                  <div className="text-foreground text-sm leading-snug">
                    <EditableField
                      content={field.content}
                      entityKind={entity.kind}
                      entityId={entity.entityId}
                      property={property}
                      propertyId={field.propertyId}
                      readonly={isAiField}
                      workspaceId={workspaceId}
                    />
                  </div>
                </>
              );
              if (handleJustifyClick) {
                return (
                  <div
                    className={cn(
                      "rounded-md transition-colors",
                      isActive && "bg-accent",
                    )}
                    key={field.id + field.propertyId}
                  >
                    <button
                      aria-pressed={isActive}
                      className={cn(
                        "flex w-full flex-col gap-1 rounded-md px-2 py-2 text-start transition-colors",
                        !isActive && "hover:bg-accent",
                      )}
                      onClick={handleJustifyClick}
                      type="button"
                    >
                      {fieldBody}
                    </button>
                    {isActive &&
                      activeJustification &&
                      fileFieldId !== null && (
                        <div className="border-s-primary mx-2 mb-2 max-h-48 overflow-y-auto border-s-2 ps-3">
                          <div className="text-primary mb-1 text-[10px] font-semibold tracking-wide uppercase">
                            {t("workspaces.justification")}
                          </div>
                          <div className="text-foreground-strong-muted text-xs leading-relaxed break-words">
                            <Justification
                              justification={activeJustification}
                              workspaceId={workspaceId}
                            />
                          </div>
                        </div>
                      )}
                  </div>
                );
              }
              return (
                <div
                  className="flex flex-col gap-1 rounded-md px-2 py-2"
                  key={field.id + field.propertyId}
                >
                  {fieldBody}
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div className={cn("flex shrink-0 border-t", TOOLBAR_ROW_HEIGHT)}>
        {extractionAction}
      </div>
    </div>
  );
};

const SectionHeading = ({ children }: PropsWithChildren) => (
  <div className="bg-muted/40 text-foreground border-b px-4 py-2 text-sm font-semibold">
    {children}
  </div>
);

type ReadOnlyRowProps = {
  label: string;
  value: string | null;
  title?: string;
};

const ReadOnlyRow = ({ label, value, title }: ReadOnlyRowProps) => (
  <div className="flex flex-col gap-1 rounded-md px-2 py-2">
    <span className="text-muted-foreground text-xs font-medium">{label}</span>
    <span className="text-foreground text-sm" title={title}>
      {value ?? <span className="text-muted-foreground">—</span>}
    </span>
  </div>
);
