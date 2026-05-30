import { useEffect, useRef, useState } from "react";

import createGlobe from "cobe";
import { XIcon } from "lucide-react";
import { useLocale, useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { cn } from "@stll/ui/lib/utils";

import { JurisdictionPicker } from "@/components/jurisdiction-picker";
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

      <div className="mt-7 flex flex-col gap-4">
        <JurisdictionPicker
          onChange={onChange}
          selected={selected}
          suggestedCountryCodes={suggestedCountryCodes}
        />

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
