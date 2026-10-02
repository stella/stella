import { useFormatter, useTranslations } from "use-intl";

import { Temporal } from "@stll/time";

import { APIError } from "@/lib/errors/api";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import type { VatRate } from "@/lib/organization/vat-rates";
import { MEDIUM_DATE_FORMAT } from "@/lib/relative-time";

const BASIS_POINTS_PER_UNIT = 10_000;

export const VatRatePercentage = ({ rateBps }: { rateBps: number }) => {
  const format = useFormatter();
  return (
    <>
      {format.number(rateBps / BASIS_POINTS_PER_UNIT, {
        style: "percent",
        maximumFractionDigits: 2,
      })}
    </>
  );
};

export const VatRateDate = ({ date }: { date: string | null }) => {
  const t = useTranslations();
  const format = useFormatter();
  if (date === null) {
    return <>{t("billing.vatRates.openEnded")}</>;
  }
  const instant = Temporal.PlainDate.from(date).toZonedDateTime({
    plainTime: Temporal.PlainTime.from("00:00"),
    timeZone: "UTC",
  }).epochMilliseconds;
  return (
    <>{format.dateTime(instant, { ...MEDIUM_DATE_FORMAT, timeZone: "UTC" })}</>
  );
};

export const vatRateStatus = ({
  rate,
  date,
}: {
  rate: Pick<VatRate, "validFrom" | "validTo">;
  date: string;
}) => {
  if (date < rate.validFrom) {
    return "future";
  }
  if (rate.validTo !== null && date >= rate.validTo) {
    return "past";
  }
  return "current";
};

export const VatRateRefusal = ({ error }: { error: unknown }) => {
  const t = useTranslations();
  return (
    <p role="alert" className="text-destructive text-sm">
      {APIError.is(error) && error.status === 409
        ? t("billing.vatRates.overlap")
        : userErrorFromThrown(error, t("errors.actionFailed"))}
    </p>
  );
};
