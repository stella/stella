---
"@stll/legal-ast": minor
---

`@stll/legal-ast/printed-paragraph-labels` reads the labels a court prints at the start of a paragraph (`12.`, `[12]`, `5.5.`, `(3)`, `a)`, `IV.`, `-`) in one place: `readPrintedLabel` names a line's label, and `printedLabelOpensParagraph` decides whether it opens a paragraph after the line above, never inside a wrapped date (`dňa` / `2. júla 2014`) or after a word its number belongs to (`písm.` / `b)`). The court paragraph numbering reads its markers from the same grammar and counts sub-paragraphs as items beside it. `splitsDate` moves here from `@stll/legal-ast/line-wrap`.
