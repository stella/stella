import { panic } from "better-result";
import { useTranslations } from "use-intl";

import type { SessionSignInLocation } from "@stll/api-contract/session-sign-ins";

import { useFormatter } from "@/i18n/formatting-context";
import type { DeviceName } from "@/routes/_protected.settings/-account.security.logic";

type KnownLocation = Extract<SessionSignInLocation, { type: "known" }>;

/**
 * How the security page words a device and a sign-in place. Browser and OS
 * names are proper nouns and print as parsed; the country name is localized
 * from its code; city and region print as the geolocation source spells them.
 */
export const useDeviceWording = () => {
  const t = useTranslations();
  const format = useFormatter();

  const deviceLabel = (name: DeviceName): string => {
    switch (name.type) {
      case "browserOnOs":
        return t("account.sessions.deviceOnOs", {
          browser: name.browser,
          os: name.os,
        });
      case "browser":
        return name.browser;
      case "os":
        return name.os;
      case "desktopApp":
        return t("settings.account.security.desktopApp");
      case "unknown":
        return t("account.sessions.unknownDevice");
      default:
        name satisfies never;
        return panic("Unknown device name kind");
    }
  };

  const placeLabel = ({ city, region, countryCode }: KnownLocation): string => {
    const country = format.displayName(countryCode, { type: "region" });
    if (city !== null) {
      return t("settings.account.security.placeCityCountry", {
        city,
        country,
      });
    }
    if (region !== null) {
      return t("settings.account.security.placeRegionCountry", {
        region,
        country,
      });
    }
    return country;
  };

  return { deviceLabel, placeLabel };
};
