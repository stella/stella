import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@stll/ui/components/button";
import { Input } from "@stll/ui/components/input";
import { cn } from "@stll/ui/lib/utils";
import createGlobe from "cobe";
import { CheckIcon, SearchIcon, StarIcon, XIcon } from "lucide-react";
import { useLocale, useTranslations } from "use-intl";

import {
  COUNTRY_POINTS,
  countryName,
  createCountryOptions,
  removeJurisdiction,
} from "@/lib/jurisdictions";
import type { PracticeJurisdiction } from "@/lib/jurisdictions";

type JurisdictionStepProps = {
  selected: readonly PracticeJurisdiction[];
  suggestedCountryCodes: readonly string[];
  onChange: (jurisdictions: PracticeJurisdiction[]) => void;
  onNext: () => void;
  onSkip: () => void;
};

const MAX_SELECTED_COUNTRIES = 12;

export const JurisdictionStep = ({
  selected,
  suggestedCountryCodes,
  onChange,
  onNext,
  onSkip,
}: JurisdictionStepProps) => {
  const t = useTranslations();
  const locale = useLocale();
  const [query, setQuery] = useState("");
  const selectedCodes = selected.map(
    (jurisdiction) => jurisdiction.countryCode,
  );
  const countryOptions = useMemo(() => createCountryOptions(locale), [locale]);
  const selectedSet = useMemo(() => new Set(selectedCodes), [selectedCodes]);
  const suggestedSet = useMemo(
    () => new Set(suggestedCountryCodes),
    [suggestedCountryCodes],
  );

  const filteredCountries = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const sorted = [...countryOptions].sort((a, b) => {
      const aSuggested = suggestedSet.has(a.code);
      const bSuggested = suggestedSet.has(b.code);

      if (aSuggested !== bSuggested) {
        return aSuggested ? -1 : 1;
      }

      return a.name.localeCompare(b.name, locale);
    });

    if (!normalizedQuery) {
      return sorted;
    }

    return sorted.filter(
      (country) =>
        country.name.toLowerCase().includes(normalizedQuery) ||
        country.code.toLowerCase().includes(normalizedQuery),
    );
  }, [countryOptions, locale, query, suggestedSet]);

  const toggleCountry = (countryCode: string) => {
    if (selectedSet.has(countryCode)) {
      onChange(removeJurisdiction(selected, countryCode));
      return;
    }

    if (selected.length >= MAX_SELECTED_COUNTRIES) {
      return;
    }

    onChange([
      ...selected,
      {
        countryCode,
        isPrimary: selected.length === 0,
      },
    ]);
  };

  const makePrimary = (countryCode: string) => {
    onChange(
      selected.map((jurisdiction) => ({
        ...jurisdiction,
        isPrimary: jurisdiction.countryCode === countryCode,
      })),
    );
  };

  return (
    <>
      <h1 className="text-foreground text-3xl font-light tracking-tight">
        {t("onboarding.jurisdictionTitle")}
      </h1>
      <p className="text-muted-foreground mt-2 text-sm">
        {t("onboarding.jurisdictionSubtitle")}
      </p>

      <div className="mt-7 flex flex-col gap-4">
        <div className="relative">
          <SearchIcon className="text-muted-foreground pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2" />
          <Input
            aria-label={t("onboarding.jurisdictionSearchLabel")}
            className="ps-9"
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("onboarding.jurisdictionSearchPlaceholder")}
            value={query}
          />
        </div>

        <div className="border-border max-h-[310px] overflow-y-auto rounded-lg border">
          {filteredCountries.map((country) => {
            const isSelected = selectedSet.has(country.code);
            const isSuggested = suggestedSet.has(country.code);
            const isPrimary = selected.some(
              (jurisdiction) =>
                jurisdiction.countryCode === country.code &&
                jurisdiction.isPrimary,
            );

            return (
              <div
                className={cn(
                  "border-border/70 flex items-center gap-2 border-b px-2 py-1.5 transition-colors last:border-b-0",
                  isSelected && "bg-accent text-foreground",
                )}
                key={country.code}
              >
                <button
                  className={cn(
                    "flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm transition-colors",
                    !isSelected && "hover:bg-accent",
                  )}
                  onClick={() => toggleCountry(country.code)}
                  type="button"
                >
                  <span
                    className={cn(
                      "border-border flex size-5 shrink-0 items-center justify-center rounded-full border",
                      isSelected && "bg-primary text-primary-foreground",
                    )}
                  >
                    {isSelected && <CheckIcon className="size-3" />}
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    {country.name}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {country.code}
                  </span>
                  {isSuggested && (
                    <span className="bg-muted text-muted-foreground rounded-full px-1.5 py-0.5 text-[10px]">
                      {t("onboarding.jurisdictionSuggested")}
                    </span>
                  )}
                </button>
                {isSelected && selected.length > 1 && (
                  <button
                    aria-label={t("onboarding.jurisdictionMakePrimary", {
                      name: country.name,
                    })}
                    className={cn(
                      "hover:bg-background/40 flex size-8 items-center justify-center rounded-md transition-colors",
                      isPrimary
                        ? "text-primary"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                    onClick={() => makePrimary(country.code)}
                    type="button"
                  >
                    <StarIcon
                      className={cn("size-4", isPrimary && "fill-current")}
                    />
                  </button>
                )}
              </div>
            );
          })}
        </div>

        <div className="mt-2 flex justify-between gap-2">
          <Button onClick={onSkip} type="button" variant="ghost">
            {t("onboarding.skipStep")}
          </Button>
          <Button
            disabled={selected.length === 0}
            onClick={onNext}
            type="button"
          >
            {t("common.next")}
          </Button>
        </div>
      </div>
    </>
  );
};

type JurisdictionGlobePreviewProps = {
  selected: readonly PracticeJurisdiction[];
  onChange?: (jurisdictions: PracticeJurisdiction[]) => void;
};

const GLOBE_PIXEL_SIZE = 440;

type RGB = [number, number, number];

// Resolves any CSS color expression — including var() chains, oklch(), color(),
// hex, rgb(), hsl() — to a normalized [r, g, b] in [0, 1].
//
// Tailwind v4 emits colour palette tokens as oklch() values, so naive regex
// parsing of getComputedStyle().color misses them. We let the browser do the
// conversion: probe the var via getComputedStyle to get a resolved color
// string, then paint it into a 1x1 canvas and read back the rgb pixel.
const readResolvedColor = (cssColor: string): RGB => {
  const probe = document.createElement("span");
  probe.style.cssText = `color: ${cssColor}; position: absolute; visibility: hidden; pointer-events: none;`;
  document.body.append(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();

  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return [0.5, 0.5, 0.5];
  }
  ctx.fillStyle = resolved;
  ctx.fillRect(0, 0, 1, 1);
  const data = ctx.getImageData(0, 0, 1, 1).data;
  return [
    (data[0] ?? 128) / 255,
    (data[1] ?? 128) / 255,
    (data[2] ?? 128) / 255,
  ];
};

const isDarkLuminance = ([r, g, b]: RGB): boolean =>
  0.2126 * r + 0.7152 * g + 0.0722 * b < 0.5;

type GlobeTheme = {
  baseColor: RGB;
  markerColor: RGB;
  glowColor: RGB;
  dark: 0 | 1;
};

// Mid-gray sphere reads as substantial in both themes; pure background gives
// a washed-out, low-presence look. cobe's `dark` flag still flips dot
// direction (dark dots on light themes, light dots on dark themes).
const SPHERE_MID_GRAY: RGB = [0.5, 0.5, 0.5];

// Stella brand blue from the favicon (#59a1d4). Not yet a design token;
// inline here until we formalise --brand-blue in globals.css.
const STELLA_BRAND_BLUE: RGB = [0x59 / 255, 0xa1 / 255, 0xd4 / 255];

const readGlobeTheme = (): GlobeTheme => {
  const background = readResolvedColor("var(--color-background)");
  const dark = isDarkLuminance(background) ? 1 : 0;
  return {
    baseColor: SPHERE_MID_GRAY,
    markerColor: STELLA_BRAND_BLUE,
    // glow matches the panel background so the rim halo blends seamlessly
    // instead of producing a visible darkening ring around the sphere.
    glowColor: background,
    dark,
  };
};

const longitudeToTargetPhi = (lon: number): number =>
  -Math.PI / 2 - (lon * Math.PI) / 180;

const shortestAngleDelta = (target: number, current: number): number =>
  Math.atan2(Math.sin(target - current), Math.cos(target - current));

export const JurisdictionGlobePreview = ({
  selected,
  onChange,
}: JurisdictionGlobePreviewProps) => {
  const t = useTranslations();
  const locale = useLocale();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const markersRef = useRef<{ location: [number, number]; size: number }[]>([]);
  const targetPhiRef = useRef<number | null>(null);
  const themeRef = useRef<GlobeTheme | null>(null);
  const [themeVersion, setThemeVersion] = useState(0);

  useEffect(() => {
    const target = document.documentElement;
    const observer = new MutationObserver(() => {
      setThemeVersion((v) => v + 1);
    });
    observer.observe(target, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const codeToPoint = new Map(
      COUNTRY_POINTS.map((point) => [point.code, point]),
    );
    markersRef.current = selected.flatMap((jurisdiction) => {
      const point = codeToPoint.get(jurisdiction.countryCode);
      if (!point) {
        return [];
      }
      return [
        {
          location: [point.lat, point.lon] as [number, number],
          size: jurisdiction.isPrimary ? 0.12 : 0.08,
        },
      ];
    });

    const focusJurisdiction =
      selected.find((jurisdiction) => jurisdiction.isPrimary) ?? selected.at(0);
    const focusPoint = focusJurisdiction
      ? codeToPoint.get(focusJurisdiction.countryCode)
      : undefined;
    targetPhiRef.current = focusPoint
      ? longitudeToTargetPhi(focusPoint.lon)
      : null;
  }, [selected]);

  useEffect(() => {
    const canvas = canvasRef.current;
    let cleanup = () => {
      // no globe was created
    };

    if (canvas) {
      themeRef.current = readGlobeTheme();
      const initialTheme = themeRef.current;
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      let phi = 0;
      let rafId = 0;

      const globe = createGlobe(canvas, {
        devicePixelRatio: pixelRatio,
        width: GLOBE_PIXEL_SIZE * pixelRatio,
        height: GLOBE_PIXEL_SIZE * pixelRatio,
        phi: 0,
        theta: 0.25,
        dark: initialTheme.dark,
        diffuse: 1.2,
        mapSamples: 16_000,
        mapBrightness: initialTheme.dark === 1 ? 4 : 2,
        baseColor: initialTheme.baseColor,
        markerColor: initialTheme.markerColor,
        glowColor: initialTheme.glowColor,
        opacity: 0.9,
        markers: markersRef.current,
      });

      const tick = () => {
        const theme = themeRef.current;
        globe.update({
          phi,
          markers: markersRef.current,
          ...(theme && {
            baseColor: theme.baseColor,
            markerColor: theme.markerColor,
            glowColor: theme.glowColor,
            dark: theme.dark,
            mapBrightness: theme.dark === 1 ? 4 : 2,
          }),
        });
        const target = targetPhiRef.current;
        if (target === null) {
          phi += 0.003;
        } else {
          const delta = shortestAngleDelta(target, phi);
          phi += delta * 0.05;
        }
        rafId = requestAnimationFrame(tick);
      };
      rafId = requestAnimationFrame(tick);

      canvas.style.opacity = "0";
      requestAnimationFrame(() => {
        canvas.style.opacity = "1";
      });

      cleanup = () => {
        cancelAnimationFrame(rafId);
        globe.destroy();
      };
    }

    return cleanup;
  }, []);

  useEffect(() => {
    themeRef.current = readGlobeTheme();
  }, [themeVersion]);

  return (
    <div className="flex flex-col items-center gap-6">
      <div
        className="relative"
        style={{ width: GLOBE_PIXEL_SIZE, height: GLOBE_PIXEL_SIZE }}
      >
        <canvas
          aria-label={t("onboarding.jurisdictionGlobeLabel")}
          className="block transition-opacity duration-700"
          ref={canvasRef}
          role="img"
          style={{
            width: GLOBE_PIXEL_SIZE,
            height: GLOBE_PIXEL_SIZE,
          }}
        />
      </div>

      <div className="flex h-24 w-full max-w-[480px] flex-wrap content-start justify-center gap-2">
        {selected.map((jurisdiction) => {
          const name = countryName(jurisdiction.countryCode, locale);
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
                <span className="bg-primary/10 text-primary rounded-full px-1.5 py-0.5 text-[10px]">
                  {t("onboarding.jurisdictionPrimary")}
                </span>
              )}
              {onChange && (
                <button
                  aria-label={t("onboarding.jurisdictionRemove", { name })}
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() =>
                    onChange(
                      removeJurisdiction(selected, jurisdiction.countryCode),
                    )
                  }
                  type="button"
                >
                  <XIcon className="size-3" />
                </button>
              )}
            </span>
          );
        })}
      </div>
    </div>
  );
};
