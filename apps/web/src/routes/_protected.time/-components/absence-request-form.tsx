import { useId, useState } from "react";

import { useTranslations } from "use-intl";

import { ABSENCE_HALF_DAY_SEGMENTS, ABSENCE_KINDS } from "@stll/api-contract";
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
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { useRequestAbsence } from "@/lib/organization/absences";

import {
  absenceRequestFromForm,
  initialAbsenceValues,
} from "./absence-form.logic";
import type { AbsenceFormValues } from "./absence-form.logic";

type AbsenceFieldsProps = {
  values: AbsenceFormValues;
  onChange: (values: AbsenceFormValues) => void;
};

const AbsenceDates = ({ values, onChange }: AbsenceFieldsProps) => {
  const id = useId();
  const t = useTranslations("billing.absences");
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-start`} id={`${id}-start-label`}>
          {t("startDate")}
        </Label>
        <DatePickerPopover
          id={`${id}-start`}
          labelledBy={`${id}-start-label`}
          value={values.startDate}
          onChange={(date) => onChange({ ...values, startDate: date ?? "" })}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-end`} id={`${id}-end-label`}>
          {t("lastDay")}
        </Label>
        <DatePickerPopover
          id={`${id}-end`}
          labelledBy={`${id}-end-label`}
          value={values.lastDay}
          {...(values.startDate ? { minDate: values.startDate } : {})}
          onChange={(date) => onChange({ ...values, lastDay: date ?? "" })}
        />
      </div>
    </div>
  );
};

const AbsenceCoverage = ({ values, onChange }: AbsenceFieldsProps) => {
  const id = useId();
  const t = useTranslations("billing.absences");
  const tDay = useTranslations("timesheets.day");
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-coverage`}>{t("coverage")}</Label>
        <Select
          value={values.coverage.type}
          onValueChange={(type) => {
            if (type === "full") {
              onChange({ ...values, coverage: { type: "full" } });
            }
            if (type === "half") {
              onChange({
                ...values,
                coverage: { type: "half", segment: "morning" },
              });
            }
          }}
        >
          <SelectTrigger id={`${id}-coverage`} className="min-h-11">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="full">{tDay("fullDay")}</SelectItem>
            <SelectItem
              value="half"
              disabled={values.startDate !== values.lastDay}
            >
              {t("halfDay")}
            </SelectItem>
          </SelectPopup>
        </Select>
      </div>
      {values.coverage.type === "half" && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-segment`}>{t("segment")}</Label>
          <Select
            value={values.coverage.segment}
            onValueChange={(segment) => {
              if (segment === "morning" || segment === "afternoon") {
                onChange({ ...values, coverage: { type: "half", segment } });
              }
            }}
          >
            <SelectTrigger id={`${id}-segment`} className="min-h-11">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {ABSENCE_HALF_DAY_SEGMENTS.map((segment) => (
                <SelectItem key={segment} value={segment}>
                  {tDay(`halfDaySegments.${segment}`)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      )}
    </div>
  );
};

export const AbsenceRequestForm = ({
  initialDate,
  onRequested,
}: {
  initialDate: string;
  onRequested: () => void;
}) => {
  const id = useId();
  const t = useTranslations("billing.absences");
  const tDay = useTranslations("timesheets.day");
  const user = useAuthenticatedUser();
  const [values, setValues] = useState(() => initialAbsenceValues(initialDate));
  const request = useRequestAbsence(user.activeOrganizationId);
  const validated = absenceRequestFromForm(values, user.timezoneId);
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (validated.type === "valid" && !request.isPending) {
          request.mutate(validated.body, { onSuccess: onRequested });
        }
      }}
    >
      <fieldset
        disabled={request.isPending}
        className="flex min-w-0 flex-col gap-4"
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-kind`}>{t("kind")}</Label>
          <Select
            value={values.kind}
            onValueChange={(kind) => {
              if (kind === "vacation" || kind === "sick" || kind === "other") {
                setValues({ ...values, kind });
              }
            }}
          >
            <SelectTrigger id={`${id}-kind`} className="min-h-11">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {ABSENCE_KINDS.map((kind) => (
                <SelectItem key={kind} value={kind}>
                  {tDay(`absenceKinds.${kind}`)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
        <AbsenceDates values={values} onChange={setValues} />
        <AbsenceCoverage values={values} onChange={setValues} />
        {validated.type === "invalid" && (
          <p role="alert" className="text-destructive text-sm">
            {validated.reason === "range"
              ? t("rangeInvalid")
              : t("halfDaySingleDay")}
          </p>
        )}
      </fieldset>
      <div className="flex justify-end">
        <Button
          disabled={validated.type === "invalid" || request.isPending}
          type="submit"
          className="min-h-11"
        >
          {t("request")}
        </Button>
      </div>
    </form>
  );
};
