import { useId, useState } from "react";

import { useTranslations } from "use-intl";

import { parsePlainDate } from "@stll/time";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { Label } from "@stll/ui/label";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";

import { DatePickerPopover } from "@/components/date-picker-popover";
import type { ApprovalFilters } from "@/features/time-approval-queue/filters.logic";

const ALL_ITEMS = "__all__";

type ApprovalFiltersFormProps = {
  filters: ApprovalFilters;
  pending: boolean;
  members: ReadonlyMap<string, string>;
  matters: ReadonlyMap<string, string>;
  onApply: (filters: ApprovalFilters) => void;
};

export const ApprovalFiltersForm = ({
  filters,
  pending,
  members,
  matters,
  onApply,
}: ApprovalFiltersFormProps) => {
  const t = useTranslations();
  const id = useId();
  const [draftFilters, setDraftFilters] = useState(filters);
  const fromDate = parsePlainDate(draftFilters.from ?? "")?.toString() ?? null;
  const toDate = parsePlainDate(draftFilters.to ?? "")?.toString() ?? null;

  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (pending) {
          return;
        }
        onApply(draftFilters);
      }}
    >
      <fieldset className="space-y-1 [&_button]:min-h-11" disabled={pending}>
        <Label htmlFor={`${id}-from`}>
          {t("settings.organization.auditLogsFrom")}
        </Label>
        <DatePickerPopover
          id={`${id}-from`}
          {...(toDate === null ? {} : { maxDate: toDate })}
          value={fromDate}
          onChange={(date) => {
            if (pending) {
              return;
            }
            setDraftFilters({
              ...draftFilters,
              from: date ?? undefined,
            });
          }}
        />
      </fieldset>
      <fieldset className="space-y-1 [&_button]:min-h-11" disabled={pending}>
        <Label htmlFor={`${id}-to`}>
          {t("settings.organization.auditLogsTo")}
        </Label>
        <DatePickerPopover
          id={`${id}-to`}
          {...(fromDate === null ? {} : { minDate: fromDate })}
          value={toDate}
          onChange={(date) => {
            if (pending) {
              return;
            }
            setDraftFilters({
              ...draftFilters,
              to: date ?? undefined,
            });
          }}
        />
      </fieldset>
      <div className="min-w-44 space-y-1">
        <Label htmlFor={`${id}-member`}>{t("organization.roles.member")}</Label>
        <Select
          disabled={pending}
          value={draftFilters.member ?? ALL_ITEMS}
          onValueChange={(value) =>
            setDraftFilters({
              ...draftFilters,
              member: value === ALL_ITEMS || value === null ? undefined : value,
            })
          }
        >
          <SelectTrigger className="min-h-11" id={`${id}-member`}>
            <SelectValue>
              {draftFilters.member ? (
                <BidiText>{members.get(draftFilters.member)}</BidiText>
              ) : (
                t("common.all")
              )}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            <SelectItem className="min-h-11" value={ALL_ITEMS}>
              {t("common.all")}
            </SelectItem>
            {[...members].map(([memberId, name]) => (
              <SelectItem className="min-h-11" key={memberId} value={memberId}>
                <BidiText>{name}</BidiText>
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      <div className="min-w-44 space-y-1">
        <Label htmlFor={`${id}-matter`}>{t("common.matter")}</Label>
        <Select
          disabled={pending}
          value={draftFilters.matter ?? ALL_ITEMS}
          onValueChange={(value) =>
            setDraftFilters({
              ...draftFilters,
              matter: value === ALL_ITEMS || value === null ? undefined : value,
            })
          }
        >
          <SelectTrigger className="min-h-11" id={`${id}-matter`}>
            <SelectValue>
              {draftFilters.matter ? (
                <BidiText>{matters.get(draftFilters.matter)}</BidiText>
              ) : (
                t("common.all")
              )}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            <SelectItem className="min-h-11" value={ALL_ITEMS}>
              {t("common.all")}
            </SelectItem>
            {[...matters].map(([matterId, name]) => (
              <SelectItem className="min-h-11" key={matterId} value={matterId}>
                <BidiText>{name}</BidiText>
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      <Button
        className="min-h-11"
        disabled={pending}
        type="submit"
        variant="outline"
      >
        {t("common.filter")}
      </Button>
    </form>
  );
};
