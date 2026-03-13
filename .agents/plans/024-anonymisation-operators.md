# Plan: Pluggable Anonymisation Operators

Date: 2026-03-13

## Goal

Extend the client-side anonymisation pipeline with a Presidio-style
operator system. Instead of every confirmed entity being replaced with
a `[LABEL_N]` placeholder, users can choose per-label how entities
are anonymised: stable placeholder, redact, mask, hash, generalise,
or encrypt. The operator is selected in the review UI before
redaction runs; the output adapts accordingly.

## Design Decisions

- **Operator interface is a pure function.** Each operator is an
  object satisfying `AnonymisationOperator`, with an `apply` method
  that receives the entity text, label, and any operator-specific
  options, and returns a replacement string. No operator touches
  the DOM or external services; Web Crypto calls are async but the
  interface wraps them. This keeps operators testable in isolation
  without a browser runtime, except `encrypt` (Web Crypto is always
  available in modern browsers and Bun's test environment).

- **Per-label operator config, not per-entity.** Users select an
  operator for each label category (e.g., all "person" entities use
  Replace, all "iban" entities use Redact). Per-entity overrides are
  out of scope for now. This is consistent with the existing per-label
  review workflow and keeps the UI simple.

- **Two built-in operators (reduced from six):**

  | Operator | Output | Reversible |
  |---|---|---|
  | `replace` | `[LABEL_N]` stable placeholder | Yes (via redaction key) |
  | `redact` | customizable string (default `[REDACTED]`) | No |

  Originally planned six operators (mask, hash, generalise, encrypt
  in addition to replace and redact). Dropped four after evaluating
  against the ICP:

  - **mask** (`J** N****`): partially guessable from context,
    AI can't meaningfully reference masked text back to the user.
    A compliance/data-science pattern, not useful for the
    "anonymise → AI review → map back" workflow.
  - **generalise** (`1985`, `J.N.`): degrades information the AI
    might need, initials and postcodes can still be identifying,
    and the AI can't reference them back via the redaction map.
  - **hash** (`[sha256:…]`): a data-engineering pattern for
    linkability across datasets. No use case for a law firm
    anonymising a single document for AI review.
  - **encrypt**: adds key-management complexity (passphrase,
    PBKDF2, salt storage) that doesn't fit the ICP. If the
    redaction map needs protection, encrypt the export file
    at the storage layer, not per-entity.

  Replace + redact cover the two real needs: "anonymise for AI
  processing, then map back" and "permanently remove, never
  recoverable." Additional operators can be added later if a
  concrete use case emerges.

- **`replace` remains the default for all labels.** Existing
  pipeline behaviour is unchanged unless the user explicitly
  reconfigures a label. Default operator suggestions per label type
  are provided as a constant but the user always controls the final
  config.

- **`deanonymise()` is extended but stays backward-compatible.**
  Replace produces reversible entries in the `redactionMap` as
  before. Encrypt produces entries with ciphertext as the value; a
  separate `decryptRedactionMap(map, key)` function decrypts them
  using Web Crypto before passing to `deanonymise()`. Redact / mask /
  hash / generalise produce no map entries (irreversible; skipped
  silently by `deanonymise`).

- **`RedactionResult` gains an `operatorMap` field.** This records
  which operator was used for each placeholder. This is needed for
  the export format and for `decryptRedactionMap` to know which
  entries are encrypted.

- **Encryption key management is the user's responsibility.** We
  prompt for a passphrase in the UI, derive an AES-GCM key via
  PBKDF2 (100,000 iterations, SHA-256, random 16-byte salt), and
  store the salt alongside the ciphertext in the exported key file.
  We never persist the passphrase or the derived key. The encrypted
  redaction key export bundles the salt and ciphertext per entity so
  the file is self-contained for future decryption.

- **`mask` strategy is label-aware.** Names: mask all but the first
  character of each word (`J*** N****`). IBANs and account numbers:
  show last 4 characters, mask the rest (`****1234`). Emails: mask
  local part, reveal domain (`j***@example.com`). Everything else:
  full asterisk mask preserving original length.

- **`generalise` strategy is label-aware.** Dates and dates of
  birth: extract year only. Addresses: extract city/postcode token
  via simple heuristic (last comma-delimited segment). Names:
  reduce to initials (`Jan Novák` → `J.N.`). Other labels: first
  word only. If the heuristic produces no meaningful result, fall
  back to `[GENERALISED]`.

- **`hash` is SHA-256 truncated to 12 hex chars.** The full 256-bit
  hash would be unwieldy in a document. 48 bits (12 hex chars) is
  enough to be collision-resistant for the entity counts typical in
  a legal document. The output format `[sha256:a3f2c1b9e820]` is
  self-documenting. Uses `crypto.subtle.digest` (Web Crypto, no
  external dependency). For the Bun test environment, `crypto` is
  available globally.

- **Operator config lives in `redact.ts`, not in `types.ts`.** The
  type definitions for the operator interface go in `types.ts`; the
  operator implementations and the `OPERATOR_REGISTRY` live in
  `operators.ts` (new file). This keeps `types.ts` declaration-only.

- **No new npm dependencies.** All six operators use only built-in
  Web APIs (Web Crypto, TextEncoder) or logic already present in
  the codebase.

## Scope

**In scope:**

- `types.ts`: `AnonymisationOperator`, `OperatorType`, `OperatorConfig`,
  extended `RedactionResult` (adds `operatorMap`)
- `operators.ts`: six operator implementations, `OPERATOR_REGISTRY`,
  `DEFAULT_OPERATOR_CONFIG` (sensible per-label defaults)
- `redact.ts`: refactor `redactText` to accept an `OperatorConfig`,
  dispatch per label, handle async encrypt operator, update
  `RedactionResult`, extend `exportRedactionKey` to embed operator
  metadata, add `decryptRedactionMap(map, passphrase)`
- `anonymize.tsx` (dev UI): operator selector per label in the
  review step sidebar; passphrase input shown only when any label
  uses `encrypt`; updated redacted output and key export
- `redact.test.ts`: tests for each operator variant, async encrypt
  round-trip, mixed-operator documents
- `operators.test.ts`: unit tests for mask/hash/generalise edge cases

**Out of scope:**

- Per-entity operator overrides (all entities of a label share one
  operator)
- Custom (user-defined) operators
- Server-side operator execution
- Operator persistence across sessions (config is ephemeral per
  redaction run)
- Integration of operators into the production anonymisation UI
  (currently dev-route only)

## Implementation

### New types in `types.ts`

```typescript
export const OPERATOR_TYPES = [
  "replace", "redact", "mask", "hash", "generalise", "encrypt",
] as const;

export type OperatorType = (typeof OPERATOR_TYPES)[number];

/** Per-label operator selection. Key is the entity label. */
export type OperatorConfig = Record<string, OperatorType>;

/** Whether an operator produces a reversible redaction entry. */
export type OperatorReversibility = "reversible" | "irreversible";

export type AnonymisationOperator = {
  type: OperatorType;
  reversibility: OperatorReversibility;
  /**
   * Apply the operator to a single entity occurrence.
   * Returns the replacement string to embed in the document.
   * May be async (encrypt operator uses Web Crypto).
   */
  apply: (
    text: string,
    label: string,
    placeholder: string,
    options?: EncryptOptions,
  ) => string | Promise<string>;
};

export type EncryptOptions = {
  key: CryptoKey;
  salt: Uint8Array;
};

/** Extended result carrying per-placeholder operator metadata. */
export type RedactionResult = {
  redactedText: string;
  /** Maps placeholder to original text (replace) or ciphertext (encrypt). */
  redactionMap: Map<string, string>;
  /** Maps placeholder to the operator that produced it. */
  operatorMap: Map<string, OperatorType>;
  entityCount: number;
};
```

### New file: `operators.ts`

Contains implementations for all six operators plus the registry
and default config:

```
OPERATOR_REGISTRY: Record<OperatorType, AnonymisationOperator>
DEFAULT_OPERATOR_CONFIG: OperatorConfig  // replace for all labels

maskText(text, label): string
generaliseText(text, label): string
hashText(text): Promise<string>
encryptText(text, key, salt): Promise<string>
decryptText(ciphertext, key, salt): Promise<string>
```

`hashText` uses `crypto.subtle.digest("SHA-256", encoder.encode(text))`,
converts to hex, takes the first 12 chars.

`encryptText` generates a random 12-byte IV per entity, encrypts with
AES-GCM, encodes as `[enc:{base64(iv)}:{base64(ciphertext)}]`.
The salt is shared for the run (not per entity); the IV is per entity.

### Changes to `redact.ts`

`redactText` becomes async:

```typescript
export const redactText = async (
  fullText: string,
  entities: Entity[],
  operatorConfig: OperatorConfig,
  encryptOptions?: EncryptOptions,
): Promise<RedactionResult>
```

Internal flow:
1. `buildPlaceholderMap` runs unchanged (placeholder assignment is
   still label+text keyed, operator does not affect naming).
2. For each non-overlapping entity, look up `operatorConfig[entity.label]`
   (default `"replace"` if absent) and call
   `OPERATOR_REGISTRY[op].apply(...)`.
3. Populate `redactionMap` only for reversible operators (replace,
   encrypt). Irreversible operators contribute nothing to the map.
4. Populate `operatorMap` for all operators.

`exportRedactionKey` encodes `operatorMap` entries alongside
`redactionMap` entries so the exported JSON is self-describing.

New export: `decryptRedactionMap(map, operatorMap, passphrase)`
derives the PBKDF2 key from the passphrase and salt (embedded in
the export), decrypts all `encrypt` entries in the map, returns a
plain `Map<string, string>` suitable for `deanonymise`.

### Changes to `anonymize.tsx` (dev UI)

- Add an "Operator" column to the entity label sidebar. Each label
  row shows a `<select>` with the six operator options.
- When any label uses `encrypt`, show a passphrase input field
  above the "Redact" button. The passphrase is kept in local
  component state; never logged or persisted.
- `redactText` call becomes `await redactText(...)`.
- The exported redaction key includes the `operatorMap`.

### Module structure (additions only)

```
apps/web/src/lib/anonymize/
├── operators.ts          # Six operator implementations + registry
├── operators.test.ts     # Unit tests for mask/hash/generalise/encrypt
└── types.ts              # Extended (AnonymisationOperator, OperatorType…)
```

## Test Cases

### `operators.test.ts`

- `maskText("Jan Novák", "person")` → `"J** N****"`
- `maskText("CZ6508000000192000145399", "iban")` → `"********************5399"`
- `maskText("jan@example.com", "email address")` → `"j**@example.com"`
- `maskText("Václavské náměstí 1", "address")` → all asterisks
- `generaliseText("15. 3. 1985", "date of birth")` → `"1985"`
- `generaliseText("Praha, Staré Město, 110 00", "address")` → `"110 00"`
- `generaliseText("Jan Novák", "person")` → `"J.N."`
- `generaliseText("", "person")` → `"[GENERALISED]"`
- `hashText("Jan Novák")` → deterministic 12-char hex string
- `hashText("Jan Novák")` called twice → same result
- Encrypt round-trip: `encryptText` then `decryptText` → original text

### `redact.test.ts` additions

- Document with `replace` operator: behaves identically to existing
  tests (backward compatibility)
- Document with `redact` operator: placeholders absent,
  `[REDACTED]` in output, `redactionMap` is empty
- Document with `mask` operator: masked strings in output, no map entries
- Document with `hash` operator: `[sha256:…]` tokens in output
- Mixed operators (person=replace, iban=redact): each label uses
  its operator; `redactionMap` has person entries only
- Encrypt operator: `redactedText` contains `[enc:…]` tokens;
  `redactionMap` contains encrypted values; `decryptRedactionMap`
  restores originals; `deanonymise` applied after decrypt restores
  full text
- `deanonymise` with an irreversible-only `redactionMap` (empty map)
  returns redacted text unchanged (no crash)
- `operatorMap` correctly records operator type per placeholder

## Open Questions

- **Hash collision communication:** If two distinct entity values
  collide on 12 hex chars (astronomically unlikely for typical
  document sizes but theoretically possible), the redacted document
  becomes ambiguous. Accept this as a known limitation and document
  it, or extend to 16 chars? Proposal: 12 chars for now; revisit
  if we add corpus-scale batch processing.

- **Generalise heuristics:** The city/postcode extraction from
  addresses is locale-specific. Czech addresses end with a postcode;
  German addresses may have `PLZ Ort` after a comma; English
  addresses vary. A simple last-comma-segment heuristic covers
  most cases but will fail on multi-line addresses. Accept the
  imprecision or add locale-aware extractors?

- **`encryptOptions` for passphrase input UX:** Deriving the PBKDF2
  key blocks the main thread for ~100 ms at 100k iterations. Should
  we move key derivation to a Web Worker, or is 100 ms acceptable
  given it only happens once per redaction run?

- **`redactText` going async:** The existing `redactText` is
  synchronous. Making it async is a breaking change for any caller
  that does not `await` it. The only caller today is `anonymize.tsx`;
  but if tests mock it synchronously, they will need updating.
  Alternative: keep `redactText` sync, add `redactTextAsync` for
  encrypt operator, unify in a follow-up. Proposal: go async now
  to avoid two code paths; update all callers in the same PR.
