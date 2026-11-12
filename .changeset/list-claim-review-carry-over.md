---
"@stll/cli": patch
---

`lists.verifications.get` returns `carryOver`: what a verification took from the previous verification of the same document against the same list. Notes and fact links follow a claim with the same words or with edited words in the same paragraph or page; other reviewer decisions follow only the same words with an unchanged verdict. It counts the reviewed claims that came across whole and lists the rest as `text-changed`, `verdict-changed`, `unmatched` or `ambiguous`. `lists.verifications.claim-reviews.list` entries carry `carriedFrom`, the earlier verification an action was first taken on.
