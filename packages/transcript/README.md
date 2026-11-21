# @stll/transcript

Pure TypeScript transcript timing, vocabulary and string exports. No I/O or
platform APIs. Invalid inputs return `better-result` errors.

- `@stll/transcript`: transcript types, Valibot schemas, version 1 canonical JSON
  parsing and serialization. Timings are safe integer milliseconds, ordered by
  start time and bounded by recording duration. Overlapping speech is allowed.
- `@stll/transcript/timeline`: metering-based kept intervals, time maps,
  transcript remapping, bitrate-based upload planning and chunk merging.
- `@stll/transcript/exporters`: plain text, Markdown, SRT, VTT and canonical JSON.
- `@stll/transcript/vocabulary`: ranked vocabulary with mechanism budgets.
- `@stll/transcript/spelling`: custom words and names spelled as written where a
  transcript comes close, as the desktop spells them after local transcription,
  keeping Czech and Slovak case endings.
- `@stll/transcript/corrections`: fixes learned from how a person corrects
  dictated words: word diff of the dictated text against the text sent, two
  matching sightings to apply, never after a contradiction.
- `@stll/transcript/learned-fixes`: the dictation fixes learned from a person's
  corrections and the changes that update them, applied the same way on every
  device and on the server.

`detectKeptIntervals` treats each dBFS sample as the following fixed-width
interval. Samples at or below the threshold are silence; `-Infinity` is valid.
Only silence meeting the minimum length is removed, leaving padding on both
sides. The source timeline is never mutated.

Time maps return `null` for removed positions. At a trimmed cut, `start` maps to
the following kept interval and `end` to the preceding one. Remapping text to the
trimmed timeline clips intersecting timings and drops text wholly in removed
intervals. A segment crossing a cut retains its text once.

`planChunks` requires caller-supplied duration and byte limits and a bitrate in
bits per second. Its byte estimate excludes container overhead; callers should
reserve that overhead in the supplied byte budget. Chunks cover the complete
source timeline. Silence preferences only affect the latter half of each chunk.

Merge offsets apply to both segments and available words; missing words are not
fabricated. Ordering at equal timestamps follows input order. Conflicting
language or model metadata is omitted.

Vocabulary deduplication folds case and diacritics while retaining the selected
original spelling. Inflected forms remain distinct. Weight ranks first, then
recency, then input order. Token estimates are deterministic approximations,
not provider token counts.

## License

Apache-2.0
