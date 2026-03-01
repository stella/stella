---
name: extract-risk-allocation
description: Extract and analyze the risk allocation mechanisms in a contract.
input:
  contract_text:
    type: string
    required: true
    description: The full text of the contract to analyze.
  focus_party:
    type: string
    required: false
    description: If provided, assess risk from this party's perspective.
output:
  type: object
  properties:
    representations_warranties:
      type: array
      items:
        type: object
        properties:
          party:
            type: string
            description: The party making the representation or warranty
          substance:
            type: string
            description: What is represented or warranted
          qualifiers:
            type: string
            description: Knowledge qualifiers, materiality thresholds, or time limitations
          clause_reference:
            type: string
            description: Section or clause number
    indemnification:
      type: object
      properties:
        scope:
          type: string
          description: What losses are covered (first-party, third-party claims, or both)
        caps:
          type: string
          description: Monetary caps on indemnification, if any
        baskets:
          type: string
          description: Minimum thresholds before indemnification applies (deductible vs. tipping basket)
        exclusions:
          type: string
          description: Categories of loss excluded from indemnification
    liability_caps:
      type: object
      properties:
        aggregate_cap:
          type: string
          description: Overall cap on liability (often expressed as a multiple of fees or a fixed amount)
        excluded_damages:
          type: string
          description: Types of damages excluded (consequential, indirect, lost profits, etc.)
        carve_outs:
          type: string
          description: Obligations exempt from the cap (e.g. IP indemnity, confidentiality breach, willful misconduct)
    force_majeure:
      type: string
      description: Scope of force majeure clause, notice requirements, and consequences (suspension vs. termination)
    insurance:
      type: string
      description: Insurance requirements and whether they adequately backstop the allocated risks
    overall_balance:
      type: string
      description: Assessment of whether the risk allocation is balanced, and which party bears disproportionate risk
    red_flags:
      type: array
      items: { type: string }
      description: Specific risk-allocation concerns (uncapped liability, missing carve-outs, asymmetric protections)
temperature: 0.2
---

Analyze the risk allocation mechanisms in the following contract. Identify how risk is distributed between the parties through representations and warranties, indemnification, limitation of liability, insurance requirements, and force majeure.

For each mechanism, cite specific sections or clause numbers. Assess whether the overall risk allocation is balanced and flag any concerns.

{{focus_party}}

{{contract_text}}
