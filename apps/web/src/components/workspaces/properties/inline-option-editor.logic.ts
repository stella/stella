/**
 * Option lists arrive pasted as often as typed: a taxonomy copied from a
 * document, a comma list from a chat. One pasted line that carries a
 * separator is several options, not one option with commas in it.
 */
const OPTION_SEPARATOR = /[,;\n]/u;

/** Whether a draft carries more than one option. */
export const hasOptionSeparator = (text: string): boolean =>
  OPTION_SEPARATOR.test(text);

type SplitOptionValuesOptions = {
  text: string;
  /** Values already in the list; a pasted duplicate is dropped, not repeated. */
  existing: readonly string[];
};

/** The distinct, trimmed, non-empty values a draft holds, in the order written. */
export const splitOptionValues = ({
  text,
  existing,
}: SplitOptionValuesOptions): string[] => {
  const seen = new Set(existing);
  const values: string[] = [];
  for (const part of text.split(OPTION_SEPARATOR)) {
    const value = part.trim();
    if (value.length === 0 || seen.has(value)) {
      continue;
    }
    seen.add(value);
    values.push(value);
  }
  return values;
};
