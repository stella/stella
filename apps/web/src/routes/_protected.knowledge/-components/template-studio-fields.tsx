import type { ReactNode } from "react";
import { useCallback, useMemo, useRef, useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangleIcon,
  ArrowLeftIcon,
  BookmarkPlusIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  LandmarkIcon,
  Loader2Icon,
  PencilIcon,
  PlusIcon,
  PlayIcon,
  RepeatIcon,
  RefreshCwIcon,
  SlashIcon,
  SplitIcon,
  SigmaIcon,
  TextQuoteIcon,
  Trash2Icon,
  UserIcon,
  WandSparklesIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import type { DirectiveRange } from "@stll/folio-react";
import { isClauseSlotName } from "@stll/template-conditions";
import { Button } from "@stll/ui/components/button";
import { Checkbox } from "@stll/ui/components/checkbox";
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/components/dialog";
import { DirectionalIcon } from "@stll/ui/components/directional-icon";
import { Input } from "@stll/ui/components/input";
import { Label } from "@stll/ui/components/label";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuTrigger,
} from "@stll/ui/components/menu";
import { ScrollArea } from "@stll/ui/components/scroll-area";
import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";

import { AIPromptInput } from "@/components/ai-prompt-input/ai-prompt-input";
import { FormulaEditor } from "@/components/conditions/formula-editor";
import Tooltip from "@/components/tooltip";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useFormatter } from "@/i18n/formatting-context";
import type { TranslationKey } from "@/i18n/types";
import { api } from "@/lib/api";
import { optionalArray } from "@/lib/arrays";
import { detached } from "@/lib/detached";
import { userErrorMessage } from "@/lib/errors/user-safe";
import { toSafeId } from "@/lib/safe-id";
import { inputTypeValueKind, VALUE_TYPE_META } from "@/lib/value-types";
import { LinkClauseDialog } from "@/routes/_protected.knowledge/-components/link-clause-dialog";
import type { LinkedClause } from "@/routes/_protected.knowledge/-components/template-clauses-tab";
import {
  OutdatedChanges,
  UnlinkButton,
} from "@/routes/_protected.knowledge/-components/template-clauses-tab";
import { createTemplateFieldMention } from "@/routes/_protected.knowledge/-components/template-field-mention-extension";
import { booleanFieldForExpr } from "@/routes/_protected.knowledge/-components/template-studio-condition-source";
import {
  ConditionBuilder,
  LoopBoundsInputs,
} from "@/routes/_protected.knowledge/-components/template-studio-conditions";
import { protectedRouteApi } from "@/routes/_protected.knowledge/-components/template-studio-constants";
import {
  buildRecipeDefinition,
  fieldHasLoopBounds,
  findEnclosingEachGroup,
  findEnclosingIfGroup,
  sanitizeFieldPath,
  type OutlineGroup,
} from "@/routes/_protected.knowledge/-components/template-studio-model";
import {
  dedupeOutlineFields,
  humanizeConditionExpr,
  outlineFieldPaths,
} from "@/routes/_protected.knowledge/-components/template-studio-outline";
import {
  useTemplateStudioStore,
  type OutlineNode,
  type StudioField,
} from "@/routes/_protected.knowledge/-components/template-studio-store";
import { FieldConfigEditor } from "@/routes/_protected.knowledge/-components/template-wizard";
import {
  knowledgeKeys,
  templateClausesOptions,
} from "@/routes/_protected.knowledge/-queries";

const effectiveSlotByLink = (
  pending: readonly { linkId: string; slotName: string }[],
): Map<string, string> => {
  const byLink = new Map<string, string>();
  for (const step of pending) {
    byLink.set(step.linkId, step.slotName);
  }
  return byLink;
};

export const ClauseFace = ({ selected }: { selected: DirectiveRange }) => {
  const t = useTranslations();
  const actions = useTemplateStudioStore((s) => s.actions);
  const templateId = useTemplateStudioStore((s) => s.templateId);
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const queryClient = useQueryClient();
  const [linkOpen, setLinkOpen] = useState(false);
  const clausesOptions = templateClausesOptions(
    activeOrganizationId,
    templateId ?? "",
  );
  const { data: linksData, status: linksStatus } = useQuery({
    ...clausesOptions,
    enabled: templateId !== null,
  });
  // Only "success" means the link set is known. While pending (including the
  // disabled state before templateId seeds) or errored, `link` stays undefined
  // for want of data, not because the slot is genuinely unlinked; a rename
  // must be held back rather than silently treated as unlinked.
  const linksReady = linksStatus === "success";
  const pendingSlotRenames = useTemplateStudioStore(
    (s) => s.pendingSlotRenames,
  );
  const setPendingSlotRename = useTemplateStudioStore(
    (s) => s.setPendingSlotRename,
  );
  const effectiveSlots = effectiveSlotByLink(pendingSlotRenames);
  // Every deferred-rename target is spoken for until the next save flushes the
  // log; reserve them so this face's "Link clause" dialog can't create a second
  // row for a name a pending rename (including this face's own) is about to take.
  // Reserve both sides of every pending step: targets are about to be
  // claimed, and sources (incl. mid-replay intermediates) stay claimed
  // server-side until the flush lands.
  const reservedSlotNames = pendingSlotRenames.flatMap((r) => [
    r.fromSlot,
    r.slotName,
  ]);
  // Match by the link's effective slot name (the LAST pending step for the
  // link, else the server record): a link with a pending (not-yet-flushed)
  // rename matches its NEW name, not the stale one still on the server, so the
  // face stays resolved to the same clause across a rename.
  const link =
    linksData && "links" in linksData
      ? linksData.links.find(
          (l) => (effectiveSlots.get(l.id) ?? l.slotName) === selected.expr,
        )
      : undefined;

  const invalidateLinks = () => {
    detached(
      queryClient.invalidateQueries({
        queryKey: clausesOptions.queryKey,
      }),
      "invalidateLinks",
    );
  };

  // Rename a clause slot. Rewrite the `{{@clause:...}}` document markers now
  // (this marks the session dirty). When a clause is linked, the link row
  // carries the slot name too, but that row rename is deferred to the save flow
  // (see handleSave): recording it as a pending rename keeps the document edit
  // and the row rename discardable together, so leaving without saving can never
  // orphan the link against the stored document's old slot name.
  const handleRename = (next: string): boolean => {
    const trimmed = next.trim();
    if (trimmed === selected.expr) {
      return true;
    }
    // Defensive: the editor is read-only until the links resolve, but never
    // rewrite the document while a linked-clause rename could go unrecorded.
    if (!linksReady) {
      return false;
    }
    if (!isClauseSlotName(trimmed)) {
      return false;
    }
    const renamed = actions?.renameClauseSlot(selected.expr, trimmed) ?? false;
    if (renamed && link !== undefined) {
      // selected.expr is the marker's current (effective) name — the name this
      // step renames away from, which stays claimed until the flush lands.
      setPendingSlotRename(link.id, trimmed, selected.expr);
    }
    return renamed;
  };

  return (
    <ScrollArea className="min-h-0 flex-1">
      <ScopeHeader
        onBack={() => actions?.deselect()}
        subtitle={selected.expr}
        title={t("templates.studio.scopeClause")}
      />
      <div className="flex flex-col gap-3 px-4 py-4">
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground text-xs font-medium">
            {t("clauses.slotName")}
          </span>
          <ClauseSlotEditor
            disabled={!linksReady}
            key={selected.expr}
            onRename={handleRename}
            slotName={selected.expr}
          />
        </div>
        <p className="text-muted-foreground text-xs leading-relaxed">
          {t("templates.studio.clauseSlotHelp")}
        </p>
        {linksReady && link === undefined && (
          <p className="text-muted-foreground text-xs">
            {t("clauses.noLinkedClauses")}
          </p>
        )}
        {link !== undefined && templateId !== null && (
          <LinkedClauseCard
            link={link}
            onChanged={invalidateLinks}
            templateId={templateId}
          />
        )}
        <Button onClick={() => setLinkOpen(true)} size="sm" variant="outline">
          {t("clauses.linkClause")}
        </Button>
      </div>
      {templateId === null ? null : (
        <LinkClauseDialog
          defaultSlotName={selected.expr}
          onLinked={invalidateLinks}
          onOpenChange={setLinkOpen}
          open={linkOpen}
          reservedSlotNames={reservedSlotNames}
          templateId={templateId}
        />
      )}
    </ScrollArea>
  );
};

/** Per-slot clause management inside the Studio inspector: the linked clause's
 *  pinned version, variant, outdated/sync affordance, change disclosure, and
 *  unlink. Reuses {@link OutdatedChanges} and {@link UnlinkButton} from the
 *  (now non-tab) clauses management surface. */
const LinkedClauseCard = ({
  link,
  templateId,
  onChanged,
}: {
  link: LinkedClause;
  templateId: string;
  onChanged: () => void;
}) => {
  const t = useTranslations();

  if (link.clause === null) {
    return (
      <div className="bg-destructive/5 flex items-start gap-2.5 rounded-md border p-2.5">
        <Trash2Icon className="text-destructive mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-destructive text-sm font-medium">
            {t("clauses.clauseDeletedTombstone")}
          </p>
          <UnlinkButton
            destructive
            linkId={link.id}
            onChanged={onChanged}
            templateId={templateId}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border p-2.5">
      <p className="text-sm font-medium" dir="auto">
        {link.clause.title}
      </p>
      <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
        {link.clauseVariant && <span>{link.clauseVariant.label}</span>}
        {link.variantDeleted && (
          <span className="text-warning-foreground flex items-center gap-1">
            <AlertTriangleIcon className="size-3" />
            {t("clauses.variantDeletedWithLabel", {
              label: link.clauseVariantLabel ?? "",
            })}
          </span>
        )}
        {link.clauseVersion && (
          <span>
            {t("common.versionLabel", {
              version: String(link.clauseVersion.version),
            })}
          </span>
        )}
        {link.isOutdated && (
          <span className="text-warning-foreground flex items-center gap-1">
            <AlertTriangleIcon className="size-3" />
            {t("clauses.outdatedVersion")}
          </span>
        )}
      </div>

      {link.isOutdated && link.clauseId && link.clauseVersion && (
        <OutdatedChanges
          clauseId={link.clauseId}
          versionId={link.clauseVersion.id}
        />
      )}

      <div className="flex items-center gap-1">
        {link.isOutdated && (
          <SlotSyncButton
            linkId={link.id}
            onChanged={onChanged}
            templateId={templateId}
          />
        )}
        <UnlinkButton
          linkId={link.id}
          onChanged={onChanged}
          templateId={templateId}
        />
      </div>
    </div>
  );
};

/** Syncs a single slot's link to its clause's latest version. The sync-all
 *  variant lives in {@link StudioOverviewSummary}'s drift popover. */
const SlotSyncButton = ({
  linkId,
  templateId,
  onChanged,
}: {
  linkId: string;
  templateId: string;
  onChanged: () => void;
}) => {
  const t = useTranslations();
  const [syncing, setSyncing] = useState(false);

  const handleSync = async () => {
    setSyncing(true);
    const response = await api
      .templates({ templateId: toSafeId<"template">(templateId) })
      .clauses({ linkId: toSafeId<"templateClause">(linkId) })
      .sync.post();
    setSyncing(false);

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

    stellaToast.add({ type: "success", title: t("clauses.synced") });
    onChanged();
  };

  return (
    <Button
      disabled={syncing}
      onClick={() => {
        detached(handleSync(), "SlotSyncButton");
      }}
      size="sm"
      variant="ghost"
    >
      <RefreshCwIcon className={cn("size-3.5", syncing && "animate-spin")} />
      {t("clauses.syncVersion")}
    </Button>
  );
};

/** Document outline: fields where they sit, condition/loop blocks as
 *  collapsible groups owning what's inside them, clause slots inline.
 *  Every row jumps the document caret to its marker. Yes/no fields are not
 *  listed here; they show under the Conditions disclosure as questions. */
export const FieldNavigator = ({
  fields,
  outline,
}: {
  fields: StudioField[];
  outline: OutlineNode[];
}) => {
  const t = useTranslations();
  const [showUnused, setShowUnused] = useState(false);
  // Fields registered in the session but with no marker in the document:
  // suggested but not placed. Tucked under a disclosure so the main list
  // shows only what is actually in the document.
  const placed = outlineFieldPaths(outline);
  // A loop-container record (carries `{{#each}}` repeat bounds, no marker of
  // its own) is loop config, not a fillable field, so it never shows in the
  // unplaced list even though its bare path is not "placed".
  const unplaced = fields.filter(
    (f) =>
      !placed.has(f.path) &&
      f.inputType !== "boolean" &&
      !fieldHasLoopBounds(f),
  );
  // A blank template (no fields, conditions, or clause slots) has an empty
  // outline and no fields, so show getting-started guidance instead of a bare
  // empty list. Conditions are boolean fields, so `fields.length` covers them;
  // clause slots and loops surface as outline nodes.
  if (fields.length === 0 && outline.length === 0) {
    return <StudioGettingStarted />;
  }
  return (
    <div className="px-4 py-3">
      <ul className="flex flex-col">
        {dedupeOutlineFields(outline).map((item) => (
          <OutlineRow
            count={item.count}
            fields={fields}
            key={item.node.from}
            node={item.node}
          />
        ))}
      </ul>
      {unplaced.length > 0 && (
        <div className="mt-1">
          <button
            aria-expanded={showUnused}
            className="hover:bg-muted text-muted-foreground flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-start text-xs font-medium"
            onClick={() => setShowUnused((visible) => !visible)}
            type="button"
          >
            {showUnused ? (
              <ChevronDownIcon className="size-3.5" />
            ) : (
              <DirectionalIcon className="size-3.5" icon={ChevronRightIcon} />
            )}
            {t("templates.unusedFields", { count: unplaced.length })}
          </button>
          {showUnused && (
            <ul className="flex flex-col">
              {unplaced.map((f) => (
                <OutlineRow
                  fields={fields}
                  key={`unplaced-${f.path}`}
                  node={{ type: "field", path: f.path, from: -1 }}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};

/** Shown in the overview when the template has no fields, conditions, or clause
 *  slots yet: three plain-language steps pointing at the selection popover, the
 *  `/` menu, and the Fill tab. Disappears as soon as the first marker exists. */
export const StudioGettingStarted = () => {
  const t = useTranslations();
  return (
    <div className="flex flex-col gap-3 px-4 py-4">
      <p className="text-muted-foreground text-xs font-medium">
        {t("templates.studio.gettingStartedTitle")}
      </p>
      <ol className="flex flex-col gap-2.5">
        <li className="flex items-start gap-2">
          <WandSparklesIcon className="text-muted-foreground mt-0.5 size-3.5 shrink-0" />
          <span className="text-muted-foreground text-xs leading-relaxed">
            {t("templates.studio.gettingStartedField")}
          </span>
        </li>
        <li className="flex items-start gap-2">
          <SlashIcon className="text-muted-foreground mt-0.5 size-3.5 shrink-0" />
          <span className="text-muted-foreground text-xs leading-relaxed">
            {t("templates.studio.gettingStartedSlash")}
          </span>
        </li>
        <li className="flex items-start gap-2">
          <PlayIcon className="text-muted-foreground mt-0.5 size-3.5 shrink-0" />
          <span className="text-muted-foreground text-xs leading-relaxed">
            {t("templates.studio.gettingStartedFill")}
          </span>
        </li>
      </ol>
    </div>
  );
};

/** The field row's hover "+" that inserts the field's marker at the document
 *  caret. A lookup field with more than one output format opens a menu so the
 *  author picks WHICH rendering (default `{{path}}` or keyed `{{path.key}}`);
 *  otherwise a single click inserts `{{path}}`. */
const InsertAtCaretButton = ({
  field,
  onInsert,
}: {
  field: StudioField;
  onInsert: (formatKey?: string) => void;
}) => {
  const t = useTranslations();
  const formats = optionalArray(field.lookup?.formats);
  const className =
    "absolute end-1.5 top-1/2 -translate-y-1/2 opacity-0 transition-opacity group-hover/row:opacity-100";
  if (formats.length <= 1) {
    return (
      <Button
        aria-label={t("templates.studio.insertAtCaret")}
        className={className}
        onClick={(e) => {
          e.stopPropagation();
          onInsert();
        }}
        size="icon-sm"
        title={t("templates.studio.insertAtCaret")}
        variant="outline"
      >
        <PlusIcon />
      </Button>
    );
  }
  return (
    <Menu>
      <MenuTrigger
        aria-label={t("templates.studio.insertAtCaret")}
        render={
          <Button
            className={className}
            onClick={(e) => e.stopPropagation()}
            size="icon-sm"
            title={t("templates.studio.insertAtCaret")}
            variant="outline"
          />
        }
      >
        <PlusIcon />
      </MenuTrigger>
      <MenuPopup align="end">
        {formats.map((format, index) => (
          <MenuItem
            key={`${format.key}-${String(index)}`}
            onClick={(e) => {
              e.stopPropagation();
              onInsert(index === 0 ? undefined : format.key);
            }}
          >
            {index === 0
              ? t("templates.studio.insertFormatDefault")
              : format.key}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
};

const OutlineRow = ({
  node,
  fields,
  count = 1,
}: {
  node: OutlineNode;
  fields: StudioField[];
  count?: number;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  const actions = useTemplateStudioStore((s) => s.actions);

  const jump = () => {
    if (node.from >= 0) {
      actions?.focusPosition(node.from);
    }
  };

  if (node.type === "field") {
    const field = fields.find((f) => f.path === node.path);
    // Yes/no fields live under the Conditions disclosure as questions.
    if (field !== undefined && field.inputType === "boolean") {
      return null;
    }
    const Icon =
      field === undefined
        ? VALUE_TYPE_META.text.icon
        : VALUE_TYPE_META[inputTypeValueKind(field.inputType)].icon;
    return (
      <li className="group/row relative">
        <Tooltip
          content={node.path}
          render={
            <button
              className="hover:bg-muted group flex w-full items-center gap-2.5 rounded-md px-2 py-2 pe-10 text-start text-sm"
              onClick={jump}
              type="button"
            />
          }
        >
          <span className="bg-muted text-muted-foreground flex size-7 shrink-0 items-center justify-center rounded-md">
            <Icon className="size-4" />
          </span>
          <FieldRowLabel label={field?.label ?? ""} path={node.path} />
          {field === undefined ? null : (
            <span className="text-muted-foreground ms-auto flex shrink-0 items-center gap-1.5">
              {count > 1 ? (
                <span className="text-muted-foreground text-[10px] tabular-nums">
                  {format.number(count)}×
                </span>
              ) : null}
              <FieldCapabilityIcons field={field} />
              <DirectionalIcon
                className="size-3.5 opacity-0 transition-opacity group-hover:opacity-100"
                icon={ChevronRightIcon}
              />
            </span>
          )}
        </Tooltip>
        {field === undefined ? null : (
          <InsertAtCaretButton
            field={field}
            onInsert={(formatKey) =>
              actions?.insertExistingField(node.path, formatKey)
            }
          />
        )}
      </li>
    );
  }

  if (node.type === "clause") {
    return (
      <li className="group/row relative">
        <Tooltip
          content={t("templates.studio.scopeClause")}
          render={
            <button
              className="hover:bg-muted flex w-full items-center gap-2.5 rounded-md px-2 py-2 pe-10 text-start text-sm"
              onClick={jump}
              type="button"
            />
          }
        >
          <span className="bg-muted text-muted-foreground flex size-7 shrink-0 items-center justify-center rounded-md">
            <TextQuoteIcon className="size-4" />
          </span>
          <span className="truncate" dir="auto">
            {node.name}
          </span>
        </Tooltip>
        <Button
          aria-label={t("templates.studio.insertAtCaret")}
          className="absolute end-1.5 top-1/2 -translate-y-1/2 opacity-0 transition-opacity group-hover/row:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            actions?.insertClauseSlot(node.name);
          }}
          size="icon-sm"
          title={t("templates.studio.insertAtCaret")}
          variant="outline"
        >
          <PlusIcon />
        </Button>
      </li>
    );
  }

  // A loop wrapping exactly one field IS that field, made repeatable: render
  // it as the field's row (opens the face) with a repeats badge, so the user
  // doesn't have to drill into the group to reach the only field inside.
  if (node.kind === "each") {
    const onlyChild = node.children.length === 1 ? node.children[0] : undefined;
    if (onlyChild !== undefined && onlyChild.type === "field") {
      const loopField = fields.find((f) => f.path === onlyChild.path);
      const LoopIcon =
        loopField === undefined
          ? VALUE_TYPE_META.text.icon
          : VALUE_TYPE_META[inputTypeValueKind(loopField.inputType)].icon;
      return (
        <li className="group/row relative">
          <Tooltip
            content={onlyChild.path}
            render={
              <button
                className="hover:bg-muted group flex w-full items-center gap-2.5 rounded-md px-2 py-2 pe-10 text-start text-sm"
                onClick={() => actions?.focusPosition(onlyChild.from)}
                type="button"
              />
            }
          >
            <span className="bg-muted text-muted-foreground flex size-7 shrink-0 items-center justify-center rounded-md">
              <LoopIcon className="size-4" />
            </span>
            <FieldRowLabel
              label={loopField?.label ?? ""}
              path={onlyChild.path}
            />
            <span className="text-muted-foreground ms-auto flex shrink-0 items-center gap-1.5">
              <RepeatIcon className="size-3.5" />
              {loopField === undefined ? null : (
                <FieldCapabilityIcons field={loopField} />
              )}
              <DirectionalIcon
                className="size-3.5 opacity-0 transition-opacity group-hover:opacity-100"
                icon={ChevronRightIcon}
              />
            </span>
          </Tooltip>
        </li>
      );
    }
  }

  return <OutlineGroupRow fields={fields} jump={jump} node={node} />;
};

/** A condition / loop block in the outline, rendered as a peer of field rows:
 *  a boxed icon slot (Split for if/elseif/else, Repeat for each) and a human
 *  reading of the opener as the label, with the raw expression kept in the
 *  row's title. Collapsible when it owns children. */
const OutlineGroupRow = ({
  node,
  fields,
  jump,
}: {
  node: OutlineGroup;
  fields: StudioField[];
  jump: () => void;
}) => {
  const t = useTranslations();
  const [open, setOpen] = useState(true);
  const GroupIcon = node.kind === "each" ? RepeatIcon : SplitIcon;
  const groupTitle =
    node.kind === "each"
      ? t("templates.studio.loop")
      : t("templates.studio.scopeCondition");
  const friendly = humanizeConditionExpr(node.expr, fields, (key) => t(key));
  let groupLabel: string;
  if (node.kind === "each") {
    groupLabel = t("templates.studio.repeats", { item: friendly });
  } else if (node.kind === "else") {
    groupLabel = t("templates.studio.otherwise");
  } else if (node.kind === "elseif") {
    groupLabel = t("templates.studio.otherwiseIf", { condition: friendly });
  } else {
    groupLabel = friendly;
  }
  const hasChildren = node.children.length > 0;
  // A condition that is a bare boolean field IS that field used as a gate, so
  // it carries the same required/repeatable affordances a field row shows.
  // Rule/AI conditions reference no single field, so they show no indicator.
  const conditionField =
    node.kind === "if" || node.kind === "elseif"
      ? booleanFieldForExpr(node.expr, fields)
      : undefined;
  return (
    <li className="group/row relative">
      {/* Expand control sits on the RIGHT so the leading icon lines up with
          field rows (which have no leading chevron). */}
      <div className="flex items-center">
        <Tooltip
          content={node.expr === "" ? groupTitle : node.expr}
          render={
            <button
              className="hover:bg-muted group flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 py-2 text-start text-sm"
              onClick={jump}
              type="button"
            />
          }
        >
          <span className="bg-muted text-muted-foreground flex size-7 shrink-0 items-center justify-center rounded-md">
            <GroupIcon className="size-4" />
          </span>
          <span className="truncate">{groupLabel}</span>
          {conditionField === undefined ? null : (
            <span className="text-muted-foreground ms-auto flex shrink-0 items-center gap-1.5">
              {fieldHasLoopBounds(conditionField) ? (
                <RepeatIcon className="size-3.5" />
              ) : null}
              <FieldCapabilityIcons field={conditionField} />
            </span>
          )}
        </Tooltip>
        {hasChildren ? (
          <button
            aria-expanded={open}
            aria-label={groupTitle}
            className="hover:bg-muted text-muted-foreground me-1 shrink-0 rounded p-0.5"
            onClick={() => setOpen((isOpen) => !isOpen)}
            type="button"
          >
            {open ? (
              <ChevronDownIcon className="size-3.5" />
            ) : (
              <DirectionalIcon className="size-3.5" icon={ChevronRightIcon} />
            )}
          </button>
        ) : null}
      </div>
      {hasChildren && open ? (
        <ul className="border-border ms-2 flex flex-col border-s ps-2">
          {dedupeOutlineFields(node.children).map((item) => (
            <OutlineRow
              count={item.count}
              fields={fields}
              key={item.node.from}
              node={item.node}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
};

/** Row text for an outline/question entry: the label leads; the mono path is
 *  secondary (revealed on hover next to it). A field without a label shows
 *  its path once instead, with a quiet pencil hinting that clicking through
 *  leads to rename. */
const FieldRowLabel = ({ label, path }: { label: string; path: string }) => {
  if (label === "") {
    return (
      <>
        <code className="truncate">{path}</code>
        <PencilIcon className="text-muted-foreground size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
      </>
    );
  }
  return (
    <>
      <span className="text-foreground min-w-0 truncate font-medium">
        {label}
      </span>
      {/* The field code only enters the layout on hover, so the label gets
          the full width and truncates solely when the code is actually
          shown — not pre-shrunk to reserve space for a hidden element. */}
      <code className="text-muted-foreground hidden min-w-0 truncate text-[10px] group-hover:block">
        {path}
      </code>
    </>
  );
};

/** Same-scope fields a formula at `currentPath` may use as operands: number
 *  inputs (any order) and EARLIER formula fields (computed before this one in
 *  manifest order). Later formula fields and non-numeric text/date fields are
 *  excluded — the evaluator NaNs on those. An empty result means a formula
 *  here would have nothing to reference, so the source is not offered. */
const formulaOperandFields = (
  fields: readonly StudioField[],
  outline: OutlineNode[],
  currentPath: string,
): StudioField[] => {
  const currentIndex = fields.findIndex((f) => f.path === currentPath);
  const scopeOf = (path: string): string | null =>
    findEnclosingEachGroup(outline, path, null)?.expr.trim() || null;
  const currentScope = scopeOf(currentPath);
  // Cheap predicates first; `scopeOf` walks the outline tree, so only run it
  // for fields that are already candidate operands.
  return fields.filter(
    (f, index) =>
      f.path !== currentPath &&
      (f.inputType === "number" || f.formula !== undefined) &&
      !(f.formula !== undefined && index >= currentIndex) &&
      scopeOf(f.path) === currentScope,
  );
};

/** The name a field at `path` is referenced by inside a formula scoped at
 *  `currentPath`: inside a `{{#each}}` the fill engine evaluates against the
 *  row object, so same-row fields are named by their row-relative path (the
 *  loop-container prefix stripped); at top level the full manifest path is
 *  used. */
const formulaRefName = (
  outline: OutlineNode[],
  currentPath: string,
  path: string,
): string => {
  const scopeOf = (p: string): string | null =>
    findEnclosingEachGroup(outline, p, null)?.expr.trim() || null;
  const currentScope = scopeOf(currentPath);
  return currentScope !== null && path.startsWith(`${currentScope}.`)
    ? path.slice(currentScope.length + 1)
    : path;
};

/** The in-scope numeric operands for a formula at `currentPath`, projected onto
 *  the `{ path, label }` shape the shared FormulaEditor consumes. `path` is the
 *  reference name the expression uses (row-relative inside a loop). */
const formulaOperandRefFields = (
  fields: readonly StudioField[],
  outline: OutlineNode[],
  currentPath: string,
): { path: string; label: string }[] =>
  formulaOperandFields(fields, outline, currentPath).map((f) => ({
    path: formulaRefName(outline, currentPath, f.path),
    label: f.label,
  }));

/** Every in-scope field a formula at `currentPath` may name, numeric or not, in
 *  the `{ path, label }` shape — so the editor can tell a non-number reference
 *  (a known field used where only numbers work) from an unknown one. */
const formulaInScopeRefFields = (
  fields: readonly StudioField[],
  outline: OutlineNode[],
  currentPath: string,
): { path: string; label: string }[] => {
  const scopeOf = (path: string): string | null =>
    findEnclosingEachGroup(outline, path, null)?.expr.trim() || null;
  const currentScope = scopeOf(currentPath);
  const result: { path: string; label: string }[] = [];
  for (const f of fields) {
    if (f.path !== currentPath && scopeOf(f.path) === currentScope) {
      result.push({
        path: formulaRefName(outline, currentPath, f.path),
        label: f.label,
      });
    }
  }
  return result;
};

/** Mini-icons marking what a field can do: registry lookup, AI involvement,
 *  formula derivation, and a quiet dot for required. */
const FieldCapabilityIcons = ({ field }: { field: StudioField }) => {
  const t = useTranslations();
  return (
    <>
      {field.lookup === undefined ? null : <LandmarkIcon className="size-3" />}
      {field.aiAdapt ? (
        <span className="flex items-center gap-0.5">
          <UserIcon className="size-3" />
          <WandSparklesIcon className="size-3" />
        </span>
      ) : null}
      {!field.aiAdapt && field.aiPrompt !== undefined ? (
        <WandSparklesIcon className="size-3" />
      ) : null}
      {field.formula === undefined ? null : <SigmaIcon className="size-3" />}
      {field.required ? (
        <Tooltip
          content={t("common.required")}
          render={
            <span className="flex size-3.5 items-center justify-center" />
          }
        >
          <span aria-hidden="true" className="size-1 rounded-full bg-current" />
        </Tooltip>
      ) : null}
    </>
  );
};

const ScopeHeader = ({
  title,
  subtitle,
  action,
  onBack,
}: {
  title?: string;
  subtitle?: ReactNode;
  /** Right-aligned control (e.g. the field face's suggest wand). */
  action?: ReactNode;
  /** Renders a leading back arrow returning to the template overview. */
  onBack?: () => void;
}) => {
  const t = useTranslations();
  return (
    <div className="flex min-h-12 items-center justify-between gap-2 border-b px-3 py-2">
      {onBack === undefined ? null : (
        <Button
          aria-label={t("common.goBack")}
          className="-ms-1.5 shrink-0 self-start"
          onClick={onBack}
          size="icon-sm"
          variant="ghost"
        >
          <DirectionalIcon icon={ArrowLeftIcon} />
        </Button>
      )}
      <div className="min-w-0 flex-1">
        {title === undefined ? null : (
          <p className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
            {title}
          </p>
        )}
        {subtitle === undefined ? null : (
          <div className="min-w-0 overflow-hidden text-sm">{subtitle}</div>
        )}
      </div>
      {action === undefined ? null : (
        <div className="shrink-0 self-start">{action}</div>
      )}
    </div>
  );
};

/** Why the Repeatable switch is locked; `TranslationKey` keeps the stored
 *  keys honest against the message catalogue. */
type RepeatDisabledKey = TranslationKey &
  (
    | "templates.studio.repeatableLoopHasOtherContent"
    | "templates.studio.repeatableNested"
  );

/** What the Repeatable toggle can show for a field: hidden for object
 *  subfields (e.g. `tenant.name`) and unplaced fields, otherwise on/off
 *  with an optional reason the switch is locked. */
type FieldRepeatState =
  | { kind: "hidden" }
  | { kind: "off" | "on"; disabledKey: RepeatDisabledKey | null };

const fieldRepeatState = (
  field: StudioField,
  outline: OutlineNode[],
): FieldRepeatState => {
  const group = findEnclosingEachGroup(outline, field.path, null);
  if (group !== null) {
    const loopPath = group.expr.trim();
    if (loopPath !== "" && field.path.startsWith(`${loopPath}.`)) {
      // The loop's own item field: ON; unwrapping is only offered while the
      // loop body holds nothing but this field's markers.
      const exclusive = group.children.every(
        (child) => child.type === "field" && child.path === field.path,
      );
      return {
        kind: "on",
        disabledKey: exclusive
          ? null
          : "templates.studio.repeatableLoopHasOtherContent",
      };
    }
    // A constant field inside someone else's loop; wrapping again would
    // nest loops the fill form cannot ask about.
    return { kind: "off", disabledKey: "templates.studio.repeatableNested" };
  }
  if (field.path.includes(".") || !outlineFieldPaths(outline).has(field.path)) {
    return { kind: "hidden" };
  }
  return { kind: "off", disabledKey: null };
};

/** Whether this field's marker is already wrapped in an `{{#if}}` block, and
 *  the block's live expression. `canRemove` mirrors the Repeatable guard: the
 *  un-wrap is only offered while the branch holds nothing but this field's
 *  marker (otherwise removing the `if` would expose the block's other
 *  content unconditionally). */
type FieldConditionState =
  | { kind: "none" }
  | { kind: "conditional"; expr: string; canRemove: boolean };

const fieldConditionState = (
  field: StudioField,
  outline: OutlineNode[],
): FieldConditionState => {
  const group = findEnclosingIfGroup(outline, field.path, null);
  if (group === null) {
    return { kind: "none" };
  }
  const canRemove = group.children.every(
    (child) => child.type === "field" && child.path === field.path,
  );
  return { kind: "conditional", expr: group.expr, canRemove };
};

/** "Show only if…" section of the field face (secondary, below the value
 *  controls): conditions the field's own marker without leaving the face.
 *  Not conditional yet → a ghost affordance that inline-wraps the marker in
 *  `{{#if condition}}…{{/if}}` and reveals the shared condition builder so the
 *  author sets the expression at once. Already conditional → the current
 *  reading plus the same builder to edit it, and a Remove action that unwraps
 *  the block (disabled when the block holds more than this field). */
const FieldConditionSection = ({
  field,
  fields,
  condition,
}: {
  field: StudioField;
  fields: StudioField[];
  condition: FieldConditionState;
}) => {
  const t = useTranslations();
  const actions = useTemplateStudioStore((s) => s.actions);
  const rewrite = (next: string) =>
    actions?.rewriteFieldConditionExpr(field.path, next) ?? false;

  if (condition.kind === "none") {
    return (
      <div className="flex flex-col gap-1.5 border-t px-4 py-3">
        <Button
          className="self-start"
          onClick={() => {
            if (actions?.wrapFieldInCondition(field.path) !== true) {
              stellaToast.add({
                type: "error",
                title: t("errors.actionFailed"),
              });
            }
          }}
          size="sm"
          variant="outline"
        >
          <SplitIcon className="size-3.5" />
          {t("templates.studio.showOnlyIf")}
        </Button>
        <p className="text-muted-foreground text-xs leading-relaxed">
          {t("templates.studio.showOnlyIfHelp")}
        </p>
      </div>
    );
  }

  const friendly = humanizeConditionExpr(condition.expr, fields, (key) =>
    t(key),
  );
  return (
    <div className="flex flex-col gap-3 border-t px-4 py-4">
      <div className="flex flex-col gap-1">
        <Label className="text-sm">{t("templates.studio.showOnlyWhen")}</Label>
        <p className="text-foreground text-sm">{friendly}</p>
      </div>
      <ConditionBuilder
        expr={condition.expr}
        fields={fields}
        fromKey={`${field.path}:${condition.expr}`}
        onRewrite={rewrite}
      />
      <Button
        className="text-muted-foreground self-start"
        disabled={!condition.canRemove}
        onClick={() => {
          if (actions?.unwrapFieldCondition(field.path) !== true) {
            stellaToast.add({ type: "error", title: t("errors.actionFailed") });
          }
        }}
        size="sm"
        title={
          condition.canRemove
            ? undefined
            : t("templates.studio.removeConditionBlocked")
        }
        variant="ghost"
      >
        <Trash2Icon className="size-3.5" />
        {t("templates.studio.removeCondition")}
      </Button>
    </div>
  );
};

/**
 * Field settings face: leads with what the field IS (a blank in the fill
 * form), lets the model propose a configuration, and previews the actual fill
 * control so every setting shows its consequence.
 */
// Survives the FieldFace remount the repeatable toggle triggers (the field
// re-paths, so its key changes): captured before the toggle and restored onto
// the fresh ScrollArea viewport so the panel stays scrolled where it was.
let pendingFieldFaceScrollTop: number | null = null;

export const FieldFace = ({
  field,
  onUpdate,
  onBack,
}: {
  field: StudioField;
  onUpdate: (patch: Partial<StudioField>) => void;
  onBack?: (() => void) | undefined;
}) => {
  const t = useTranslations();
  const actions = useTemplateStudioStore((s) => s.actions);
  const fields = useTemplateStudioStore((s) => s.fields);
  const fieldCount = fields.length;
  const outline = useTemplateStudioStore((s) => s.outline);

  // `@`-mention source for the AI-instruction inputs: every other field's
  // path/label, so an author can reference a sibling field. The mention node
  // serializes back to `{{path}}` in the stored `aiPrompt` string.
  const fieldMention = useMemo(() => {
    const mentionFields: { id: string; label: string }[] = [];
    for (const f of fields) {
      if (f.path !== field.path) {
        mentionFields.push({ id: f.path, label: f.label || f.path });
      }
    }
    return createTemplateFieldMention(mentionFields);
  }, [fields, field.path]);
  const [recipeDialogOpen, setRecipeDialogOpen] = useState(false);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  // Restore the captured scroll position when the remounted viewport mounts.
  const setViewport = useCallback((el: HTMLDivElement | null) => {
    viewportRef.current = el;
    if (el !== null && pendingFieldFaceScrollTop !== null) {
      el.scrollTop = pendingFieldFaceScrollTop;
      pendingFieldFaceScrollTop = null;
    }
  }, []);

  // Clear the in-document preview when the face leaves or switches fields
  // (cancelling any pending lookup preview so it cannot re-set it).
  useExternalSyncEffect(
    () => () => {
      useTemplateStudioStore.getState().actions?.setFillPreview(null);
    },
    [field.path],
  );

  const repeat = fieldRepeatState(field, outline);
  // The loop-container path that carries this loop's repeat bounds: the
  // enclosing `{{#each <path>}}` group's array path (which equals `<base>` for
  // a single-field repeatable, where the item field is `<base>.value`).
  const enclosingEach = findEnclosingEachGroup(outline, field.path, null);
  const loopContainerPath =
    enclosingEach === null ? null : enclosingEach.expr.trim() || null;
  const condition = fieldConditionState(field, outline);
  const fieldIsPlaced = outlineFieldPaths(outline).has(field.path);
  const toggleRepeatable = (next: boolean) => {
    // Keep the panel scrolled where it is across the re-path remount.
    pendingFieldFaceScrollTop = viewportRef.current?.scrollTop ?? null;
    const applied = actions?.setFieldRepeatable(field.path, next) ?? false;
    if (!applied) {
      pendingFieldFaceScrollTop = null;
      stellaToast.add({ type: "error", title: t("errors.actionFailed") });
    }
  };

  // The four value sources are mutually exclusive (the manifest validator
  // rejects combinations), so each picker button clears the other three.
  let valueSource: ValueSource = "person";
  if (field.formula !== undefined) {
    valueSource = "formula";
  } else if (field.aiAdapt) {
    valueSource = "textAi";
  } else if (field.aiPrompt !== undefined) {
    valueSource = "ai";
  }

  // A formula needs at least one same-scope number (or earlier formula) field
  // to reference; with none, the source is offered nothing to compute over, so
  // the picker stays disabled. An already-formula field keeps it enabled so the
  // author is never trapped on a value source they cannot leave.
  const canUseFormula =
    valueSource === "formula" ||
    formulaOperandFields(fields, outline, field.path).length > 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ScrollArea className="min-h-0 flex-1" viewportRef={setViewport}>
        <ScopeHeader
          action={
            <div className="flex items-center gap-0.5">
              <Button
                aria-label={t("common.previous")}
                disabled={fieldCount < 2}
                onClick={() => actions?.focusAdjacentField(-1)}
                size="icon-sm"
                variant="ghost"
              >
                <DirectionalIcon icon={ChevronLeftIcon} />
              </Button>
              <Button
                aria-label={t("common.next")}
                disabled={fieldCount < 2}
                onClick={() => actions?.focusAdjacentField(1)}
                size="icon-sm"
                variant="ghost"
              >
                <DirectionalIcon icon={ChevronRightIcon} />
              </Button>
              <Button
                aria-label={t("common.delete")}
                onClick={() => actions?.deleteField(field.path)}
                size="icon-sm"
                title={t("common.delete")}
                variant="ghost"
              >
                <Trash2Icon className="text-muted-foreground" />
              </Button>
              <Button
                aria-label={t("templates.studio.saveAsRecipe")}
                onClick={() => setRecipeDialogOpen(true)}
                size="icon-sm"
                title={t("templates.studio.saveAsRecipe")}
                variant="ghost"
              >
                <BookmarkPlusIcon />
              </Button>
            </div>
          }
          onBack={onBack ?? (() => actions?.deselect())}
          subtitle={
            <FieldPathEditor
              key={field.path}
              onRename={(next) => {
                if (!actions) {
                  return false;
                }
                const safe = sanitizeFieldPath(next);
                const renamed = actions.renameFieldPath(field.path, safe);
                // A human-looking name doubles as the label while none is
                // set: typing "Name of lawyer" yields path name_of_lawyer
                // and that label in one go.
                if (renamed && field.label === "" && next.trim() !== safe) {
                  onUpdate({ label: next.trim() });
                }
                return renamed;
              }}
              path={field.path}
            />
          }
        />
        <div className="flex flex-col gap-2 border-t px-4 py-4">
          <Label className="text-sm">{t("templates.studio.whoFills")}</Label>
          <div className="grid grid-cols-2 gap-1.5">
            <Button
              className="justify-start"
              onClick={() =>
                onUpdate({
                  aiPrompt: undefined,
                  aiAdapt: false,
                  aiSeesDocument: false,
                  formula: undefined,
                })
              }
              size="sm"
              variant={valueSource === "person" ? "default" : "outline"}
            >
              <UserIcon className="size-3.5" />
              {t("templates.studio.filledByPerson")}
            </Button>
            <Button
              className="justify-start"
              onClick={() =>
                onUpdate({
                  aiAdapt: true,
                  aiSeesDocument: false,
                  formula: undefined,
                })
              }
              size="sm"
              variant={valueSource === "textAi" ? "default" : "outline"}
            >
              <WandSparklesIcon className="size-3.5" />
              {t("templates.studio.textPlusAi")}
            </Button>
            <Button
              className="justify-start"
              onClick={() =>
                onUpdate({
                  aiPrompt: field.aiPrompt ?? "",
                  aiAdapt: false,
                  formula: undefined,
                })
              }
              size="sm"
              variant={valueSource === "ai" ? "default" : "outline"}
            >
              <WandSparklesIcon className="size-3.5" />
              {t("templates.studio.draftedByAi")}
            </Button>
            {/* A disabled button gets `pointer-events-none`, which suppresses
                its native title tooltip; the wrapper keeps pointer events so
                the "why disabled" hint still shows. */}
            <span
              title={
                canUseFormula
                  ? undefined
                  : t("templates.studio.formulaNoFields")
              }
            >
              <Button
                className="w-full justify-start"
                disabled={!canUseFormula}
                onClick={() =>
                  onUpdate({
                    formula: field.formula ?? "",
                    aiPrompt: undefined,
                    aiAdapt: false,
                    aiSeesDocument: false,
                    lookup: undefined,
                  })
                }
                size="sm"
                variant={valueSource === "formula" ? "default" : "outline"}
              >
                <SigmaIcon className="size-3.5" />
                {t("common.formula")}
              </Button>
            </span>
          </div>
          {valueSource === "textAi" ? (
            <>
              <p className="text-muted-foreground text-xs leading-relaxed">
                {t("templates.aiAdaptHint")}
              </p>
              <AIPromptInput
                className="bg-muted/40 focus-within:ring-ring/40 rounded-md border px-2.5 py-2 focus-within:ring-1"
                mentionExtension={fieldMention}
                onChange={(value) => onUpdate({ aiPrompt: value || undefined })}
                placeholder={t(
                  "templates.studio.aiAdaptInstructionPlaceholder",
                )}
                value={field.aiPrompt ?? ""}
                valueFormat="text"
                variant="minimal"
              />
            </>
          ) : null}
          {valueSource === "ai" ? (
            <>
              <AIPromptInput
                className="bg-muted/40 focus-within:ring-ring/40 rounded-md border px-2.5 py-2 focus-within:ring-1"
                mentionExtension={fieldMention}
                onChange={(value) => onUpdate({ aiPrompt: value })}
                placeholder={t("templates.studio.aiPromptPlaceholder")}
                value={field.aiPrompt ?? ""}
                valueFormat="text"
                variant="minimal"
              />
              <p className="text-muted-foreground text-xs leading-relaxed">
                {t("templates.studio.aiPromptContextHint")}
              </p>
              <label className="text-muted-foreground flex w-fit cursor-pointer items-center gap-1.5 text-xs">
                <Checkbox
                  checked={field.aiSeesDocument}
                  onCheckedChange={(checked) =>
                    onUpdate({ aiSeesDocument: checked })
                  }
                />
                {t("templates.studio.aiSeesDocument")}
              </label>
            </>
          ) : null}
          {valueSource === "formula" ? (
            <FormulaEditor
              knownFields={formulaInScopeRefFields(fields, outline, field.path)}
              numberFields={formulaOperandRefFields(
                fields,
                outline,
                field.path,
              )}
              onChange={(formula) => onUpdate({ formula })}
              value={field.formula ?? ""}
            />
          ) : null}
          {valueSource === "person" || valueSource === "textAi" ? (
            <label className="text-muted-foreground flex w-fit cursor-pointer items-center gap-1.5 text-xs">
              <Checkbox
                checked={field.required}
                onCheckedChange={(checked) => onUpdate({ required: checked })}
              />
              {t("common.required")}
              <span aria-hidden className="text-destructive">
                *
              </span>
            </label>
          ) : null}
        </div>
        <FieldConfigEditor
          embedded
          field={field}
          hideFormulaControl
          hideHint={valueSource === "ai"}
          hideRequired
          hideSourceControl={loopContainerPath !== null}
          onUpdate={onUpdate}
        />
        {field.lookup !== undefined && field.lookup.formats.length > 0 ? (
          <div className="flex flex-col gap-1.5 border-t px-4 py-4">
            <Label className="text-sm">
              {t("templates.studio.insertOutput")}
            </Label>
            {field.lookup.formats.map((format, index) => (
              <Button
                className="justify-between gap-2"
                key={format.key}
                onClick={() =>
                  actions?.insertExistingField(
                    field.path,
                    index === 0 ? undefined : format.key,
                  )
                }
                size="sm"
                variant="outline"
              >
                <span className="flex items-center gap-2">
                  <PlusIcon className="size-3.5" />
                  {index === 0
                    ? t("templates.studio.insertFormatDefault")
                    : format.key}
                </span>
                <code className="text-muted-foreground text-[10px]">
                  {index === 0
                    ? `{{${field.path}}}`
                    : `{{${field.path}.${format.key}}}`}
                </code>
              </Button>
            ))}
          </div>
        ) : null}
        {repeat.kind === "hidden" || valueSource === "formula" ? null : (
          <div className="flex flex-col gap-1.5 border-t px-4 py-3">
            <Button
              aria-pressed={repeat.kind === "on"}
              className="self-start"
              disabled={repeat.disabledKey !== null}
              onClick={() => toggleRepeatable(repeat.kind !== "on")}
              size="sm"
              title={
                repeat.disabledKey === null ? undefined : t(repeat.disabledKey)
              }
              variant={repeat.kind === "on" ? "secondary" : "outline"}
            >
              <RepeatIcon className="size-3.5" />
              {t("templates.studio.repeatable")}
            </Button>
            <p className="text-muted-foreground text-xs leading-relaxed">
              {t("templates.studio.repeatableHelp")}
            </p>
            {repeat.kind === "on" && loopContainerPath !== null && (
              <LoopBoundsInputs containerPath={loopContainerPath} />
            )}
          </div>
        )}
        {fieldIsPlaced ? (
          <FieldConditionSection
            condition={condition}
            field={field}
            fields={fields}
          />
        ) : null}
      </ScrollArea>
      <SaveRecipeDialog
        fieldPath={field.path}
        onOpenChange={setRecipeDialogOpen}
        open={recipeDialogOpen}
      />
    </div>
  );
};

/** The four mutually exclusive ways a field's value is produced at fill time. */
type ValueSource = "person" | "textAi" | "ai" | "formula";

/**
 * Save the field's configuration as an org-wide recipe, insertable into any
 * template. When the field's marker sits inside a `{{#each}}` block, the
 * whole block is the recipe: the loop path plus every field used inside it.
 */
const SaveRecipeDialog = ({
  fieldPath,
  open,
  onOpenChange,
}: {
  fieldPath: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const outline = useTemplateStudioStore((s) => s.outline);
  const fields = useTemplateStudioStore((s) => s.fields);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  const definition = buildRecipeDefinition(fieldPath, outline, fields);

  const save = async () => {
    const trimmed = name.trim();
    if (trimmed === "") {
      return;
    }
    setSaving(true);
    const response = await api["template-recipes"].put({
      name: trimmed,
      definition,
    });
    setSaving(false);
    if (response.error) {
      stellaToast.add({
        type: "error",
        title: t("templates.studio.recipeSaveFailed"),
      });
      return;
    }
    stellaToast.add({
      type: "success",
      title: t("templates.studio.recipeSaved"),
    });
    detached(
      queryClient.invalidateQueries({
        queryKey: knowledgeKeys.templateRecipes.all(activeOrganizationId),
      }),
      "save",
    );
    setName("");
    onOpenChange(false);
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogPopup className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("templates.studio.saveAsRecipe")}</DialogTitle>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-3">
          <div className="text-muted-foreground flex items-center gap-2 text-xs">
            {definition.loop === undefined ? null : (
              <span className="flex items-center gap-1">
                <RepeatIcon className="size-3.5 shrink-0" />
                <code>{definition.loop.path}</code>
              </span>
            )}
            <span>
              {t("templates.fieldCount", { count: definition.fields.length })}
            </span>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="recipe-name">{t("common.name")}</Label>
            <Input
              autoFocus
              id="recipe-name"
              onChange={(e) => setName(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  detached(save(), "SaveRecipeDialog");
                }
              }}
              value={name}
            />
          </div>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>
            {t("common.cancel")}
          </DialogClose>
          <Button
            disabled={name.trim() === "" || saving}
            onClick={() => detached(save(), "SaveRecipeDialog")}
          >
            {saving ? (
              <Loader2Icon className="animate-spin" />
            ) : (
              <BookmarkPlusIcon />
            )}
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
};

/** Click-to-edit clause slot name: rewrites the `{{@clause:name}}` markers in
 *  the document. When a clause is linked, `onRename` also records a deferred
 *  rename of the stored `slotName` link row, flushed on the next template save
 *  (see {@link ClauseFace}); it returns `false` only when the new name is
 *  rejected as invalid. */
const ClauseSlotEditor = ({
  slotName,
  onRename,
  disabled = false,
}: {
  slotName: string;
  onRename: (next: string) => boolean | Promise<boolean>;
  /** Read-only while the link query is still resolving: a rename in that window
   *  cannot know whether the slot is linked, so it would rewrite the document
   *  without recording the deferred link-row rename (see {@link ClauseFace}). */
  disabled?: boolean;
}) => {
  const t = useTranslations();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(slotName);

  if (disabled) {
    // Non-interactive presentation: same slot-name display, no edit affordance.
    return (
      <div className="text-muted-foreground -ms-1 flex w-full min-w-0 items-center gap-1.5 px-1 py-0.5">
        <code className="truncate text-xs" dir="auto" title={slotName}>
          {slotName}
        </code>
      </div>
    );
  }

  const commit = async () => {
    if (value.trim() === slotName) {
      setEditing(false);
      return;
    }
    if (await onRename(value)) {
      setEditing(false);
      return;
    }
    stellaToast.add({
      type: "error",
      title: t("clauses.renameSlotInvalid"),
    });
  };

  if (!editing) {
    return (
      <Tooltip
        content={t("clauses.renameSlot")}
        render={
          <button
            className="hover:bg-muted/60 group text-muted-foreground -ms-1 flex w-full min-w-0 items-center gap-1.5 rounded px-1 py-0.5"
            onClick={() => setEditing(true)}
            type="button"
          />
        }
      >
        <code className="truncate text-xs" dir="auto" title={slotName}>
          {slotName}
        </code>
        <PencilIcon className="size-3 opacity-0 transition-opacity group-hover:opacity-100" />
      </Tooltip>
    );
  }
  return (
    <Input
      autoFocus
      className="h-7 font-mono text-xs"
      onBlur={() => detached(commit(), "ClauseSlotEditor")}
      onChange={(e) => setValue(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          detached(commit(), "ClauseSlotEditor");
        }
        if (e.key === "Escape") {
          setValue(slotName);
          setEditing(false);
        }
      }}
      value={value}
    />
  );
};

/** Click-to-edit field path: renames the {{markers}} in the document. */
const FieldPathEditor = ({
  path,
  onRename,
}: {
  path: string;
  onRename: (next: string) => boolean;
}) => {
  const t = useTranslations();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(path);

  const commit = () => {
    if (value.trim() === path) {
      setEditing(false);
      return;
    }
    if (onRename(value)) {
      setEditing(false);
      return;
    }
    stellaToast.add({
      type: "error",
      title: t("templates.studio.renameFieldInvalid"),
    });
  };

  if (!editing) {
    return (
      <Tooltip
        content={t("templates.studio.renameField")}
        render={
          <button
            className="hover:bg-muted/60 group text-muted-foreground -ms-1 flex w-full min-w-0 items-center gap-1.5 rounded px-1 py-0.5"
            onClick={() => setEditing(true)}
            type="button"
          />
        }
      >
        <code className="truncate text-xs" title={path}>
          {path}
        </code>
        <PencilIcon className="size-3 opacity-0 transition-opacity group-hover:opacity-100" />
      </Tooltip>
    );
  }
  return (
    <Input
      autoFocus
      className="h-7 font-mono text-xs"
      onBlur={commit}
      onChange={(e) => setValue(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          commit();
        }
        if (e.key === "Escape") {
          setValue(path);
          setEditing(false);
        }
      }}
      value={value}
    />
  );
};
