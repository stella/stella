import { XIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Form } from "@stll/ui/form";
import { cn } from "@stll/ui/utils";

import { Globe, type GlobeMarker } from "@/components/globe";
import { JurisdictionPicker } from "@/components/jurisdiction-picker";
import Tooltip from "@/components/tooltip";
import { useFormatter } from "@/i18n/formatting-context";
import {
  COUNTRY_POINTS,
  countryName,
  removeJurisdiction,
} from "@/lib/jurisdictions";
import type { CountryCode, PracticeJurisdiction } from "@/lib/jurisdictions";

type JurisdictionStepProps = {
  selected: readonly PracticeJurisdiction[];
  suggestedCountryCodes: readonly CountryCode[];
  onChange: (jurisdictions: PracticeJurisdiction[]) => void;
  onNext: () => void;
  onSkip: () => void;
};

export const JurisdictionStep = ({
  selected,
  suggestedCountryCodes,
  onChange,
  onNext,
  onSkip,
}: JurisdictionStepProps) => {
  const t = useTranslations();

  return (
    <>
      <h1 className="text-foreground text-3xl font-light tracking-tight">
        {t("onboarding.jurisdictionTitle")}
      </h1>
      <p className="text-muted-foreground mt-2 text-sm">
        {t("onboarding.jurisdictionSubtitle")}
      </p>

      <Form
        className="mt-7 flex min-h-0 flex-1 flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          if (selected.length === 0) {
            return;
          }
          onNext();
        }}
      >
        <div className="flex min-h-0 flex-1 flex-col gap-4">
          <JurisdictionPicker
            autoFocus
            onChange={onChange}
            selected={selected}
            suggestedCountryCodes={suggestedCountryCodes}
          />
        </div>

        <div className="mt-auto flex items-center justify-between gap-3 pt-8">
          <Button onClick={onSkip} type="button" variant="ghost">
            {t("onboarding.skipStep")}
          </Button>
          <Button disabled={selected.length === 0} type="submit">
            {t("common.next")}
          </Button>
        </div>
      </Form>
    </>
  );
};

type JurisdictionGlobePreviewProps = {
  selected: readonly PracticeJurisdiction[];
  onChange?: (jurisdictions: PracticeJurisdiction[]) => void;
};

const GLOBE_PIXEL_SIZE = 440;

export const JurisdictionGlobePreview = ({
  selected,
  onChange,
}: JurisdictionGlobePreviewProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const codeToPoint = new Map(
    COUNTRY_POINTS.map((point) => [point.code, point]),
  );
  const markers = selected.flatMap<GlobeMarker>((jurisdiction) => {
    const point = codeToPoint.get(jurisdiction.countryCode);
    if (!point) {
      return [];
    }
    return [
      {
        location: [point.lat, point.lon],
        size: jurisdiction.isPrimary ? 0.12 : 0.08,
      },
    ];
  });
  const focusJurisdiction =
    selected.find((jurisdiction) => jurisdiction.isPrimary) ?? selected.at(0);
  const focusPoint = focusJurisdiction
    ? codeToPoint.get(focusJurisdiction.countryCode)
    : undefined;

  return (
    <div className="flex flex-col items-center gap-6">
      <Globe
        focusLongitude={focusPoint?.lon ?? null}
        label={t("onboarding.jurisdictionGlobeLabel")}
        markers={markers}
        scale={1}
        size={GLOBE_PIXEL_SIZE}
      />

      <div className="flex h-24 w-full max-w-[480px] flex-wrap content-start justify-center gap-2">
        {selected.map((jurisdiction) => {
          const name = countryName(
            jurisdiction.countryCode,
            format.displayName,
          );
          return (
            <span
              className={cn(
                "border-border bg-background flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs",
                jurisdiction.isPrimary &&
                  selected.length > 1 &&
                  "border-primary/40 bg-primary/10",
              )}
              key={jurisdiction.countryCode}
            >
              <span className="truncate">{name}</span>
              {jurisdiction.isPrimary && selected.length > 1 && (
                <span className="bg-primary/10 text-primary text-3xs rounded-full px-1.5 py-0.5">
                  {t("onboarding.jurisdictionPrimary")}
                </span>
              )}
              {onChange && (
                <Tooltip
                  content={t("onboarding.jurisdictionRemove", { name })}
                  render={
                    <button
                      aria-label={t("onboarding.jurisdictionRemove", {
                        name,
                      })}
                      className="text-muted-foreground hover:text-foreground"
                      onClick={() =>
                        onChange(
                          removeJurisdiction(
                            selected,
                            jurisdiction.countryCode,
                          ),
                        )
                      }
                      type="button"
                    >
                      <XIcon className="size-3" />
                    </button>
                  }
                />
              )}
            </span>
          );
        })}
      </div>
    </div>
  );
};
