import { chatDecisionPassagesIn } from "@stll/api-contract";
import { parseStatutePath } from "@stll/api-contract/statute-route";

import type { ExternalSourceEntry } from "@/components/chat/source-chips.logic";

/**
 * How a cited part of a source is named under its source: the number the
 * court printed on the paragraph, else the publisher's own label or the
 * heading it sits under, else nothing the reader can be shown.
 */
export type SourceChipPartLabel =
  | { type: "paragraph"; number: number }
  | { type: "text"; text: string }
  | { type: "unnamed" };

export type SourceChipPart = {
  /** The block anchor the part opens at. */
  anchorId: string;
  label: SourceChipPartLabel;
  url: string;
};

/**
 * One chip of the answer's source tray. A decision or an act is one chip
 * however many of its parts the answer drew on; its parts list under it.
 */
export type SourceChipGroup =
  | {
      type: "decision";
      key: string;
      /** The decision's own source entry, which the chip opens. */
      source: ExternalSourceEntry;
      /** Court abbreviation and docket (`NS 21 Cdo 4733/2015`). */
      label: string;
      court: string | null;
      decisionDate: string | null;
      parts: SourceChipPart[];
    }
  | {
      type: "statute";
      key: string;
      source: ExternalSourceEntry;
      label: string;
      parts: SourceChipPart[];
    }
  | { type: "source"; key: string; source: ExternalSourceEntry };

const PART_TEXT_MAX_CHARS = 48;

/** The page a URL opens, without the block it scrolls to. */
const pageOf = (url: string): string => url.split("#", 1)[0] ?? url;

const anchorOf = (url: string): string | null => {
  const hash = url.indexOf("#");
  if (hash === -1 || hash === url.length - 1) {
    return null;
  }
  try {
    return decodeURIComponent(url.slice(hash + 1));
  } catch {
    return null;
  }
};

const pathnameOf = (url: string): string | null =>
  URL.canParse(url, "https://app.invalid")
    ? new URL(url, "https://app.invalid").pathname
    : null;

const readerUrlOf = (source: ExternalSourceEntry): string =>
  source.appUrl ?? source.url;

/**
 * What a part is called when nothing numbers it: a publisher label (`12.`,
 * `III.`) or a heading the tool returned as the source's title, cut short.
 * A label that merely repeats the decision's docket names nothing.
 */
const partTextLabel = (
  source: ExternalSourceEntry,
  groupLabel: string,
): SourceChipPartLabel => {
  const title = source.title.trim();
  if (title === "" || groupLabel.includes(title) || title.startsWith("http")) {
    return { type: "unnamed" };
  }
  return {
    type: "text",
    text:
      title.length > PART_TEXT_MAX_CHARS
        ? `${title.slice(0, PART_TEXT_MAX_CHARS - 1)}…`
        : title,
  };
};

const decisionLabel = (source: ExternalSourceEntry): string => {
  const decision = source.caseLawDecision;
  if (decision === undefined) {
    return source.title;
  }
  const court = decision.citation?.courtShortCode;
  return court === undefined
    ? decision.caseNumber
    : `${court} ${decision.caseNumber}`;
};

/** A court number outranks any text label, and a label any unnamed part. */
const LABEL_RANK: Readonly<Record<SourceChipPartLabel["type"], number>> = {
  paragraph: 2,
  text: 1,
  unnamed: 0,
};

type MutableGroup = Extract<SourceChipGroup, { type: "decision" | "statute" }>;

const addPart = (group: MutableGroup, part: SourceChipPart) => {
  const existing = group.parts.find(
    ({ anchorId }) => anchorId === part.anchorId,
  );
  if (existing === undefined) {
    group.parts.push(part);
    return;
  }
  if (LABEL_RANK[part.label.type] > LABEL_RANK[existing.label.type]) {
    existing.label = part.label;
  }
};

/**
 * The answer's sources as tray chips: every source naming one stella
 * decision is one chip, labelled by its court and docket, with the passages
 * the tools returned and the answer cited listed under it; every source of
 * one act is one chip with its provisions under it; anything else keeps its
 * own chip. Order follows each group's first source.
 */
export const groupSourceChips = ({
  answerTexts,
  sources,
}: {
  /** The answer's Markdown, whose passage links name cited paragraphs. */
  answerTexts: readonly string[];
  sources: readonly ExternalSourceEntry[];
}): SourceChipGroup[] => {
  const groups: SourceChipGroup[] = [];
  const decisionByPage = new Map<string, MutableGroup>();
  const decisionById = new Map<string, MutableGroup>();
  const statuteByAct = new Map<string, MutableGroup>();

  // Decisions first, so a paragraph source listed before its decision still
  // finds the chip it belongs under.
  for (const source of sources) {
    const decision = source.caseLawDecision;
    if (decision === undefined) {
      continue;
    }
    const page = pageOf(readerUrlOf(source));
    const existing = decisionById.get(decision.decisionId);
    if (existing !== undefined) {
      decisionByPage.set(page, existing);
      continue;
    }
    const group: MutableGroup = {
      type: "decision",
      key: `decision:${decision.decisionId}`,
      source: {
        ...source,
        url: pageOf(source.url),
        ...(source.appUrl === undefined ? {} : { appUrl: page }),
      },
      label: decisionLabel(source),
      court: decision.citation?.court ?? null,
      decisionDate: decision.citation?.decisionDate ?? null,
      parts: [],
    };
    decisionById.set(decision.decisionId, group);
    decisionByPage.set(page, group);
  }

  const decisionGroupOf = (source: ExternalSourceEntry) =>
    source.caseLawDecision === undefined
      ? decisionByPage.get(pageOf(readerUrlOf(source)))
      : decisionById.get(source.caseLawDecision.decisionId);

  const placed = new Set<MutableGroup>();
  for (const source of sources) {
    const reader = readerUrlOf(source);
    const anchorId = anchorOf(reader);
    const decisionGroup = decisionGroupOf(source);
    if (decisionGroup !== undefined) {
      if (!placed.has(decisionGroup)) {
        placed.add(decisionGroup);
        groups.push(decisionGroup);
      }
      if (anchorId !== null) {
        addPart(decisionGroup, {
          anchorId,
          label:
            source.caseLawDecision === undefined
              ? partTextLabel(source, decisionGroup.label)
              : { type: "unnamed" },
          url: reader,
        });
      }
      continue;
    }
    const pathname = pathnameOf(reader);
    const statute = pathname === null ? null : parseStatutePath(pathname);
    if (statute !== null) {
      const actKey = `statute:${statute.country}/${statute.slug}`;
      let group = statuteByAct.get(actKey);
      if (group === undefined) {
        group = {
          type: "statute",
          key: actKey,
          source,
          label: source.title,
          parts: [],
        };
        statuteByAct.set(actKey, group);
        groups.push(group);
      }
      if (anchorId === null) {
        // The act's own entry names the chip; a provision only its part.
        group.source = source;
        group.label = source.title;
      } else {
        addPart(group, {
          anchorId,
          label: partTextLabel(source, group.label),
          url: reader,
        });
      }
      continue;
    }
    groups.push({ type: "source", key: `source:${source.url}`, source });
  }

  // The court's own paragraph number travels on the answer's passage links.
  for (const text of answerTexts) {
    for (const passage of chatDecisionPassagesIn(text)) {
      const group = decisionById.get(passage.decisionId);
      if (group === undefined || !placed.has(group)) {
        continue;
      }
      addPart(group, {
        anchorId: passage.anchorId,
        label:
          passage.courtParagraphNumber === null
            ? { type: "unnamed" }
            : { type: "paragraph", number: passage.courtParagraphNumber },
        url: `${readerUrlOf(group.source)}#${encodeURIComponent(passage.anchorId)}`,
      });
    }
  }
  return groups;
};
