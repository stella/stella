# @stll/template-conditions

A document-template marker and condition engine: the `{{...}}` marker grammar,
an expression parser, numeric/arithmetic compute, a condition-builder
serializer, and deterministic field-value rendering. Small, side-effect-free
functions usable on both backend (Bun) and frontend (browser).

Boolean conditions are evaluated through the canonical
[`@stll/conditions`](https://github.com/stella/stella/tree/main/packages/conditions)
AST and its single evaluator, so template `{% if ... %}` conditionals share one
set of operators and semantics with the rest of the system. This package owns
the template surface: the marker grammar, the string parser, the named-condition
resolver, the numeric expression evaluator, and the no-code builder serializer.

```ts
import { evaluateCondition, scanMarkers } from "@stll/template-conditions";

const branch = evaluateCondition("isCompany and signed", fillData);

for (const marker of scanMarkers(templateText)) {
  // marker.kind, marker.path, ...
}
```

## Install

```sh
bun add @stll/template-conditions
```

## Exports (`.`)

- Condition evaluation: `evaluateCondition`, `parseCondition`,
  `evaluateNumericExpression`, `serializeCondition`, `resolvePath`.
- Field values: `renderDeterministicFieldValue`, `formatDate`.
- Marker grammar: `scanMarkers`, `classifyMarker`, `markerPattern`,
  `placeholderPattern`, and the directive-kind constants.

## Migrating to 0.7

`evaluateCondition(expression, data, namedConditions?)` now owns its recursion
state. Calls with two or three arguments retain their behavior, including the
50-reference limit for named conditions and cycle detection.

The previously exported fourth `_resolved` and fifth `_depth` arguments have
been removed. Remove those arguments when they only supplied the defaults
(`new Set()` and `0`). Consumers that deliberately supplied visited names or a
starting depth must adapt that logic before upgrading, or remain on 0.6.x;
there is no public replacement for manually controlling the recursion state.

## License

Apache-2.0
