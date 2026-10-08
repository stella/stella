import { isPlainPrimaryClick } from "@/components/inspector/case-decision-view";

/** What a click on a cited provision does. */
export const CITED_PROVISION_CLICK = {
  peek: "peek",
  /** A browser navigation gesture keeps the meaning the browser gives it. */
  navigate: "navigate",
} as const;

/** A plain click keeps the preview open even when hover already opened it. */
export const citedProvisionClick = (
  gesture: Parameters<typeof isPlainPrimaryClick>[0],
) =>
  isPlainPrimaryClick(gesture)
    ? CITED_PROVISION_CLICK.peek
    : CITED_PROVISION_CLICK.navigate;

const comparable = (text: string): string =>
  text.normalize("NFC").toLocaleLowerCase().replaceAll(/\s+/gu, " ").trim();

type ProvisionTrailInput = {
  /** The card's own name for the provision: the citation as written. */
  label: string;
  /** The act, then the part, chapter and division the provision sits under. */
  places: readonly string[];
};

/**
 * Where a cited provision sits, minus what its label already says: a citation
 * that names its act ("§ 2 zákona č. 89/2012 Sb.") does not repeat the act
 * under it, and a heading the label spells out is not shown twice. Empty when
 * nothing is left to add, so the card shows no line for it.
 */
export const informativeProvisionTrail = ({
  label,
  places,
}: ProvisionTrailInput): string[] => {
  const name = comparable(label);
  const seen = new Set<string>();
  const trail: string[] = [];
  for (const place of places) {
    const text = comparable(place);
    if (text === "" || seen.has(text) || name.includes(text)) {
      continue;
    }
    seen.add(text);
    trail.push(place.trim());
  }
  return trail;
};
