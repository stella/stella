import { CornerDownLeftIcon, SearchIcon } from "lucide-react";

import { cn } from "@stll/ui/utils";

/**
 * Three snippets copied from unrelated sources; oldest first. History
 * lists them newest first, as a clipboard manager does.
 */
const SNIPPETS = [
  {
    label: "A",
    chipClass: "bg-destructive text-destructive-foreground",
    selectionClass: "bg-destructive/10 ring-destructive/30",
    sourceWidths: ["w-full", "w-2/3"],
    historyWidth: "w-1/2",
  },
  {
    label: "B",
    chipClass: "bg-info text-info-foreground",
    selectionClass: "bg-info/10 ring-info/30",
    sourceWidths: ["w-3/4", "w-full"],
    historyWidth: "w-2/3",
  },
  {
    label: "C",
    chipClass: "bg-success text-success-foreground",
    selectionClass: "bg-success/10 ring-success/30",
    sourceWidths: ["w-full", "w-1/2"],
    historyWidth: "w-2/5",
  },
] as const;

type Snippet = (typeof SNIPPETS)[number];

const HISTORY = SNIPPETS.toReversed();

/** Timeline (ms): sources appear, selections pop, lines draw, key presses, history opens. */
const T = {
  source: 0,
  sourceStagger: 120,
  select: 500,
  selectStagger: 280,
  connectors: 1350,
  key: 1550,
  panel: 1750,
  row: 1950,
  rowStagger: 90,
} as const;

const ANIMATION_STYLE = `
@keyframes cwp-rise {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes cwp-pop {
  0% { opacity: 0; transform: scale(0.92); }
  60% { opacity: 1; transform: scale(1.03); }
  100% { opacity: 1; transform: scale(1); }
}
@keyframes cwp-draw {
  from { stroke-dashoffset: 1; }
  to { stroke-dashoffset: 0; }
}
@keyframes cwp-press {
  0% { opacity: 0; transform: translateY(-4px); }
  40% { opacity: 1; transform: translateY(0) scale(1); }
  60% { transform: translateY(1px) scale(0.96); }
  100% { opacity: 1; transform: translateY(0) scale(1); }
}
.cwp-rise { animation: cwp-rise 320ms ease-out both; }
.cwp-pop { animation: cwp-pop 360ms cubic-bezier(0.2, 0.8, 0.2, 1) both; }
.cwp-draw {
  stroke-dasharray: 1;
  stroke-dashoffset: 1;
  animation: cwp-draw 420ms ease-in-out both;
}
.cwp-press { animation: cwp-press 480ms ease-out both; }
@media (prefers-reduced-motion: reduce) {
  .cwp-rise, .cwp-pop, .cwp-press { animation: none; }
  .cwp-draw { animation: none; stroke-dashoffset: 0; }
}
`;

const delay = (ms: number) => ({ animationDelay: `${ms}ms` });

type ClipboardWorkflowPreviewProps = {
  copyShortcut: string;
  shortcut: string;
  title: string;
};

/**
 * Teaches the clipboard manager without prose: snippets A, B and C are
 * copied (copy key pressed) from three unrelated documents, the history
 * shortcut is pressed, and the same marked snippets reappear in a
 * searchable history.
 */
export const ClipboardWorkflowPreview = ({
  copyShortcut,
  shortcut,
  title,
}: ClipboardWorkflowPreviewProps) => (
  <div
    aria-hidden="true"
    className="bg-muted/40 relative overflow-hidden rounded-xl px-4 pt-4 pb-3"
  >
    <style>{ANIMATION_STYLE}</style>

    <div className="grid grid-cols-3 gap-3">
      {SNIPPETS.map((snippet, index) => (
        <SourceWindow
          copyShortcut={copyShortcut}
          index={index}
          key={snippet.label}
          snippet={snippet}
        />
      ))}
    </div>

    <div className="relative -mx-4 h-9">
      <svg
        className="text-border absolute inset-0 size-full"
        fill="none"
        preserveAspectRatio="none"
        viewBox="0 0 432 36"
      >
        {[
          "M72 0 C72 18 216 18 216 36",
          "M216 0 V36",
          "M360 0 C360 18 216 18 216 36",
        ].map((d) => (
          <path
            className="cwp-draw"
            d={d}
            key={d}
            pathLength={1}
            stroke="currentColor"
            strokeWidth={1}
            style={delay(T.connectors)}
          />
        ))}
      </svg>
      <kbd
        className="cwp-press bg-background text-foreground border-border/70 absolute start-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-md border px-2 py-0.5 font-mono text-[11px] shadow-[0_1px_0_var(--color-border)] rtl:translate-x-1/2"
        dir="ltr"
        style={delay(T.key)}
      >
        {shortcut}
      </kbd>
    </div>

    <div
      className="cwp-pop bg-background border-border/50 rounded-lg border shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_24px_rgb(0_0_0/0.08)]"
      style={delay(T.panel)}
    >
      <div className="border-border/50 flex items-center gap-2 border-b px-2.5 py-2">
        <SearchIcon className="text-muted-foreground size-3.5 shrink-0" />
        <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
          {title}
        </span>
      </div>
      <ul className="flex flex-col gap-0.5 p-1.5">
        {HISTORY.map((snippet, index) => (
          <li
            className={cn(
              "cwp-rise flex h-7 items-center gap-2 rounded-md px-2",
              index === 0 && "bg-accent",
            )}
            key={snippet.label}
            style={delay(T.row + index * T.rowStagger)}
          >
            <Chip snippet={snippet} />
            <span
              className={cn(
                "bg-foreground/15 h-1.5 rounded-full",
                snippet.historyWidth,
              )}
            />
            {index === 0 && (
              <CornerDownLeftIcon className="text-muted-foreground ms-auto size-3" />
            )}
          </li>
        ))}
      </ul>
    </div>
  </div>
);

const Chip = ({ snippet }: { snippet: Snippet }) => (
  <span
    className={cn(
      "grid size-4 shrink-0 place-items-center rounded-[4px] text-[10px] leading-none font-semibold",
      snippet.chipClass,
    )}
  >
    <bdi>{snippet.label}</bdi>
  </span>
);

const SourceWindow = ({
  copyShortcut,
  snippet,
  index,
}: {
  copyShortcut: string;
  snippet: Snippet;
  index: number;
}) => (
  <div
    className="cwp-rise bg-background border-border/50 min-w-0 rounded-lg border p-2 shadow-xs"
    style={delay(T.source + index * T.sourceStagger)}
  >
    <div className="mb-2 flex items-center gap-1">
      <span className="bg-muted-foreground/25 size-1.5 rounded-full" />
      <span className="bg-muted-foreground/25 size-1.5 rounded-full" />
      <span className="bg-muted-foreground/15 ms-1 h-1 w-1/3 rounded-full" />
      <kbd
        className="cwp-press bg-muted text-muted-foreground ms-auto rounded-[3px] px-1 py-px font-mono text-[9px] leading-none"
        dir="ltr"
        style={delay(T.select + index * T.selectStagger)}
      >
        {copyShortcut}
      </kbd>
    </div>
    <div className="flex flex-col gap-1.5">
      <span
        className={cn(
          "bg-muted-foreground/20 h-1 rounded-full",
          snippet.sourceWidths[0],
        )}
      />
      <span
        className={cn(
          "cwp-pop flex h-5 items-center gap-1 rounded-sm px-1 ring-1",
          snippet.selectionClass,
        )}
        style={delay(T.select + index * T.selectStagger)}
      >
        <Chip snippet={snippet} />
        <span className="bg-foreground/25 h-1 flex-1 rounded-full" />
      </span>
      <span
        className={cn(
          "bg-muted-foreground/20 h-1 rounded-full",
          snippet.sourceWidths[1],
        )}
      />
    </div>
  </div>
);
