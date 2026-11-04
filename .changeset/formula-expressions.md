---
"@stll/conditions": minor
---

Add formula expressions: a structured AST (`expressionSchema`) for arithmetic, money, dates, comparisons, conditionals over condition nodes, and cross-row aggregates (min, max, sum, avg, count, rank, share of total), with a pure evaluator (`evaluateExpression`) that takes today's date as input and returns typed errors instead of NaN.
