---
"@stll/template-conditions": minor
---

The root `@stll/template-conditions` entrypoint now exposes
`evaluateCondition(expression, data, namedConditions?)`. Remove the fourth
`_resolved` and fifth `_depth` arguments: cycle tracking and the 50-reference
depth limit are owned by a private evaluation context. This is a breaking 0.7
release for callers that supplied those arguments; two- and three-argument calls
retain their behavior.

Calls that passed the defaults (`new Set()` and `0`) can drop those arguments.
Consumers that intentionally supplied visited names or a starting depth must
adapt that logic before upgrading or remain on 0.6.x. There is no replacement
public recursion-state API.
