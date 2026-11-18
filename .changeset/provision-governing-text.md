---
"@stll/cli": patch
---

`read_statute_provisions` and `read_provision_history` return `governingText` beside a subdivision's text: the lead-in and closing wording of every unit it is nested in, so a letter is never read without the sentence that qualifies it.
