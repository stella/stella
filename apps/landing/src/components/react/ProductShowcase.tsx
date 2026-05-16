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
              className="showcase-tile min-w-[82%] snap-center self-start transition-[opacity,transform] duration-300 ease-out sm:min-w-[20rem] md:min-w-0"
              key={item.title}
            >
              <div
                className={cn(
                  "group border-border/45 relative flex aspect-[0.75] min-h-[20rem] items-center justify-center overflow-hidden rounded-[1.45rem] border bg-[color-mix(in_srgb,var(--background)_90%,var(--auth-gradient-end)_10%)] shadow-[0_14px_34px_-28px_rgba(0,0,0,0.16)] transition-[border-color,box-shadow,transform] duration-300 ease-out sm:min-h-[24rem]",
                )}
                data-showcase-shell
              >
                <Illustration />
                <div className="pointer-events-none absolute inset-0 rounded-[inherit] ring-1 ring-black/4 transition-opacity duration-300 group-hover:opacity-70 dark:ring-white/6" />
                <div className="pointer-events-none absolute inset-0 rounded-[inherit] opacity-0 transition-opacity duration-300 group-hover:opacity-100">
                  <div className="absolute inset-x-6 top-0 h-24 rounded-full bg-[linear-gradient(180deg,rgba(255,255,255,0.36),rgba(255,255,255,0))] blur-2xl dark:bg-[linear-gradient(180deg,rgba(255,255,255,0.12),rgba(255,255,255,0))]" />
                  <div className="absolute inset-0 rounded-[inherit] ring-1 ring-[color:color-mix(in_srgb,var(--auth-gradient-end)_56%,white_44%)] dark:ring-[color:color-mix(in_srgb,var(--auth-gradient-end)_52%,white_16%)]" />
                </div>
              </div>

              <div className="px-1 pt-4">
                <h3 className="showcase-title text-base font-medium tracking-tight transition-colors duration-300">
                  {item.title}
                </h3>
                <p className="showcase-description text-muted-foreground mt-2 text-sm leading-6 transition-colors duration-300">
                  {item.description}
                </p>
              </div>
            </article>
          );
        })}
      </div>

      <style>{`
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
      `}</style>
    </div>
  );
}

/**
 * Geometric abstractions for each capability.
 * Minimal wireframe illustrations using brand blues (hsl 204-215°).
 */

/** Tabular review: a grid of rows with status indicators */
function ReviewIllustration() {
  return (
    <svg viewBox="0 0 320 280" fill="none" className="h-full w-full">
      {/* Table header */}
      <rect
        x="40"
        y="40"
        width="240"
        height="28"
        rx="6"
        fill="currentColor"
        opacity="0.06"
      />
      <rect
        x="52"
        y="50"
        width="48"
        height="8"
        rx="3"
        fill="currentColor"
        opacity="0.15"
      />
      <rect
        x="120"
        y="50"
        width="32"
        height="8"
        rx="3"
        fill="currentColor"
        opacity="0.1"
      />
      <rect
        x="172"
        y="50"
        width="28"
        height="8"
        rx="3"
        fill="currentColor"
        opacity="0.1"
      />
      <rect
        x="220"
        y="50"
        width="44"
        height="8"
        rx="3"
        fill="currentColor"
        opacity="0.1"
      />
      {/* Rows */}
      {[0, 1, 2, 3, 4].map((i) => {
        const y = 80 + i * 36;
        const active = i === 1 || i === 3;
        return (
          <g key={i}>
            <rect
              x="40"
              y={y}
              width="240"
              height="28"
              rx="6"
              fill={active ? "#549CD1" : "currentColor"}
              opacity={active ? 0.08 : 0.03}
            />
            <rect
              x="52"
              y={y + 10}
              width={36 + ((i * 7) % 20)}
              height="8"
              rx="3"
              fill="currentColor"
              opacity={active ? 0.2 : 0.1}
            />
            <rect
              x="120"
              y={y + 10}
              width="24"
              height="8"
              rx="3"
              fill="currentColor"
              opacity={0.08}
            />
            <circle
              cx="184"
              cy={y + 14}
              r="4"
              fill={active ? "#549CD1" : "currentColor"}
              opacity={active ? 0.5 : 0.1}
            />
            <rect
              x="220"
              y={y + 10}
              width={20 + ((i * 11) % 24)}
              height="8"
              rx="3"
              fill="currentColor"
              opacity={0.08}
            />
          </g>
        );
      })}
    </svg>
  );
}

/** Template drafting: a document outline with fields and structure */
function DraftIllustration() {
  return (
    <svg viewBox="0 0 320 280" fill="none" className="h-full w-full">
      <rect
        x="60"
        y="30"
        width="200"
        height="220"
        rx="10"
        fill="currentColor"
        opacity="0.03"
        stroke="currentColor"
        strokeOpacity="0.08"
        strokeWidth="1"
      />
      <rect
        x="80"
        y="50"
        width="100"
        height="10"
        rx="4"
        fill="currentColor"
        opacity="0.15"
      />
      <line
        x1="80"
        y1="72"
        x2="240"
        y2="72"
        stroke="currentColor"
        strokeOpacity="0.06"
      />
      <rect
        x="80"
        y="84"
        width="40"
        height="6"
        rx="2"
        fill="currentColor"
        opacity="0.1"
      />
      <rect
        x="80"
        y="96"
        width="140"
        height="20"
        rx="5"
        fill="#549CD1"
        opacity="0.06"
        stroke="#549CD1"
        strokeOpacity="0.15"
        strokeWidth="1"
      />
      <rect
        x="90"
        y="103"
        width="60"
        height="6"
        rx="2"
        fill="#549CD1"
        opacity="0.2"
      />
      <rect
        x="80"
        y="128"
        width="36"
        height="6"
        rx="2"
        fill="currentColor"
        opacity="0.1"
      />
      <rect
        x="80"
        y="140"
        width="140"
        height="20"
        rx="5"
        fill="currentColor"
        opacity="0.03"
        stroke="currentColor"
        strokeOpacity="0.08"
        strokeWidth="1"
      />
      <rect
        x="90"
        y="147"
        width="80"
        height="6"
        rx="2"
        fill="currentColor"
        opacity="0.1"
      />
      <rect
        x="80"
        y="176"
        width="150"
        height="6"
        rx="2"
        fill="currentColor"
        opacity="0.08"
      />
      <rect
        x="80"
        y="188"
        width="130"
        height="6"
        rx="2"
        fill="currentColor"
        opacity="0.06"
      />
      <rect
        x="80"
        y="200"
        width="144"
        height="6"
        rx="2"
        fill="currentColor"
        opacity="0.06"
      />
      <rect
        x="80"
        y="212"
        width="90"
        height="6"
        rx="2"
        fill="currentColor"
        opacity="0.05"
      />
      <rect
        x="80"
        y="176"
        width="1.5"
        height="14"
        rx="0.5"
        fill="#549CD1"
        opacity="0.4"
      />
    </svg>
  );
}

/** Grounded research: connected nodes (citation constellation) */
function ResearchIllustration() {
  const nodes = [
    { x: 160, y: 100, r: 10, primary: true },
    { x: 90, y: 70, r: 6, primary: false },
    { x: 230, y: 80, r: 7, primary: false },
    { x: 110, y: 160, r: 8, primary: true },
    { x: 210, y: 170, r: 6, primary: false },
    { x: 160, y: 210, r: 5, primary: false },
    { x: 70, y: 130, r: 5, primary: false },
    { x: 250, y: 140, r: 5, primary: false },
  ];
  const edges = [
    [0, 1],
    [0, 2],
    [0, 3],
    [0, 4],
    [3, 5],
    [3, 6],
    [4, 5],
    [2, 7],
  ] as const;

  return (
    <svg viewBox="0 0 320 280" fill="none" className="h-full w-full">
      {edges.map(([a, b], i) => (
        <line
          key={`e${i}`}
          x1={nodes[a].x}
          y1={nodes[a].y}
          x2={nodes[b].x}
          y2={nodes[b].y}
          stroke="#549CD1"
          strokeOpacity="0.15"
          strokeWidth="1"
        />
      ))}
      {nodes.map((n, i) => (
        <g key={`n${i}`}>
          {n.primary && (
            <circle
              cx={n.x}
              cy={n.y}
              r={n.r + 8}
              fill="#549CD1"
              opacity="0.06"
            />
          )}
          <circle
            cx={n.x}
            cy={n.y}
            r={n.r}
            fill={n.primary ? "#549CD1" : "currentColor"}
            opacity={n.primary ? 0.3 : 0.1}
          />
          <rect
            x={n.x + n.r + 6}
            y={n.y - 3}
            width={n.primary ? 32 : 20}
            height="6"
            rx="2"
            fill="currentColor"
            opacity={n.primary ? 0.12 : 0.06}
          />
        </g>
      ))}
    </svg>
  );
}
