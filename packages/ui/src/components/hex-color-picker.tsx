/**
 * Hex color picker — saturation/brightness square + hue strip.
 *
 * Adapted from react-colorful (MIT, Copyright 2020 Vlad Shilov).
 * https://github.com/omgovich/react-colorful
 *
 * Changes from upstream:
 * - Trimmed to hex-only (no RGB/HSL/alpha variants)
 * - Dropped React.memo, useMemo, useCallback (React Compiler handles this)
 * - Converted CSS classes to Tailwind
 * - Merged small utility files into one module
 * - Strict TypeScript (no `any`, no enums)
 * - Arrow functions per project conventions
 */

"use client";

import type * as React from "react";
import { useEffect, useRef, useState } from "react";

import { cn } from "@stll/ui/lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type HsvaColor = { h: number; s: number; v: number; a: number };
type RgbaColor = { r: number; g: number; b: number; a: number };
type Interaction = { left: number; top: number };

type HexColorPickerProps = {
  /** Hex color with or without # (e.g. "#ff0000" or "FF0000") */
  color?: string | undefined;
  onChange?: (hex: string) => void;
  className?: string;
};

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------

const clamp = (n: number, min = 0, max = 1): number =>
  n > max ? max : n < min ? min : n;

const round = (n: number, digits = 0): number => {
  const base = 10 ** digits;
  return Math.round(base * n) / base;
};

// ---------------------------------------------------------------------------
// Color conversion (hex ↔ HSVA, only what we need)
// ---------------------------------------------------------------------------

const hexToRgba = (hex: string): RgbaColor => {
  const h = hex.startsWith("#") ? hex.slice(1) : hex;
  if (h.length < 6) {
    const r0 = h.charAt(0);
    const g0 = h.charAt(1);
    const b0 = h.charAt(2);
    return {
      r: Number.parseInt(r0 + r0, 16),
      g: Number.parseInt(g0 + g0, 16),
      b: Number.parseInt(b0 + b0, 16),
      a: 1,
    };
  }
  return {
    r: Number.parseInt(h.slice(0, 2), 16),
    g: Number.parseInt(h.slice(2, 4), 16),
    b: Number.parseInt(h.slice(4, 6), 16),
    a: 1,
  };
};

const rgbaToHsva = ({ r, g, b, a }: RgbaColor): HsvaColor => {
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  const hh = delta
    ? max === r
      ? (g - b) / delta
      : max === g
        ? 2 + (b - r) / delta
        : 4 + (r - g) / delta
    : 0;

  return {
    h: round(60 * (hh < 0 ? hh + 6 : hh)),
    s: round(max ? (delta / max) * 100 : 0),
    v: round((max / 255) * 100),
    a,
  };
};

const hexToHsva = (hex: string): HsvaColor => rgbaToHsva(hexToRgba(hex));

const hsvaToRgba = ({ h, s, v, a }: HsvaColor): RgbaColor => {
  const hNorm = (h / 360) * 6;
  const sNorm = s / 100;
  const vNorm = v / 100;
  const hFloor = Math.floor(hNorm);
  const bVal = vNorm * (1 - sNorm);
  const cVal = vNorm * (1 - (hNorm - hFloor) * sNorm);
  const dVal = vNorm * (1 - (1 - hNorm + hFloor) * sNorm);
  const mod = hFloor % 6;

  const rLookup = [vNorm, cVal, bVal, bVal, dVal, vNorm];
  const gLookup = [dVal, vNorm, vNorm, cVal, bVal, bVal];
  const bLookup = [bVal, bVal, dVal, vNorm, vNorm, cVal];

  return {
    r: round((rLookup[mod] ?? 0) * 255),
    g: round((gLookup[mod] ?? 0) * 255),
    b: round((bLookup[mod] ?? 0) * 255),
    a: round(a, 2),
  };
};

const formatHexByte = (n: number): string => {
  const hex = n.toString(16);
  return hex.length < 2 ? `0${hex}` : hex;
};

const rgbaToHex = ({ r, g, b }: RgbaColor): string =>
  `#${formatHexByte(r)}${formatHexByte(g)}${formatHexByte(b)}`;

const hsvaToHex = (hsva: HsvaColor): string => rgbaToHex(hsvaToRgba(hsva));

const hsvaToHsla = ({ h, s, v, a }: HsvaColor) => {
  const hh = ((200 - s) * v) / 100;
  return {
    h: round(h),
    s: round(
      hh > 0 && hh < 200
        ? ((s * v) / 100 / (hh <= 100 ? hh : 200 - hh)) * 100
        : 0,
    ),
    l: round(hh / 2),
    a: round(a, 2),
  };
};

const hsvaToHslString = (hsva: HsvaColor): string => {
  const { h, s, l } = hsvaToHsla(hsva);
  return `hsl(${h}, ${s}%, ${l}%)`;
};

const equalHex = (a: string, b: string): boolean => {
  if (a.toLowerCase() === b.toLowerCase()) {
    return true;
  }
  const ra = hexToRgba(a);
  const rb = hexToRgba(b);
  return ra.r === rb.r && ra.g === rb.g && ra.b === rb.b && ra.a === rb.a;
};

const equalHsva = (a: HsvaColor, b: HsvaColor): boolean =>
  a.h === b.h && a.s === b.s && a.v === b.v && a.a === b.a;

// ---------------------------------------------------------------------------
// useEventCallback — stable ref for callbacks
// ---------------------------------------------------------------------------

const useEventCallback = <T,>(
  handler?: (value: T) => void,
): ((value: T) => void) => {
  const callbackRef = useRef(handler);
  const fn = useRef((value: T) => {
    callbackRef.current?.(value);
  });
  callbackRef.current = handler;
  return fn.current;
};

// ---------------------------------------------------------------------------
// useColorManipulation — bidirectional hex ↔ HSVA sync
// ---------------------------------------------------------------------------

const useColorManipulation = (
  color: string,
  onChange?: (hex: string) => void,
): [HsvaColor, (params: Partial<HsvaColor>) => void] => {
  const onChangeCallback = useEventCallback<string>(onChange);
  const [hsva, setHsva] = useState<HsvaColor>(() => hexToHsva(color));
  const cache = useRef({ color, hsva });

  // Sync inbound color prop → internal HSVA
  useEffect(() => {
    if (!equalHex(color, cache.current.color)) {
      const next = hexToHsva(color);
      cache.current = { hsva: next, color };
      setHsva(next);
    }
  }, [color]);

  // Sync internal HSVA → outbound onChange
  useEffect(() => {
    if (!equalHsva(hsva, cache.current.hsva)) {
      const hex = hsvaToHex(hsva);
      if (!equalHex(hex, cache.current.color)) {
        cache.current = { hsva, color: hex };
        onChangeCallback(hex);
      }
    }
  }, [hsva, onChangeCallback]);

  const handleChange = (params: Partial<HsvaColor>) => {
    setHsva((current) => ({ ...current, ...params }));
  };

  return [hsva, handleChange];
};

// ---------------------------------------------------------------------------
// Interactive — pointer/touch/keyboard interaction engine
// ---------------------------------------------------------------------------

const isTouch = (e: MouseEvent | TouchEvent): e is TouchEvent => "touches" in e;

const getTouchPoint = (touches: TouchList, id: number | null): Touch => {
  const found = Array.from(touches).find((t) => t.identifier === id);
  // SAFETY: callers only invoke this when touches.length > 0
  // eslint-disable-next-line typescript/no-non-null-assertion
  return found ?? touches.item(0)!;
};

const getParentWindow = (node?: HTMLDivElement | null): Window =>
  node?.ownerDocument.defaultView ?? self;

const getRelativePosition = (
  node: HTMLDivElement,
  event: MouseEvent | TouchEvent,
  touchId: number | null,
): Interaction => {
  const rect = node.getBoundingClientRect();
  const pointer = isTouch(event)
    ? getTouchPoint(event.touches, touchId)
    : event;
  const win = getParentWindow(node);
  return {
    left: clamp((pointer.pageX - (rect.left + win.pageXOffset)) / rect.width),
    top: clamp((pointer.pageY - (rect.top + win.pageYOffset)) / rect.height),
  };
};

const InteractiveArea = ({
  onMove,
  onKey,
  children,
  ...rest
}: {
  onMove: (interaction: Interaction) => void;
  onKey: (offset: Interaction) => void;
  children: React.ReactNode;
} & Omit<React.HTMLAttributes<HTMLDivElement>, "onKeyDown">) => {
  const container = useRef<HTMLDivElement>(null);
  const onMoveRef = useEventCallback<Interaction>(onMove);
  const onKeyRef = useEventCallback<Interaction>(onKey);
  const touchId = useRef<number | null>(null);
  const hasTouch = useRef(false);

  const listenersRef = useRef<{
    moveType: string;
    endType: string;
    handleMove: EventListener;
    handleEnd: EventListener;
    win: Window;
  } | null>(null);

  const detachListeners = () => {
    const l = listenersRef.current;
    if (!l) {
      return;
    }
    l.win.removeEventListener(l.moveType, l.handleMove);
    l.win.removeEventListener(l.endType, l.handleEnd);
    listenersRef.current = null;
  };

  const attachListeners = () => {
    detachListeners();
    const win = getParentWindow(container.current);
    const touch = hasTouch.current;
    const moveType = touch ? "touchmove" : "mousemove";
    const endType = touch ? "touchend" : "mouseup";

    const handleMove: EventListener = (event) => {
      // eslint-disable-next-line typescript/no-unsafe-type-assertion -- EventListener receives Event; we only attach to mouse/touch events
      const e = event as MouseEvent | TouchEvent;
      if (!isTouch(e)) {
        e.preventDefault();
      }
      const isDown = isTouch(e) ? e.touches.length > 0 : e.buttons > 0;
      if (isDown && container.current) {
        onMoveRef(getRelativePosition(container.current, e, touchId.current));
      } else {
        detachListeners();
      }
    };

    const handleEnd: EventListener = () => detachListeners();

    listenersRef.current = { moveType, endType, handleMove, handleEnd, win };
    win.addEventListener(moveType, handleMove);
    win.addEventListener(endType, handleEnd);
  };

  useEffect(() => detachListeners, []);

  const handleStart = (e: React.MouseEvent | React.TouchEvent) => {
    const el = container.current;
    if (!el) {
      return;
    }

    const native = e.nativeEvent;
    if (!isTouch(native)) {
      native.preventDefault();
    }
    if (hasTouch.current && !isTouch(native)) {
      return;
    }

    if (isTouch(native)) {
      hasTouch.current = true;
      const changed = native.changedTouches;
      const first = changed.item(0);
      if (first) {
        touchId.current = first.identifier;
      }
    }

    el.focus();
    onMoveRef(getRelativePosition(el, native, touchId.current));
    attachListeners();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    const key = e.key;
    if (
      key !== "ArrowLeft" &&
      key !== "ArrowRight" &&
      key !== "ArrowUp" &&
      key !== "ArrowDown"
    ) {
      return;
    }
    e.preventDefault();
    onKeyRef({
      left: key === "ArrowRight" ? 0.05 : key === "ArrowLeft" ? -0.05 : 0,
      top: key === "ArrowDown" ? 0.05 : key === "ArrowUp" ? -0.05 : 0,
    });
  };

  return (
    <div
      {...rest}
      className="absolute inset-0 touch-none rounded-[inherit] outline-none"
      onKeyDown={handleKeyDown}
      onMouseDown={handleStart}
      onTouchStart={handleStart}
      ref={container}
      // eslint-disable-next-line jsx-a11y/role-has-required-aria-props -- aria-value* props are passed via ...rest by callers
      role="slider"
      tabIndex={0}
    >
      {children}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Pointer — draggable circle
// ---------------------------------------------------------------------------

const Pointer = ({
  left,
  top = 0.5,
  color,
}: {
  left: number;
  top?: number;
  color: string;
}) => (
  <div
    className="absolute z-1 size-7 -translate-1/2 rounded-full border-2 border-white shadow-[0_2px_4px_rgba(0,0,0,0.2)]"
    style={{ top: `${top * 100}%`, left: `${left * 100}%` }}
  >
    <div
      className="absolute inset-0 rounded-full"
      style={{ backgroundColor: color }}
    />
  </div>
);

// ---------------------------------------------------------------------------
// Saturation — 2D brightness/saturation square
// ---------------------------------------------------------------------------

const Saturation = ({
  hsva,
  onChange,
}: {
  hsva: HsvaColor;
  onChange: (params: Partial<HsvaColor>) => void;
}) => {
  const handleMove = (interaction: Interaction) => {
    onChange({
      s: interaction.left * 100,
      v: 100 - interaction.top * 100,
    });
  };

  const handleKey = (offset: Interaction) => {
    onChange({
      s: clamp(hsva.s + offset.left * 100, 0, 100),
      v: clamp(hsva.v - offset.top * 100, 0, 100),
    });
  };

  return (
    <div
      className="relative grow rounded-t-lg border-b-[12px] border-b-black shadow-[inset_0_0_0_1px_rgba(0,0,0,0.05)]"
      style={{
        backgroundColor: hsvaToHslString({
          h: hsva.h,
          s: 100,
          v: 100,
          a: 1,
        }),
        backgroundImage:
          "linear-gradient(to top, #000, rgba(0,0,0,0)), linear-gradient(to right, #fff, rgba(255,255,255,0))",
      }}
    >
      <InteractiveArea
        aria-label="Color"
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={round(hsva.s)}
        aria-valuetext={`Saturation ${round(hsva.s)}%, Brightness ${round(hsva.v)}%`}
        onKey={handleKey}
        onMove={handleMove}
      >
        <Pointer
          color={hsvaToHslString(hsva)}
          left={hsva.s / 100}
          top={1 - hsva.v / 100}
        />
      </InteractiveArea>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Hue — horizontal hue strip
// ---------------------------------------------------------------------------

const HueStrip = ({
  hue,
  onChange,
}: {
  hue: number;
  onChange: (params: Partial<HsvaColor>) => void;
}) => {
  const handleMove = (interaction: Interaction) => {
    onChange({ h: 360 * interaction.left });
  };

  const handleKey = (offset: Interaction) => {
    onChange({ h: clamp(hue + offset.left * 360, 0, 360) });
  };

  return (
    <div
      className="relative h-6 rounded-b-lg"
      style={{
        background:
          "linear-gradient(to right, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%)",
      }}
    >
      <InteractiveArea
        aria-label="Hue"
        aria-valuemax={360}
        aria-valuemin={0}
        aria-valuenow={round(hue)}
        onKey={handleKey}
        onMove={handleMove}
      >
        <Pointer
          color={hsvaToHslString({ h: hue, s: 100, v: 100, a: 1 })}
          left={hue / 360}
        />
      </InteractiveArea>
    </div>
  );
};

// ---------------------------------------------------------------------------
// HexColorPicker (public)
// ---------------------------------------------------------------------------

const HexColorPicker = ({
  color = "000000",
  onChange,
  className,
}: HexColorPickerProps) => {
  const [hsva, updateHsva] = useColorManipulation(color, onChange);

  return (
    <div
      className={cn(
        "relative flex h-[200px] w-[200px] cursor-default flex-col select-none",
        className,
      )}
    >
      <Saturation hsva={hsva} onChange={updateHsva} />
      <HueStrip hue={hsva.h} onChange={updateHsva} />
    </div>
  );
};

export { HexColorPicker, type HexColorPickerProps };
