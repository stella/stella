import { useState, type PropsWithChildren } from "react";

import {
  CheckIcon,
  EqualIcon,
  EyeIcon,
  MinusIcon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";

import Tooltip from "@/components/tooltip";
import type { TranslationKey } from "@/i18n/types";
import type {
  ConditionNode,
  WorkspaceEntity,
  WorkspaceField,
  WorkspaceProperty,
} from "@/lib/types";
import { ActiveEditBadge } from "@/routes/_protected.workspaces/$workspaceId/-components/active-edit-badge";
import { AICellSourceCard } from "@/routes/_protected.workspaces/$workspaceId/-components/ai-cell-source-card";
import {
  CellMetadataFlags,
  useCellMetadataFlags,
} from "@/routes/_protected.workspaces/$workspaceId/-components/cell-metadata-flags";
import { EditableField } from "@/routes/_protected.workspaces/$workspaceId/-components/editable-field";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import { PropertyPopover } from "@/routes/_protected.workspaces/$workspaceId/-components/property-popover";
import {
  isAIExtractionProperty,
  resolveAiCellTargets,
  type AIExtractionTarget,
  type SourceFileTarget,
} from "@/routes/_protected.workspaces/$workspaceId/-components/table-column.logic";
import type { TableColumnDef } from "@/routes/_protected.workspaces/$workspaceId/-components/table/types";
import {
  type ColorVariants,
  emptyColor,
  resolveOptionColor,
} from "@/routes/_protected.workspaces/$workspaceId/-components/utils";
import { useRetryCell } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-retry-cell";
import {
  selectJustificationByFieldId,
  useWorkspaceStore,
} from "@/routes/_protected.workspaces/$workspaceId/-store";

type PropertyColumnOptions = {
  filters: ConditionNode[];
  property: WorkspaceProperty;
  // The graded position's verdict, when this ASK column has one. Rendered as a
  // chip beside the extracted value so the pair reads as a single
  // compliance-matrix cell. Undefined for plain columns and extractOnly ASKs.
  verdictProperty: WorkspaceProperty | undefined;
};

export const getPropertyColumn = ({
  filters,
  property,
  verdictProperty,
}: PropertyColumnOptions): TableColumnDef => ({
  id: property.id,
  accessorFn: (row) => row.fields[property.id],
  header: (ctx) => (
    <PropertyPopover
      filters={filters}
      header={ctx.header}
      property={property}
    />
  ),
  size: 200,
  cell: (props) => {
    const entity = props.row.original;
    if (!verdictProperty) {
      return <PropertyCell entity={entity} property={property} />;
    }
    // Verdict badge leads the cell so the extracted value keeps the remaining
    // width; the tier label + rationale live in the badge's hover card.
    const valuePending = entity.fields[property.id]?.content.type === "pending";
    return (
      <>
        <VerdictBadge
          entity={entity}
          loading={valuePending}
          verdictProperty={verdictProperty}
        />
        <PropertyCell entity={entity} property={property} />
      </>
    );
  },
});

const PropertyCell = ({
  entity,
  property,
}: {
  entity: WorkspaceEntity;
  property: WorkspaceProperty;
}) => {
  const field = entity.fields[property.id];
  const fieldContent = field?.content;
  const cellMetadata = entity.cellMetadata[property.id];
  // Coordinated with the CellMetadataFlags child via the shared
  // override store, so both calls land on the same in-flight patch.
  // setLocked lets us latch an AI cell the moment the user commits
  // a manual edit — see the AI-model branch below.
  const { setLocked } = useCellMetadataFlags({
    workspaceId: property.workspaceId,
    entityId: entity.entityId,
    propertyId: property.id,
    metadata: cellMetadata,
  });

  const justification = useWorkspaceStore((s) =>
    selectJustificationByFieldId(s.justifications, field?.id),
  );
  const extractionPreview = useWorkspaceStore((s) =>
    fieldContent?.type === "pending"
      ? s.getExtractionPreview(entity.entityId, property.id)
      : null,
  );

  if (fieldContent?.type === "pending") {
    return (
      <EditableField
        content={fieldContent}
        displayVariant="table"
        entityId={entity.entityId}
        entityKind={entity.kind}
        fieldId={field?.id}
        pendingPreview={extractionPreview}
        property={property}
        propertyId={property.id}
        readonly
        workspaceId={property.workspaceId}
      />
    );
  }

  if (property.content.type === "file" || fieldContent?.type === "file") {
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        <CellMetadataFlags
          entityId={entity.entityId}
          metadata={cellMetadata}
          propertyId={property.id}
          workspaceId={property.workspaceId}
        />
        <EditableField
          content={fieldContent}
          displayVariant="table"
          entityId={entity.entityId}
          entityKind={entity.kind}
          fieldId={field?.id}
          property={property}
          propertyId={property.id}
          readonly
          workspaceId={property.workspaceId}
        />
        {entity.activeEditBy && (
          <ActiveEditBadge
            className="shrink-0"
            image={entity.activeEditBy.image}
            name={entity.activeEditBy.name}
          />
        )}
      </span>
    );
  }

  if (property.tool.type === "manual-input") {
    return (
      <>
        <CellMetadataFlags
          entityId={entity.entityId}
          metadata={cellMetadata}
          propertyId={property.id}
          workspaceId={property.workspaceId}
        />
        <EditableField
          content={fieldContent}
          entityId={entity.entityId}
          entityKind={entity.kind}
          fieldId={field?.id}
          displayVariant="table"
          property={property}
          propertyId={property.id}
          showDateIcon={false}
          workspaceId={property.workspaceId}
        />
      </>
    );
  }

  // Playbook verdict: a system-computed single-select tier (compliant /
  // fallback / deviation / missing). Read-only — render the colored chip via
  // EditableField display mode, and surface the grading rationale through the
  // provenance card when a justification exists.
  if (property.tool.type === "playbook-verdict") {
    const verdictCell = (
      <span className="flex min-w-0 items-center gap-1.5">
        <CellMetadataFlags
          entityId={entity.entityId}
          metadata={cellMetadata}
          propertyId={property.id}
          workspaceId={property.workspaceId}
        />
        <EditableField
          content={fieldContent}
          displayVariant="table"
          entityId={entity.entityId}
          entityKind={entity.kind}
          fieldId={field?.id}
          property={property}
          propertyId={property.id}
          readonly
          workspaceId={property.workspaceId}
        />
      </span>
    );

    if (!justification) {
      return verdictCell;
    }
    return (
      <AICellSourceCard
        cellMetadata={cellMetadata}
        entity={entity}
        justification={justification}
      >
        {verdictCell}
      </AICellSourceCard>
    );
  }

  // AI-model property: click opens peek PDF with justification
  if (isAIExtractionProperty(property) && field !== undefined) {
    const targets = resolveAiCellTargets({
      entity,
      extractionField: field,
      extractionProperty: property,
      justificationFileFieldId: justification?.fileFieldIds.at(0),
    });

    if (targets) {
      const cell = (
        <WithOpenEntityButton
          extraction={targets.extraction}
          retryDisabled={cellMetadata?.locked === true || entity.readOnly}
          sourceFile={targets.sourceFile}
        >
          <CellMetadataFlags
            entityId={entity.entityId}
            metadata={cellMetadata}
            propertyId={property.id}
            workspaceId={property.workspaceId}
          />
          <EditableField
            content={fieldContent}
            displayVariant="table"
            entityId={entity.entityId}
            entityKind={entity.kind}
            fieldId={field.id}
            onManualSave={() => setLocked(true)}
            property={property}
            propertyId={property.id}
            showDateIcon={false}
            workspaceId={property.workspaceId}
          />
        </WithOpenEntityButton>
      );

      if (!justification) {
        return cell;
      }
      return (
        <AICellSourceCard
          cellMetadata={cellMetadata}
          entity={entity}
          justification={justification}
          onOpen={() =>
            useInspectorStore.getState().openFile({
              id: targets.sourceFile.fieldId,
              entityId: entity.entityId,
              label: targets.sourceFile.label,
              fileName: targets.sourceFile.fileName,
              mimeType: targets.sourceFile.mimeType,
              pdfFileId: targets.sourceFile.pdfFileId,
              justificationFieldId: field.id,
              propertyId: targets.sourceFile.propertyId,
              workspaceId: property.workspaceId,
            })
          }
        >
          {cell}
        </AICellSourceCard>
      );
    }
  }

  return (
    <>
      <CellMetadataFlags
        entityId={entity.entityId}
        metadata={cellMetadata}
        propertyId={property.id}
        workspaceId={property.workspaceId}
      />
      <EditableField
        content={fieldContent}
        displayVariant="table"
        entityId={entity.entityId}
        entityKind={entity.kind}
        fieldId={field?.id}
        property={property}
        propertyId={property.id}
        showDateIcon={false}
        workspaceId={property.workspaceId}
      />
    </>
  );
};

// Verdict tiers map to their localized label so the chip reads "Compliant"
// rather than the raw single-select id "compliant". Chip colors come from the
// verdict property's own single-select options (the same semantic tokens the
// standalone column used), so no color literals are needed here.
const VERDICT_TIER_LABEL_KEYS = {
  compliant: "knowledge.playbooks.verdict.compliant",
  fallback: "knowledge.playbooks.verdict.fallback",
  deviation: "knowledge.playbooks.verdict.deviation",
  missing: "knowledge.playbooks.verdict.missing",
} as const satisfies Record<string, TranslationKey>;

// Each tier also carries a distinct glyph so the badge encodes the verdict by
// shape as well as color (colorblind-safe): check = on standard, equals = an
// accepted alternative, cross = a deviation, dash = nothing extracted.
const VERDICT_TIER_ICONS = {
  compliant: CheckIcon,
  fallback: EqualIcon,
  deviation: XIcon,
  missing: MinusIcon,
} as const satisfies Record<string, LucideIcon>;

// Narrows an arbitrary tier id to a known tier without widening to the full
// TranslationKey union, so `t()` resolves the placeholder-free overload.
const isVerdictTier = (
  tier: string,
): tier is keyof typeof VERDICT_TIER_LABEL_KEYS =>
  tier in VERDICT_TIER_LABEL_KEYS;

type VerdictBadgeProps = {
  entity: WorkspaceEntity;
  verdictProperty: WorkspaceProperty;
  // The paired value cell is rerunning: show a spinner instead of the stale
  // verdict tier until the new grade lands.
  loading?: boolean;
};

/**
 * Compact compliance indicator: a small colored badge carrying the tier's glyph,
 * so the verdict reads by both color and shape. Color comes from the verdict
 * property's single-select options (the same semantic tokens the standalone
 * column used). The tier label and grading rationale stay one hover away — via
 * the shared provenance card when a justification exists, or a plain tooltip
 * otherwise — so dropping the always-on text label loses nothing.
 */
const VerdictBadge = ({
  entity,
  verdictProperty,
  loading = false,
}: VerdictBadgeProps) => {
  const t = useTranslations();
  const field = entity.fields[verdictProperty.id];
  const cellMetadata = entity.cellMetadata[verdictProperty.id];
  const justification = useWorkspaceStore((s) =>
    selectJustificationByFieldId(s.justifications, field?.id),
  );

  if (loading) {
    return (
      <span
        aria-label={t("common.loading")}
        className="text-muted-foreground flex size-4 shrink-0 items-center justify-center self-center group-data-[expanded-cell]/cell-content:self-end"
        role="img"
      >
        <RefreshCwIcon aria-hidden="true" className="size-3 animate-spin" />
      </span>
    );
  }

  const tier = verdictTier(field);
  if (!tier) {
    return null;
  }

  const label = isVerdictTier(tier) ? t(VERDICT_TIER_LABEL_KEYS[tier]) : tier;
  const Icon = isVerdictTier(tier) ? VERDICT_TIER_ICONS[tier] : null;
  const color = resolveVerdictColor(verdictProperty, tier);

  // Compact: the badge leads the cell in flow (centered). Expanded: it leaves
  // flow and pins to the bottom-left, on the same baseline as the Preview/Retry
  // actions (which are absolute bottom-1.5), so the whole action row lines up.
  const triggerAlignmentClass =
    "flex shrink-0 items-center self-center group-data-[expanded-cell]/cell-content:absolute group-data-[expanded-cell]/cell-content:bottom-1.5 group-data-[expanded-cell]/cell-content:start-2";

  const badge = (
    <span aria-label={label} className="flex items-center" role="img">
      {/* Compact table cell: a colored circle carrying just the tier glyph. */}
      <span
        className="flex size-4 items-center justify-center rounded-full group-data-[expanded-cell]/cell-content:hidden"
        style={{ backgroundColor: color.background, color: color.foreground }}
      >
        {Icon !== null && <Icon aria-hidden="true" className="size-2.5" />}
      </span>
      {/* Expanded cell: an icon + label pill matching the Preview/Retry actions
          on the same row, keeping the tier color on the glyph. */}
      <span className="text-foreground-ghost hover:text-foreground hidden h-6 items-center gap-1 px-1.5 text-xs opacity-70 group-data-[expanded-cell]/cell-content:flex hover:opacity-100">
        {Icon !== null && (
          <Icon
            aria-hidden="true"
            className="size-3.5"
            style={{ color: color.foreground }}
          />
        )}
        {label}
      </span>
    </span>
  );

  if (!justification) {
    return (
      <Tooltip
        content={label}
        render={<span className={triggerAlignmentClass}>{badge}</span>}
      />
    );
  }

  return (
    <AICellSourceCard
      cellMetadata={cellMetadata}
      clampStatements={false}
      entity={entity}
      justification={justification}
      title={label}
      triggerClassName={triggerAlignmentClass}
    >
      {badge}
    </AICellSourceCard>
  );
};

// Reads the verdict tier id from its field. We index by `"value" in content`
// rather than `content.type === "single-select"` on purpose: the dot is a status
// indicator, not field-value display, and a content-type comparison would (a)
// trip no-workspace-field-value-drift, which custom-plugin rules can't suppress
// inline, and (b) imply we're re-rendering the value, which we are not.
const verdictTier = (field: WorkspaceField | undefined): string | null => {
  const content = field?.content;
  if (!content || !("value" in content)) {
    return null;
  }
  const { value } = content;
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  return value;
};

const resolveVerdictColor = (
  verdictProperty: WorkspaceProperty,
  tier: string,
): ColorVariants => {
  if (verdictProperty.content.type !== "single-select") {
    return emptyColor;
  }
  const optionColor = verdictProperty.content.options.find(
    (option) => option.value === tier,
  )?.color;
  return optionColor ? resolveOptionColor(optionColor) : emptyColor;
};

type WithOpenEntityButtonProps = {
  extraction: AIExtractionTarget;
  retryDisabled: boolean;
  sourceFile: SourceFileTarget;
};

/** Shows a peek PDF preview in the inspector with the AI justification visible. */
const WithOpenEntityButton = ({
  extraction,
  retryDisabled,
  sourceFile,
  children,
}: PropsWithChildren<WithOpenEntityButtonProps>) => {
  const t = useTranslations();
  const workspaceId = extraction.property.workspaceId;
  const openFile = useInspectorStore((s) => s.openFile);
  const isFileAlreadyOpen = useInspectorStore((s) =>
    s.tabs.some((tab) => tab.type === "pdf" && tab.id === sourceFile.fieldId),
  );
  const retryCell = useRetryCell(workspaceId);
  const [isRetrying, setIsRetrying] = useState(false);

  const handleOpenPreview = () => {
    openFile({
      id: sourceFile.fieldId,
      entityId: extraction.entityId,
      label: sourceFile.label,
      fileName: sourceFile.fileName,
      mimeType: sourceFile.mimeType,
      pdfFileId: sourceFile.pdfFileId,
      justificationFieldId: extraction.fieldId,
      propertyId: sourceFile.propertyId,
      workspaceId,
    });
  };

  // If the file is ALREADY open in the inspector and the user clicks
  // anywhere in this cell, push this cell's justification onto the
  // open tab so the source bar + folio highlight come up without
  // making the user hunt for the inline Náhled button. Skipped when
  // the file isn't open — opening unrelated files on every cell click
  // would be far more disruptive than the current "just expand".
  const handleCellClick = (event: React.MouseEvent) => {
    if (!isFileAlreadyOpen) {
      return;
    }
    // Don't fire when the user is clicking an interactive child
    // (editable field input, action button, etc.) — those have
    // their own click semantics that the inspector update would
    // step on. Same predicate the row-expansion handler uses.
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest(
        "button, a, input, textarea, select, [role='button'], [role='checkbox'], [data-row-expansion-ignore], [data-slot='select-trigger']",
      )
    ) {
      return;
    }
    handleOpenPreview();
  };

  const handleRetry = async () => {
    if (isRetrying) {
      return;
    }
    setIsRetrying(true);
    try {
      await retryCell({
        entityId: extraction.entityId,
        propertyId: extraction.property.id,
      });
    } finally {
      setIsRetrying(false);
    }
  };

  const inlineActionClass =
    "text-foreground-ghost hover:text-foreground hidden h-6 gap-1 px-1.5 text-xs opacity-70 group-data-[expanded-cell]/cell-content:flex hover:opacity-100";

  return (
    // The wrapper onClick is a click-only enhancement: when the
    // referenced file is already open in the inspector, clicking
    // anywhere in the cell pushes that cell's justification onto
    // the open tab. Keyboard users have a fully equivalent path via
    // the inline Preview button rendered below.
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- see comment above
    <div className="w-full min-w-0 text-start" onClick={handleCellClick}>
      {children}
      <div
        className="absolute end-1.5 bottom-1.5 hidden items-center gap-1 group-data-[expanded-cell]/cell-content:flex"
        data-row-expansion-ignore
      >
        <Button
          className={inlineActionClass}
          onClick={(event) => {
            event.stopPropagation();
            handleOpenPreview();
          }}
          size="xs"
          variant="ghost"
        >
          <EyeIcon className="size-3.5" />
          {t("common.preview")}
        </Button>
        <Button
          className={inlineActionClass}
          disabled={retryDisabled || isRetrying}
          onClick={(event) => {
            event.stopPropagation();
            void handleRetry();
          }}
          size="xs"
          variant="ghost"
        >
          <RefreshCwIcon className="size-3.5" />
          {t("common.retry")}
        </Button>
      </div>
    </div>
  );
};
