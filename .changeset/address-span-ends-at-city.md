---
"@stll/anonymize": patch
---

End an address span at the city that completes its destination. Right-expansion kept walking past the city to the next unrelated boundary, so a return address absorbed the prose after it ("14 Rue de la Paix, Paris, and Meridian Capital", "..., Paris last year" now both end at "Paris"). A postal code following the city is itself an address seed, so it still joins the span.
