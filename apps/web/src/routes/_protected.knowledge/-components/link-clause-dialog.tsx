import { useCallback, useState } from "react";

import { useQuery } from "@tanstack/react-query";
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
import { stellaToast } from "@stll/ui/components/toast";

import { api } from "@/lib/api";
import { userErrorMessage } from "@/lib/errors";
import type { SafeId } from "@/lib/safe-id";
import { toSafeId } from "@/lib/safe-id";
import {
  clauseCategoriesOptions,
  clausesOptions,
} from "@/routes/_protected.knowledge/-queries";

// ── Types ────────────────────────────────────────────

type LinkClauseDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  templateId: string;
  /** Available slot names from the template preview. */
  availableSlots?: string[] | undefined;
  onLinked: () => void;
};

// ── Component ────────────────────────────────────────

export const LinkClauseDialog = ({
  open,
  onOpenChange,
  templateId,
  availableSlots,
  onLinked,
}: LinkClauseDialogProps) => {
  const t = useTranslations();
  const [selectedCategory, setSelectedCategory] = useState("");
  const [search, setSearch] = useState("");
  const [selectedClauseId, setSelectedClauseId] = useState<string | null>(null);
  const [slotName, setSlotName] = useState("");
  const [linking, setLinking] = useState(false);

  const { data: catData } = useQuery({
    ...clauseCategoriesOptions(),
    enabled: open,
  });
  const {
    data: clauseData,
    isLoading: clausesLoading,
    isError: clausesError,
  } = useQuery({
    ...clausesOptions({ limit: 200 }),
    enabled: open,
  });

  const categories =
    catData && "categories" in catData ? catData.categories : [];
  const clauses =
    clauseData && "clauses" in clauseData ? clauseData.clauses : [];

  const filtered = clauses.filter((c) => {
    if (selectedCategory && c.categoryId !== selectedCategory) {
      return false;
    }
    if (search && !c.title.toLowerCase().includes(search.toLowerCase())) {
      return false;
    }
    return true;
  });

  const handleLink = useCallback(async () => {
    if (!selectedClauseId) {
      return;
    }

    setLinking(true);

    const body: {
      clauseId: SafeId<"clause">;
      slotName?: string;
    } = { clauseId: toSafeId<"clause">(selectedClauseId) };
    if (slotName.trim()) {
      body.slotName = slotName.trim();
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
    setSearch("");
    setSlotName("");
    onOpenChange(false);
    onLinked();
  }, [selectedClauseId, slotName, templateId, t, onOpenChange, onLinked]);

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
                    onClick={() => setSelectedClauseId(clause.id)}
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

          <div>
            <label
              className="mb-1 block text-sm font-medium"
              htmlFor="slot-name-input"
            >
              {t("clauses.slotName")}
            </label>
            <Input
              id="slot-name-input"
              list="available-slots"
              onChange={(e) => setSlotName(e.target.value)}
              placeholder={t("clauses.slotNamePlaceholder")}
              value={slotName}
            />
            {availableSlots && availableSlots.length > 0 && (
              <datalist id="available-slots">
                {availableSlots.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
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
