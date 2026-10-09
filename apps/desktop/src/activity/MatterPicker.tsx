import { useEffect, useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { useTranslations } from "use-intl";

import type {
  DesktopMatter,
  DesktopTimeEntryMatterCandidate,
} from "@stll/api-contract/desktop-time-entries";
import { Button } from "@stll/ui/button";
import { MatterIcon } from "@stll/ui/matter-icon";
import { Popover, PopoverPopup, PopoverTrigger } from "@stll/ui/popover";
import { ScrollArea } from "@stll/ui/scroll-area";
import { SearchField } from "@stll/ui/search-field";

export const MatterPicker = ({
  candidates,
  onChoose,
  label,
  disabled = false,
}: {
  candidates: readonly DesktopTimeEntryMatterCandidate[];
  onChoose: (matter: DesktopMatter) => void;
  label: string;
  disabled?: boolean;
}) => {
  const t = useTranslations("activity");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<
    | { type: "idle" }
    | { type: "failed"; query: string }
    | { type: "ready"; query: string; matters: DesktopMatter[] }
  >({ type: "idle" });
  useEffect(() => {
    if (disabled || !open || !query.trim()) {
      return;
    }
    let disposed = false;
    const timer = setTimeout(() => {
      invoke<DesktopMatter[]>("time_entry_search_matters", { query })
        .then((matters) => {
          if (!disposed) {
            setSearch({ type: "ready", query, matters });
          }
          return undefined;
        })
        .catch(() => {
          if (!disposed) {
            setSearch({ type: "failed", query });
          }
          return undefined;
        });
    }, 250);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [query, open, disabled]);
  const searching =
    query.trim().length > 0 &&
    (search.type === "idle" || search.query !== query);
  const failed = search.type === "failed" && search.query === query;
  let matters: readonly DesktopMatter[] = candidates;
  if (query.trim()) {
    matters =
      search.type === "ready" && search.query === query ? search.matters : [];
  }
  return (
    <Popover
      open={open}
      onOpenChange={(value) => {
        if (!disabled || !value) {
          setOpen(value);
        }
      }}
    >
      <PopoverTrigger
        render={<Button size="sm" variant="outline" disabled={disabled} />}
      >
        {label}
      </PopoverTrigger>
      <PopoverPopup className="w-80" side="bottom" align="start">
        <SearchField
          aria-label={t("searchMatters")}
          clearLabel={t("clearMatterSearch")}
          onValueChange={setQuery}
          disabled={disabled}
          value={query}
          placeholder={t("searchMatters")}
        />
        {failed ? (
          <p role="alert" className="text-destructive text-xs">
            {t("errorMatterSearch")}
          </p>
        ) : null}
        {searching ? (
          <p role="status" className="text-muted-foreground text-xs">
            {t("searchingMatters")}
          </p>
        ) : null}
        <ScrollArea className="max-h-64">
          <div className="flex flex-col">
            {matters.map((matter) => (
              <Button
                className="justify-start"
                disabled={disabled}
                variant="ghost"
                size="row"
                key={matter.id}
                onClick={() => {
                  onChoose(matter);
                  setOpen(false);
                }}
              >
                <MatterIcon matter={matter} className="size-4" />
                <bdi className="min-w-0 truncate">{matter.name}</bdi>
                <span className="text-muted-foreground text-xs">
                  {matter.reference}
                </span>
              </Button>
            ))}
            {!searching && matters.length === 0 ? (
              <p className="text-muted-foreground py-2 text-xs">
                {t("noMatters")}
              </p>
            ) : null}
          </div>
        </ScrollArea>
      </PopoverPopup>
    </Popover>
  );
};
