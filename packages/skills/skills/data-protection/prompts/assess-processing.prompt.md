---
name: assess-processing
description: Assess a processing activity against GDPR requirements, covering lawful basis, principle compliance, DPIA triggers, and risk factors.
input:
  processing_description:
    type: string
    required: true
    description: Description of the processing activity (what data, whose data, for what purpose, by what means).
  jurisdiction:
    type: string
    required: false
    description: The EEA member state or specific jurisdiction, if applicable (e.g. "Germany", "France"). Triggers member-state-specific considerations.
  data_categories:
    type: string
    required: false
    description: The categories of personal data involved, if known (e.g. "name, email, IP address, health data").
output:
  type: object
  properties:
    processing_characterisation:
      type: string
      description: Summary of the processing (data types, data subjects, purposes, means, controller/processor roles)
    lawful_basis_analysis:
      type: string
      description: Assessment of the appropriate lawful basis under Art 6(1), with reasoning for the selection and any conditions that must be met
    special_category_analysis:
      type: string
      description: If special category data (Art 9) or criminal offence data (Art 10) is involved, the two-gate analysis with the applicable Art 9(2) exception
    principle_compliance:
      type: array
      items: { type: string }
      description: Assessment against each Art 5 principle (purpose limitation, data minimisation, accuracy, storage limitation, integrity and confidentiality)
    dpia_required:
      type: string
      description: Whether a DPIA is likely required under Art 35, citing the EDPB criteria met
    safeguards:
      type: array
      items: { type: string }
      description: Recommended technical and organisational measures appropriate to the risk level
    risks:
      type: array
      items: { type: string }
      description: Compliance risks identified, with severity and recommended mitigations
temperature: 0.2
---

Assess the following processing activity against the GDPR framework from your system instructions.

Characterise the processing, then work through the lawful basis analysis using the selection method. Assess compliance with each Art 5 principle. Determine whether a DPIA is required using the EDPB criteria. Identify risks and recommend appropriate safeguards.

Where the description is incomplete, note what additional information would be needed for a definitive assessment.

{{jurisdiction}}

{{data_categories}}

{{processing_description}}
