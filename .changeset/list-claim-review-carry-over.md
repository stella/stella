---
"@stll/cli": patch
---

`lists.verifications.get` returns `carryOver`: what a verification took from the previous verification of the same document against the same list. Reviewer decisions follow a claim with the same words, or with edited words in the same paragraph or page; notes and fact links always follow, other decisions only when the verdict is unchanged. It counts the reviewed claims that came across whole and lists the rest as `verdict-changed`, `unmatched` or `ambiguous`. `lists.verifications.claim-reviews.list` entries carry `carriedFrom`, the earlier verification an action was first taken on.
