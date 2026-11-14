---
"@stll/cli": patch
---

Add `lists.verifications.graph.get`: reads the verification graph of one list, a page of verified documents at a time: their claims with the verdict as reviewers see it, the list's facts (held, tier, off the list), the documents those facts come from, each claim's links to the facts it cites or conflicts on, and each fact's source locators.
