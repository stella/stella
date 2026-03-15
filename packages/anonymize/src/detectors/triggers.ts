import csTriggers from "../config/triggers.cs.json";
import deTriggers from "../config/triggers.de.json";
import enTriggers from "../config/triggers.en.json";
import { DETECTION_SOURCES } from "../types";
import type { Entity, TriggerRule } from "../types";

const TRIGGER_SCORE = 0.95;
const WHITESPACE_RE = /\s+/;

type TriggerConfigRow = {
  trigger: string;
  label: string;
  strategy: TriggerRule["strategy"];
};

const mapConfig = (rows: readonly TriggerConfigRow[]): readonly TriggerRule[] =>
  rows.map((row) => ({
    trigger: row.trigger,
    label: row.label,
    strategy: row.strategy,
  }));

/**
 * Czech legal trigger phrases loaded from JSON config.
 */
const CZECH_TRIGGERS: readonly TriggerRule[] = mapConfig(
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- JSON config validated by mapConfig at runtime
  csTriggers as readonly TriggerConfigRow[],
);

/**
 * German legal trigger phrases loaded from JSON config.
 */
const GERMAN_TRIGGERS: readonly TriggerRule[] = mapConfig(
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- JSON config validated by mapConfig at runtime
  deTriggers as readonly TriggerConfigRow[],
);

/**
 * English legal trigger phrases loaded from JSON config.
 */
const ENGLISH_TRIGGERS: readonly TriggerRule[] = mapConfig(
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- JSON config validated by mapConfig at runtime
  enTriggers as readonly TriggerConfigRow[],
);

const ALL_TRIGGERS: readonly TriggerRule[] = [
  ...CZECH_TRIGGERS,
  ...GERMAN_TRIGGERS,
  ...ENGLISH_TRIGGERS,
];

/**
 * Strip surrounding quotation marks, parentheses, and
 * similar punctuation from extracted trigger values.
 * Handles Czech "...", German >>...<<, and standard quotes.
 */
const LEADING_PUNCT = /^[„""»«'"()\s]+/;
const TRAILING_PUNCT = /[""»«'"()\s]+$/;

const stripQuotes = (value: {
  start: number;
  end: number;
  text: string;
}): { start: number; end: number; text: string } | null => {
  const leadingMatch = LEADING_PUNCT.exec(value.text);
  const leadingLen = leadingMatch ? leadingMatch[0].length : 0;
  const stripped = value.text.slice(leadingLen).replace(TRAILING_PUNCT, "");
  if (stripped.length === 0) {
    return null;
  }
  return {
    start: value.start + leadingLen,
    end: value.start + leadingLen + stripped.length,
    text: stripped,
  };
};

/**
 * Extract value span following a trigger phrase using
 * the rule's extraction strategy.
 *
 * Returns null if no meaningful value can be extracted.
 */
const extractValue = (
  text: string,
  triggerEnd: number,
  strategy: TriggerRule["strategy"],
): { start: number; end: number; text: string } | null => {
  const remaining = text.slice(triggerEnd);
  const trimmedOffset = remaining.length - remaining.trimStart().length;
  const valueStart = triggerEnd + trimmedOffset;
  const valueText = remaining.trimStart();

  if (valueText.length === 0) {
    return null;
  }

  switch (strategy.type) {
    case "to-next-comma": {
      const commaIdx = valueText.indexOf(",");
      const newlineIdx = valueText.indexOf("\n");
      let end: number;

      if (commaIdx !== -1 && newlineIdx !== -1) {
        end = Math.min(commaIdx, newlineIdx);
      } else if (commaIdx !== -1) {
        end = commaIdx;
      } else if (newlineIdx !== -1) {
        end = newlineIdx;
      } else {
        end = Math.min(valueText.length, 100);
      }

      const rawSlice = valueText.slice(0, end);
      const extracted = rawSlice.trim();
      if (extracted.length === 0) {
        return null;
      }
      const trailingSpaces = rawSlice.length - rawSlice.trimEnd().length;
      return {
        start: valueStart,
        end: valueStart + end - trailingSpaces,
        text: extracted,
      };
    }

    case "to-end-of-line": {
      const newlineIdx = valueText.indexOf("\n");
      const end = newlineIdx !== -1 ? newlineIdx : valueText.length;
      const rawSlice = valueText.slice(0, end);
      const extracted = rawSlice.trim();
      if (extracted.length === 0) {
        return null;
      }
      const trailingSpaces = rawSlice.length - rawSlice.trimEnd().length;
      return {
        start: valueStart,
        end: valueStart + end - trailingSpaces,
        text: extracted,
      };
    }

    case "n-words": {
      const words = valueText.split(WHITESPACE_RE).slice(0, strategy.count);
      if (words.length === 0) {
        return null;
      }
      // Find actual end in the original text (preserves
      // multi-space gaps instead of collapsing to single space)
      let actualEnd = 0;
      let searchPos = 0;
      for (const word of words) {
        const wordIdx = valueText.indexOf(word, searchPos);
        actualEnd = wordIdx + word.length;
        searchPos = actualEnd;
      }
      return {
        start: valueStart,
        end: valueStart + actualEnd,
        text: valueText.slice(0, actualEnd),
      };
    }

    default:
      return null;
  }
};

/**
 * Scan text for Czech/German legal trigger phrases.
 * Extracts the value following each trigger and returns
 * it as an Entity with score = 0.95.
 *
 * Case-insensitive matching for the trigger prefix.
 */
export const detectTriggerPhrases = (fullText: string): Entity[] => {
  const results: Entity[] = [];
  const lowerText = fullText.toLowerCase();

  for (const rule of ALL_TRIGGERS) {
    const lowerTrigger = rule.trigger.toLowerCase();
    let searchFrom = 0;

    while (searchFrom < lowerText.length) {
      const idx = lowerText.indexOf(lowerTrigger, searchFrom);
      if (idx === -1) {
        break;
      }

      // Word-boundary check: skip if preceded by a letter
      // (e.g., "IC:" should not match inside "DIC:")
      if (idx > 0 && /\p{L}/u.test(lowerText[idx - 1] ?? "")) {
        searchFrom = idx + 1;
        continue;
      }

      const triggerEnd = idx + rule.trigger.length;
      const rawValue = extractValue(fullText, triggerEnd, rule.strategy);
      const value = rawValue ? stripQuotes(rawValue) : null;

      if (value) {
        results.push({
          start: value.start,
          end: value.end,
          label: rule.label,
          text: value.text,
          score: TRIGGER_SCORE,
          source: DETECTION_SOURCES.TRIGGER,
        });
      }

      searchFrom = triggerEnd;
    }
  }

  return results;
};
