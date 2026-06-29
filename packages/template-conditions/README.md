# @stll/template-conditions

A document-template marker and condition engine: the `{{...}}` marker grammar,
an expression parser, numeric/arithmetic compute, a condition-builder
serializer, and deterministic field-value rendering. Small, side-effect-free
functions usable on both backend (Bun) and frontend (browser).

Boolean conditions are evaluated through the canonical
[`@stll/conditions`](https://github.com/stella/stella/tree/main/packages/conditions)
AST and its single evaluator, so template `{{#if ...}}` conditionals share one
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
- Field values: `renderDeterministicFieldValue`, `renderComposite`,
  `formatDate`.
- Marker grammar: `scanMarkers`, `classifyMarker`, `markerPattern`,
  `placeholderPattern`, and the directive-kind constants.

## License

Apache-2.0
