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

import type { PublicLawSearchCountry } from "@/components/public-law-search";
import { ChromeHeaderActions } from "@/lib/chrome-header-actions";

type PublicLawCountryMenuProps = {
  /** The jurisdiction the route is scoped to, as the route carries it. */
  country: string;
  countries: readonly PublicLawSearchCountry[];
  onCountryChange: (country: string) => void;
};

/**
 * Which jurisdiction the reader is in, in the top bar rather than beside the
 * search box.
 *
 * A lawyer changes jurisdiction about never, so the control belongs where the
 * page says where you are, not where it asks what you want. It goes through
 * the shell's header-actions slot, the one route-specific top-bar mechanism,
 * so the shell still imports nothing from either page.
 */
export const PublicLawCountryMenu = ({
  countries,
  country,
  onCountryChange,
}: PublicLawCountryMenuProps) => {
  const t = useTranslations();
  const current = countries.find((option) => option.value === country);

  return (
    <ChromeHeaderActions>
      <Menu>
        <MenuTrigger
          render={
            <Button
              aria-label={t("common.country")}
              className="text-muted-foreground gap-1.5"
              size="sm"
              variant="ghost"
            />
          }
        >
          <GlobeIcon aria-hidden="true" className="size-3.5" />
          <span className="text-xs">
            {current === undefined ? country.toUpperCase() : current.label}
          </span>
        </MenuTrigger>
        <MenuPopup>
          <MenuRadioGroup
            onValueChange={(value: unknown) => {
              if (typeof value === "string" && value !== country) {
                onCountryChange(value);
              }
            }}
            value={country}
          >
            {countries.map((option) => (
              <MenuRadioItem key={option.value} value={option.value}>
                {option.label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuPopup>
      </Menu>
    </ChromeHeaderActions>
  );
};
