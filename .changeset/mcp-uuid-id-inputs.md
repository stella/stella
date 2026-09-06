---
"@stll/cli": patch
---

Every id a tool accepts that names a persisted record is now advertised as a UUID, so a malformed id is rejected before it is sent instead of failing on the server.
