---
name: review-dpa
description: Review a data processing agreement for GDPR Article 28 compliance, assessing role determination, mandatory elements, sub-processor governance, and transfer provisions.
input:
  dpa_text:
    type: string
    required: true
    description: The full text of the data processing agreement to review.
  role:
    type: string
    required: false
    description: The perspective to assess from (e.g. "controller", "processor"). If omitted, assess from both perspectives.
  services_description:
    type: string
    required: false
    description: A description of the services being provided, to verify the DPA accurately reflects the actual processing.
output:
  type: object
  properties:
    role_assessment:
      type: string
      description: Whether the contractual role designations (controller/processor) match the functional reality of the arrangement
    art28_compliance:
      type: array
      items: { type: string }
      description: Checklist of each Art 28(3) mandatory element with its compliance status (present, absent, or partially addressed) and the relevant clause reference
    sub_processor_governance:
      type: string
      description: Assessment of the sub-processor authorisation mechanism, objection rights, flow-down obligations, and current sub-processor list
    transfer_provisions:
      type: string
      description: Assessment of international transfer mechanisms and post-Schrems II compliance, if applicable
    red_flags:
      type: array
      items: { type: string }
      description: Specific concerns identified in the DPA drafting (circular instructions, unexercisable audit rights, missing breach timelines, inadequate deletion provisions)
    overall_assessment:
      type: string
      description: Summary of the DPA's compliance posture, distinguishing mandatory-element failures (high severity) from best-practice shortfalls (medium severity)
temperature: 0.2
---

Review the following data processing agreement against the Article 28 framework from your system instructions.

First, assess whether the functional roles of the parties match their contractual designations. Then check each Art 28(3) mandatory element against the DPA text, citing specific clauses. Evaluate sub-processor governance and international transfer provisions where applicable.

For each gap or concern, state the regulatory requirement, what is missing or deficient, and the severity level.

{{role}}

{{services_description}}

{{dpa_text}}
