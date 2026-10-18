"use client";

import { useState } from "react";

import { cn } from "../lib/utils";

type SwapState = {
  current: string;
  generation: number;
  previous: string | null;
};

/**
 * A short label that changes in place (a live status line): the old text
 * lifts out with a slight blur while the new one rises into the same cell,
 * so the change reads as one motion instead of a blink. Both layers share a
 * grid cell, so nothing reflows mid-swap. The first render is still, and
 * under reduced motion the label simply changes.
 */
const SwapText = ({
  className,
  text,
}: {
  /** Applied to the text inside each layer, so a text effect with its own
   *  animation (a shimmer) runs alongside the swap instead of replacing it. */
  className?: string;
  text: string;
}) => {
  const [state, setState] = useState<SwapState>({
    current: text,
    generation: 0,
    previous: null,
  });
  if (state.current !== text) {
    setState({
      current: text,
      generation: state.generation + 1,
      previous: state.current,
    });
  }
  const hasSwapped = state.generation > 0;

  return (
    <span className="inline-grid" data-slot="swap-text">
      {state.previous !== null && (
        <span
          aria-hidden="true"
          className="motion-safe:animate-swap-out col-start-1 row-start-1 motion-reduce:hidden"
          key={`out-${state.generation}`}
          onAnimationEnd={(event) => {
            // The caller's own text effect animates inside; only the
            // layer's exit ends the swap.
            if (event.target !== event.currentTarget) {
              return;
            }
            setState((current) =>
              current.generation === state.generation
                ? { ...current, previous: null }
                : current,
            );
          }}
        >
          <span className={className}>{state.previous}</span>
        </span>
      )}
      <span
        className={cn(
          "col-start-1 row-start-1",
          hasSwapped && "motion-safe:animate-swap-in",
        )}
        key={`in-${state.generation}`}
      >
        <span className={className}>{state.current}</span>
      </span>
    </span>
  );
};

export { SwapText };
