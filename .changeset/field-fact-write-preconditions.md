---
"@stll/cli": major
---

Require `expectedUpdatedAt` for field value and list fact-detail replacements. Read the current timestamp before replacing an existing value; pass null only when creating an absent value. The curated `set_field_value` tool now requires `expected_updated_at` from `read_document`.
