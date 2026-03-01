---
name: extract-contract-type
description: Classify a contract into a standard type.
input:
  contract_text:
    type: string
    required: true
    description: The full text or excerpt of the contract to classify.
output:
  type: single-select
  options:
    - NDA
    - MSA
    - SaaS Agreement
    - Service Agreement
    - Employment Agreement
    - Consulting Agreement
    - Lease
    - Licensing Agreement
    - Purchase/Sale Agreement
    - Loan/Credit Agreement
    - Partnership/Joint Venture
    - Settlement Agreement
    - Other
temperature: 0
---

Read the following contract and classify it into one of the available types.

{{contract_text}}
