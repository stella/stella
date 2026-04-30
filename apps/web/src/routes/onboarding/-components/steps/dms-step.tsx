import { useMemo, useState } from "react";

import { Button } from "@stll/ui/components/button";
import { Input } from "@stll/ui/components/input";
import { cn } from "@stll/ui/lib/utils";
import { CheckIcon } from "lucide-react";
import { useTranslations } from "use-intl";

export const DMS_NONE = "none" as const;

const KNOWN_DMS = [
  "iManage",
  "NetDocuments",
  "Worldox",
  "SharePoint",
  "Google Drive",
  "Dropbox",
  "Box",
] as const;

type DmsStepProps = {
  onNext: (data: { dms: string }) => void;
  onSelectionChange?: (count: number) => void;
};

export const DmsStep = ({ onNext, onSelectionChange }: DmsStepProps) => {
  const t = useTranslations();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(new Set<string>());

  const filtered = useMemo(() => {
    if (!query.trim()) {
      return [...KNOWN_DMS];
    }
    const q = query.toLowerCase();
    return KNOWN_DMS.filter((dms) => dms.toLowerCase().includes(q));
  }, [query]);

  const hasExactMatch = KNOWN_DMS.some(
    (dms) => dms.toLowerCase() === query.trim().toLowerCase(),
  );

  const toggleSelect = (value: string) => {
    setSelected((prev) => {
      let next: Set<string>;
      if (value === DMS_NONE) {
        next = new Set([DMS_NONE]);
      } else {
        next = new Set(prev);
        next.delete(DMS_NONE);
        if (next.has(value)) {
          next.delete(value);
        } else {
          next.add(value);
        }
      }
      const dmsCount = [...next].filter((v) => v !== DMS_NONE).length;
      onSelectionChange?.(dmsCount);
      return next;
    });
  };

  const isSelected = (value: string) => selected.has(value);
  const hasSelection = selected.size > 0;

  const formatSelection = () => [...selected].join(", ");

  return (
    <>
      <h1 className="text-foreground text-3xl font-light tracking-tight">
        {t("onboarding.dmsTitle")}
      </h1>
      <p className="text-muted-foreground mt-2 text-sm">
        {t("onboarding.dmsSubtitle")}
      </p>

      <div className="mt-8 flex flex-col gap-3">
        <Input
          autoFocus
          onChange={(e) => {
            setQuery(e.target.value);
          }}
          placeholder={t("onboarding.dmsPlaceholder")}
          value={query}
        />

        <div className="flex max-h-[280px] flex-col gap-1.5 overflow-y-auto">
          {filtered.map((dms) => (
            <button
              className={cn(
                "flex items-center justify-between rounded-lg border px-4 py-2.5 text-start text-sm transition-colors",
                isSelected(dms)
                  ? "border-primary bg-primary/5 text-foreground"
                  : "border-border text-foreground hover:bg-accent/50",
              )}
              key={dms}
              onClick={() => toggleSelect(dms)}
              type="button"
            >
              <span>{dms}</span>
              {isSelected(dms) && <CheckIcon className="text-primary size-4" />}
            </button>
          ))}

          {/* Custom value */}
          {query.trim() &&
            !hasExactMatch &&
            filtered.length < KNOWN_DMS.length && (
              <button
                className={cn(
                  "flex items-center justify-between rounded-lg border px-4 py-2.5 text-start text-sm transition-colors",
                  isSelected(query.trim())
                    ? "border-primary bg-primary/5 text-foreground"
                    : "border-border text-foreground hover:bg-accent/50",
                )}
                onClick={() => toggleSelect(query.trim())}
                type="button"
              >
                <span>&ldquo;{query.trim()}&rdquo;</span>
                {isSelected(query.trim()) && (
                  <CheckIcon className="text-primary size-4" />
                )}
              </button>
            )}

          {/* "Starting fresh" */}
          <button
            className={cn(
              "flex items-center justify-between rounded-lg border px-4 py-2.5 text-start text-sm transition-colors",
              isSelected(DMS_NONE)
                ? "border-primary bg-primary/5 text-foreground"
                : "border-border text-muted-foreground hover:bg-accent/50",
            )}
            onClick={() => toggleSelect(DMS_NONE)}
            type="button"
          >
            <span>{t("onboarding.dmsNone")}</span>
            {isSelected(DMS_NONE) && (
              <CheckIcon className="text-primary size-4" />
            )}
          </button>
        </div>
      </div>

      {hasSelection && !isSelected(DMS_NONE) && (
        <p className="text-muted-foreground mt-3 text-xs">
          {t("onboarding.dmsConfirmMigration", {
            dms: formatSelection(),
          })}
        </p>
      )}

      <p className="text-muted-foreground/60 mt-3 text-xs">
        {t("onboarding.dmsNoCommitment")}
      </p>

      <div className="mt-6 flex items-center justify-end gap-3">
        <Button
          onClick={() => onNext({ dms: DMS_NONE })}
          type="button"
          variant="ghost"
        >
          {t("onboarding.skipStep")}
        </Button>
        <Button
          disabled={!hasSelection}
          onClick={() => {
            onNext({ dms: formatSelection() });
          }}
          type="button"
        >
          {t("common.next")}
        </Button>
      </div>
    </>
  );
};
