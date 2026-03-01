---
name: review-privacy-notice
description: Review a privacy notice for GDPR Articles 13-14 compliance, assessing completeness, quality, and transparency.
input:
  notice_text:
    type: string
    required: true
    description: The full text of the privacy notice to review.
  collection_context:
    type: string
    required: false
    description: Whether data is collected directly from data subjects (Art 13), indirectly (Art 14), or both. If omitted, infer from the notice content.
  processing_context:
    type: string
    required: false
    description: Description of the controller's actual processing activities, to verify the notice accurately reflects them.
output:
  type: object
  properties:
    collection_type:
      type: string
      description: Whether the notice covers direct collection (Art 13), indirect collection (Art 14), or both
    completeness_check:
      type: array
      items: { type: string }
      description: Each mandatory element from Art 13 or Art 14 with its status (present, absent, or partially addressed) and the relevant notice section
    quality_assessment:
      type: string
      description: Assessment against the transparency quality dimensions (conciseness, intelligibility, accessibility, specificity)
    gaps:
      type: array
      items: { type: string }
      description: Missing or insufficient elements, ranked by materiality
    red_flags:
      type: array
      items: { type: string }
      description: Misleading framing, vague formulations, or practices that undermine transparency
    overall_assessment:
      type: string
      description: Summary of the notice's compliance posture with the most significant findings highlighted
temperature: 0.2
---

Review the following privacy notice using the transparency framework from your system instructions.

Determine the applicable checklist (Art 13 for direct collection, Art 14 for indirect, or both). Check each mandatory element against the notice text. Then assess the quality of the notice against the transparency dimensions.

For each gap, state the regulatory requirement, what is missing, and the materiality of the omission.

{{collection_context}}

{{processing_context}}

{{notice_text}}
