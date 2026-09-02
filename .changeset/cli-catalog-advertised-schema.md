---
"@stll/cli": patch
---

Generated capability commands expose bounded integer flags where the server advertises them instead of routing those fields to `--input`; `date` and `date-time` inputs are refused when they name a day the calendar lacks or a time field out of range.
