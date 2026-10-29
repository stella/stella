---
"@stll/business-registries": patch
---

Entity checks read each SOAP response in one strict pass, and fast-xml-parser is no longer a dependency. A character reference in a response is decoded rather than kept as literal text.
