---
"@stll/cli": patch
---

New list capabilities: `lists.items.fact-details.update` sets a fact item's date, evidence kind, medium, confidence, interpretation note and scoring hold; `lists.verifications.create` starts checking a document against a list's facts; `lists.verifications.get` reads the claims found and their verdicts; `lists.verifications.claim-reviews.create` and `lists.verifications.claim-reviews.bulk.create` record reviewer decisions on those claims; `lists.verifications.list` lists a document's verifications, newest first, with claim counts per verdict state; `lists.verifications.latest.list` reads the latest verification of up to 200 document files at once.
