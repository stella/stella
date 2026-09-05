import type { UIEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import { panic } from "better-result";
import { useDebouncedCallback } from "use-debounce";

import type { ChatAnonPair } from "@stll/anonymize-chat";

import { runAnonymizeDemo } from "../anonymize-demo-worker-client";

/**
 * Live, in-browser run of stella's real anonymization engine (the same
 * WASM pipeline the workspace runs off the main thread for chat and
 * document review) as the product page's hero: edit the paragraph and
 * watch detected entities highlight as the pipeline re-runs. Entirely
 * client-side, no server call.
 *
 * The visible text always mirrors what's typed; only the *highlighting*
 * lags behind by one debounce + pipeline pass, so a fresh keystroke is
 * never hidden behind a stale render.
 *
 * The engine is several hundred kilobytes of wasm plus name and city
 * dictionaries, so the untouched sample renders from precomputed pairs
 * immediately and swaps to live output the moment the worker answers.
 */

export const INITIAL_TEXT =
  "This engagement letter is entered into between Laure Chevalier, of 14 Rue de la Paix, Paris, and Meridian Capital Partners LLC, represented by its counsel at Edison Bank plc. Laure Chevalier can be reached at +33 1 42 61 53 00 or laure.chevalier@meridiancapital.example, tax identification number FR12 345678901.";

const DEBOUNCE_MS = 300;

/** All `buildSegments` reads off a detection; also the precomputed shape. */
type HighlightPair = Pick<ChatAnonPair, "original" | "label">;

/**
 * What the real pipeline detects in {@link INITIAL_TEXT}, captured so the
 * demo shows its result on first paint rather than after the wasm engine and
 * its dictionaries have downloaded. These go through the same
 * {@link buildSegments} as live pairs, so the swap to engine output when the
 * worker answers produces identical markup.
 *
 * Regenerate whenever {@link INITIAL_TEXT} changes, from apps/landing (prints
 * this constant; paste it verbatim):
 *
 *   bun scripts/precompute-anonymize-demo-sample.ts
 *
 * `bun run test` runs that script with `--check` and fails on drift, so a
 * stale constant cannot reach a visitor.
 */
export const PRECOMPUTED_SAMPLE_PAIRS = [
  { original: "Laure Chevalier", label: "person" },
  { original: "14 Rue de la Paix, Paris", label: "address" },
  { original: "Meridian Capital Partners LLC", label: "organization" },
  { original: "Edison Bank plc", label: "organization" },
  { original: "+33 1 42 61 53 00", label: "phone number" },
  {
    original: "laure.chevalier@meridiancapital.example",
    label: "email address",
  },
  { original: "FR12 345678901", label: "tax identification number" },
] as const satisfies readonly HighlightPair[];

type Bucket =
  | "person"
  | "organization"
  | "id"
  | "phone"
  | "address"
  | "country"
  | "email"
  | "date"
  | "amount"
  | "misc";

// Maps the pipeline's label vocabulary (DEFAULT_CHAT_ANON_ENTITY_LABELS in
// @stll/anonymize-chat) onto a smaller set of display buckets, so the
// legend stays legible instead of listing all ~20 labels.
const LABEL_TO_BUCKET: Record<string, Bucket> = {
  person: "person",
  organization: "organization",
  "phone number": "phone",
  address: "address",
  country: "country",
  "email address": "email",
  date: "date",
  "date of birth": "date",
  "bank account number": "id",
  iban: "id",
  "tax identification number": "id",
  "identity card number": "id",
  "birth number": "id",
  "national identification number": "id",
  "social security number": "id",
  "registration number": "id",
  "credit card number": "id",
  "passport number": "id",
  crypto: "id",
  "monetary amount": "amount",
  "land parcel": "address",
  misc: "misc",
};

const bucketOf = (label: string): Bucket => LABEL_TO_BUCKET[label] ?? "misc";

// person/organization/id keep the exact hues from the static section-1
// preview (AnonymizationPreview.tsx) for visual continuity between the
// two anonymization surfaces on this page. The rest reuse hues already
// established elsewhere in the landing (frameAccents' iris/ember, and the
// theme-paired --auth-gradient-end/--terminal-accent/--warning/
// --muted-foreground tokens) rather than inventing new colors.
const BUCKET_STYLE: Record<Bucket, { fg: string; displayLabel: string }> = {
  person: { fg: "rgb(22,163,74)", displayLabel: "Person" },
  organization: { fg: "rgb(37,99,235)", displayLabel: "Organization" },
  id: { fg: "rgb(217,119,6)", displayLabel: "ID / number" },
  phone: { fg: "#6264a7", displayLabel: "Phone" },
  address: { fg: "#d97757", displayLabel: "Address" },
  country: { fg: "var(--auth-gradient-end)", displayLabel: "Country" },
  email: { fg: "var(--terminal-accent)", displayLabel: "Email" },
  date: { fg: "var(--muted-foreground)", displayLabel: "Date" },
  amount: { fg: "var(--warning)", displayLabel: "Amount" },
  misc: { fg: "var(--muted-foreground)", displayLabel: "Other" },
};

type Segment = { text: string; bucket?: Bucket };

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/gu;
const escapeRegExp = (value: string): string =>
  value.replaceAll(REGEX_SPECIAL, "\\$&");

/**
 * Splits `text` into plain/highlighted segments by locating each detected
 * pair's raw span. Pairs are deduplicated by original text (the pipeline
 * already collapses repeat occurrences of the same entity into one
 * placeholder), longest-first, so a highlight for "Edison Bank plc"
 * takes priority over one for "Edison" alone.
 */
const buildSegments = (
  text: string,
  pairs: readonly HighlightPair[],
): Segment[] => {
  if (text.length === 0 || pairs.length === 0) {
    return [{ text }];
  }
  const bucketByOriginal = new Map<string, Bucket>();
  for (const pair of pairs) {
    if (!bucketByOriginal.has(pair.original)) {
      bucketByOriginal.set(pair.original, bucketOf(pair.label));
    }
  }
  const originals = [...bucketByOriginal.keys()].sort(
    (a, b) => b.length - a.length,
  );
  const pattern = new RegExp(originals.map(escapeRegExp).join("|"), "gu");
  const segments: Segment[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index;
    const matched = match[0];
    if (index > lastIndex) {
      segments.push({ text: text.slice(lastIndex, index) });
    }
    segments.push({ text: matched, bucket: bucketByOriginal.get(matched) });
    lastIndex = index + matched.length;
  }
  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex) });
  }
  return segments;
};

type EngineState =
  | { status: "warming" }
  | { status: "ready"; pairs: readonly HighlightPair[] }
  | { status: "error" };

/**
 * Which detection the backdrop renders. `precomputed` only ever applies to the
 * untouched sample: once a visitor edits the text, nothing but the live engine
 * can say what is in it, so the highlights drop away until the worker answers.
 */
type Highlights = {
  source: "engine" | "precomputed" | "pending";
  pairs: readonly HighlightPair[];
};

// Stable identity so the `pending` branch does not invalidate the segment and
// legend memos on every render.
const NO_PAIRS: readonly HighlightPair[] = [];

const highlightsFor = (engine: EngineState, text: string): Highlights => {
  if (engine.status === "ready") {
    return { source: "engine", pairs: engine.pairs };
  }
  if (text === INITIAL_TEXT) {
    return { source: "precomputed", pairs: PRECOMPUTED_SAMPLE_PAIRS };
  }
  return { source: "pending", pairs: NO_PAIRS };
};

// Shared metrics so the backdrop's highlighted text lines up with the
// transparent textarea's real characters on top of it.
const textLayerClassName =
  "m-0 h-full w-full resize-none overflow-auto p-4 font-sans text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]";

export const AnonymizeLiveDemo = () => {
  const [text, setText] = useState(INITIAL_TEXT);
  const [engine, setEngine] = useState<EngineState>({ status: "warming" });
  const latestRequestRef = useRef(0);
  const backdropRef = useRef<HTMLDivElement>(null);

  const run = (value: string) => {
    latestRequestRef.current += 1;
    const requestId = latestRequestRef.current;
    runAnonymizeDemo(value)
      .then((result) => {
        if (requestId === latestRequestRef.current) {
          setEngine({ status: "ready", pairs: result.pairs });
        }
        return;
      })
      .catch(() => {
        if (requestId !== latestRequestRef.current) {
          return;
        }
        setEngine({ status: "error" });
      });
  };

  const runDebounced = useDebouncedCallback(run, DEBOUNCE_MS);

  useEffect(() => {
    runDebounced(text);
    // Only the text itself should retrigger a run; `runDebounced`'s identity
    // is stable across renders (useDebouncedCallback memoizes it) and does
    // not need to be listed.
  }, [text]);

  const highlights = highlightsFor(engine, text);
  const segments = useMemo(
    () => buildSegments(text, highlights.pairs),
    [text, highlights.pairs],
  );

  const legend = useMemo(() => {
    const buckets = new Set<Bucket>();
    for (const pair of highlights.pairs) {
      buckets.add(bucketOf(pair.label));
    }
    return [...buckets];
  }, [highlights.pairs]);

  const retry = () => {
    setEngine({ status: "warming" });
    run(text);
  };

  const syncBackdropScroll = (event: UIEvent<HTMLTextAreaElement>) => {
    if (backdropRef.current) {
      backdropRef.current.scrollTop = event.currentTarget.scrollTop;
      backdropRef.current.scrollLeft = event.currentTarget.scrollLeft;
    }
  };

  return (
    <div
      className="flex h-full w-full flex-col overflow-hidden"
      style={{ background: "var(--background)" }}
    >
      <div className="relative min-h-0 flex-1">
        <div
          ref={backdropRef}
          aria-hidden="true"
          className={`${textLayerClassName} pointer-events-none absolute inset-0 overflow-hidden`}
          style={{ color: "var(--foreground)" }}
        >
          {segments.map((segment, index) =>
            segment.bucket === undefined ? (
              <span key={index}>{segment.text}</span>
            ) : (
              <span
                key={index}
                className="entity-span rounded-[0.2em]"
                style={{
                  backgroundColor: `color-mix(in srgb, ${BUCKET_STYLE[segment.bucket].fg} 20%, transparent)`,
                  color: BUCKET_STYLE[segment.bucket].fg,
                  boxDecorationBreak: "clone",
                  WebkitBoxDecorationBreak: "clone",
                }}
              >
                {segment.text}
              </span>
            ),
          )}
        </div>
        <label htmlFor="anon-demo-textarea" className="sr-only">
          Try the anonymization engine: edit this paragraph
        </label>
        <textarea
          id="anon-demo-textarea"
          className={`${textLayerClassName} absolute inset-0 border-0 bg-transparent text-transparent caret-[var(--foreground)] outline-none [-webkit-text-fill-color:transparent]`}
          value={text}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(event) => setText(event.target.value)}
          onScroll={syncBackdropScroll}
        />
      </div>
      <div
        className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t px-4 py-2 text-xs"
        style={{
          borderColor: "color-mix(in srgb, var(--border) 65%, transparent)",
          color: "var(--muted-foreground)",
        }}
      >
        <div className="flex items-center gap-2">
          <p aria-live="polite" className="m-0">
            {describeEngineStatus(engine, highlights)}
          </p>
          {engine.status === "error" && (
            <button
              type="button"
              className="cursor-pointer rounded border px-2 py-0.5 underline-offset-2 hover:underline"
              style={{
                borderColor:
                  "color-mix(in srgb, var(--border) 65%, transparent)",
                color: "var(--foreground)",
              }}
              onClick={retry}
            >
              Retry
            </button>
          )}
        </div>
        {legend.length > 0 && (
          <ul className="m-0 flex list-none flex-wrap gap-x-3 gap-y-1 p-0">
            {legend.map((bucket) => (
              <li key={bucket} className="flex items-center gap-1">
                <span
                  aria-hidden="true"
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: BUCKET_STYLE[bucket].fg }}
                />
                {BUCKET_STYLE[bucket].displayLabel}
              </li>
            ))}
          </ul>
        )}
      </div>
      <style>{`
        .entity-span {
          transition: background-color 200ms ease;
        }
        @media (prefers-reduced-motion: reduce) {
          .entity-span {
            transition: none;
          }
        }
      `}</style>
    </div>
  );
};

/**
 * Deliberately quiet while the engine warms: highlights are already on screen,
 * so the line reports what produced them rather than blocking on a spinner.
 */
const describeEngineStatus = (
  engine: EngineState,
  highlights: Highlights,
): string => {
  switch (engine.status) {
    case "warming": {
      return highlights.source === "precomputed"
        ? "Engine warming up; showing a saved result for this sample."
        : "Reading your text…";
    }
    case "error": {
      return "Something went wrong.";
    }
    case "ready": {
      if (highlights.pairs.length === 0) {
        return "No entities detected yet — try adding a name or company.";
      }
      return highlights.pairs.length === 1
        ? "1 entity detected"
        : `${highlights.pairs.length} entities detected`;
    }
    default: {
      engine satisfies never;
      return panic(`Unhandled engine: ${String(engine)}`);
    }
  }
};
