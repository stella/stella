Run `bun scripts/audit-decision-kinds.ts` from `apps/api` to audit the checked-in
Czech and Slovak decision fixtures against the canonical-kind mapping and the
stored-value inventory. Pass a JSON file path to audit an exported array instead:

```json
[
  {
    "id": "sample",
    "source": "cz-ns",
    "court": "Nejvyšší soud",
    "ecli": "ECLI:CZ:NS:2026:1.CDO.1.2026.1",
    "stated": "usn.",
    "headings": ["USNESENÍ"]
  }
]
```

Supply one row per decision per source. `headings` contains only the decision's
own title blocks, not body text, citations, or titles of attached decisions.
The script reads files only; it makes no database or network calls.

The JSON report contains unmapped or missing stated types, conflicts between a
mapped kind and title words (`rozsudek`, `rozsudok`, `usnesení`, `uznesenie`,
`nález`, `trestný rozkaz`), and kind-share differences between
sources for the same court. Shares include zero-count kinds and require at
least 20 rows per source and a difference of 25 percentage points. Small fixture
sets cannot establish that source shares agree. These signals require review;
they do not rewrite official values or infer kinds during ingestion.

ECLI country and court segments group courts across publisher names. The Czech
ECLI terminal number is an ordinal, not a decision-type discriminator
([national ECLI syntax](https://e-justice.europa.eu/topics/legislation-and-case-law/european-case-law-identifier-ecli/cz_en)).
The audit does not infer a kind from undocumented ECLI segments or a court name.
