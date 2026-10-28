type SpotPlacement =
  | { type: "placed"; start: number; end: number }
  | { type: "detached"; reason: "other-version" | "text-changed" };

const EQUIVALENT_CHARACTERS: Readonly<Record<string, string>> = {
  "‘": "'",
  "’": "'",
  "‚": "'",
  "‛": "'",
  "“": '"',
  "”": '"',
  "„": '"',
  "‟": '"',
  "«": '"',
  "»": '"',
  "‹": "'",
  "›": "'",
  "–": "-",
  "—": "-",
  "−": "-",
};

const foldWithoutWhitespace = (text: string) => {
  let folded = "";
  const offsets: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charAt(index);
    if (/\s/u.test(unit)) {
      continue;
    }
    folded += EQUIVALENT_CHARACTERS[unit] ?? unit;
    offsets.push(index);
  }
  return { folded, offsets };
};

type PlaceSpotTextOptions = {
  start: number;
  end: number;
  quote: string;
  storedDigest: string | undefined;
  text: string;
  textDigest: string | undefined;
  sameVersion: boolean;
};

/** Place stored words in current text without ever trusting stale offsets. */
export const placeSpotText = ({
  start,
  end,
  quote,
  storedDigest,
  text,
  textDigest,
  sameVersion,
}: PlaceSpotTextOptions): SpotPlacement => {
  if (
    storedDigest !== undefined &&
    storedDigest === textDigest &&
    text.slice(start, end) === quote
  ) {
    return { type: "placed", start, end };
  }
  if (!sameVersion) {
    return { type: "detached", reason: "other-version" };
  }

  const needle = foldWithoutWhitespace(quote).folded;
  const haystack = foldWithoutWhitespace(text);
  if (needle.length === 0) {
    return { type: "detached", reason: "text-changed" };
  }

  let best: { start: number; end: number } | null = null;
  for (
    let found = haystack.folded.indexOf(needle);
    found !== -1;
    found = haystack.folded.indexOf(needle, found + 1)
  ) {
    const candidateStart = haystack.offsets.at(found);
    const last = haystack.offsets.at(found + needle.length - 1);
    if (candidateStart === undefined || last === undefined) {
      continue;
    }
    const candidate = { start: candidateStart, end: last + 1 };
    if (
      best === null ||
      Math.abs(candidate.start - start) < Math.abs(best.start - start)
    ) {
      best = candidate;
    }
  }

  return best === null
    ? { type: "detached", reason: "text-changed" }
    : { type: "placed", ...best };
};
