<p align="center">
  <img src=".github/assets/banner.png" alt="stll/legal-ast" width="100%" />
</p>

# @stll/legal-ast

A shared vocabulary for legal text.

Legal documents are more than paragraphs. A statute has articles, provisions,
points, letters, tables, footnotes, anchors, effective dates, and amendment
history. A judgment has headings, holdings, citations, anonymized spans, and
source metadata. `@stll/legal-ast` gives those structures a typed shape that
parsers, search indexes, readers, and AI tools can share.

## What It Gives You

- Shared inline formatting nodes: text, bold, italic, links, and line breaks.
- A document AST for judgments and other structured legal documents.
- A statute AST for legislation and consolidated legal text.
- Persisted decision-analysis contracts for case-law readers.
- Runtime guards for persisted JSON.
- Versioned types designed for long-lived public legal corpora.

The goal is simple: parse once, preserve structure, reuse everywhere.

## Install

Inside the stella monorepo:

```sh
bun add @stll/legal-ast --workspace
```

## Example

```ts
import { isStatuteAst, parseStatuteAst } from "@stll/legal-ast";

const ast = parseStatuteAst(rawJson);

if (isStatuteAst(ast)) {
  console.log(ast.metadata.title);
  console.log(ast.body[0]?.kind);
}
```

## Design Promises

- Pure types and guards only: no database, network, storage, or framework code.
- Native labels are preserved; normalized fields are added for cross-source use.
- Persisted shapes are versioned. New formats should add versions, not mutate old
  data in place.

## License

Apache-2.0
