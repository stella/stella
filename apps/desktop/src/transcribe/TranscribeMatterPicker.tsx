import { useEffect, useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { useTranslations } from "use-intl";

import type { DesktopMatter } from "@stll/api-contract/desktop-time-entries";
import { Button } from "@stll/ui/button";
import { ChevronDownIcon } from "@stll/ui/icons";
import { MatterIcon } from "@stll/ui/matter-icon";
import { Popover, PopoverPopup, PopoverTrigger } from "@stll/ui/popover";
import { ScrollArea } from "@stll/ui/scroll-area";
import { SearchField } from "@stll/ui/search-field";
import { TruncatedText } from "@stll/ui/truncated-text";

const SEARCH_DELAY_MS = 250;

type Search =
  | { type: "idle" }
  | { type: "failed"; query: string }
  | { type: "ready"; query: string; matters: DesktopMatter[] };

/** The matter a recording is filed under, or none. Opening it lists the
 *  matters worked on last; typing searches them all. */
export const TranscribeMatterPicker = ({
  matter,
  onChange,
  disabled = false,
}: {
  matter: DesktopMatter | null;
  onChange: (matter: DesktopMatter | null) => void;
  disabled?: boolean;
}) => {
  const t = useTranslations("transcribe.matter");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<Search>({ type: "idle" });
  useEffect(() => {
    if (disabled || !open) {
      return undefined;
    }
    let disposed = false;
    const timer = setTimeout(
      () => {
        invoke<DesktopMatter[]>("transcribe_search_matters", { query })
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
      },
      query === "" ? 0 : SEARCH_DELAY_MS,
    );
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [query, open, disabled]);
  const answered = search.type !== "idle" && search.query === query;
  const failed = answered && search.type === "failed";
  const matters =
    answered && search.type === "ready" ? search.matters : undefined;
  const choose = (next: DesktopMatter | null) => {
    onChange(next);
    setOpen(false);
  };
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
        render={
          <Button
            className="max-w-56 min-w-44 justify-between"
            disabled={disabled}
            size="sm"
            variant="outline"
          />
        }
      >
        <TruncatedText render={<bdi />}>
          {matter === null ? t("none") : matter.name}
        </TruncatedText>
        <ChevronDownIcon aria-hidden="true" className="text-muted-foreground" />
      </PopoverTrigger>
      <PopoverPopup align="end" className="w-80" side="bottom">
        <SearchField
          aria-label={t("search")}
          clearLabel={t("clearSearch")}
          disabled={disabled}
          onValueChange={setQuery}
          placeholder={t("search")}
          value={query}
        />
        {failed ? (
          <p className="text-destructive text-xs" role="alert">
            {t("failed")}
          </p>
        ) : null}
        {!answered ? (
          <p className="text-muted-foreground text-xs" role="status">
            {t("searching")}
          </p>
        ) : null}
        <ScrollArea className="max-h-64">
          <div className="flex flex-col">
            {query === "" && matter !== null ? (
              <Button
                className="justify-start"
                onClick={() => choose(null)}
                size="row"
                variant="ghost"
              >
                {t("none")}
              </Button>
            ) : null}
            {matters?.map((option) => (
              <Button
                className="justify-start"
                key={option.id}
                onClick={() => choose(option)}
                size="row"
                variant="ghost"
              >
                <MatterIcon className="size-4" matter={option} />
                <TruncatedText render={<bdi />}>{option.name}</TruncatedText>
                {option.reference ? (
                  <bdi className="text-muted-foreground text-xs">
                    {option.reference}
                  </bdi>
                ) : null}
              </Button>
            ))}
            {matters?.length === 0 ? (
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
