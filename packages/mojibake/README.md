# @stll/mojibake

Detection and reversal of text decoded with the wrong character set, scored
against CLDR exemplar characters.

## What lives here

- `detect`: `checkTextEncoding(text, language)` reports U+FFFD, C1 controls,
  UTF-8 read as windows-1252 or Latin-1, and any reversible mis-decoding
  between the charsets in `charsets`, with the pair, a confidence, sample
  spans and a repaired preview. `repairMisdecoding` undoes a reported pair.
- `charsets`: exact encoders and fatal decoders, derived from the platform's
  WHATWG decoders.
- `exemplars.generated.ts`: CLDR main, auxiliary and punctuation exemplars per
  language, written by `bun run extract:exemplars` from the pinned
  `cldr-misc-full`; a test fails when the two disagree.

## What does not

Deciding what to do with a suspect text: rejecting, flagging or repairing it
belongs to the caller.

## License

Apache-2.0
