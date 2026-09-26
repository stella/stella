---
"@stll/business-registries": minor
"@stll/cli": minor
---

Add entity checks: screen a company by IČO or a person by name and birth date against the Czech insolvency register (ISIR). Each check answers clear, found (with typed findings), unavailable, or not-covered; a source error, timeout, outage page, or unparseable answer is never reported as clear. The CLI gains `contact check-counterparty`.
