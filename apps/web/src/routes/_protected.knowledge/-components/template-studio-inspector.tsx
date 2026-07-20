import { useRef, useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangleIcon,
  BookmarkIcon,
  BracesIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  HashIcon,
  LayoutTemplateIcon,
  PlusIcon,
  RefreshCwIcon,
  RepeatIcon,
  SaveIcon,
  SigmaIcon,
  SplitIcon,
  TextQuoteIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import type {
  DirectiveRange,
  TemplatePreviewSpan,
  TemplatePreviewValue,
} from "@stll/folio-react";
import { displayLanguageName } from "@stll/locales";
import type { DeterministicFieldConfig } from "@stll/template-conditions";
import { renderDeterministicFieldValue } from "@stll/template-conditions";
import { Button } from "@stll/ui/components/button";
import { Label } from "@stll/ui/components/label";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "@stll/ui/components/menu";
import {
  Popover,
  PopoverPopup,
  PopoverTrigger,
} from "@stll/ui/components/popover";
import { ScrollArea } from "@stll/ui/components/scroll-area";
import { Textarea } from "@stll/ui/components/textarea";
import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";

import { FacetBar } from "@/components/inspector/inspector-facet-bar";
import { useInspectorStore } from "@/components/inspector/inspector-store";
import { InspectorTabHeader } from "@/components/inspector/inspector-tab-header";
import type {
  InspectorRailIconProps,
  InspectorViewRenderProps,
} from "@/components/inspector/view-registry";
import { registerInspectorView } from "@/components/inspector/view-registry";
import Tooltip from "@/components/tooltip";
import { useMountEffect } from "@/hooks/use-effect";
import { usePermissions } from "@/hooks/use-permissions";
import { useFormatter } from "@/i18n/formatting-context";
import { useI18nStore } from "@/i18n/i18n-store";
import { api } from "@/lib/api";
import { optionalArray, optionalReadonlyArray } from "@/lib/arrays";
import { BoundedMap } from "@/lib/bounded-set";
import { SIDE_RAIL_TAB_ICON_SIZE_PX, TOOLBAR_ROW_HEIGHT } from "@/lib/consts";
import { detached } from "@/lib/detached";
import { userErrorMessage } from "@/lib/errors/user-safe";
import { toSafeId } from "@/lib/safe-id";
import { LinkClauseDialog } from "@/routes/_protected.knowledge/-components/link-clause-dialog";
import { parseArrayItemKey } from "@/routes/_protected.knowledge/-components/template-array-item-key";
import { TemplateCheckDialog } from "@/routes/_protected.knowledge/-components/template-check-dialog";
import type { LinkedClause } from "@/routes/_protected.knowledge/-components/template-clauses-tab";
import {
  ARRAY_INDEX_KEY_PREFIX,
  TemplateForm,
  useFillToMatterSaveTarget,
} from "@/routes/_protected.knowledge/-components/template-form";
import { useTemplateNavStore } from "@/routes/_protected.knowledge/-components/template-nav-store";
import {
  ConditionFace,
  LoopFace,
} from "@/routes/_protected.knowledge/-components/template-studio-conditions";
import {
  protectedRouteApi,
  TEMPLATE_STUDIO_VIEW,
  TEMPLATES_ROUTE_ID,
  templateStudioTabId,
} from "@/routes/_protected.knowledge/-components/template-studio-constants";
import {
  ClauseFace,
  FieldFace,
  FieldNavigator,
} from "@/routes/_protected.knowledge/-components/template-studio-fields";
import {
  defaultStudioField,
  useTemplateStudioStore,
  type OutlineNode,
  type StudioActions,
  type StudioField,
} from "@/routes/_protected.knowledge/-components/template-studio-store";
import { TemplateVersionsTab } from "@/routes/_protected.knowledge/-components/template-versions-tab";
import {
  knowledgeKeys,
  templateCheckOptions,
  templateClausePreviewOptions,
  templateClausesOptions,
  templateDetailOptions,
  templateFillDiscoverOptions,
  templateRecipesOptions,
} from "@/routes/_protected.knowledge/-queries";

type StudioFacet = "fields" | "guidance" | "history" | "fill";
type TemplateStudioPayload = { templateId: string };

const STUDIO_FACETS: readonly StudioFacet[] = [
  "fields",
  "guidance",
  "history",
  "fill",
];

export function TemplateStudioInspectorView({
  tab,
  onClose,
}: InspectorViewRenderProps<TemplateStudioPayload>) {
  const t = useTranslations();
  const { templateId } = tab.payload;
  // Fill performs real fills (and fill-to-matter writes), which the backend
  // gates on template:use; without it the tab would be a form that can only
  // fail at the last click.
  const canUseTemplate = usePermissions({ template: ["use"] });
  const [rawFacet, setFacet] = useState<StudioFacet>("fields");
  const facet = !canUseTemplate && rawFacet === "fill" ? "fields" : rawFacet;
  const visibleFacets = canUseTemplate
    ? STUDIO_FACETS
    : STUDIO_FACETS.filter((f) => f !== "fill");
  const [editReturnFacet, setEditReturnFacet] = useState<StudioFacet | null>(
    null,
  );
  const sessionTemplateId = useTemplateStudioStore((s) => s.templateId);
  const fields = useTemplateStudioStore((s) => s.fields);
  const outline = useTemplateStudioStore((s) => s.outline);
  const selected = useTemplateStudioStore((s) => s.selected);
  const upsertField = useTemplateStudioStore((s) => s.upsertField);

  const queryClient = useQueryClient();
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const lang = useI18nStore((s) => s.lang);
  // Languages sit in the tab header (next to the name) so the template's identity
  // reads at a glance; useQuery (not suspense) keeps a cache miss from blocking
  // the whole studio chrome.
  const { data: detailData } = useQuery(
    templateDetailOptions(activeOrganizationId, templateId),
  );
  const detail =
    detailData && !(detailData instanceof Response) && "manifest" in detailData
      ? detailData
      : null;
  const languages = detail ? detail.languages : [];
  const openView = useInspectorStore((s) => s.openView);
  const setNavName = useTemplateNavStore((s) => s.setName);
  const [rename, setRename] = useState<{ active: boolean; value: string }>({
    active: false,
    value: "",
  });

  const commitRename = async () => {
    const next = rename.value.trim();
    setRename({ active: false, value: "" });
    if (!next || next === tab.label) {
      return;
    }
    const response = await api
      .templates({ templateId: toSafeId<"template">(templateId) })
      .post({ name: next });
    if (response.error) {
      stellaToast.add({ type: "error", title: t("templates.renameFailed") });
      return;
    }
    // Reflect the new name in the tab label, the breadcrumb, and the list.
    openView({
      type: TEMPLATE_STUDIO_VIEW,
      id: templateStudioTabId(templateId),
      label: next,
      payload: { templateId },
      ownerRouteId: TEMPLATES_ROUTE_ID,
    });
    setNavName(templateId, next);
    detached(
      queryClient.invalidateQueries({
        queryKey: knowledgeKeys.templates.all(activeOrganizationId),
      }),
      "commitRename",
    );
    stellaToast.add({ type: "success", title: t("templates.templateRenamed") });
  };

  const facetLabels: Record<StudioFacet, string> = {
    fields: t("templates.fields"),
    guidance: t("templates.whenToUse"),
    history: t("common.history"),
    fill: t("templates.fill"),
  };

  // Leaving the field-settings face returns to wherever the edit was launched
  // from (the Fill-tab pencil records "fill"); otherwise it drops to the
  // Fields overview.
  const exitField = () => {
    if (editReturnFacet !== null) {
      setFacet(editReturnFacet);
      setEditReturnFacet(null);
    }
    useTemplateStudioStore.getState().actions?.deselect();
  };

  // The page seeds the session on mount; until then (or after it unmounts and
  // clears) the body has nothing to show — but keep the header + subtab row so
  // the tab reads consistently with the rest of the inspector.
  const ready = sessionTemplateId === templateId;

  return (
    <div className="bg-background flex h-full flex-1 flex-col overflow-hidden">
      <InspectorTabHeader
        actions={
          <>
            <StudioHealthBadge templateId={templateId} />
            <StudioSaveAction />
          </>
        }
        label={tab.label}
        matter={
          languages.length > 0 ? (
            <span className="flex shrink-0 items-center gap-1">
              {languages.map((tag) => (
                <Tooltip
                  content={tag}
                  key={tag}
                  render={
                    <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-[10px] font-medium">
                      {languageChipLabel(tag, lang)}
                    </span>
                  }
                />
              ))}
            </span>
          ) : undefined
        }
        onClose={onClose}
        onStartRename={() => setRename({ active: true, value: tab.label })}
        rename={{
          active: rename.active,
          value: rename.value,
          onChange: (value) => setRename({ active: true, value }),
          onCommit: () => detached(commitRename(), "onCommit"),
          onCancel: () => setRename({ active: false, value: "" }),
        }}
      />
      <FacetBar
        facet={facet}
        facets={visibleFacets}
        labels={facetLabels}
        onChange={(next) => {
          // Re-clicking Fields returns to the template overview.
          if (next === facet && next === "fields") {
            useTemplateStudioStore.getState().actions?.deselect();
          }
          setEditReturnFacet(null);
          setFacet(next);
        }}
      />
      {!ready && (
        <div className="flex flex-1 items-center justify-center p-8">
          <p className="text-muted-foreground text-sm">{t("common.loading")}</p>
        </div>
      )}
      {ready && facet === "fields" && (
        <Inspector
          fields={fields}
          onFieldBack={exitField}
          onFieldUpdate={upsertField}
          outline={outline}
          selected={selected}
        />
      )}
      {ready && facet === "guidance" && (
        <div className="min-h-0 flex-1 overflow-auto">
          <TemplateGuidanceFacet templateId={templateId} />
        </div>
      )}
      {ready && facet === "history" && (
        <div className="min-h-0 flex-1 overflow-auto">
          <TemplateVersionsTab templateId={templateId} />
        </div>
      )}
      {ready && facet === "fill" && (
        <TemplateFillFacet
          onEditField={(path) => {
            setEditReturnFacet("fill");
            setFacet("fields");
            useTemplateStudioStore.getState().actions?.focusField(path);
          }}
          templateId={templateId}
        />
      )}
      {ready && facet === "fields" && !selected && (
        <StudioOverviewSummary fields={fields} templateId={templateId} />
      )}
      {ready && facet === "fields" && <StudioInsertRow />}
    </div>
  );
}

/**
 * Ambient template-health indicator in the tab title row. Runs the pre-flight
 * check as calm chrome (`useQuery`, never suspending): a subtle check when the
 * template is clean, a tinted issue count when it is not. Clicking opens the
 * full check dialog. The check query lives under the templates subtree, so the
 * save handler's `templates.all` invalidation refetches it after every save.
 */
export const StudioHealthBadge = ({ templateId }: { templateId: string }) => {
  const t = useTranslations();
  const format = useFormatter();
  const organizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const { data } = useQuery(templateCheckOptions(organizationId, templateId));

  // Nothing to show until the first result lands; keeps the row from flashing
  // a placeholder state on cold mount.
  if (!data) {
    return null;
  }

  const issueCount = data.findings.length;
  const hasErrors = data.findings.some(
    (finding) => finding.severity === "error",
  );

  const badge = (
    <Button
      aria-label={t("templates.checkTemplate")}
      className={cn(
        issueCount === 0 && "text-success",
        issueCount > 0 && !hasErrors && "text-warning-foreground",
        hasErrors && "text-destructive",
      )}
      size="xs"
      title={t("templates.checkTemplate")}
      variant="ghost"
    >
      {issueCount === 0 ? (
        <CheckCircle2Icon className="size-3.5" />
      ) : (
        <>
          <AlertTriangleIcon className="size-3.5" />
          {format.number(issueCount)}
        </>
      )}
    </Button>
  );

  return <TemplateCheckDialog templateId={templateId} trigger={badge} />;
};

/** Save lives in the tab's title row; enabled only with unsaved edits. */
export const StudioSaveAction = () => {
  const t = useTranslations();
  const actions = useTemplateStudioStore((s) => s.actions);
  const ui = useTemplateStudioStore((s) => s.ui);
  const isDirty = useTemplateStudioStore((s) => s.isDirty);
  // Nothing to save → no button at all; a permanently greyed-out control just
  // reads as broken. It reappears the moment an edit makes the tab dirty.
  if (!actions || (!isDirty && !ui.isSaving)) {
    return null;
  }
  return (
    <Button
      disabled={ui.isSaving}
      onClick={() => {
        detached(actions.save(), "StudioSaveAction");
      }}
      size="xs"
    >
      <SaveIcon className="size-3.5" />
      {t("common.save")}
    </Button>
  );
};

// Filling happens in-place as the "Fill" subtab. It targets the *saved*
// template (the fill endpoint reads from S3). The persisted manifest carries no
// field kind/itemFields, so re-discover the stored DOCX (the same merge the
// fill endpoint uses) to get the real field shape — {{#each}} array fields
// included — rather than reconstructing it from the flat manifest.
export const TemplateFillFacet = ({
  templateId,
  onEditField,
}: {
  templateId: string;
  onEditField: (path: string) => void;
}) => {
  const fillSaveTarget = useFillToMatterSaveTarget();
  const facetOrgId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const { data: clausePreview } = useQuery({
    ...templateClausePreviewOptions(facetOrgId, templateId),
  });
  // Leaving the facet clears the in-document preview (and drops any pending
  // lookup-preview response so it cannot re-set a stale preview).
  useMountEffect(() => () => {
    cancelLookupPreviews();
    useTemplateStudioStore.getState().actions?.setFillPreview(null);
  });
  const t = useTranslations();
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const detailOptions = templateDetailOptions(activeOrganizationId, templateId);
  const { data: detailData } = useQuery(detailOptions);
  const fillIsDirty = useTemplateStudioStore((s) => s.isDirty);
  const fillActions = useTemplateStudioStore((s) => s.actions);
  // Persisted so the entered values survive a facet switch (edit a field and
  // come back) instead of remounting away with the fill form.
  const fillValues = useTemplateStudioStore((s) => s.fillValues);
  const setFillValues = useTemplateStudioStore((s) => s.setFillValues);
  const detail =
    detailData && !(detailData instanceof Response) && "manifest" in detailData
      ? detailData
      : null;

  const presignedUrl = detail?.presignedUrl;
  const fileName = detail?.fileName;
  const {
    data: discovered,
    isLoading: discovering,
    isError,
  } = useQuery(
    templateFillDiscoverOptions({
      key: { organizationId: activeOrganizationId, templateId },
      context: { presignedUrl, fileName },
    }),
  );

  if (!detail || discovering) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <p className="text-muted-foreground text-sm">{t("common.loading")}</p>
      </div>
    );
  }

  if (isError || !discovered) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <p className="text-muted-foreground text-sm">
          {t("templates.loadFailed")}
        </p>
      </div>
    );
  }

  return (
    <>
      {fillIsDirty ? (
        <div className="border-warning/30 bg-warning/10 mx-4 mt-3 flex items-center justify-between gap-2 rounded-lg border p-2.5">
          <p className="text-warning-foreground text-xs">
            {t("templates.studio.fillStale")}
          </p>
          <Button
            onClick={() => detached(fillActions?.save(), "TemplateFillFacet")}
            size="sm"
            variant="outline"
          >
            {t("common.save")}
          </Button>
        </div>
      ) : null}
      <TemplateForm
        conditions={discovered.conditions}
        fields={discovered.fields}
        fileName={detail.fileName}
        initialValues={fillValues ?? undefined}
        onBack={() => undefined}
        onDone={() => undefined}
        onEditField={onEditField}
        onValuesChange={(values) => {
          setFillValues(values);
          pushFillPreview(values, discovered.fields, clausePreview?.slotTexts);
        }}
        saveTarget={fillSaveTarget}
        structureErrors={discovered.structureErrors}
        templateId={templateId}
      />
    </>
  );
};

/** Typed fill values become the live in-document preview, each field rendered
 *  through the SAME deterministic dispatcher the API fill engine uses
 *  (`renderDeterministicFieldValue`): composite joins via its `format`
 *  template, a formula is computed, a date is rendered in its locale/style —
 *  so the preview is byte-identical to the generated document. A lookup
 *  field's value is resolved server-side, so it previews the raw registry
 *  number until the debounced lookup-preview response lands (and on a miss the
 *  raw number stays); that async overlay is the one exception to the shared
 *  dispatcher.
 *
 *  Repeatable (array) fields preview with their FIRST item only: the form
 *  names item inputs `path[i].sub` while the `{{#each}}` body's markers use
 *  the bare item path (`path.sub`), so item 0's values map onto those paths
 *  and the loop body previews with the first entry. Expanding the loop into
 *  one preview per item is a known future item. */
const pushFillPreview = (
  values: Record<string, unknown>,
  fields?: readonly LookupPreviewField[],
  clauseTexts?: Record<string, string>,
) => {
  cancelLookupPreviews();
  const preview: Record<string, TemplatePreviewValue> = {};
  const fieldByPath = new Map<string, LookupPreviewField>(
    optionalReadonlyArray(fields).map((field) => [field.path, field]),
  );
  // Linked clause slots preview their resolved text, keyed by slot name to
  // match the folio plugin's clause-range key.
  if (clauseTexts) {
    Object.assign(preview, clauseTexts);
  }
  for (const [key, value] of Object.entries(values)) {
    if (key.startsWith(ARRAY_INDEX_KEY_PREFIX)) {
      continue;
    }
    const item = parseArrayItemKey(key);
    if (item && item.index !== 0) {
      continue;
    }
    const path = item ? `${item.path}.${item.sub}` : key;
    const previewValue = renderPreviewFieldValue(
      fieldByPath.get(path),
      value,
      values,
    );
    if (previewValue !== null) {
      preview[path] = previewValue;
    }
  }
  // Formula fields are derived (no form input), so they never appear in the
  // submitted values; render them from the field list directly.
  const availableFields = optionalReadonlyArray(fields);
  for (const field of availableFields) {
    if (field.formula === undefined || preview[field.path] !== undefined) {
      continue;
    }
    const computed = renderDeterministicFieldValue(field, values);
    if (computed !== null) {
      preview[field.path] = computed;
    }
  }
  const pending = applyCachedLookupRenderings(preview, availableFields);
  useTemplateStudioStore
    .getState()
    .actions?.setFillPreview(Object.keys(preview).length > 0 ? preview : null);
  if (pending.length > 0) {
    queueLookupPreviews(pending, () =>
      pushFillPreview(values, fields, clauseTexts),
    );
  }
};

// ── Lookup live preview ──────────────────────────────────
// A lookup field's live preview shows the deterministic looked-up rendering
// (number → registry hit → the field's [token] format), not the raw number.
// Plausible numbers debounce into POST /templates/lookup-preview; the
// rendered text (with the format's **bold** / *italic* markers intact)
// substitutes into the preview map when the response lands, parsed into
// formatted preview spans so the document preview shows the formatting.

/** A plausibly-complete registry identifier for ANY supported registry:
 *  alphanumeric, hyphen-tolerant, 5–20 chars after whitespace is stripped.
 *  Deliberately broader than one registry's exact format so non-KRS IDs (Czech
 *  IČO, Companies House CRN, VAT, CIK, SIRET, Finnish business id, …) also queue
 *  the debounced preview; the settled value is queued once, and one that no
 *  registry resolves simply renders as the raw number (a graceful miss). */
const LOOKUP_PREVIEW_NUMBER_RE = /^[A-Za-z0-9-]{5,20}$/u;

const normalizeLookupNumber = (value: string): string =>
  value.replaceAll(/\s/gu, "");

/** Mirrors LOOKUP_MARKDOWN_RE in apps/api/src/handlers/docx/lookup-fields.ts
 *  (the source of truth for the lookup format's inline markdown): `**bold**`
 *  and `*italic*` spans, non-nesting, asterisk-free content, unmatched
 *  asterisks stay literal. */
const LOOKUP_PREVIEW_MARKDOWN_RE =
  /\*\*(?<bold>[^*]+)\*\*|(?<!\*)\*(?<italic>[^*]+)\*(?!\*)/gu;

/** A rendered lookup output as a folio preview value: formatted spans when
 *  the format used `**bold**` / `*italic*`, otherwise the plain string. */
const lookupPreviewValue = (rendered: string): TemplatePreviewValue => {
  const spans: TemplatePreviewSpan[] = [];
  let cursor = 0;
  for (const match of rendered.matchAll(LOOKUP_PREVIEW_MARKDOWN_RE)) {
    if (match.index > cursor) {
      spans.push({ text: rendered.slice(cursor, match.index) });
    }
    const { bold, italic } = match.groups ?? {};
    if (bold !== undefined) {
      spans.push({ text: bold, bold: true });
    } else if (italic !== undefined) {
      spans.push({ text: italic, italic: true });
    }
    cursor = match.index + match[0].length;
  }
  if (spans.length === 0) {
    return rendered;
  }
  if (cursor < rendered.length) {
    spans.push({ text: rendered.slice(cursor) });
  }
  return { runs: spans };
};

type StudioLookup = NonNullable<StudioField["lookup"]>;

/** A field as the live preview needs it: the deterministic-transform config
 *  the shared dispatcher reads (composite/formula/date), plus the lookup
 *  config the async overlay handles itself. */
type LookupPreviewField = DeterministicFieldConfig & {
  lookup?: StudioLookup | undefined;
};

/** A single field's live preview string. A deterministic field (composite /
 *  formula / date) renders through the shared dispatcher, so it matches the
 *  generated document exactly; everything else (a scalar, or a lookup field
 *  whose value the async overlay later replaces) falls back to the raw
 *  string/number/boolean. Returns null when there is nothing to preview. */
const renderPreviewFieldValue = (
  field: LookupPreviewField | undefined,
  value: unknown,
  values: Record<string, unknown>,
): TemplatePreviewValue | null => {
  if (field !== undefined) {
    const deterministic = renderDeterministicFieldValue(field, values);
    if (deterministic !== null) {
      return deterministic;
    }
  }
  if (typeof value === "string") {
    return value === "" ? null : value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
};

type LookupPreviewRequest = {
  registry: StudioLookup["registry"];
  number: string;
  format: string | null;
  /** Where the rendering lands in the preview map: the bare `field.path` for
   *  the default (first) format, the keyed `${field.path}.${format.key}` for
   *  every later one. Excluded from the cache key (renderings depend only on
   *  registry+number+format), so identical formats across markers share a
   *  cache slot. */
  previewPath: string;
};

const lookupPreviewKey = (request: LookupPreviewRequest): string =>
  `${request.registry} ${request.number} ${request.format ?? ""}`;

/** Rendered previews (the endpoint's marked-up string, parsed at
 *  substitution time) keyed registry+number+format so repeats are instant;
 *  null marks a known miss (typo'd number, registry outage) that keeps the
 *  raw number without refetch loops. Bounded: past the cap the oldest
 *  insertion is evicted, so a long studio session cannot grow it without
 *  limit. */
const LOOKUP_PREVIEW_CACHE_MAX = 100;
const lookupPreviewCache = new BoundedMap<string, string | null>(
  LOOKUP_PREVIEW_CACHE_MAX,
);

const rememberLookupRendering = (key: string, rendered: string | null) => {
  lookupPreviewCache.set(key, rendered);
};

const LOOKUP_PREVIEW_DEBOUNCE_MS = 500;
let lookupPreviewSeq = 0;
let lookupPreviewTimer: ReturnType<typeof setTimeout> | undefined;

/** Invalidate the debounce and any in-flight responses; every preview push
 *  (and preview-surface unmount) starts here so only the latest push can
 *  apply its renderings. */
const cancelLookupPreviews = () => {
  lookupPreviewSeq += 1;
  clearTimeout(lookupPreviewTimer);
};

/** Substitute cached renderings into `preview` in place (parsed into
 *  formatted spans where the format carries markup) and return the requests
 *  that still need the endpoint. */
const applyCachedLookupRenderings = (
  preview: Record<string, TemplatePreviewValue>,
  fields: readonly LookupPreviewField[],
): LookupPreviewRequest[] => {
  const pending: LookupPreviewRequest[] = [];
  for (const field of fields) {
    const lookup = field.lookup;
    const raw = preview[field.path];
    // The entered value is always a plain string (the registry number);
    // anything else is a previous substitution and needs no lookup.
    if (lookup === undefined || typeof raw !== "string") {
      continue;
    }
    const number = normalizeLookupNumber(raw);
    if (!LOOKUP_PREVIEW_NUMBER_RE.test(number)) {
      continue;
    }
    // The fill pipeline writes the default (first) format under the bare
    // `field.path` and every later format under the keyed
    // `${field.path}.${format.key}`; the preview plugin matches markers by
    // exact expression, so each configured format needs its own request and
    // its own preview slot or keyed markers like `{{company.address}}` stay
    // blank.
    for (const [index, format] of lookup.formats.entries()) {
      const request: LookupPreviewRequest = {
        registry: lookup.registry,
        number,
        format: format.template,
        previewPath: index === 0 ? field.path : `${field.path}.${format.key}`,
      };
      const cached = lookupPreviewCache.get(lookupPreviewKey(request));
      if (cached === undefined) {
        pending.push(request);
      } else if (cached !== null) {
        preview[request.previewPath] = lookupPreviewValue(cached);
      }
    }
  }
  return pending;
};

/** Debounced fetch of the pending renderings into the cache; `onResolved`
 *  re-runs the push (which now substitutes synchronously) unless a newer
 *  push superseded this one. */
const queueLookupPreviews = (
  requests: readonly LookupPreviewRequest[],
  onResolved: () => void,
) => {
  const seq = lookupPreviewSeq;
  clearTimeout(lookupPreviewTimer);
  lookupPreviewTimer = setTimeout(() => {
    detached(
      (async () => {
        const resolved = await Promise.all(
          requests.map(async (request) => {
            const response = await api.templates["lookup-preview"].post({
              registry: request.registry,
              number: request.number,
              format: request.format,
            });
            // A miss keeps the raw number in the preview (cached as null so
            // it is not refetched); the fill submit reports the real error.
            const rendered =
              !response.error && !(response.data instanceof Response)
                ? response.data.rendered
                : null;
            rememberLookupRendering(lookupPreviewKey(request), rendered);
            return rendered !== null;
          }),
        );
        if (seq === lookupPreviewSeq && resolved.some(Boolean)) {
          onResolved();
        }
      })(),
      "queueLookupPreviews",
    );
  }, LOOKUP_PREVIEW_DEBOUNCE_MS);
};

/** One field entry in an "Existing field…" insert list. A lookup field with
 *  more than one output format expands into a submenu so the author picks WHICH
 *  rendering to insert: the first format as the default (`{{path}}`), each
 *  later format keyed (`{{path.key}}`). Single-format lookups and non-lookup
 *  fields insert with one click as `{{path}}`. */
export const InsertExistingFieldItem = ({
  field,
  onInsert,
}: {
  field: StudioField;
  onInsert: (path: string, formatKey?: string) => void;
}) => {
  const t = useTranslations();
  const label = field.label === "" ? field.path : field.label;
  const formats = optionalArray(field.lookup?.formats);
  if (formats.length <= 1) {
    return (
      <MenuItem onClick={() => onInsert(field.path)}>
        <span className="min-w-0 truncate">{label}</span>
        <code className="text-muted-foreground ms-auto ps-3 text-[10px]">
          {field.path}
        </code>
      </MenuItem>
    );
  }
  return (
    <MenuSub>
      <MenuSubTrigger>
        <span className="min-w-0 truncate">{label}</span>
        <code className="text-muted-foreground ms-auto ps-3 text-[10px]">
          {field.path}
        </code>
      </MenuSubTrigger>
      <MenuSubPopup>
        {formats.map((format, index) => (
          <MenuItem
            key={`${format.key}-${String(index)}`}
            onClick={() =>
              onInsert(field.path, index === 0 ? undefined : format.key)
            }
          >
            <span className="min-w-0 truncate">
              {index === 0
                ? t("templates.studio.insertFormatDefault")
                : format.key}
            </span>
          </MenuItem>
        ))}
      </MenuSubPopup>
    </MenuSub>
  );
};

/** Primary footer action, contextual to the open detail: a placeholder field
 *  inserts its marker, a condition (`#if`) inserts its block, and the overview
 *  creates a new field. */
export const StudioPrimaryInsertButton = ({
  actions,
  selected,
}: {
  actions: StudioActions;
  selected: DirectiveRange | null;
}) => {
  const t = useTranslations();
  if (selected?.kind === "placeholder") {
    return (
      <Button
        className="flex-1 justify-start"
        onClick={() => actions.insertExistingField(selected.expr)}
        size="sm"
        variant="ghost"
      >
        <BracesIcon />
        {t("templates.studio.insertIntoTemplate")}
      </Button>
    );
  }
  if (selected?.kind === "if") {
    return (
      <Button
        className="flex-1 justify-start"
        onClick={() => actions.insertExistingCondition(selected.expr)}
        size="sm"
        variant="ghost"
      >
        <BracesIcon />
        {t("templates.studio.insertConditionIntoTemplate")}
      </Button>
    );
  }
  return (
    <Button
      className="flex-1 justify-start"
      onClick={actions.insertField}
      size="sm"
      variant="ghost"
    >
      <PlusIcon />
      {t("templates.studio.newField")}
    </Button>
  );
};

/** The effective (document-visible) slot name per link: the LAST recorded step
 *  for each link in the pending-rename replay log wins, superseding the stale
 *  server record. Derive once per render, then look up by link id. */
const effectiveSlotByLink = (
  pending: readonly { linkId: string; slotName: string }[],
): Map<string, string> => {
  const byLink = new Map<string, string>();
  for (const step of pending) {
    byLink.set(step.linkId, step.slotName);
  }
  return byLink;
};

/** Document actions row — rendered in the inspector tab's top area; the page
 *  registers the handlers + UI state in the session store. */
const MENU_ITEM_PRESS_REASON = "item-press";

export const StudioInsertRow = () => {
  const t = useTranslations();
  const actions = useTemplateStudioStore((s) => s.actions);
  const fields = useTemplateStudioStore((s) => s.fields);
  const selected = useTemplateStudioStore((s) => s.selected);
  const sessionTemplateId = useTemplateStudioStore((s) => s.templateId);
  const pendingSlotRenames = useTemplateStudioStore(
    (s) => s.pendingSlotRenames,
  );
  const effectiveSlots = effectiveSlotByLink(pendingSlotRenames);
  // Every deferred-rename target is spoken for until the next save flushes the
  // log, so the link dialog must not offer these names for a new link row.
  // Reserve both sides of every pending step: targets are about to be
  // claimed, and sources (incl. mid-replay intermediates) stay claimed
  // server-side until the flush lands.
  const reservedSlotNames = pendingSlotRenames.flatMap((r) => [
    r.fromSlot,
    r.slotName,
  ]);
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  // Linked clauses feed the Insert > Clause slot submenu so the user picks a
  // real clause instead of typing a slot name into a bare {{@clause:...}}.
  const { data: clausesData } = useQuery({
    ...templateClausesOptions(activeOrganizationId, sessionTemplateId ?? ""),
    enabled: sessionTemplateId !== null,
  });
  // Saved recipes (org-wide) feed the Insert > Recipes submenu.
  const { data: recipesData } = useQuery(
    templateRecipesOptions(activeOrganizationId),
  );
  // The loop-token submenu (`{{@index}}`/`{{@count}}`) only makes sense inside
  // an `{{#each}}` body. `isCaretInLoop` reads the live caret imperatively, so
  // recompute it each time the menu opens rather than reactively.
  const [caretInLoop, setCaretInLoop] = useState(false);
  const preserveEditorFocusRef = useRef(false);
  const linkClauseDialogLaunchRef = useRef(false);
  // Clause linking lives inline here (the standalone clauses tab was removed):
  // link a clause, then drop its slot at the caret from the same menu.
  const [linkClauseOpen, setLinkClauseOpen] = useState(false);
  const queryClient = useQueryClient();
  const recipes =
    recipesData && "recipes" in recipesData ? recipesData.recipes : [];
  const linkedClauses =
    clausesData && "links" in clausesData && Array.isArray(clausesData.links)
      ? clausesData.links.flatMap(
          (link: {
            id: string;
            slotName: string | null;
            clause: { title: string } | null;
          }) =>
            link.clause
              ? [
                  {
                    id: link.id,
                    // A pending (unsaved) rename supersedes the server slot
                    // name, so the menu inserts the marker the document uses.
                    slotName: effectiveSlots.get(link.id) ?? link.slotName,
                    title: link.clause.title,
                  },
                ]
              : [],
        )
      : [];
  if (!actions) {
    return null;
  }
  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-1 border-t px-2",
        TOOLBAR_ROW_HEIGHT,
      )}
    >
      <StudioPrimaryInsertButton actions={actions} selected={selected} />
      <Menu
        onOpenChange={(open, eventDetails) => {
          preserveEditorFocusRef.current =
            !open && eventDetails.reason === MENU_ITEM_PRESS_REASON;
          if (open) {
            setCaretInLoop(actions.isCaretInLoop());
          }
        }}
      >
        <MenuTrigger
          aria-label={t("templates.studio.insert")}
          render={<Button size="icon-sm" variant="ghost" />}
        >
          <ChevronDownIcon />
        </MenuTrigger>
        <MenuPopup
          align="end"
          finalFocus={() => {
            if (linkClauseDialogLaunchRef.current) {
              linkClauseDialogLaunchRef.current = false;
              preserveEditorFocusRef.current = false;
              return false;
            }
            if (!preserveEditorFocusRef.current) {
              return true;
            }
            preserveEditorFocusRef.current = false;
            return actions.focusEditor();
          }}
        >
          {fields.length > 0 && (
            <MenuSub>
              <MenuSubTrigger>
                <BracesIcon />
                {t("templates.fields")}
              </MenuSubTrigger>
              <MenuSubPopup>
                {fields.map((f) => (
                  <InsertExistingFieldItem
                    field={f}
                    key={f.path}
                    onInsert={actions.insertExistingField}
                  />
                ))}
              </MenuSubPopup>
            </MenuSub>
          )}
          <MenuItem onClick={actions.insertCondition}>
            <SplitIcon />
            {t("templates.studio.scopeCondition")}
          </MenuItem>
          <MenuItem onClick={actions.insertLoop}>
            <RepeatIcon />
            {t("templates.studio.loop")}
          </MenuItem>
          {caretInLoop && (
            <MenuSub>
              <MenuSubTrigger>
                <RepeatIcon />
                {t("templates.studio.loop")}
              </MenuSubTrigger>
              <MenuSubPopup>
                <MenuItem onClick={() => actions.insertText("{{@index}}")}>
                  <HashIcon />
                  {t("templates.studio.insertItemNumber")}
                </MenuItem>
                <MenuItem onClick={() => actions.insertText("{{@count}}")}>
                  <SigmaIcon />
                  {t("templates.studio.insertItemTotal")}
                </MenuItem>
              </MenuSubPopup>
            </MenuSub>
          )}
          {recipes.length > 0 && (
            <MenuSub>
              <MenuSubTrigger>
                <BookmarkIcon />
                {t("templates.studio.recipes")}
              </MenuSubTrigger>
              <MenuSubPopup>
                {recipes.map((recipe) => (
                  <MenuItem
                    key={recipe.id}
                    onClick={() => actions.insertRecipe(recipe.definition)}
                  >
                    <span className="min-w-0 truncate">{recipe.name}</span>
                  </MenuItem>
                ))}
              </MenuSubPopup>
            </MenuSub>
          )}
          <MenuSub>
            <MenuSubTrigger>
              <TextQuoteIcon />
              {t("templates.studio.scopeClause")}
            </MenuSubTrigger>
            <MenuSubPopup>
              {linkedClauses.map((link) => {
                // Only links bound to a concrete slot are insertable here: fill
                // resolution matches links by their persisted slotName, so a
                // slugified-title fallback for a null-slot link would leave its
                // {{@clause:...}} marker unresolved in the generated document.
                const slotName = link.slotName;
                if (slotName === null) {
                  return null;
                }
                return (
                  <MenuItem
                    dir="auto"
                    key={link.id}
                    onClick={() => actions.insertClauseSlot(slotName)}
                  >
                    {link.title}
                  </MenuItem>
                );
              })}
              {linkedClauses.some((link) => link.slotName !== null) && (
                <MenuSeparator />
              )}
              <MenuItem onClick={actions.insertClause}>
                {t("templates.studio.emptyClauseSlot")}
              </MenuItem>
              {sessionTemplateId !== null && (
                <>
                  <MenuSeparator />
                  <MenuItem
                    onClick={() => {
                      linkClauseDialogLaunchRef.current = true;
                      setLinkClauseOpen(true);
                    }}
                  >
                    <PlusIcon />
                    {t("clauses.linkClause")}
                  </MenuItem>
                </>
              )}
            </MenuSubPopup>
          </MenuSub>
        </MenuPopup>
      </Menu>
      {sessionTemplateId !== null && (
        <LinkClauseDialog
          onLinked={() => {
            queryClient
              .invalidateQueries({
                queryKey: knowledgeKeys.templates.clauses(
                  activeOrganizationId,
                  sessionTemplateId,
                ),
              })
              .catch(() => {
                /* fire-and-forget */
              });
          }}
          onOpenChange={setLinkClauseOpen}
          open={linkClauseOpen}
          reservedSlotNames={reservedSlotNames}
          templateId={sessionTemplateId}
        />
      )}
    </div>
  );
};

export const TemplateStudioRailIcon = (
  _props: InspectorRailIconProps<TemplateStudioPayload>,
) => <LayoutTemplateIcon size={SIDE_RAIL_TAB_ICON_SIZE_PX} />;

registerInspectorView<TemplateStudioPayload>({
  navigationPolicy: "close-on-route-leave",
  railIcon: TemplateStudioRailIcon,
  render: TemplateStudioInspectorView,
  type: TEMPLATE_STUDIO_VIEW,
  validate: (value): value is TemplateStudioPayload =>
    typeof value === "object" &&
    value !== null &&
    "templateId" in value &&
    typeof value.templateId === "string",
});

// ── Selection-scoped inspector ───────────────────────────

type InspectorProps = {
  selected: DirectiveRange | null;
  fields: StudioField[];
  outline: OutlineNode[];
  onFieldUpdate: (path: string, patch: Partial<StudioField>) => void;
  onFieldBack?: () => void;
};

export const Inspector = ({
  selected,
  fields,
  outline,
  onFieldUpdate,
  onFieldBack,
}: InspectorProps) => {
  if (selected && selected.kind === "placeholder") {
    const field =
      fields.find((f) => f.path === selected.expr) ??
      defaultStudioField(selected.expr);
    return (
      <FieldFace
        field={field}
        key={field.path}
        onBack={onFieldBack}
        onUpdate={(patch) => onFieldUpdate(field.path, patch)}
      />
    );
  }

  if (selected && (selected.kind === "if" || selected.kind === "elseif")) {
    return <ConditionFace fields={fields} selected={selected} />;
  }

  if (selected && selected.kind === "clause") {
    return <ClauseFace selected={selected} />;
  }

  if (selected && selected.kind === "each") {
    return <LoopFace key={selected.expr} selected={selected} />;
  }

  // Default: whole-template overview — the field/condition outline. Identity
  // (language) now lives in the tab header, the when-to-use guidance in its own
  // subtab, and the count summary in the footer above the insert row.
  return (
    <ScrollArea className="min-h-0 flex-1">
      <FieldNavigator fields={fields} outline={outline} />
    </ScrollArea>
  );
};

/** Subtle count strip pinned above the insert row on the template overview:
 *  fields · conditions · clauses. Conditions ARE the template's boolean
 *  fields, so they are derived rather than fetched. */
export const StudioOverviewSummary = ({
  fields,
  templateId,
}: {
  fields: StudioField[];
  templateId: string;
}) => {
  const t = useTranslations();
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const clausesOptions = templateClausesOptions(
    activeOrganizationId,
    templateId,
  );
  const { data: clausesData } = useQuery(clausesOptions);
  const links: LinkedClause[] =
    clausesData && "links" in clausesData ? clausesData.links : [];
  const outdated = links.filter((link) => link.isOutdated);
  const conditionCount = fields.filter((f) => f.inputType === "boolean").length;
  const summary = [
    t("templates.fieldCount", { count: fields.length }),
    t("templates.conditionCount", { count: conditionCount }),
    t("clauses.clauseCount", { count: links.length }),
  ].join(" · ");
  return (
    <div className="flex shrink-0 items-center gap-2 px-4 py-2">
      <p className="text-muted-foreground text-xs tabular-nums">{summary}</p>
      {outdated.length > 0 && (
        <ClauseDriftPopover
          outdated={outdated}
          queryKey={clausesOptions.queryKey}
          templateId={templateId}
        />
      )}
    </div>
  );
};

/** Quiet footer affordance surfacing linked clauses whose pinned version drifted
 *  behind their clause; lists them and offers a sync-all without restoring the
 *  removed standalone clauses tab. */
export const ClauseDriftPopover = ({
  outdated,
  templateId,
  queryKey,
}: {
  outdated: LinkedClause[];
  templateId: string;
  queryKey: readonly unknown[];
}) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const [syncingAll, setSyncingAll] = useState(false);

  const handleSyncAll = async () => {
    setSyncingAll(true);
    const response = await api
      .templates({ templateId: toSafeId<"template">(templateId) })
      .clauses.sync.post();
    setSyncingAll(false);

    if (response.error) {
      stellaToast.add({
        type: "error",
        title: t("clauses.syncFailed"),
        description: userErrorMessage(
          response.error,
          t("common.unexpectedError"),
        ),
      });
      return;
    }

    if ("syncedCount" in response.data) {
      stellaToast.add({
        type: "success",
        title: t("clauses.syncedAllResult", {
          count: response.data.syncedCount,
        }),
      });
    }
    detached(queryClient.invalidateQueries({ queryKey }), "handleSyncAll");
  };

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            className="text-warning-foreground h-auto gap-1 px-1.5 py-0.5 text-xs font-normal"
            size="xs"
            variant="ghost"
          >
            <AlertTriangleIcon className="size-3" />
            {t("clauses.needUpdate", { count: outdated.length })}
          </Button>
        }
      />
      <PopoverPopup className="w-72 p-3">
        <ul className="mb-2 flex flex-col gap-1">
          {outdated.map((link) => (
            <li className="truncate text-sm" dir="auto" key={link.id}>
              {link.clause?.title ?? t("clauses.clauseDeleted")}
            </li>
          ))}
        </ul>
        <Button
          className="w-full"
          disabled={syncingAll}
          onClick={() => {
            detached(handleSyncAll(), "ClauseDriftPopover");
          }}
          size="sm"
          variant="outline"
        >
          <RefreshCwIcon
            className={cn("size-3.5", syncingAll && "animate-spin")}
          />
          {t("clauses.syncAllOutdated")}
        </Button>
      </PopoverPopup>
    </Popover>
  );
};

/** "When to use" subtab: free-text guidance that steers agents (and humans)
 *  toward or away from this template. Its own tab because the guidance matters
 *  to agents picking a template, not just to the author drafting one. */
export const TemplateGuidanceFacet = ({
  templateId,
}: {
  templateId: string;
}) => {
  const t = useTranslations();
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const { data: detailData } = useQuery(
    templateDetailOptions(activeOrganizationId, templateId),
  );
  const detail =
    detailData && !(detailData instanceof Response) && "manifest" in detailData
      ? detailData
      : null;
  if (detail === null) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <p className="text-muted-foreground text-sm">{t("common.loading")}</p>
      </div>
    );
  }
  return (
    <GuidanceFields
      key={templateId}
      languages={detail.languages}
      organizationId={activeOrganizationId}
      templateId={templateId}
      whenNotToUse={detail.whenNotToUse ?? ""}
      whenToUse={detail.whenToUse ?? ""}
    />
  );
};

/** Both guidance notes, committed on blur via the template update endpoint
 *  (the same fields the list's guidance dialog writes). Keyed on templateId so
 *  switching templates resets the local drafts. */
export const GuidanceFields = ({
  organizationId,
  templateId,
  whenToUse,
  whenNotToUse,
  languages,
}: {
  organizationId: string;
  templateId: string;
  whenToUse: string;
  whenNotToUse: string;
  languages: string[];
}) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const [useText, setUseText] = useState(whenToUse);
  const [notText, setNotText] = useState(whenNotToUse);

  const commit = async () => {
    const nextUse = useText.trim() || null;
    const nextNot = notText.trim() || null;
    if (
      nextUse === (whenToUse.trim() || null) &&
      nextNot === (whenNotToUse.trim() || null)
    ) {
      return;
    }
    // The update endpoint replaces guidance wholesale, so send every field
    // explicitly — omitting languages would clear them.
    const response = await api.templates({ templateId }).post({
      whenToUse: nextUse,
      whenNotToUse: nextNot,
      languages,
    });
    if (response.error) {
      stellaToast.add({
        type: "error",
        title: t("templates.saveFailed"),
        description: userErrorMessage(
          response.error,
          t("common.unexpectedError"),
        ),
      });
      return;
    }
    await queryClient.invalidateQueries({
      queryKey: knowledgeKeys.templates.detail(organizationId, templateId),
    });
  };

  return (
    <div className="flex flex-col gap-4 p-4">
      <GuidanceNote
        label={t("templates.whenToUse")}
        onBlur={() => detached(commit(), "GuidanceFields")}
        onChange={setUseText}
        placeholder={t("templates.whenToUsePlaceholder")}
        value={useText}
      />
      <GuidanceNote
        label={t("templates.whenNotToUse")}
        onBlur={() => detached(commit(), "GuidanceFields")}
        onChange={setNotText}
        placeholder={t("templates.whenNotToUsePlaceholder")}
        value={notText}
      />
    </div>
  );
};

// The hard cap (matching templates/update.ts) is a generous safety net, not a
// content limit; the soft recommended length is what actually nudges — past it
// the live counter turns amber so notes stay concise for the agents reading
// them.
const GUIDANCE_MAX_LENGTH = 10_000;
const GUIDANCE_RECOMMENDED_LENGTH = 500;

/** One guidance note: label, a height-capped textarea that scrolls internally
 *  once it fills, and a live character count that warns past the soft limit. */
export const GuidanceNote = ({
  label,
  value,
  onChange,
  onBlur,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  onBlur: () => void;
  placeholder: string;
}) => {
  const format = useFormatter();
  const overRecommended = value.length > GUIDANCE_RECOMMENDED_LENGTH;
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-sm">{label}</Label>
      <Textarea
        aria-label={label}
        className="text-sm"
        maxLength={GUIDANCE_MAX_LENGTH}
        onBlur={onBlur}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{ maxHeight: "12rem" }}
        value={value}
      />
      <span
        className={cn(
          "self-end text-[11px] tabular-nums",
          overRecommended ? "text-warning" : "text-muted-foreground",
        )}
      >
        {format.number(value.length)}
      </span>
    </div>
  );
};

/** Language-chip text from the shared language list (endonym), with an
 *  Intl fallback localized to the UI language for tags outside the list. */
const languageChipLabel = (tag: string, uiLang: string): string =>
  displayLanguageName(tag, { displayLocale: uiLang });

/** A condition string that is exactly one field's bare name (the "is filled"
 *  / yes-no truthy check) maps back to that field, so the question input can
 *  prefill with its label for editing. */
