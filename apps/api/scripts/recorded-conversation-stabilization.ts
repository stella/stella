const UUID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;
const CLIENT_ID_PATTERN = /(run|msg)-\d{13}-[0-9a-z]{6}/gu;
const ISO_INSTANT_PATTERN = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/gu;
/** Epoch milliseconds from 2023 to 2033, the stream's timestamp values. */
const EPOCH_MS_PATTERN = /(?<![\d.])1[7-9]\d{11}(?![\d.])/gu;
const RECORDING_EPOCH_MS = Date.UTC(2026, 0, 1);
const DURATION_PATTERN = /(\\?"(?:duration|durationMs|elapsedMs)\\?":\s*)\d+/gu;

type RenameEachOptions = {
  text: string;
  pattern: RegExp;
  name: (index: number, match: string) => string;
};

const renameEach = ({ text, pattern, name }: RenameEachOptions): string => {
  const names = new Map<string, string>();
  return text.replaceAll(pattern, (match) => {
    const key = match.toLowerCase();
    const known = names.get(key);
    if (known !== undefined) {
      return known;
    }
    const next = name(names.size + 1, match);
    names.set(key, next);
    return next;
  });
};

/** Normalize clocks by occurrence order, independently of source-clock collisions. */
export const stabilizeRecordedConversation = (recording: object): string => {
  let instants = 0;
  const nextInstant = () => {
    instants += 1;
    return RECORDING_EPOCH_MS + instants * 1000;
  };
  const text = renameEach({
    text: renameEach({
      text: JSON.stringify(recording, null, 2),
      pattern: UUID_PATTERN,
      name: (index) =>
        `00000000-0000-7000-8000-${index.toString(16).padStart(12, "0")}`,
    }),
    pattern: CLIENT_ID_PATTERN,
    name: (index, match) => `${match.slice(0, 3)}-recorded-${String(index)}`,
  })
    .replaceAll(ISO_INSTANT_PATTERN, () =>
      new Date(nextInstant()).toISOString(),
    )
    .replaceAll(EPOCH_MS_PATTERN, () => String(nextInstant()))
    .replaceAll(DURATION_PATTERN, (_, key: string) => `${key}0`);
  return `${text}\n`;
};
