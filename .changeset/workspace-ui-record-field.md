---
"@stll/workspace-ui": minor
---

Add the `record` field content type: a cell holding typed records from a data source or a structured AI answer. `FieldValue` renders it as a summary (the record's values, a record count, a prompt to choose among unselected candidates, or a review or not-found note), and `RecordFieldValue`, `summarizeRecordField` and the `RecordField*` types are exported. `GenericProperty` and `PropertyIconType` accept `record`.
