import type { ReactNode } from "react";

import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { CheckIcon, ListFilterIcon } from "@stll/ui/icons";
import { Popover, PopoverPopup, PopoverTrigger } from "@stll/ui/popover";
import { cn } from "@stll/ui/utils";

import type { TranslationKey } from "@/i18n/types";

const SEARCH_SCOPE = {
  all: "all",
  matters: "matters",
  caseLaw: "case-law",
  registries: "registries",
} as const;

export const SEARCH_SCOPES = Object.values(SEARCH_SCOPE);

export type SearchScope = (typeof SEARCH_SCOPE)[keyof typeof SEARCH_SCOPE];

const SCOPE_LABELS = {
  all: "common.all",
  matters: "common.matters",
  "case-law": "common.caseLaw",
  registries: "search.scopeRegistries",
} as const satisfies Record<SearchScope, TranslationKey>;

const SCOPE_PLACEHOLDERS = {
  all: "search.scopePlaceholderAll",
  matters: "search.scopePlaceholderMatters",
  "case-law": "search.scopePlaceholderCaseLaw",
  registries: "search.scopePlaceholderRegistries",
} as const satisfies Record<SearchScope, TranslationKey>;

type SearchScopeFilterProps = {
  scope: SearchScope;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (scope: SearchScope) => void;
  visible: boolean;
  caseLawEnabled: boolean;
};

export const SearchScopeFilter = ({
  scope,
  open,
  onOpenChange,
  onChange,
  visible,
  caseLawEnabled,
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
            className="size-11 shrink-0"
          />
        }
      >
        <ListFilterIcon className="size-4" />
      </PopoverTrigger>
      <PopoverPopup
        layer="search-child"
        align="end"
        className="w-56"
        padding="xs"
      >
        {SEARCH_SCOPES.filter(
          (value) => value !== "case-law" || caseLawEnabled,
        ).map((value) => (
          <Button
            key={value}
            variant="ghost"
            className="min-h-11 w-full justify-start gap-2"
            aria-pressed={scope === value}
            onClick={() => {
              onChange(value);
              onOpenChange(false);
            }}
          >
            <CheckIcon
              aria-hidden="true"
              className={cn("size-4", scope !== value && "invisible")}
            />
            {t(SCOPE_LABELS[value])}
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
                // An inline word in the placeholder sentence; on a touch
                // screen the button's own 44px target makes it reachable.
                <Button
                  className="pointer-events-auto"
                  onClick={onOpenFilter}
                  size="inline"
                >
                  {chunks}
                </Button>
              ),
            })}
          </span>
        </div>
      )}
    </div>
  );
};
