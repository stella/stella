---
name: analyze-statute
description: Interpret a single statutory or regulatory provision using the three-component framework (language, purpose, normative context).
input:
  provision_text:
    type: string
    required: true
    description: The text of the provision to interpret (one article, section, or paragraph).
  context_text:
    type: string
    required: false
    description: Surrounding provisions, definitions, or recitals that provide context for the provision.
  jurisdiction:
    type: string
    required: false
    description: The jurisdiction or legal system (e.g. "EU", "Germany", "California").
  question:
    type: string
    required: false
    description: A specific interpretive question to focus the analysis (e.g. "Does 'employee' include independent contractors?").
output:
  type: object
  properties:
    provision_reference:
      type: string
      description: The article, section, or paragraph number being interpreted
    linguistic_analysis:
      type: string
      description: Ordinary meaning, defined terms, semantic range, and any ambiguity or vagueness identified in the text
    purpose_analysis:
      type: string
      description: Subjective purpose (legislative intent from text and extrinsic sources) and objective purpose (systemic values, reasonable-author standard)
    normative_context:
      type: string
      description: Placement within the act, higher-law conformity, collision rules, and relevant case law or scholarly opinion
    addressees:
      type: array
      items: { type: string }
      description: Who the provision addresses and what it requires, permits, or prohibits for each
    ambiguities:
      type: array
      items: { type: string }
      description: Points where the text is unclear or where interpretation methods yield divergent readings, with the tension explained
    interpretation:
      type: string
      description: The preferred interpretation, stating which components support it and why they outweigh any countervailing components
temperature: 0.2
---

Interpret the following provision using the three-component framework from your system instructions. Apply all three components (language, purpose, normative context) and explain how they interact.

If a specific question is provided, focus your analysis on resolving that question. Otherwise, provide a general interpretation covering the provision's meaning, scope, and addressees.

Where the components point in different directions, explain the tension and state which component carries more weight for this type of text.

{{question}}

{{jurisdiction}}

Provision:
{{provision_text}}

{{context_text}}
