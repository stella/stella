---
name: assess-breach
description: Assess a personal data breach for severity, notification obligations under Articles 33-34, and recommended response steps.
input:
  breach_description:
    type: string
    required: true
    description: Description of the breach incident (what happened, when it was discovered, what data and systems were affected).
  data_categories:
    type: string
    required: false
    description: The categories of personal data affected, if known (e.g. "names, email addresses, health records").
  individuals_affected:
    type: string
    required: false
    description: The number or categories of individuals affected, if known.
output:
  type: object
  properties:
    breach_classification:
      type: string
      description: Classification by type (confidentiality, integrity, availability, or combination)
    severity_assessment:
      type: string
      description: Risk assessment based on the severity factors (data type, identifiability, consequences, vulnerable individuals, scale, controller characteristics)
    sa_notification:
      type: object
      properties:
        required:
          type: string
          description: Whether supervisory authority notification is required and the reasoning
        deadline:
          type: string
          description: The notification deadline (72 hours from awareness) and when the clock started
        content:
          type: array
          items: { type: string }
          description: The required content elements under Art 33(3)
    data_subject_notification:
      type: object
      properties:
        required:
          type: string
          description: Whether data subject notification is required (high risk threshold) and the reasoning
        exceptions:
          type: string
          description: Whether any Art 34(3) exceptions apply (encryption, subsequent measures, disproportionate effort)
    recommended_steps:
      type: array
      items: { type: string }
      description: Prioritised response steps (containment, assessment, notification, documentation, remediation)
    documentation_requirements:
      type: string
      description: What must be recorded under Art 33(5) regardless of whether the breach is notifiable
temperature: 0.2
---

Assess the following personal data breach using the breach assessment framework from your system instructions.

Classify the breach, assess its severity, and determine the notification obligations under Articles 33 and 34. Provide prioritised response steps.

Where the description is incomplete, note what additional information would be needed for a definitive assessment and state the precautionary position (e.g., if severity is uncertain, err toward notification).

{{data_categories}}

{{individuals_affected}}

{{breach_description}}
