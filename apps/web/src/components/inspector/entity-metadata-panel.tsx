import type { PropsWithChildren, ReactNode } from "react";
import {
  useCallback,
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
import { useTranslations } from "use-intl";

import { cn } from "@stll/ui/utils";

import { DocumentPropertiesSection } from "@/components/inspector/document-properties-section";
import { MetadataPanelSkeleton } from "@/components/inspector/file-facets";
import { QuerySuspenseBoundary } from "@/components/query-suspense-boundary";
import Tooltip from "@/components/tooltip";
import { UserIdentity } from "@/components/user-avatar";
import { CreateProperty } from "@/components/workspaces/create-property";
import { EditableField } from "@/components/workspaces/editable-field";
import { Justification } from "@/components/workspaces/justification";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { TOOLBAR_ROW_HEIGHT } from "@/lib/consts";
import { detached } from "@/lib/detached";
import { formatFullTimestamp, formatRelativeTime } from "@/lib/relative-time";
import type {
  EntityField,
  EntityId,
  EntityKind,
  PropertyId,
  WorkspaceProperty,
} from "@/lib/types";
import {
  isPlaybookVerdictProperty,
  playbookVerdictByAskId,
} from "@/lib/workspaces/playbook-verdicts";
import { entitiesKeys, entityOptions } from "@/lib/workspaces/queries/entities";
import { entityVersionsOptions } from "@/lib/workspaces/queries/entity-versions";
import { propertiesOptions } from "@/lib/workspaces/queries/properties";
import { useIsWorkflowRunning } from "@/lib/workspaces/queries/workspace";
import {
  selectJustificationByFieldId,
  useWorkspaceStore,
} from "@/lib/workspaces/store";

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
    entityId: EntityId;
    fields: EntityField[];
  };
};

type FieldInfoRow = {
  id: string;
  propertyId: PropertyId;
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
    readonly PropertyId[]
  >([]);
  const activeJustification = useWorkspaceStore(
    (s) =>
      selectJustificationByFieldId(
        s.justifications,
        activeJustificationFieldId,
      ) ?? null,
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

  useExternalSyncEffect(() => {
    if (isWorkflowRunning) {
      sawWorkflowRunning.current = true;
      return;
    }

    if (!sawWorkflowRunning.current) {
      return;
    }

    sawWorkflowRunning.current = false;
    detached(
      refreshEntityFields(),
      "entity-metadata-panel.refresh-entity-fields",
    );
  }, [isWorkflowRunning, refreshEntityFields]);

  const entityFieldPropertyIds = new Set(
    entity.fields.map((field) => field.propertyId),
  );
  const entityFieldPropertyIdsKey = [...entityFieldPropertyIds]
    .toSorted()
    .join(",");

  // Prune optimistic placeholders whose real fields have now arrived. Adjusting
  // state during render (instead of in an effect) drops the placeholder in the
  // same commit the field lands in and avoids the cascading-render warning.
  const [lastArrivedKey, setLastArrivedKey] = useState(
    entityFieldPropertyIdsKey,
  );
  if (entityFieldPropertyIdsKey !== lastArrivedKey) {
    setLastArrivedKey(entityFieldPropertyIdsKey);
    const arrivedIds = new Set(
      entityFieldPropertyIdsKey.split(",").filter((id) => id.length > 0),
    );
    setPendingPlaceholderIds((prev) =>
      prev.every((id) => !arrivedIds.has(id))
        ? prev
        : prev.filter((id) => !arrivedIds.has(id)),
    );
  }

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

  // Resolve the current version (if loaded) for the stella record section.
  // We never block render on this — the section just shows a muted dash
  // until the versions query resolves.
  const currentVersion =
    versionsData?.versions.find(
      (v) => v.id === versionsData.currentVersionId,
    ) ?? null;
  const versionLabel = currentVersion
    ? t("inspector.metadata.versionCurrent", {
        version: String(currentVersion.versionNumber),
      })
    : null;
  const updatedAtIso = currentVersion?.createdAt ?? null;

  // A verdict is one fact with the value it grades, so it is never listed on
  // its own. `playbook-verdicts` owns that rule for every surface; this panel
  // used to rediscover it and got it wrong, rendering each grade as a row
  // stranded from its answer.
  const verdictPropertyByAskId = playbookVerdictByAskId(optimisticProperties);
  const isVerdictField = (field: FieldInfoRow) => {
    const property = visiblePropertyById.get(field.propertyId);
    return property !== undefined && isPlaybookVerdictProperty(property);
  };

  /** The verdict row grading a given ASK property, if this entity has one. */
  const verdictFieldByAskId = new Map<string, FieldInfoRow>();
  for (const field of visibleFields) {
    const property = visiblePropertyById.get(field.propertyId);
    if (property !== undefined && isPlaybookVerdictProperty(property)) {
      verdictFieldByAskId.set(property.tool.askPropertyId, field);
    }
  }

  // The groups answer different questions and must not be mixed: what stella
  // recorded, what the file says about itself, and the matter's own columns.
  // Whether AI or a person filled a column is not a different question — it is
  // an attribute of the row — so both live in one list.
  const columnFields = visibleFields.filter((field) => !isVerdictField(field));

  const renderField = (field: FieldInfoRow) => {
    const property = visiblePropertyById.get(field.propertyId);
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
    const isActive = isAiField && field.id === activeJustificationFieldId;
    const handleJustifyClick = canJustify
      ? () =>
          onAiFieldClick({
            fieldId: field.id,
            propertyId: field.propertyId,
          })
      : undefined;
    // The grade belongs beside the value it grades, not in a row of its own:
    // "missing" means nothing without the answer it was reached from.
    const verdictField = verdictFieldByAskId.get(property.id);
    const verdictProperty = verdictPropertyByAskId.get(property.id);
    const fieldBody = (
      <>
        <span
          className={cn(
            "text-foreground-strong-muted inline-flex items-center gap-1 text-[10px] font-medium tracking-wide uppercase",
            isPending && "opacity-60",
          )}
        >
          {/* Carries what the AI section heading used to say, now per row:
              which columns AI filled is a fact about the column, not a
              separate kind of metadata. */}
          {isAiField && (
            <Sparkles
              aria-label={t("inspector.metadata.aiExtractedHeading")}
              className="text-primary size-3 shrink-0"
            />
          )}
          {property.name}
          {verdictField !== undefined && verdictProperty !== undefined && (
            <span className="normal-case">
              <EditableField
                content={verdictField.content}
                entityId={entity.entityId}
                entityKind={entity.kind}
                property={verdictProperty}
                propertyId={verdictField.propertyId}
                readonly
                workspaceId={workspaceId}
              />
            </span>
          )}
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
          {isActive && activeJustification && fileFieldId !== null && (
            <div className="border-s-primary mx-2 mb-2 max-h-48 overflow-y-auto border-s-2 ps-3">
              <div className="text-primary mb-1 text-[10px] font-semibold tracking-wide uppercase">
                {t("workspaces.justification")}
              </div>
              <div className="text-foreground-strong-muted text-xs leading-relaxed wrap-break-word">
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
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <SectionHeading>{t("inspector.metadata.stellaHeading")}</SectionHeading>
        <div className="flex flex-col gap-px px-2 pb-2">
          {/* A person is shown as a person here, the same as everywhere else
              in the app; a bare name in a panel of machine fields read as one
              more string. Version and its timestamp answer the same question
              ("which revision am I looking at, and when"), so they share a
              row instead of being read as two unrelated facts. */}
          <PersonRow
            label={t("inspector.metadata.lastUpdatedBy")}
            person={currentVersion?.author ?? null}
          />
          <ReadOnlyRow
            label={t("common.version")}
            title={
              updatedAtIso === null
                ? undefined
                : formatFullTimestamp(updatedAtIso)
            }
            value={
              versionLabel === null || updatedAtIso === null
                ? versionLabel
                : `${versionLabel} · ${formatRelativeTime(updatedAtIso)}`
            }
          />
        </div>

        {fileFieldId !== null && (
          <>
            <SectionHeading>
              {t("inspector.metadata.documentProperties.heading")}
            </SectionHeading>
            <DocumentPropertiesSection
              fileFieldId={fileFieldId}
              workspaceId={workspaceId}
            />
          </>
        )}

        {/* One list, not an AI section beside a manual one: those named
            different things — who produced the value, and what the value is —
            so they read as alternatives when an AI-filled column is also a
            column. Which ones AI filled is a property of the row, and the
            sparkle already says it. */}
        <SectionHeading>
          {t("inspector.metadata.matterColumnsHeading")}
        </SectionHeading>
        {columnFields.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 px-6 py-6 text-center">
            <span className="text-muted-foreground text-sm">
              {t("inspector.metadata.noMatterColumns")}
            </span>
          </div>
        ) : (
          <div className="flex flex-col gap-px p-2 pt-0">
            {columnFields.map(renderField)}
          </div>
        )}
      </div>
      <div className={cn("flex shrink-0 border-t", TOOLBAR_ROW_HEIGHT)}>
        {extractionAction}
      </div>
    </div>
  );
};

const SectionHeading = ({
  children,
  icon,
}: PropsWithChildren<{ icon?: ReactNode }>) => (
  <div className="bg-muted/40 text-foreground flex items-center gap-1.5 border-b px-4 py-2 text-sm font-semibold">
    {icon}
    {children}
  </div>
);

type PersonRowProps = {
  label: string;
  person: { id: string; name: string; image: string | null } | null;
};

const PersonRow = ({ label, person }: PersonRowProps) => (
  <div className="flex flex-col gap-1 rounded-md px-2 py-2">
    <span className="text-muted-foreground text-xs font-medium">{label}</span>
    {person === null ? (
      <span className="text-muted-foreground text-sm">—</span>
    ) : (
      <UserIdentity
        avatarClassName="size-5 shrink-0 text-[0.5625rem]"
        className="min-w-0"
        image={person.image}
        name={person.name}
        nameClassName="text-sm"
      />
    )}
  </div>
);

type ReadOnlyRowProps = {
  label: string;
  value: string | null;
  title?: string | undefined;
};

const ReadOnlyRow = ({ label, value, title }: ReadOnlyRowProps) => {
  const content = value ?? <span className="text-muted-foreground">—</span>;
  return (
    <div className="flex flex-col gap-1 rounded-md px-2 py-2">
      <span className="text-muted-foreground text-xs font-medium">{label}</span>
      {title === undefined ? (
        <span className="text-foreground text-sm">{content}</span>
      ) : (
        <Tooltip
          content={title}
          render={<span className="text-foreground text-sm">{content}</span>}
        />
      )}
    </div>
  );
};
