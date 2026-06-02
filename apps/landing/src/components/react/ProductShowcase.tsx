import { cn } from "@stll/ui/lib/utils";

import { primaryCapabilities } from "../../data/capabilities";

const illustrations = [
  ReviewIllustration,
  DraftIllustration,
  ResearchIllustration,
];

export default function ProductShowcase() {
  return (
    <div className="w-full">
      <div className="showcase-grid flex snap-x snap-mandatory gap-4 overflow-x-auto pb-1 md:grid md:grid-cols-3 md:items-start md:overflow-visible md:pb-0">
        {primaryCapabilities.map((item, index) => {
          const Illustration = illustrations[index];

          return (
            <article
              data-reveal
              className="showcase-tile min-w-[82%] snap-center self-start transition-[opacity,transform] duration-[500ms] ease-[cubic-bezier(0.22,1,0.36,1)] sm:min-w-[20rem] md:min-w-0"
              key={item.title}
            >
              <div
                className={cn(
                  "group border-border/45 relative flex aspect-square min-h-[15rem] items-center justify-center overflow-hidden rounded-[1.45rem] border backdrop-blur-md transition-[border-color,box-shadow,transform] duration-300 ease-out sm:min-h-[18rem]",
                )}
                data-showcase-shell
                style={{
                  background:
                    "color-mix(in srgb, var(--card) 78%, transparent)",
                  boxShadow:
                    "inset 0 1px 0 color-mix(in srgb, white 10%, transparent), 0 18px 40px -28px rgba(0, 0, 0, 0.28)",
                }}
              >
                {/* Glass light catch — brighter at top edge, fades down. */}
                <div
                  className="pointer-events-none absolute inset-0"
                  style={{
                    background:
                      "linear-gradient(180deg, color-mix(in srgb, white 7%, transparent) 0%, transparent 38%)",
                  }}
                  aria-hidden="true"
                />
                {/* Subtle bottom darkening — adds depth, like glass thickness. */}
                <div
                  className="pointer-events-none absolute inset-0"
                  style={{
                    background:
                      "linear-gradient(180deg, transparent 65%, color-mix(in srgb, black 14%, transparent) 100%)",
                  }}
                  aria-hidden="true"
                />
                <Illustration />
                <div className="pointer-events-none absolute inset-0 rounded-[inherit] ring-1 ring-black/4 transition-opacity duration-300 group-hover:opacity-70 dark:ring-white/6" />
                <div className="pointer-events-none absolute inset-0 rounded-[inherit] opacity-0 transition-opacity duration-300 group-hover:opacity-100">
                  <div className="absolute inset-x-6 top-0 h-24 rounded-full bg-[linear-gradient(180deg,rgba(255,255,255,0.36),rgba(255,255,255,0))] blur-2xl dark:bg-[linear-gradient(180deg,rgba(255,255,255,0.12),rgba(255,255,255,0))]" />
                  <div className="absolute inset-0 rounded-[inherit] ring-1 ring-[color:color-mix(in_srgb,var(--auth-gradient-end)_56%,white_44%)] dark:ring-[color:color-mix(in_srgb,var(--auth-gradient-end)_52%,white_16%)]" />
                </div>
              </div>

              <div className="px-1 pt-5">
                <h3 className="showcase-title font-display text-xl leading-tight font-medium tracking-tight transition-colors duration-300 sm:text-2xl">
                  <span
                    className="tabular-nums"
                    style={{ color: "var(--muted-foreground)" }}
                  >
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span
                    className="mx-2"
                    style={{ color: "var(--muted-foreground)" }}
                    aria-hidden="true"
                  >
                    —
                  </span>
                  {item.title}
                </h3>
                <p className="showcase-description text-muted-foreground mt-3 text-sm leading-[1.7] transition-colors duration-300">
                  {item.description}
                </p>
              </div>
            </article>
          );
        })}
      </div>

      <style>{`
        /* Stagger the per-tile reveal — set as CSS vars rather than
           inline style so the React type checker stays out of CSS
           variable territory. */
        .showcase-grid > .showcase-tile:nth-child(1) { --reveal-delay: 0ms; }
        .showcase-grid > .showcase-tile:nth-child(2) { --reveal-delay: 100ms; }
        .showcase-grid > .showcase-tile:nth-child(3) { --reveal-delay: 200ms; }

        @media (hover: hover) and (pointer: fine) {
          .showcase-grid:hover .showcase-tile {
            opacity: 0.88;
          }
          .showcase-grid:hover .showcase-tile:hover,
          .showcase-grid:hover .showcase-tile:focus-within {
            opacity: 1;
            transform: translateY(-1px);
          }
          .showcase-grid:hover .showcase-tile .showcase-title {
            color: color-mix(in srgb, var(--foreground) 74%, var(--muted-foreground) 26%);
          }
          .showcase-grid:hover .showcase-tile .showcase-description {
            color: color-mix(in srgb, var(--muted-foreground) 92%, transparent);
          }
          .showcase-grid:hover .showcase-tile:hover .showcase-title,
          .showcase-grid:hover .showcase-tile:focus-within .showcase-title {
            color: var(--foreground);
          }
          .showcase-grid:hover .showcase-tile:hover .showcase-description,
          .showcase-grid:hover .showcase-tile:focus-within .showcase-description {
            color: color-mix(in srgb, var(--foreground) 72%, var(--muted-foreground) 28%);
          }
          .showcase-grid:hover .showcase-tile:hover [data-showcase-shell],
          .showcase-grid:hover .showcase-tile:focus-within [data-showcase-shell] {
            border-color: color-mix(in srgb, var(--auth-gradient-end) 50%, var(--border) 50%);
            box-shadow: 0 18px 38px -30px rgba(0, 0, 0, 0.22);
          }
        }

        /* ——— Line-art illustrations ——— */

        /* The brand accent is on the scan line statically; the drafting
           cursor word is set dynamically per-frame by the rAF driver so
           the blue follows the active write/erase position. The sunburst
           rays' blue moment is set per-keyframe by the WAAPI driver. */
        .review-line .scan {
          stroke: #549CD1;
          filter: drop-shadow(0 0 7px rgba(84, 156, 209, 0.55));
        }
      `}</style>
    </div>
  );
}

/**
 * Line-art glyphs. Pure strokes, no fills, no fake UI.
 * The illustrations sit centered with generous negative space.
 */

/** Tabular review: lines light up to white as the scan passes; all fade together at cycle end. */
function ReviewIllustration() {
  const lines = Array.from({ length: 6 }, (_, i) => 80 + i * 28);
  return (
    <svg
      viewBox="0 0 320 280"
      fill="none"
      className="review-line h-full w-full"
    >
      {lines.map((y) => (
        <line
          key={y}
          className="line"
          x1="60"
          y1={y}
          x2="260"
          y2={y}
          stroke="currentColor"
          strokeOpacity="0.32"
          strokeWidth="1.25"
          strokeLinecap="round"
        />
      ))}
      <line
        className="scan"
        x1="60"
        y1="80"
        x2="260"
        y2="80"
        stroke="currentColor"
        strokeOpacity="1"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Drafting: short dashes grouped as "words" appear one at a time, building paragraphs. */
function DraftIllustration() {
  const startX = 60;
  const gap = 8;
  const lineSpec: { y: number; words: number[] }[] = [
    { y: 100, words: [20, 14, 28, 12, 22, 16] },
    { y: 130, words: [16, 26, 14, 32, 12, 20] },
    { y: 160, words: [22, 16, 28, 14, 18, 26] },
    { y: 190, words: [18, 28, 14, 22] },
  ];

  type Word = { idx: number; y: number; x1: number; x2: number };
  const words: Word[] = [];
  let counter = 0;
  for (const line of lineSpec) {
    let x = startX;
    for (const w of line.words) {
      words.push({ idx: counter, y: line.y, x1: x, x2: x + w });
      x += w + gap;
      counter += 1;
    }
  }

  return (
    <svg viewBox="0 0 320 280" fill="none" className="draft-line h-full w-full">
      {words.map((w) => (
        <line
          key={w.idx}
          className="word"
          data-word-idx={w.idx}
          x1={w.x1}
          y1={w.y}
          x2={w.x2}
          y2={w.y}
          stroke="currentColor"
          strokeOpacity="0.9"
          strokeWidth="1.25"
          strokeLinecap="round"
        />
      ))}
    </svg>
  );
}

/** Grounded research: sunburst with varied ray lengths; spotlight sweep brightens each ray to blue. */
function ResearchIllustration() {
  const rayCount = 16;
  const cx = 160;
  const cy = 140;
  const inner = 20;
  return (
    <svg
      viewBox="0 0 320 280"
      fill="none"
      className="research-burst h-full w-full"
    >
      {Array.from({ length: rayCount }, (_, i) => {
        const angle = (i / rayCount) * Math.PI * 2 - Math.PI / 2;
        // Deterministic length variance so the burst feels hand-drawn.
        const variance = ((i * 11 + 3) % 7) / 7;
        const outer = 56 + variance * 24;
        const x1 = cx + Math.cos(angle) * inner;
        const y1 = cy + Math.sin(angle) * inner;
        const x2 = cx + Math.cos(angle) * outer;
        const y2 = cy + Math.sin(angle) * outer;
        return (
          <line
            key={i}
            className="ray"
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            stroke="currentColor"
            strokeOpacity="0.25"
            strokeWidth="1.25"
            strokeLinecap="round"
          />
        );
      })}
    </svg>
  );
}
