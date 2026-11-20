import type { CountryCode } from "@stll/country-codes";

import { Body } from "../components/body";
import { Button } from "../components/button";
import { Container } from "../components/container";
import { Head } from "../components/head";
import { Heading } from "../components/heading";
import { Hr } from "../components/hr";
import { Html } from "../components/html";
import { Img } from "../components/img";
import { Preview } from "../components/preview";
import { Section } from "../components/section";
import { Text } from "../components/text";
import { getEmailDirection, getTranslator } from "../i18n/translate";
import type { SupportedLang } from "../i18n/translate";
import { LOCATION_MAP_DISPLAY_SIZE } from "../map/location-map";
import { brand, BRAND_FOOTER_TEXT, sharedStyles } from "./_shared";
import { Wordmark } from "./_wordmark";

/**
 * Where the sign-in came from, as far as the IP address tells. `unknown` when
 * nothing trustworthy says (a private or local address, no geolocating proxy):
 * the email then leaves the location out rather than guess.
 */
export type SignInLocation =
  | { type: "unknown" }
  | {
      type: "known";
      city: string | null;
      region: string | null;
      countryCode: CountryCode;
      /** The map image, attached to the message as an inline part. */
      map: { contentId: string } | null;
    };

type Props = {
  device: string;
  ipAddress: string;
  location: SignInLocation;
  time: string;
  sessionsUrl: string;
  lang: SupportedLang;
};

export const Email = ({
  device,
  ipAddress,
  location,
  time,
  sessionsUrl,
  lang,
}: Props) => {
  const t = getTranslator(lang);
  const place = location.type === "known" ? placeName(location, lang) : null;

  return (
    <Html lang={lang} dir={getEmailDirection(lang)}>
      <Head />
      <Preview>{t("newDeviceLogin.preview", { device })}</Preview>
      <Body style={sharedStyles.body}>
        <Container style={sharedStyles.container}>
          <Wordmark />
          <Heading style={sharedStyles.heading}>
            {t("newDeviceLogin.heading")}
          </Heading>
          <Text style={sharedStyles.text}>{t("newDeviceLogin.body")}</Text>
          <Section style={styles.detailsSection}>
            <Text style={styles.detailRow}>
              <strong>{t("newDeviceLogin.device")}:</strong> {device}
            </Text>
            <Text style={styles.detailRow}>
              <strong>{t("newDeviceLogin.ipAddress")}:</strong> {ipAddress}
            </Text>
            {place === null ? null : (
              <Text style={styles.detailRow}>
                <strong>{t("newDeviceLogin.location")}:</strong> {place}
              </Text>
            )}
            <Text style={styles.detailRow}>
              <strong>{t("newDeviceLogin.time")}:</strong> {time}
            </Text>
          </Section>
          {location.type === "known" ? (
            <LocationNotes lang={lang} location={location} />
          ) : null}
          <Section style={styles.buttonSection}>
            <Button href={sessionsUrl} style={styles.button}>
              {t("newDeviceLogin.action")}
            </Button>
          </Section>
          <Hr style={sharedStyles.hr} />
          <Text style={sharedStyles.footer}>{t("newDeviceLogin.ignore")}</Text>
          <Text style={sharedStyles.brandFooter}>{BRAND_FOOTER_TEXT}</Text>
        </Container>
      </Body>
    </Html>
  );
};

type KnownLocation = Extract<SignInLocation, { type: "known" }>;

type LocationNotesProps = { location: KnownLocation; lang: SupportedLang };

/**
 * The map, when there is one, and what the location rests on. The base map is
 * public domain and needs no credit line.
 */
const LocationNotes = ({ location, lang }: LocationNotesProps) => {
  const t = getTranslator(lang);
  return (
    <>
      {location.map === null ? null : (
        <Img
          alt={t("newDeviceLogin.mapAlt", {
            location: placeName(location, lang),
          })}
          height={String(LOCATION_MAP_DISPLAY_SIZE.height)}
          src={`cid:${location.map.contentId}`}
          style={styles.map}
          width={String(LOCATION_MAP_DISPLAY_SIZE.width)}
        />
      )}
      <Text style={styles.caption}>{t("newDeviceLogin.locationNote")}</Text>
    </>
  );
};

/**
 * City, region and country, most specific first, with the locale's own
 * separators. The country name is localized from its code; city and region
 * come as the geolocation source spells them. A region named like its city
 * (Prague, Vienna) is said once.
 */
const placeName = (
  { city, region, countryCode }: KnownLocation,
  lang: SupportedLang,
): string => {
  const t = getTranslator(lang);
  const country =
    new Intl.DisplayNames([lang], { type: "region" }).of(countryCode) ??
    countryCode;
  const distinctRegion = region === city ? null : region;
  if (city !== null && distinctRegion !== null) {
    return t("newDeviceLogin.place.cityRegionCountry", {
      city,
      region: distinctRegion,
      country,
    });
  }
  if (city !== null) {
    return t("newDeviceLogin.place.cityCountry", { city, country });
  }
  if (distinctRegion !== null) {
    return t("newDeviceLogin.place.regionCountry", {
      region: distinctRegion,
      country,
    });
  }
  return country;
};

const styles = {
  detailsSection: {
    marginBottom: "16px",
    borderRadius: "10px",
    backgroundColor: brand.backgroundCodeBlock,
    padding: "16px",
  },
  detailRow: {
    margin: "0 0 4px",
    color: brand.textPrimary,
    fontSize: "14px",
    lineHeight: "22px",
  },
  map: {
    margin: "0 0 8px",
    width: "100%",
    maxWidth: `${LOCATION_MAP_DISPLAY_SIZE.width}px`,
    height: "auto",
    borderRadius: "10px",
    border: `1px solid ${brand.border}`,
  },
  caption: {
    margin: "0 0 4px",
    color: brand.textMuted,
    fontSize: "12px",
    lineHeight: "18px",
  },
  buttonSection: {
    margin: "24px 0",
    textAlign: "center" as const,
  },
  button: {
    backgroundColor: brand.foreground,
    borderRadius: "8px",
    color: brand.foregroundOnAccent,
    fontSize: "16px",
    fontWeight: "600",
    padding: "12px 24px",
    textDecoration: "none",
  },
} satisfies Record<string, React.CSSProperties>;
