---
"@stll/template-conditions": minor
---

`detectRowBlockPair` names the row block a table row declares when a `{{#each}}`
/ `{{#if}}` opener prefixes one cell's text and its closer suffixes a later
cell's text in the same row. Both the fill pipeline and the authoring scorer
read the placement from this one function, so a row that repeats and a row the
scorer accepts cannot disagree.
