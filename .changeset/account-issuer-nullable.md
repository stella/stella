---
"@stll/auth-model": patch
---

Record `account.issuer` as nullable in the database and key accounts by `(providerId, accountId)`, the identity index Better Auth links accounts by.
