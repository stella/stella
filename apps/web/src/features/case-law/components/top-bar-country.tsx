import { useNavigate, useRouterState } from "@tanstack/react-router";
import { GlobeIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@stll/ui/menu";

import { clearedCaseLawFilters } from "@/features/case-law/case-law-index-search.logic";
import {
  PUBLIC_CASE_LAW_COUNTRIES,
  toCaseLawCountryParam,
} from "@/features/case-law/case-law-jurisdiction";
import { caseLawCountryName } from "@/features/case-law/components/case-law-search";
import { countryScopedLawRoute } from "@/features/case-law/country-scope.logic";
import type { CountryScopedLawRoute } from "@/features/case-law/country-scope.logic";
import { useFormatter } from "@/i18n/formatting-context";
import { detached } from "@/lib/detached";

/**
 * The jurisdiction the reader is in, in the title row.
 *
 * A lawyer changes jurisdiction about never, so the control belongs where the
 * page says where you are rather than beside the box that asks what you want.
 * It lives in the shell, like the citation strip and the language select, for
 * the reason those do: the top bar has exactly one of each. A page that
 * published its own into a shared slot would publish one per live route match,
 * and a screen that keeps the previous match alive across a filter change
 * would then show two, then four.
 */
export const TopBarCountry = () => {
  const scoped = useRouterState({
    select: (state) => countryScopedLawRoute(state.matches.at(-1)?.routeId),
  });
  if (scoped === null) {
    return null;
  }
  return <TopBarCountryFor route={scoped} />;
};

const TopBarCountryFor = ({ route }: { route: CountryScopedLawRoute }) => {
  const t = useTranslations();
  const format = useFormatter();
  const navigate = useNavigate();
  // Read from the location rather than a route-scoped hook: this renders in
  // shared chrome, above the route whose search it is reading.
  const country = useRouterState({
    select: (state) => state.location.search.country,
  });
  const options = PUBLIC_CASE_LAW_COUNTRIES.map((code) => ({
    label: caseLawCountryName(format, code),
    value: toCaseLawCountryParam(code),
  }));
  const current = options.find((option) => option.value === country);

  const switchTo = (next: string) => {
    if (route === "home") {
      detached(
        navigate({ to: "/law", search: { country: next }, replace: true }),
        "law-home.switch-country",
      );
      return;
    }
    // A court, a year or a source belongs to one corpus; carrying it into
    // another would filter by a value that corpus never uses.
    detached(
      navigate({
        to: "/law/cases",
        search: (previous) => ({
          ...previous,
          ...clearedCaseLawFilters(),
          country: next,
        }),
        replace: true,
      }),
      "cases.switch-country",
    );
  };

  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            aria-label={t("common.country")}
            className="text-muted-foreground shrink-0 gap-1.5"
            size="sm"
            variant="ghost"
          />
        }
      >
        <GlobeIcon aria-hidden="true" className="size-3.5" />
        <span className="text-xs">{current?.label ?? t("common.country")}</span>
      </MenuTrigger>
      <MenuPopup>
        <MenuRadioGroup
          onValueChange={(value: unknown) => {
            if (typeof value === "string" && value !== country) {
              switchTo(value);
            }
          }}
          value={country}
        >
          {options.map((option) => (
            <MenuRadioItem key={option.value} value={option.value}>
              {option.label}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
};
