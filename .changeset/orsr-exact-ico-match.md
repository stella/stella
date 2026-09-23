---
"@stll/business-registries": patch
---

`orsr.lookupByIco` only considers search hits whose registration number equals the requested IČO, and returns `null` for an extract that names a different IČO. The ORSR search also matches corporate names, so a company named after another's IČO could previously be returned.
