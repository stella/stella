const RECAP_MAX_LENGTH = 700;

const stripRecapPrefix = (value: string): string => {
  const prefix = "recap:";
  if (value.slice(0, prefix.length).toLowerCase() !== prefix) {
    return value;
  }

  return value.slice(prefix.length).trimStart();
};

const isWrappingQuote = (char: string): boolean => char === '"' || char === "'";

const trimWrappingQuotes = (value: string): string => {
  let start = 0;
  let end = value.length;

  while (start < end && isWrappingQuote(value.charAt(start))) {
    start += 1;
  }
  while (end > start && isWrappingQuote(value.charAt(end - 1))) {
    end -= 1;
  }

  return value.slice(start, end);
};

// Root locale: the same boundaries on every host, whatever its default.
const sentences = new Intl.Segmenter("und", { granularity: "sentence" });

/** Whole sentences within the cap: a recap never ends mid-word. */
export const cleanRecapText = (text: string): string | null => {
  const withoutLabel = stripRecapPrefix(text.trim());
  const unquoted = trimWrappingQuotes(withoutLabel).trim();
  let capped = "";
  for (const { segment } of sentences.segment(unquoted)) {
    if (capped.length + segment.length > RECAP_MAX_LENGTH) {
      break;
    }
    capped += segment;
  }
  const trimmed = capped.trim();
  return trimmed.length > 0 ? trimmed : null;
};
