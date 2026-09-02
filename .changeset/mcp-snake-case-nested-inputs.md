---
"@stll/cli": minor
---

Every tool input is snake_case at every depth. `clause save` body paragraphs take `list_kind`, `list_level`, `is_directive`, `directive_kind`, `directive_expression`; `template save` field overlays take `input_type`, `options_from`, `ai_prompt`, `ai_adapt`, `ai_sees_document`, `date_format`, `parts[].input_type` and `validation.min_length`/`max_length`/`min_items`/`max_items`; `organization set-jurisdictions` takes `country_code` and `is_primary`. The former camelCase spellings are rejected.
