---
name: brief-case
description: Produce a full structured brief of a judicial decision, extracting all structural components.
input:
  decision_text:
    type: string
    required: true
    description: The full text of the judicial decision to brief.
  jurisdiction:
    type: string
    required: false
    description: The jurisdiction or legal tradition for context (e.g. "US federal", "France", "ECJ", "ICJ").
output:
  type: object
  properties:
    case_id:
      type: object
      properties:
        name:
          type: string
          description: Full case name
        citation:
          type: string
          description: Official citation(s)
        court:
          type: string
          description: Court that issued the decision
        date:
          type: string
          description: Date of decision
        panel:
          type: string
          description: Judges or justices who heard the case
    procedural_history:
      type: string
      description: How the case reached this court and the procedural posture
    material_facts:
      type: array
      items: { type: string }
      description: Facts the court treated as material to its reasoning
    legal_issues:
      type: array
      items: { type: string }
      description: Precise legal questions the court addressed
    applicable_rules:
      type: array
      items: { type: string }
      description: Statutory provisions, constitutional norms, precedents, and doctrinal sources relied on
    reasoning:
      type: string
      description: Step-by-step reconstruction of the court's reasoning chain, noting interpretive methods and key analytical moves
    ratio:
      type: string
      description: The binding principle (ratio decidendi in common law, or the operative legal rule in civil law)
    disposition:
      type: string
      description: The court's actual decision (affirmed, reversed, remanded, etc.) and specific relief
    dissents_concurrences:
      type: array
      items: { type: string }
      description: Core disagreements (dissents) or alternative reasoning (concurrences), if any
    significance:
      type: string
      description: The decision's contribution to the law — what it settles, what it leaves open, and its likely influence
temperature: 0.2
---

Brief the following judicial decision using the structural framework from your system instructions. Identify the legal tradition and adapt the analysis accordingly.

For each component, cite specific paragraph or page numbers from the decision. Where the court's reasoning is ambiguous or could support more than one reading, note the tension.

{{jurisdiction}}

{{decision_text}}
