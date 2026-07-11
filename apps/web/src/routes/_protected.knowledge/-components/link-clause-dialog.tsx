import type { ComponentProps } from "react";
import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { SearchIcon, TextQuoteIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/components/dialog";
import { Input } from "@stll/ui/components/input";
import {
  MenuPreviewLayout,
  PreviewPane,
} from "@stll/ui/components/preview-pane";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/components/select";
import { stellaToast } from "@stll/ui/components/toast";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors/api";
import { userErrorMessage } from "@/lib/errors/user-safe";
import type { SafeId } from "@/lib/safe-id";
import { toSafeId } from "@/lib/safe-id";
import { ClauseBody } from "@/routes/_protected.knowledge/-components/clause-body";
import {
  clauseCategoriesOptions,
  clausesOptions,
  templateClausesOptions,
  templatePreviewOptions,
} from "@/routes/_protected.knowledge/-queries";

// ── Types ────────────────────────────────────────────

type LinkClauseDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  templateId: string;
  onLinked: () => void;
  /** Preselect this slot (e.g. opened from the slot's inspector face). */
  defaultSlotName?: string | undefined;
  /** Slot names already claimed by a not-yet-saved (deferred) link-row rename.
   *  The server still records the old name, so these slots look free in the
   *  links query; treat them as taken so a second link row can't be created
   *  for a name a pending rename is about to occupy. */
  reservedSlotNames: readonly string[];
};

// Select values for the slot picker. Discovered slot names are
// prefixed so the "none"/"custom" sentinels can never collide with
// a real slot that happens to carry one of those names.
const SLOT_VALUE_NONE = "none";
const SLOT_VALUE_CUSTOM = "custom";
const SLOT_VALUE_PREFIX = "slot:";

// ── Component ────────────────────────────────────────

const protectedRouteApi = getRouteApi("/_protected");

export const LinkClauseDialog = ({
  open,
  onOpenChange,
  templateId,
  onLinked,
  defaultSlotName,
  reservedSlotNames,
}: LinkClauseDialogProps) => {
  const t = useTranslations();
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const [selectedCategory, setSelectedCategory] = useState("");
  const [search, setSearch] = useState("");
  const [selectedClauseId, setSelectedClauseId] = useState<string | null>(null);
  const [selectedVariantId, setSelectedVariantId] = useState<string | null>(
    null,
  );
  // Variant whose body the preview pane shows while its option is highlighted;
  // null renders the pane empty (and is the "Standard (no variant)" row).
  const [previewVariantId, setPreviewVariantId] = useState<string | null>(null);
  // null = not yet initialized; the state machine below preselects the first
  // unfilled discovered slot once the template preview loads.
  const [slotValue, setSlotValue] = useState<string | null>(null);
  const [customSlotName, setCustomSlotName] = useState("");
  const [linking, setLinking] = useState(false);

  const { data: catData } = useQuery({
    ...clauseCategoriesOptions(activeOrganizationId),
    enabled: open,
  });
  const {
    data: clauseData,
    isLoading: clausesLoading,
    isError: clausesError,
  } = useQuery({
    ...clausesOptions(activeOrganizationId, { limit: 200 }),
    enabled: open,
  });

  // Slots discovered in the template document ({{@clause:...}}
  // markers) and slots already taken by existing links.
  const { data: previewData } = useQuery({
    ...templatePreviewOptions(activeOrganizationId, templateId),
    enabled: open,
  });
  const { data: linksData } = useQuery({
    ...templateClausesOptions(activeOrganizationId, templateId),
    enabled: open,
  });

  const discoveredSlots =
    previewData && "clauseSlots" in previewData ? previewData.clauseSlots : [];
  // A slot is unavailable if a saved link already carries it OR a deferred
  // rename is about to claim it. Both read the same to the author (the slot is
  // spoken for), so they share the "already linked" presentation and block a
  // second link row for the same name.
  const takenSlots = new Set([
    ...(linksData && "links" in linksData
      ? linksData.links.flatMap((link) =>
          link.slotName === null ? [] : [link.slotName],
        )
      : []),
    ...reservedSlotNames,
  ]);

  const [lastOpen, setLastOpen] = useState(open);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (!open) {
      setSlotValue(null);
      setCustomSlotName("");
    }
  }

  // Until the user owns the slot draft, initialize it from the explicit
  // default or from the first async-discovered unclaimed slot. Once non-null,
  // query refetches cannot overwrite the user's selection.
  if (open && slotValue === null) {
    const reserved = new Set(reservedSlotNames);
    if (defaultSlotName !== undefined && !reserved.has(defaultSlotName)) {
      setSlotValue(SLOT_VALUE_PREFIX + defaultSlotName);
    } else if (previewData !== undefined) {
      const firstUnfilled = discoveredSlots.find(
        (slot) => !takenSlots.has(slot),
      );
      setSlotValue(
        firstUnfilled === undefined
          ? SLOT_VALUE_NONE
          : SLOT_VALUE_PREFIX + firstUnfilled,
      );
    }
  }

  const categories =
    catData && "categories" in catData ? catData.categories : [];
  const clauses = clauseData && "items" in clauseData ? clauseData.items : [];

  // Variants of the currently selected clause, offered at link time.
  const { data: variantsResult } = useQuery({
    queryKey: ["clause-variants", selectedClauseId],
    queryFn: async ({ signal }) => {
      if (!selectedClauseId) {
        return { variants: [] };
      }
      const response = await api
        .clauses({ clauseId: toSafeId<"clause">(selectedClauseId) })
        .variants.get({ fetch: { signal } });
      if (response.error) {
        throw toAPIError(response.error);
      }
      if (response.data instanceof Response) {
        throw new TypeError("Unexpected response shape");
      }
      return response.data;
    },
    enabled: open && selectedClauseId !== null,
  });
  const variants =
    variantsResult && "variants" in variantsResult
      ? variantsResult.variants
      : [];
  const previewVariant = variants.find((v) => v.id === previewVariantId);

  const filtered = clauses.filter((c) => {
    if (selectedCategory && c.categoryId !== selectedCategory) {
      return false;
    }
    if (search && !c.title.toLowerCase().includes(search.toLowerCase())) {
      return false;
    }
    return true;
  });

  const resolveSlotName = (): string | undefined => {
    if (slotValue === SLOT_VALUE_CUSTOM) {
      const trimmed = customSlotName.trim();
      return trimmed === "" ? undefined : trimmed;
    }
    if (slotValue !== null && slotValue.startsWith(SLOT_VALUE_PREFIX)) {
      return slotValue.slice(SLOT_VALUE_PREFIX.length);
    }
    return undefined;
  };

  // Whether the chosen slot name is already spoken for (a saved link or a
  // deferred rename). Discovered options are disabled, but a preselected
  // default or a hand-typed custom name can still resolve to a taken slot.
  const resolvedSlotName = resolveSlotName();
  const slotUnavailable =
    resolvedSlotName !== undefined && takenSlots.has(resolvedSlotName);

  // No useCallback: React Compiler handles memoization, and the
  // closure depends on half the dialog state anyway.
  const handleLink = async () => {
    if (!selectedClauseId || slotUnavailable) {
      return;
    }

    setLinking(true);

    const body: {
      clauseId: SafeId<"clause">;
      variantId?: SafeId<"clauseVariant">;
      slotName?: string;
    } = { clauseId: toSafeId<"clause">(selectedClauseId) };
    if (selectedVariantId) {
      body.variantId = toSafeId<"clauseVariant">(selectedVariantId);
    }
    const slotName = resolveSlotName();
    if (slotName !== undefined) {
      body.slotName = slotName;
    }

    const response = await api
      .templates({ templateId: toSafeId<"template">(templateId) })
      .clauses.put(body);

    setLinking(false);

    if (response.error) {
      stellaToast.add({
        type: "error",
        title: t("clauses.linkFailed"),
        description: userErrorMessage(
          response.error,
          t("common.unexpectedError"),
        ),
      });
      return;
    }

    stellaToast.add({
      type: "success",
      title: t("clauses.linked"),
    });

    setSelectedClauseId(null);
    setSelectedVariantId(null);
    setSearch("");
    onOpenChange(false);
    onLinked();
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("clauses.linkClause")}</DialogTitle>
        </DialogHeader>
        <DialogPanel className="grid gap-4">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <SearchIcon className="text-muted-foreground absolute start-2.5 top-2.5 size-4" />
              <Input
                aria-label={t("clauses.searchClauses")}
                className="ps-8"
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("clauses.searchClauses")}
                value={search}
              />
            </div>
            <select
              className="flex h-9 rounded-md border bg-transparent px-3 py-1 text-sm"
              onChange={(e) => setSelectedCategory(e.target.value)}
              value={selectedCategory}
            >
              <option value="">{t("clauses.allClauses")}</option>
              {categories.map((cat) => (
                <option dir="auto" key={cat.id} value={cat.id}>
                  {cat.name}
                </option>
              ))}
            </select>
          </div>

          <div className="max-h-64 overflow-y-auto rounded-lg border">
            {clausesLoading && (
              <p className="text-muted-foreground p-4 text-center text-sm">
                {t("clauses.loading")}
              </p>
            )}
            {clausesError && (
              <p className="text-muted-foreground p-4 text-center text-sm">
                {t("clauses.loadFailed")}
              </p>
            )}
            {!clausesLoading && !clausesError && filtered.length === 0 && (
              <p className="text-muted-foreground p-4 text-center text-sm">
                {t("clauses.noResults")}
              </p>
            )}
            <ul className="divide-y">
              {filtered.map((clause) => (
                <li key={clause.id}>
                  <button
                    className={`flex w-full items-center gap-3 px-4 py-2.5 text-start text-sm ${
                      selectedClauseId === clause.id
                        ? "bg-muted"
                        : "hover:bg-muted/50"
                    }`}
                    onClick={() => {
                      setSelectedClauseId(clause.id);
                      setSelectedVariantId(null);
                    }}
                    type="button"
                  >
                    <TextQuoteIcon className="text-muted-foreground size-4 shrink-0" />
                    <span
                      className="min-w-0 flex-1 truncate font-medium"
                      dir="auto"
                    >
                      {clause.title}
                    </span>
                    <span className="text-muted-foreground shrink-0 text-xs">
                      {t("common.versionLabel", {
                        version: String(clause.currentVersion),
                      })}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>

          {selectedClauseId && variants.length > 0 && (
            <div className="grid gap-1">
              <span className="text-sm font-medium">
                {t("clauses.variant")}
              </span>
              <Select
                onValueChange={(value: string | null) =>
                  setSelectedVariantId(
                    value === null || value === "" ? null : value,
                  )
                }
                value={selectedVariantId ?? ""}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={t("clauses.variantDefault")} />
                </SelectTrigger>
                <SelectPopup>
                  <MenuPreviewLayout
                    preview={
                      <PreviewPane>
                        {previewVariantId !== null && (
                          <VariantBodyPreview
                            body={previewVariant ? previewVariant.body : []}
                          />
                        )}
                      </PreviewPane>
                    }
                  >
                    <SelectItem
                      onFocus={() => setPreviewVariantId(null)}
                      onMouseEnter={() => setPreviewVariantId(null)}
                      value=""
                    >
                      {t("clauses.variantDefault")}
                    </SelectItem>
                    {variants.map((variant) => (
                      <SelectItem
                        key={variant.id}
                        onFocus={() => setPreviewVariantId(variant.id)}
                        onMouseEnter={() => setPreviewVariantId(variant.id)}
                        value={variant.id}
                      >
                        {variant.label}
                      </SelectItem>
                    ))}
                  </MenuPreviewLayout>
                </SelectPopup>
              </Select>
            </div>
          )}

          <div className="grid gap-1">
            <span className="text-sm font-medium">{t("clauses.slotName")}</span>
            <p className="text-muted-foreground text-xs">
              {t("clauses.slotHelp")}
            </p>
            <Select
              onValueChange={(value: string | null) =>
                setSlotValue(value ?? SLOT_VALUE_NONE)
              }
              value={slotValue ?? SLOT_VALUE_NONE}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder={t("clauses.slotNone")} />
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value={SLOT_VALUE_NONE}>
                  {t("clauses.slotNone")}
                </SelectItem>
                {discoveredSlots.map((slot) => {
                  const isTaken = takenSlots.has(slot);
                  return (
                    <SelectItem
                      disabled={isTaken}
                      key={slot}
                      value={SLOT_VALUE_PREFIX + slot}
                    >
                      {isTaken ? t("clauses.slotTaken", { slot }) : slot}
                    </SelectItem>
                  );
                })}
                <SelectItem value={SLOT_VALUE_CUSTOM}>
                  {t("clauses.slotCustom")}
                </SelectItem>
              </SelectPopup>
            </Select>
            {slotValue === SLOT_VALUE_CUSTOM && (
              <>
                <Input
                  aria-label={t("clauses.slotName")}
                  onChange={(e) => setCustomSlotName(e.target.value)}
                  placeholder={t("clauses.slotNamePlaceholder")}
                  value={customSlotName}
                />
                {/* slotUnavailable is an aliased condition, so its truth
                    already narrows resolvedSlotName to string here. */}
                {slotUnavailable && (
                  <p className="text-destructive text-xs">
                    {t("clauses.slotTaken", { slot: resolvedSlotName })}
                  </p>
                )}
              </>
            )}
          </div>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>
            {t("common.cancel")}
          </DialogClose>
          <Button
            disabled={linking || !selectedClauseId || slotUnavailable}
            onClick={() => {
              void handleLink();
            }}
          >
            {t("clauses.linkClause")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
};

// ── Variant preview ──────────────────────────────────

type ClauseBodyParagraphs = ComponentProps<typeof ClauseBody>["paragraphs"];

/** The highlighted variant's actual body text, scaled down to fit the pane;
 *  the same ClauseBody renderer the clause detail uses, so what the author
 *  previews is exactly what links. */
const VariantBodyPreview = ({ body }: { body: ClauseBodyParagraphs }) => {
  if (body.length === 0) {
    return null;
  }
  return (
    <div className="h-[133%] w-[133%] origin-top-left scale-75 text-xs [&_p]:text-xs">
      <ClauseBody paragraphs={body} />
    </div>
  );
};
