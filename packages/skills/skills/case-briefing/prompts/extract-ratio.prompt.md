---
name: extract-ratio
description: Extract the ratio decidendi (binding legal principle) from a judicial decision.
input:
  decision_text:
    type: string
    required: true
    description: The full text of the judicial decision.
  jurisdiction:
    type: string
    required: false
    description: The jurisdiction or legal tradition for context.
output:
  type: object
  properties:
    ratio:
      type: string
      description: The binding legal principle necessary to the decision, stated as a rule applicable to future cases
    material_facts:
      type: array
      items: { type: string }
      description: The facts to which the ratio is tied — changing these facts would change the rule's applicability
    supporting_paragraphs:
      type: array
      items: { type: string }
      description: Key passages from the decision that establish the ratio, cited by paragraph or page number
    obiter_dicta:
      type: array
      items: { type: string }
      description: Significant statements of law that are not part of the ratio but may be persuasive
    confidence:
      type: string
      description: Assessment of how clearly the decision states its ratio (clear, inferable, contested)
temperature: 0.2
---

Extract the ratio decidendi from the following judicial decision. The ratio is the rule of law necessary to the decision, applied to the material facts; it is what the court had to decide to reach its result.

Distinguish the ratio from obiter dicta (statements not necessary to the outcome). If the decision contains multiple rationes (because it decides multiple issues), identify each separately.

If you are working with a civil law decision that does not use the ratio/obiter framework, extract the operative legal rule the court applied and the syllogistic structure of the reasoning.

{{jurisdiction}}

{{decision_text}}
