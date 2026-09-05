---
name: product-deep-think
description: 'Deeply assess a consequential product idea using repository evidence, current market research, switching costs, international constraints, and maintainability before planning or coding.'
---

# Product Deep Think

Assess whether and how to build a consequential feature. This is a
conversational research exercise: do not edit code or create files unless the
user later asks for a plan or implementation.

## Interaction Mode

Default to one coherent pass after confirming the problem statement. Do not
stop after every analytical lens for ceremonial approval. Pause only when the
user's answer would materially change who the product serves, the product
boundary, or the recommended direction. If the user explicitly asks for an
interactive workshop, work through the lenses one useful question at a time.

Lead with discoveries, not phase narration. Keep intermediate updates short
and translate abstractions into concrete user behavior.

## 1. Establish the Problem

Separate the pain from the proposed feature:

- who experiences it, in which workflow, and how often;
- what they do today, including manual workarounds and tolerated failure;
- what happens if Stella does nothing;
- what outcome would demonstrate improvement.

Confirm this framing once when it is genuinely ambiguous. Do not make the user
answer questions the repository or evidence can resolve.

## 2. Autopsy the Status Quo

Understand why the current process persists before redesigning it. Account for
regulation, liability, professional norms, migration, training, political
ownership, integration, and parallel safety systems. Apply the Schuster check:
is the idea better after switching costs, or merely cleaner on a blank page?

## 3. Test Stella's Product Boundary

Evaluate the idea for:

- 5–50 lawyer firms without dedicated workflow administrators;
- a credible path to 2,000–5,000+ lawyers;
- buyer, administrator, and daily-user incentives;
- international jurisdictions, terminology, formats, RTL, and legal-system
  differences;
- privileged data, auditability, trust, and graceful failure;
- open standards, self-hosting, and provider replaceability.

Inspect the current repository and nearby plans so the recommendation extends
existing product primitives instead of inventing a parallel system.

## 4. Research the Market and Structural Analogs

Because product and competitor capabilities change, verify current claims with
web research and cite direct, authoritative sources. Separate documented facts
from inference and unknowns.

Compare:

- legal-sector table stakes, strengths, complaints, and switching paths;
- adjacent categories that solve the same structural problem;
- interaction models and mental models worth importing, rather than cosmetic
  feature copying;
- genuine differentiation Stella can sustain rather than a temporary feature
  gap.

## 5. Rebuild, Then Reconcile

Describe the clean-slate ideal and its remarkable version. List inherited
assumptions and distinguish real constraints from convention. Then bring back
path dependence: identify which parts survive now, which require compatibility,
and which should only shape the long-term architecture.

Offer at least three shapes when materially different options exist:

- the smallest coherent version;
- the stronger durable version;
- what not to build yet.

Make the tradeoffs explicit and recommend one.

## 6. Apply the Maintenance Filter

Assess ongoing complexity, operator burden, tuning, failure behavior, likely
follow-up demands, extensibility, and the ability to explain the feature in
three sentences. Prefer a smaller model with truthful states over a flexible
system whose edge cases require permanent manual discipline.

## 7. Verdict

Return **Build**, **Reshape**, **Defer**, or **Kill**, with:

- the problem and affected user;
- evidence from the repository and current market;
- options considered and why the recommendation wins;
- the smallest valuable scope and explicit non-goals;
- three guardrails that must carry into planning;
- failure/maintenance risks and success signals;
- a one-sentence pitch to a skeptical managing partner.

Keep the synthesis compact enough to act on. Move to `/plan` only after the
product boundary is coherent and the user asks for a durable plan artifact.
