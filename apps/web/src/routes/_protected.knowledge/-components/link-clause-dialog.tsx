import { useEffect, useState } from "react";

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
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/components/select";
import { stellaToast } from "@stll/ui/components/toast";

import { api } from "@/lib/api";
import { toAPIError, userErrorMessage } from "@/lib/errors";
import type { SafeId } from "@/lib/safe-id";
import { toSafeId } from "@/lib/safe-id";
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
  // null = not yet initialized; the effect below preselects the first
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
  const takenSlots = new Set(
    linksData && "links" in linksData
      ? linksData.links.flatMap((link) =>
          link.slotName === null ? [] : [link.slotName],
        )
      : [],
  );

  useEffect(() => {
    if (!open) {
      setSlotValue(null);
      setCustomSlotName("");
      return;
    }
    if (slotValue !== null || previewData === undefined) {
      return;
    }
    const slots = "clauseSlots" in previewData ? previewData.clauseSlots : [];
    const taken = new Set(
      linksData && "links" in linksData
        ? linksData.links.flatMap((link) =>
            link.slotName === null ? [] : [link.slotName],
          )
        : [],
    );
    const firstUnfilled = slots.find((slot) => !taken.has(slot));
    setSlotValue(
      firstUnfilled === undefined
        ? SLOT_VALUE_NONE
        : SLOT_VALUE_PREFIX + firstUnfilled,
    );
  }, [open, slotValue, previewData, linksData]);

  const categories =
    catData && "categories" in catData ? catData.categories : [];
  const clauses = clauseData && "items" in clauseData ? clauseData.items : [];

  // Variants of the currently selected clause, offered at link time.
  const { data: variantsResult } = useQuery({
    queryKey: ["clause-variants", selectedClauseId],
    queryFn: async () => {
      if (!selectedClauseId) {
        return { variants: [] };
      }
      const response = await api
        .clauses({ clauseId: toSafeId<"clause">(selectedClauseId) })
        .variants.get();
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

  // No useCallback: React Compiler handles memoization, and the
  // closure depends on half the dialog state anyway.
  const handleLink = async () => {
    if (!selectedClauseId) {
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
                <option key={cat.id} value={cat.id}>
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
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {clause.title}
                    </span>
                    <span className="text-muted-foreground shrink-0 text-xs">
                      {t("clauses.version", {
                        version: String(clause.currentVersion),
                      })}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>

          {selectedClauseId && variants.length > 0 && (
            <div>
              <label
                className="mb-1 block text-sm font-medium"
                htmlFor="variant-select"
              >
                {t("clauses.variant")}
              </label>
              <select
                className="flex h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm"
                id="variant-select"
                onChange={(e) => setSelectedVariantId(e.target.value || null)}
                value={selectedVariantId ?? ""}
              >
                <option value="">{t("clauses.variantDefault")}</option>
                {variants.map((variant) => (
                  <option key={variant.id} value={variant.id}>
                    {variant.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="grid gap-1">
            <span className="text-sm font-medium">{t("clauses.slotName")}</span>
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
              <Input
                aria-label={t("clauses.slotName")}
                onChange={(e) => setCustomSlotName(e.target.value)}
                placeholder={t("clauses.slotNamePlaceholder")}
                value={customSlotName}
              />
            )}
          </div>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>
            {t("common.cancel")}
          </DialogClose>
          <Button
            disabled={linking || !selectedClauseId}
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
