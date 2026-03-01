import { useCallback, useEffect, useState } from "react";
import { SearchIcon, TextQuoteIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stella/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stella/ui/components/dialog";
import { Input } from "@stella/ui/components/input";
import { toastManager } from "@stella/ui/components/toast";

import { api } from "@/lib/api";
import { userErrorMessage } from "@/lib/errors";

// ── Types ────────────────────────────────────────────

type CategoryItem = {
  id: string;
  name: string;
};

type ClauseItem = {
  id: string;
  title: string;
  categoryId: string | null;
  currentVersion: number;
};

type LinkClauseDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  templateId: string;
  onLinked: () => void;
};

// ── Component ────────────────────────────────────────

export const LinkClauseDialog = ({
  open,
  onOpenChange,
  templateId,
  onLinked,
}: LinkClauseDialogProps) => {
  const t = useTranslations();
  const [categories, setCategories] = useState<CategoryItem[]>([]);
  const [clauses, setClauses] = useState<ClauseItem[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string>("");
  const [search, setSearch] = useState("");
  const [selectedClauseId, setSelectedClauseId] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);

  // Load categories and clauses when dialog opens
  useEffect(() => {
    if (!open) {
      return;
    }

    const load = async () => {
      const [catRes, clauseRes] = await Promise.all([
        api["clause-categories"].get(),
        api.clauses.get({ query: { limit: 200 } }),
      ]);

      if (catRes.error) {
        toastManager.add({
          type: "error",
          title: t("clauses.loadFailed"),
          description: userErrorMessage(
            catRes.error,
            t("common.unexpectedError"),
          ),
        });
      } else if (!(catRes.data instanceof Response)) {
        setCategories(catRes.data.categories);
      }

      if (clauseRes.error) {
        toastManager.add({
          type: "error",
          title: t("clauses.loadFailed"),
          description: userErrorMessage(
            clauseRes.error,
            t("common.unexpectedError"),
          ),
        });
      } else if (!(clauseRes.data instanceof Response)) {
        setClauses(clauseRes.data.clauses);
      }
    };

    // biome-ignore lint/nursery/noFloatingPromises: fire-and-forget
    load();
  }, [open, t]);

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

    const response = await api.templates({ templateId }).clauses.put({
      clauseId: selectedClauseId,
    });

    setLinking(false);

    if (response.error) {
      toastManager.add({
        type: "error",
        title: t("clauses.linkFailed"),
        description: userErrorMessage(
          response.error,
          t("common.unexpectedError"),
        ),
      });
      return;
    }

    toastManager.add({
      type: "success",
      title: t("clauses.linked"),
    });

    setSelectedClauseId(null);
    setSearch("");
    onOpenChange(false);
    onLinked();
  }, [selectedClauseId, templateId, t, onOpenChange, onLinked]);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("clauses.linkClause")}</DialogTitle>
        </DialogHeader>
        <DialogPanel className="grid gap-4">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <SearchIcon className="absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
              <Input
                aria-label={t("clauses.searchClauses")}
                className="pl-8"
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
            {filtered.length === 0 && (
              <p className="p-4 text-center text-sm text-muted-foreground">
                {t("clauses.noResults")}
              </p>
            )}
            <ul className="divide-y">
              {filtered.map((clause) => (
                <li key={clause.id}>
                  <button
                    className={`flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm ${
                      selectedClauseId === clause.id
                        ? "bg-muted"
                        : "hover:bg-muted/50"
                    }`}
                    onClick={() => setSelectedClauseId(clause.id)}
                    type="button"
                  >
                    <TextQuoteIcon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {clause.title}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {t("clauses.version", {
                        version: String(clause.currentVersion),
                      })}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>
            {t("common.cancel")}
          </DialogClose>
          <Button disabled={linking || !selectedClauseId} onClick={handleLink}>
            {t("clauses.linkClause")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
};
