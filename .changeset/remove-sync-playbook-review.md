---
"@stll/cli": minor
---

Remove the synchronous `playbooks.review` capability. Document reviews now run as durable background runs; the review result is available through the document review run endpoints instead of a single blocking call.
