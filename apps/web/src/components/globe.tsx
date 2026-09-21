import { useRef, useState } from "react";

import createGlobe from "cobe";

import { cn } from "@stll/ui/utils";

import { useExternalSyncEffect, useMountEffect } from "@/hooks/use-effect";

export type GlobeMarker = {
  /** Latitude, then longitude, in degrees. */
  location: [number, number];
  /** cobe's marker radius, a fraction of the sphere; 0.03 is a pin, 0.15 a blot. */
  size: number;
  /** A six-digit hex colour of its own; without one, the marker is brand blue. */
  color?: string;
};

/** A six-digit hex colour as cobe takes it: three channels in [0, 1]. */
const hexToRgb = (hex: string): RGB => {
  const digits = hex.replace("#", "");
  const channel = (offset: number): number =>
    Number.parseInt(digits.slice(offset, offset + 2), 16) / 255;
  return [channel(0), channel(2), channel(4)];
};

type CobeMarker = {
  location: [number, number];
  size: number;
  color?: [number, number, number];
};

const toCobeMarker = ({ color, location, size }: GlobeMarker): CobeMarker =>
  color === undefined
    ? { location, size }
    : { location, size, color: hexToRgb(color) };

type GlobeProps = {
  markers: readonly GlobeMarker[];
  /**
   * The longitude to turn toward and hold, or null to keep the sphere turning.
   * Changing it eases the sphere round rather than jumping.
   */
  focusLongitude: number | null;
  /**
   * How far the sphere leans toward the reader, in radians: 0 faces the
   * equator, about 0.85 puts fifty degrees north at the centre.
   */
  tilt: number;
  /** The canvas's side in CSS pixels. */
  size: number;
  /**
   * How much of the canvas the sphere fills: 1 fits it, above 1 crops the
   * rim. A cropped sphere wants a round clip on `className`, or it ends at
   * the canvas's square edge.
   */
  scale: number;
  /** What the picture shows, for readers who cannot see it. */
  label: string;
  className?: string;
};

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

// Stella brand blue from the favicon. Not yet a design token; inline here
// until we formalise --brand-blue in the design-system theme.
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

/**
 * A slowly turning dotted globe with markers on it, drawn by cobe on a
 * canvas. One drawing for every surface that puts places on a sphere, so
 * they share the sphere, the marker colour and the theme handling.
 *
 * The markers and the focus live in refs the animation frame reads, so a
 * change to either reaches the next frame without rebuilding the globe.
 */
export const Globe = ({
  className,
  focusLongitude,
  label,
  markers,
  scale,
  size,
  tilt,
}: GlobeProps) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const markersRef = useRef<CobeMarker[]>([]);
  const targetPhiRef = useRef<number | null>(null);
  const themeRef = useRef<GlobeTheme | null>(null);
  const [themeVersion, setThemeVersion] = useState(0);

  useMountEffect(() => {
    const target = document.documentElement;
    const observer = new MutationObserver(() => {
      setThemeVersion((v) => v + 1);
    });
    observer.observe(target, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  });

  useExternalSyncEffect(() => {
    markersRef.current = markers.map(toCobeMarker);
    targetPhiRef.current =
      focusLongitude === null ? null : longitudeToTargetPhi(focusLongitude);
  }, [focusLongitude, markers]);

  useMountEffect(() => {
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
        width: size * pixelRatio,
        height: size * pixelRatio,
        phi: 0,
        theta: tilt,
        dark: initialTheme.dark,
        diffuse: 1.2,
        mapSamples: 16_000,
        mapBrightness: initialTheme.dark === 1 ? 4 : 2,
        baseColor: initialTheme.baseColor,
        markerColor: initialTheme.markerColor,
        glowColor: initialTheme.glowColor,
        opacity: 0.9,
        scale,
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
  });

  useExternalSyncEffect(() => {
    themeRef.current = readGlobeTheme();
  }, [themeVersion]);

  return (
    <div
      className={cn("relative", className)}
      style={{ width: size, height: size }}
    >
      <canvas
        aria-label={label}
        className="block transition-opacity duration-700"
        ref={canvasRef}
        role="img"
        style={{ width: size, height: size }}
      />
    </div>
  );
};
