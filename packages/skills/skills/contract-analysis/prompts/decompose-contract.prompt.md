---
name: decompose-contract
description: Produce a full structural decomposition of a contract, identifying all components, risk allocation, and potential issues.
input:
  contract_text:
    type: string
    required: true
    description: The full text of the contract to analyze.
  jurisdiction:
    type: string
    required: false
    description: The governing law or jurisdiction for context (e.g. "New York law", "English law", "CISG").
output:
  type: object
  properties:
    parties:
      type: array
      items: { type: string }
      description: Identified parties with their defined roles in the contract
    contract_type:
      type: string
      description: Classification of the contract (e.g. SaaS agreement, asset purchase, distribution agreement)
    term_and_termination:
      type: string
      description: Duration, renewal mechanism, and termination rights (for cause and convenience)
    core_obligations:
      type: array
      items: { type: string }
      description: Primary obligations of each party, citing specific clauses
    risk_allocation:
      type: object
      properties:
        representations_warranties:
          type: array
          items: { type: string }
          description: Key representations and warranties by each party
        indemnification:
          type: string
          description: Scope, caps, baskets, and exclusions of indemnification obligations
        liability_caps:
          type: string
          description: Caps on liability, excluded damage types, and carve-outs
        force_majeure:
          type: string
          description: Scope of force majeure clause and consequences
        insurance:
          type: string
          description: Insurance requirements and whether they backstop the allocated risks
    dispute_resolution:
      type: string
      description: Governing law, jurisdiction or arbitration, and escalation mechanisms
    red_flags:
      type: array
      items: { type: string }
      description: Potential issues, ambiguities, or imbalances identified in the drafting
    summary:
      type: string
      description: One-paragraph plain-language summary of the contract's purpose, structure, and key terms
temperature: 0.2
---

Decompose the following contract using the structural framework from your system instructions. Identify all components, trace defined terms for consistency, and assess the risk allocation between the parties.

For each component, cite specific sections or clause numbers from the contract. Where the drafting is ambiguous or creates potential issues, flag the concern and explain the risk.

{{jurisdiction}}

{{contract_text}}
