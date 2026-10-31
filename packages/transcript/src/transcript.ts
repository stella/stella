import { Result, TaggedError } from "better-result";
import * as v from "valibot";

export class TranscriptInputError extends TaggedError("TranscriptInputError")<{
  message: string;
}> {}

const milliseconds = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
export const intervalSchema = v.pipe(
  v.strictObject({ startMs: milliseconds, endMs: milliseconds }),
  v.check(({ startMs, endMs }) => endMs >= startMs, "Invalid interval"),
);
export type Interval = v.InferOutput<typeof intervalSchema>;
export const timedTextSchema = v.pipe(
  v.strictObject({
    startMs: milliseconds,
    endMs: milliseconds,
    text: v.string(),
  }),
  v.check(({ startMs, endMs }) => endMs >= startMs, "Invalid timing"),
);
export type TimedText = v.InferOutput<typeof timedTextSchema>;
const orderedWithin = (items: readonly TimedText[], durationMs: number) =>
  items.every(
    (item, index) =>
      item.endMs <= durationMs &&
      (index === 0 || item.startMs >= (items.at(index - 1)?.startMs ?? 0)),
  );
export const transcriptSchema = v.pipe(
  v.strictObject({
    language: v.optional(v.string()),
    durationMs: milliseconds,
    segments: v.array(timedTextSchema),
    words: v.optional(v.array(timedTextSchema)),
    model: v.optional(v.string()),
  }),
  v.check(
    ({ segments, words, durationMs }) =>
      orderedWithin(segments, durationMs) &&
      orderedWithin(words ?? [], durationMs),
    "Timings must be ordered and within duration",
  ),
);
export type Transcript = v.InferOutput<typeof transcriptSchema>;
export const canonicalTranscriptSchema = v.strictObject({
  version: v.literal(1),
  transcript: transcriptSchema,
});

export const validateTranscript = (
  input: unknown,
): Result<Transcript, TranscriptInputError> => {
  const parsed = v.safeParse(transcriptSchema, input);
  if (!parsed.success) {
    return Result.err(
      new TranscriptInputError({ message: parsed.issues[0].message }),
    );
  }
  return Result.ok(parsed.output);
};

export const parseTranscript = (json: string) =>
  Result.try({
    try: (): unknown => JSON.parse(json),
    catch: () =>
      new TranscriptInputError({ message: "Invalid transcript JSON" }),
  }).andThen((input) => {
    const parsed = v.safeParse(canonicalTranscriptSchema, input);
    if (!parsed.success) {
      return Result.err(
        new TranscriptInputError({ message: parsed.issues[0].message }),
      );
    }
    return Result.ok(parsed.output.transcript);
  });

export const serializeTranscript = (transcript: Transcript) =>
  validateTranscript(transcript).map((value) =>
    JSON.stringify({ version: 1, transcript: value }, null, 2),
  );
