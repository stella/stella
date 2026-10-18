"use client";

import { useState } from "react";

import { cn } from "../lib/utils";

type Glyph = { char: string; enters: boolean; key: string };

type GlyphState = { generation: number; glyphs: Glyph[]; value: string };

/**
 * Aligns characters from the end, where digits keep their place value, so
 * 99 → 100 changes every glyph but 120 → 121 only the last one. An unchanged
 * glyph keeps its key and therefore its DOM node: it never replays its fade.
 */
const toGlyphs = (
  value: string,
  previous: readonly Glyph[] | null,
  generation: number,
): Glyph[] => {
  const chars = Array.from(value);
  return chars.map((char, index) => {
    const fromEnd = chars.length - index;
    const priorIndex = previous === null ? -1 : previous.length - fromEnd;
    const prior = priorIndex >= 0 ? previous?.[priorIndex] : undefined;
    if (prior?.char === char) {
      return prior;
    }
    return { char, enters: previous !== null, key: `${generation}:${fromEnd}` };
  });
};

/**
 * A formatted number whose changed characters fade in. The caller formats
 * (locale digits, units); the glyphs stay plain inline text so bidirectional
 * ordering is the browser's, and only opacity moves. The first render is
 * still: a count that loads does not announce itself.
 */
const AnimatedCount = ({
  className,
  value,
}: {
  className?: string;
  value: string;
}) => {
  const [state, setState] = useState<GlyphState>(() => ({
    generation: 0,
    glyphs: toGlyphs(value, null, 0),
    value,
  }));
  let { glyphs } = state;
  if (state.value !== value) {
    const generation = state.generation + 1;
    glyphs = toGlyphs(value, state.glyphs, generation);
    setState({ generation, glyphs, value });
  }

  return (
    <span className={cn("tabular-nums", className)} data-slot="animated-count">
      <span className="sr-only">{value}</span>
      <span aria-hidden="true">
        {glyphs.map((glyph) => (
          <span
            className={cn(glyph.enters && "motion-safe:animate-text-fade")}
            key={glyph.key}
          >
            {glyph.char}
          </span>
        ))}
      </span>
    </span>
  );
};

export { AnimatedCount };
