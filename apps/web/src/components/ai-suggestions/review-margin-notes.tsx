/**
 * Margin-notes reading mode: the document keeps the page, and the findings
 * become sidenotes pinned beside the clauses they are about.
 *
 * The panel and the main-pane arrangements both ask the reviewer to hold a
 * clause in their head while they read about it. Tufte's sidenote does not:
 * the note is level with the passage, and the eye travels sideways instead of
 * back and forth. That only works if the notes actually track the page, so
 * every scroll frame re-reads where folio painted each cited block and lays
 * the column out in one pass.
 *
 * Performance shape: no note owns React state, and no note measures itself.
 * One rAF-throttled pass reads every rect, hands them to `layoutMarginNotes`,
 * and writes one `transform` per note. React state changes only when the count
 * of notes off either edge changes, which is a few times per document.
 */

import { useRef, useState } from "react";
import type { RefObject } from "react";

import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";

import type { DocxEditorRef, FolioAIBlock } from "@stll/folio-react";
import { BidiText } from "@stll/ui/bidi-text";
import { cn } from "@stll/ui/utils";

import { layoutMarginNotes } from "@/components/ai-suggestions/review-margin-notes.logic";
import {
  folioLayoutBlockElement,
  folioScrollRoot,
} from "@/components/docx/folio-block-geometry";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { useFormatter } from "@/i18n/formatting-context";

// TODO(i18n): English until the review surface is localized as a whole.
const MARGIN_NOTES_LABEL = "Findings beside the clauses they are about";
const NOTES_ABOVE_LABEL = (count: string): string => `${count} above`;
const NOTES_BELOW_LABEL = (count: string): string => `${count} below`;
const UNANCHORED_GROUP_LABEL = "Not tied to a clause";
const DOCUMENT_NOT_READ_LABEL =
  "Open the document in the main pane to pin the findings beside it.";

/** The least space between two notes, in px. Below this they read as one. */
const NOTE_GAP = 10;
/** How long to wait for folio's scroll container before giving up, in frames.
 *  A large DOCX takes a while to parse; a missing editor never arrives. */
const SCROLL_ROOT_FRAME_BUDGET = 600;
/** Marks a note element for the layout pass, which reads them out of the DOM
 *  rather than holding a ref per note. */
const NOTE_ELEMENT_SELECTOR = "[data-margin-note]";

export type ReviewMarginNote = {
  id: string;
  /** The cited clause of the reviewed document. */
  blockId: string;
  title: string;
  /** The judgment in one word or phrase: `Unfavourable`, `Missing`. */
  label: string;
  /** The one caption sentence, when the finding has one. */
  caption: string | null;
  /** Painted in the one accent the strip and the notes share. */
  accent: boolean;
};

type ReviewMarginNotesProps = {
  /** Findings with a target citation, in the order the list reads them. */
  notes: readonly ReviewMarginNote[];
  /** Findings citing nothing in the document — a missing clause has no place
   *  to point at — listed under the column rather than dropped. */
  unanchored: readonly Omit<ReviewMarginNote, "blockId">[];
  /** The reviewed document's blocks, in document order. */
  blocks: readonly FolioAIBlock[];
  editorRef: RefObject<DocxEditorRef | null>;
  /** Open the full card: back to the panel, focused on this finding. */
  onOpen: (findingId: string) => void;
  onScrollToBlock: (blockId: string) => void;
};

type ColumnEdges = { aboveIds: readonly string[]; belowIds: readonly string[] };

const NO_EDGES: ColumnEdges = { aboveIds: [], belowIds: [] };

const sameIds = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length &&
  left.every((id, index) => id === right[index]);

export const ReviewMarginNotes = ({
  notes,
  unanchored,
  blocks,
  editorRef,
  onOpen,
  onScrollToBlock,
}: ReviewMarginNotesProps) => {
  const columnRef = useRef<HTMLUListElement | null>(null);
  const [edges, setEdges] = useState<ColumnEdges>(NO_EDGES);
  const blockIndexById = new Map(
    blocks.map((block, index) => [block.id, index]),
  );
  const noteById = new Map(notes.map((note) => [note.id, note]));

  /**
   * One pass: read every rect, place them, write one transform each. Held
   * through `useLatestCallback` so the scroll subscription below is set up
   * once per editor rather than re-registered on every render.
   */
  const relayout = useLatestCallback(() => {
    const column = columnRef.current;
    const root = folioScrollRoot(editorRef);
    if (column === null || root === null) {
      return;
    }
    const elements = new Map<string, HTMLElement>();
    for (const element of column.querySelectorAll<HTMLElement>(
      NOTE_ELEMENT_SELECTOR,
    )) {
      const id = element.dataset["marginNote"];
      if (id !== undefined) {
        elements.set(id, element);
      }
    }
    const columnTop = column.getBoundingClientRect().top;
    const anchors = notes.map((note) => {
      const index = blockIndexById.get(note.blockId);
      const painted =
        index === undefined ? null : folioLayoutBlockElement(root, index);
      return {
        id: note.id,
        anchorTop:
          painted === null
            ? null
            : painted.getBoundingClientRect().top - columnTop,
        height: elements.get(note.id)?.offsetHeight ?? 0,
      };
    });

    const { placements, aboveIds, belowIds } = layoutMarginNotes({
      anchors,
      viewportHeight: column.clientHeight,
      gap: NOTE_GAP,
    });

    const placed = new Set<string>();
    for (const { id, top } of placements) {
      const element = elements.get(id);
      if (element === undefined) {
        continue;
      }
      element.style.transform = `translateY(${String(Math.round(top))}px)`;
      element.style.visibility = "visible";
      placed.add(id);
    }
    for (const [id, element] of elements) {
      if (!placed.has(id)) {
        element.style.visibility = "hidden";
      }
    }

    // The only React state the column keeps: returning `prev` unchanged is
    // what stops a scroll frame from re-rendering the whole panel.
    setEdges((previous) =>
      sameIds(previous.aboveIds, aboveIds) &&
      sameIds(previous.belowIds, belowIds)
        ? previous
        : { aboveIds, belowIds },
    );
  });

  // The column is only in the DOM once the document's block order has
  // arrived, so the subscription waits for it rather than attaching to an
  // element that is not there yet.
  const columnMounted = blocks.length > 0;

  useExternalSyncEffect(() => {
    if (!columnMounted) {
      return undefined;
    }
    const abort = new AbortController();
    let frame: number | null = null;
    let attach: number | null = null;
    let framesLeft = SCROLL_ROOT_FRAME_BUDGET;

    const schedule = () => {
      if (frame !== null || abort.signal.aborted) {
        return;
      }
      frame = requestAnimationFrame(() => {
        frame = null;
        relayout();
      });
    };

    const observer = new ResizeObserver(schedule);
    const tryAttach = () => {
      attach = null;
      if (abort.signal.aborted) {
        return;
      }
      const root = folioScrollRoot(editorRef);
      if (root === null) {
        framesLeft -= 1;
        if (framesLeft > 0) {
          attach = requestAnimationFrame(tryAttach);
        }
        return;
      }
      // Passive: the notes follow the page, they never steer it.
      root.addEventListener("scroll", schedule, {
        passive: true,
        signal: abort.signal,
      });
      window.addEventListener("resize", schedule, {
        passive: true,
        signal: abort.signal,
      });
      // Repagination and a resized inspector move the anchors without a
      // scroll event of their own.
      observer.observe(root);
      const column = columnRef.current;
      if (column !== null) {
        observer.observe(column);
      }
      schedule();
    };
    tryAttach();

    return () => {
      abort.abort();
      observer.disconnect();
      if (frame !== null) {
        cancelAnimationFrame(frame);
      }
      if (attach !== null) {
        cancelAnimationFrame(attach);
      }
    };
  }, [columnMounted, editorRef, relayout]);

  // A note that arrives, leaves, or changes height has to be re-placed even
  // when nothing scrolled. Keyed by value so a re-render alone does not
  // re-measure the column.
  const noteKey = notes.map((note) => note.id).join("|");
  useExternalSyncEffect(() => {
    relayout();
  }, [columnMounted, noteKey, relayout]);

  if (!columnMounted) {
    return (
      <p className="text-muted-foreground px-3 py-6 text-center text-xs text-pretty">
        {DOCUMENT_NOT_READ_LABEL}
      </p>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative min-h-0 flex-1">
        <ul
          aria-label={MARGIN_NOTES_LABEL}
          className="absolute inset-0 overflow-hidden"
          ref={columnRef}
        >
          {notes.map((note) => (
            <MarginNote key={note.id} note={note} onOpen={onOpen} />
          ))}
        </ul>
        <EdgePill
          direction="above"
          ids={edges.aboveIds}
          onScrollTo={(id) => {
            const note = noteById.get(id);
            if (note !== undefined) {
              onScrollToBlock(note.blockId);
            }
          }}
        />
        <EdgePill
          direction="below"
          ids={edges.belowIds}
          onScrollTo={(id) => {
            const note = noteById.get(id);
            if (note !== undefined) {
              onScrollToBlock(note.blockId);
            }
          }}
        />
      </div>
      {unanchored.length > 0 && (
        <section className="max-h-48 shrink-0 overflow-y-auto border-t px-2 py-2">
          <h3 className="text-muted-foreground mb-1 px-1 text-[11px] font-medium tracking-wide uppercase">
            {UNANCHORED_GROUP_LABEL}
          </h3>
          <ul className="space-y-1">
            {unanchored.map((note) => (
              <li key={note.id}>
                <MarginNoteBody note={note} onOpen={onOpen} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
};

/**
 * One sidenote. It carries no `style` prop on purpose: the layout pass owns
 * `transform` and `visibility`, and a React-managed style object would fight
 * it on every render.
 */
const MarginNote = ({
  note,
  onOpen,
}: {
  note: ReviewMarginNote;
  onOpen: (findingId: string) => void;
}) => (
  <li
    className="invisible absolute start-0 end-0 top-0 will-change-transform"
    data-margin-note={note.id}
  >
    <MarginNoteBody note={note} onOpen={onOpen} />
  </li>
);

const MarginNoteBody = ({
  note,
  onOpen,
}: {
  note: Omit<ReviewMarginNote, "blockId">;
  onOpen: (findingId: string) => void;
}) => (
  <button
    className={cn(
      "hover:bg-muted/70 focus-visible:ring-ring flex min-h-11 w-full flex-col justify-center gap-0.5 border-s-2 px-2.5 py-1.5 text-start transition-colors focus-visible:ring-2 focus-visible:outline-none",
      note.accent ? "border-destructive" : "border-border",
    )}
    onClick={() => onOpen(note.id)}
    type="button"
  >
    <BidiText
      as="span"
      className="text-foreground text-xs leading-5 font-medium"
    >
      {note.title}
    </BidiText>
    <span className="text-muted-foreground text-[11px] leading-4">
      {note.label}
    </span>
    {note.caption !== null && (
      <BidiText
        as="span"
        className="text-muted-foreground line-clamp-3 text-[11px] leading-4 text-pretty"
      >
        {note.caption}
      </BidiText>
    )}
  </button>
);

/** How many findings sit past one edge of the column, and the way back to the
 *  nearest of them. Total over the two edges so neither can be added without
 *  its own placement and glyph. */
const EDGE_PILL = {
  above: { icon: ChevronUpIcon, position: "top-1", label: NOTES_ABOVE_LABEL },
  below: {
    icon: ChevronDownIcon,
    position: "bottom-1",
    label: NOTES_BELOW_LABEL,
  },
} as const satisfies Record<
  "above" | "below",
  {
    icon: typeof ChevronUpIcon;
    position: string;
    label: (count: string) => string;
  }
>;

const EdgePill = ({
  direction,
  ids,
  onScrollTo,
}: {
  direction: keyof typeof EDGE_PILL;
  ids: readonly string[];
  onScrollTo: (findingId: string) => void;
}) => {
  const format = useFormatter();
  const nearest = ids.at(0);
  if (nearest === undefined) {
    return null;
  }
  const { icon: Icon, position, label } = EDGE_PILL[direction];

  return (
    <div
      className={cn(
        "pointer-events-none absolute start-0 end-0 flex justify-center",
        position,
      )}
    >
      <button
        // The pill stays small; its target does not. The pseudo-element
        // widens the hit area without moving the pill or its neighbours.
        className="bg-background/90 text-muted-foreground hover:text-foreground focus-visible:ring-ring pointer-events-auto relative flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] tabular-nums shadow-xs backdrop-blur transition-colors before:absolute before:-inset-2.5 before:content-[''] focus-visible:ring-2 focus-visible:outline-none"
        onClick={() => onScrollTo(nearest)}
        type="button"
      >
        <Icon className="size-3" />
        {label(format.number(ids.length))}
      </button>
    </div>
  );
};
