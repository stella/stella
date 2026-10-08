import { useEffect, useRef, useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { useLocale, useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Checkbox } from "@stll/ui/checkbox";
import { DatePickerPopover } from "@stll/ui/date-picker-popover";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogPanel,
  DialogTitle,
} from "@stll/ui/dialog";
import { Input } from "@stll/ui/input";
import { Label } from "@stll/ui/label";
import { SearchField } from "@stll/ui/search-field";
import { Textarea } from "@stll/ui/textarea";

import type { ActivityBlock } from "./activity-logic";
import { initialTimeEntry, localEntryBlock } from "./time-entry-form";

export const TimeEntryDialog = ({
  block,
  date,
  onClose,
  onDrafted,
}: TimeEntryDialogProps) => {
  const t = useTranslations("activity");
  const locale = useLocale();
  const [entry, setEntry] = useState(() => initialTimeEntry(date, block));
  const [selectedMatter, setSelectedMatter] = useState<Matter | null>(null);
  const [query, setQuery] = useState("");
  const [matters, setMatters] = useState<Matter[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<"search" | "submit" | null>(null);
  const [state, setState] = useState<SubmitState>({ type: "editing" });
  const requestId = useRef(0);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    let disposed = false;
    const current = ++requestId.current;
    const timer = setTimeout(() => {
      setSearching(true);
      invoke<Matter[]>("time_entry_search_matters", { query })
        .then((result) => {
          if (disposed || current !== requestId.current) {
            return null;
          }
          setMatters(result);
          setError(null);
          return null;
        })
        .catch(() => {
          if (disposed || current !== requestId.current) {
            return null;
          }
          setMatters([]);
          setError("search");
          return null;
        })
        .finally(() => {
          if (!disposed && current === requestId.current) {
            setSearching(false);
          }
        });
    }, 250);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [query]);

  const submit = () => {
    if (state.type !== "editing" || !entry.workspaceId) {
      return;
    }
    setError(null);
    setState({ type: "submitting" });
    // The native command separates these local identifiers from the six confirmed fields.
    invoke<{ id: string; markerSaved: boolean }>(
      "time_entry_submit_confirmed",
      {
        block: localEntryBlock(date, block),
        entry: {
          workspaceId: entry.workspaceId,
          dateWorked: entry.dateWorked,
          timezoneId: entry.timezoneId,
          durationMinutes: entry.durationMinutes,
          narrative: entry.narrative,
          billable: entry.billable,
        },
      },
    )
      .then(({ id, markerSaved }) => {
        onDrafted(id);
        setState({ type: "saved", markerSaved });
        return null;
      })
      .catch(() => {
        setError("submit");
        setState({ type: "editing" });
      });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && state.type !== "submitting") {
          onClose();
        }
      }}
    >
      <DialogPopup className="max-w-lg" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t("createDraftEntry")}</DialogTitle>
          <DialogDescription>
            {t("entryConfirmationDescription")}
          </DialogDescription>
        </DialogHeader>
        {state.type === "saved" ? (
          <>
            <DialogPanel>
              <p role="status" className="text-sm">
                {t("entryCreated")}
              </p>
              {!state.markerSaved ? (
                <p role="alert" className="text-destructive text-sm">
                  {t("entryMarkerFailed")}
                </p>
              ) : null}
            </DialogPanel>
            <DialogFooter>
              <Button onClick={onClose}>{t("closeEntry")}</Button>
            </DialogFooter>
          </>
        ) : (
          <form
            ref={formRef}
            onSubmit={(event) => {
              event.preventDefault();
            }}
            className="flex min-h-0 flex-col"
          >
            <DialogPanel className="flex flex-col gap-4">
              <fieldset
                disabled={state.type === "submitting"}
                className="flex min-w-0 flex-col gap-4"
              >
                <div className="flex flex-col gap-2">
                  <Label htmlFor="entry-matter-search">
                    {t("entryMatter")}
                  </Label>
                  <SearchField
                    id="entry-matter-search"
                    value={query}
                    onValueChange={setQuery}
                    clearLabel={t("clearMatterSearch")}
                    placeholder={t("searchMatters")}
                  />
                  {searching ? (
                    <p role="status" className="text-muted-foreground text-xs">
                      {t("searchingMatters")}
                    </p>
                  ) : null}
                  {!searching && matters.length === 0 && !error ? (
                    <p className="text-muted-foreground text-xs">
                      {t("noMatters")}
                    </p>
                  ) : null}
                  <ul className="flex flex-col gap-1">
                    {matters.map((matter) => (
                      <li key={matter.id}>
                        <Button
                          className="w-full justify-start text-start whitespace-normal"
                          aria-pressed={entry.workspaceId === matter.id}
                          onClick={() => {
                            setSelectedMatter(matter);
                            setEntry({ ...entry, workspaceId: matter.id });
                          }}
                          type="button"
                          variant={
                            entry.workspaceId === matter.id
                              ? "secondary"
                              : "ghost"
                          }
                        >
                          {matter.name}
                          {matter.reference ? ` (${matter.reference})` : ""}
                        </Button>
                      </li>
                    ))}
                  </ul>
                  {selectedMatter ? (
                    <p className="text-sm font-medium">
                      {selectedMatter.name}
                      {selectedMatter.reference
                        ? ` (${selectedMatter.reference})`
                        : ""}
                    </p>
                  ) : null}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-2">
                    <Label id="entry-date-label" htmlFor="entry-date">
                      {t("entryDate")}
                    </Label>
                    <DatePickerPopover
                      id="entry-date"
                      labelledBy="entry-date-label"
                      locale={locale}
                      variant="field"
                      hideClear
                      disabled={state.type === "submitting"}
                      value={entry.dateWorked}
                      onChange={(dateWorked) => {
                        if (dateWorked !== null) {
                          setEntry({ ...entry, dateWorked });
                        }
                      }}
                      dialogLabel={t("datePicker.label")}
                      previousMonthLabel={t("datePicker.previousMonth")}
                      nextMonthLabel={t("datePicker.nextMonth")}
                      previousYearLabel={t("datePicker.previousYear")}
                      nextYearLabel={t("datePicker.nextYear")}
                      previousDecadeLabel={t("datePicker.previousDecade")}
                      nextDecadeLabel={t("datePicker.nextDecade")}
                      todayLabel={t("today")}
                    />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="entry-duration">{t("entryDuration")}</Label>
                    <Input
                      id="entry-duration"
                      type="number"
                      min={1}
                      step={1}
                      required
                      value={entry.durationMinutes}
                      onChange={(event) =>
                        setEntry({
                          ...entry,
                          durationMinutes: Number(event.target.value),
                        })
                      }
                    />
                  </div>
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="entry-timezone">{t("entryTimezone")}</Label>
                  <Input
                    id="entry-timezone"
                    required
                    maxLength={64}
                    value={entry.timezoneId}
                    onChange={(event) =>
                      setEntry({ ...entry, timezoneId: event.target.value })
                    }
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="entry-narrative">{t("entryNarrative")}</Label>
                  <Textarea
                    id="entry-narrative"
                    maxLength={10_000}
                    value={entry.narrative}
                    onChange={(event) =>
                      setEntry({ ...entry, narrative: event.target.value })
                    }
                  />
                </div>
                <Label htmlFor="entry-billable">
                  <Checkbox
                    id="entry-billable"
                    checked={entry.billable}
                    onCheckedChange={(billable) =>
                      setEntry({ ...entry, billable })
                    }
                  />
                  {t("entryBillable")}
                </Label>
              </fieldset>
              {error ? (
                <p role="alert" className="text-destructive text-sm">
                  {error === "search"
                    ? t("errorMatterSearch")
                    : t("errorEntrySubmit")}
                </p>
              ) : null}
            </DialogPanel>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                disabled={state.type === "submitting"}
                onClick={onClose}
              >
                {t("cancel")}
              </Button>
              <Button
                type="button"
                onClick={() => {
                  if (formRef.current?.reportValidity()) {
                    submit();
                  }
                }}
                disabled={!entry.workspaceId || state.type === "submitting"}
              >
                {state.type === "submitting"
                  ? t("entrySubmitting")
                  : t("confirmDraftEntry")}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogPopup>
    </Dialog>
  );
};

type Matter = { id: string; name: string; reference: string | null };
type SubmitState =
  | { type: "editing" }
  | { type: "submitting" }
  | { type: "saved"; markerSaved: boolean };
type TimeEntryDialogProps = {
  block: ActivityBlock;
  date: string;
  onClose: () => void;
  onDrafted: (entryId: string) => void;
};
