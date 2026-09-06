import type { ReactNode } from "react";

import { CheckIcon, ListFilterIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "@stll/ui/popover";
import { cn } from "@stll/ui/utils";

import type { TranslationKey } from "@/i18n/types";

export type SearchScope = "all" | "matters" | "registries";

const SCOPE_LABELS = {
  all: "common.all",
  matters: "common.matters",
  registries: "search.scopeRegistries",
} as const satisfies Record<SearchScope, TranslationKey>;

const SCOPE_PLACEHOLDERS = {
  all: "search.scopePlaceholderAll",
  matters: "search.scopePlaceholderMatters",
  registries: "search.scopePlaceholderRegistries",
} as const satisfies Record<SearchScope, TranslationKey>;

type SearchScopeFilterProps = {
  scope: SearchScope;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (scope: SearchScope) => void;
  visible: boolean;
};

export const SearchScopeFilter = ({
  scope,
  open,
  onOpenChange,
  onChange,
  visible,
}: SearchScopeFilterProps) => {
  const t = useTranslations();
  if (!visible) {
    return null;
  }
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={
          <Button
            aria-label={t("search.scopeFilter")}
            title={t("search.scopeFilter")}
            size="icon-sm"
            variant={scope === "all" ? "ghost" : "secondary"}
            className="size-8 shrink-0"
          />
        }
      >
        <ListFilterIcon className="size-4" />
      </PopoverTrigger>
      <PopoverPopup layer="search-child" align="end" className="w-56 p-1">
        {Object.entries(SCOPE_LABELS).map(([value, label]) => (
          <Button
            key={value}
            variant="ghost"
            className="min-h-11 w-full justify-start gap-2"
            aria-pressed={scope === value}
            onClick={() => {
              if (
                value !== "all" &&
                value !== "matters" &&
                value !== "registries"
              ) {
                return;
              }
              onChange(value);
              onOpenChange(false);
            }}
          >
            <CheckIcon
              aria-hidden="true"
              className={cn("size-4", scope !== value && "invisible")}
            />
            {t(label)}
          </Button>
        ))}
      </PopoverPopup>
    </Popover>
  );
};

type SearchScopeInputProps = {
  children: ReactNode;
  scope: SearchScope;
  showPrompt: boolean;
  onOpenFilter: () => void;
};

export const SearchScopeInput = ({
  children,
  scope,
  showPrompt,
  onOpenFilter,
}: SearchScopeInputProps) => {
  const t = useTranslations();
  return (
    <div className="relative min-w-0 flex-1">
      {children}
      {showPrompt && (
        <div className="text-muted-foreground pointer-events-none absolute inset-y-0 start-8 end-0 flex items-center overflow-hidden text-sm whitespace-nowrap">
          <span>
            {t.rich(SCOPE_PLACEHOLDERS[scope], {
              scope: (chunks) => (
                <button
                  type="button"
                  className="hover:text-foreground pointer-events-auto underline underline-offset-4 focus-visible:outline-2"
                  onClick={onOpenFilter}
                >
                  {chunks}
                </button>
              ),
            })}
          </span>
        </div>
      )}
    </div>
  );
};
