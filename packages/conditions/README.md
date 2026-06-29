# @stll/conditions

A generic, side-effect-free boolean/predicate condition engine: a typed
condition AST, its single evaluator, and a walker.

The package owns one canonical structured-condition shape (compare, predicate,
and group nodes combined with `and`/`or` and negation) so that different
consumers — filters, gating, templates — share one set of operators and
semantics and never drift apart. Domain code supplies a small `resolve`
adapter that turns a non-literal operand into a concrete value; the evaluator
handles operators, boolean combination, and negation.

```ts
import { evaluateCondition, type Condition } from "@stll/conditions";

const condition: Condition = {
  type: "group",
  combinator: "and",
  negated: false,
  children: [
    {
      type: "compare",
      op: "eq",
      left: { type: "path", path: "status" },
      right: { type: "literal", value: "open" },
    },
  ],
};

const result = evaluateCondition(condition, (operand) =>
  operand.type === "path" ? data[operand.path] : undefined,
);
```

## Install

```sh
bun add @stll/conditions
```

## API

Everything is exported from the package root (`@stll/conditions`). The surface
is organised into three areas:

- **schema** — the condition AST types and Valibot schemas
  (`conditionSchema`, `conditionNodeSchema`, `emptyCondition`).
- **evaluate** — the single evaluator (`evaluateCondition`, `OperandResolver`,
  `pruneIncomplete`).
- **walk** — AST traversal helpers (`conditionHasFormula`).

## License

Apache-2.0
