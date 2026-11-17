import { stableHash } from "../lib/stable-hash";

/**
 * Swatches for time no matter claimed yet, such as one document's or window's
 * stretch of a day. A separate low-chroma set (`--topic-*` in theme.css), so
 * a topic is never painted in a colour a matter can have.
 */
const DEFAULT_TOPIC_SWATCH = "--topic-sand";

export const TOPIC_SWATCHES = [
  DEFAULT_TOPIC_SWATCH,
  "--topic-sage",
  "--topic-mist",
  "--topic-heather",
  "--topic-clay",
  "--topic-slate",
] as const;

export const getTopicSwatch = (key: string) =>
  TOPIC_SWATCHES[stableHash(key) % TOPIC_SWATCHES.length] ??
  DEFAULT_TOPIC_SWATCH;

export const getTopicColor = (key: string) => `var(${getTopicSwatch(key)})`;
