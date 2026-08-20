# @stll/anonymize-cli

Command-line PII detection and anonymization powered by
[`@stll/anonymize`](https://github.com/stella/anonymize).
Processing is local and makes no network calls. `bunx` and `npx` may contact a
package registry to download the CLI; use an existing local or global install
when the invocation itself must remain offline.

## Usage

```bash
# No install needed
echo "Contact Jan Novák at jan.novak@example.com" | bunx @stll/anonymize-cli
# Contact [PERSON_1] at [EMAIL_ADDRESS_1]

# Or with npx / a global install (bin name: anonymize)
npx @stll/anonymize-cli contract.txt > contract.anon.txt
```

Reversible round-trip for LLM workflows — anonymize, send the
redacted text to a model, restore names in the answer:

```bash
anonymize -k key.json -o redacted.txt input.txt
# ... send redacted.txt to the LLM, save reply as reply.txt ...
anonymize -d key.json reply.txt
```

## Options

| Flag                      | Meaning                                          |
| ------------------------- | ------------------------------------------------ |
| `-o, --output <path>`     | Output file, or directory for batch input        |
| `-m, --mode <mode>`       | `replace` (reversible placeholders) or `redact`  |
| `-k, --key <path>`        | Write the redaction key JSON (replace mode)      |
| `-d, --deanonymise <key>` | Restore text using a redaction key               |
| `--revert <term>`         | With `-d`, restore only this entity (repeatable) |
| `-r, --recursive`         | Descend into subdirectories for a directory arg  |
| `--workers <n>`           | Batch files processed concurrently (min(4,cpus)) |
| `--labels <list>`         | Entity labels to detect (default: all)           |
| `--languages <list>`      | Name-corpus languages, e.g. `cs,de,en`           |
| `--countries <list>`      | ISO 3166-1 alpha-2 deny-list/city scope          |
| `--threshold <n>`         | Minimum confidence score 0-1 (default 0.3)       |
| `--redact-string <s>`     | Replacement text in redact mode                  |
| `--json`                  | Emit entities + redacted text as JSON            |
| `--capabilities`          | Emit the versioned capability manifest as JSON   |
| `--quiet`                 | Suppress the stderr summary                      |

`--key` export is supported on Linux. It fails closed on other platforms
because the CLI cannot verify owner-only filesystem ACLs.

Run `anonymize --help` for the full reference, including the
`--json` schema and exit codes.

## PDF workflows

PDF anonymization uses locally installed Poppler and Tesseract, runs one
explicit OCR language pack, and writes a verified fresh image-only document.
It never overlays black boxes on retained source content and refuses to
overwrite the input, a symlink input, or an existing output.

```bash
anonymize pdf anonymize contract.pdf \
  --output contract.anonymized.pdf \
  --ocr-language eng \
  --languages en \
  --countries GB \
  --json
```

The raster output intentionally loses searchability, accessibility, links,
forms, signatures, metadata, attachments, and other interactive PDF features.
Its certificate verifies structure and rewritten pixels but cannot prove
perfect OCR or detector recall; `piiCleanGuaranteed` is always false.

## DOCX workflows

DOCX anonymization preserves supported document structure and stores reversible
placeholder mappings only in an encrypted session archive. Create a raw 32-byte
key file outside the document and restrict its filesystem permissions:

```bash
openssl rand 32 > matter.key
chmod 600 matter.key

anonymize docx anonymize contract.docx \
  --output contract.anonymized.docx \
  --session-mode create \
  --session-archive matter.stlasession \
  --session-key-file matter.key \
  --session-id opaque_matter_1 \
  --countries CZ,DE \
  --languages cs,de \
  --json
```

Continue the same session across another document by changing
`--session-mode create` to `--session-mode continue`. Continue mode opens the
expected encrypted archive and atomically replaces it only after the complete
DOCX rewrite succeeds. It holds an exclusive `<archive>.lock` sidecar until the
archive and document are published, so concurrent continuations fail closed
instead of losing mappings. If a process is interrupted and leaves the lock
behind, verify that no continuation is still running before removing it.

Restore a document with the same archive, key, and expected session identity:

```bash
anonymize docx restore contract.anonymized.docx \
  --output contract.restored.docx \
  --session-archive matter.stlasession \
  --session-key-file matter.key \
  --session-id opaque_matter_1 \
  --json
```

The default `--coverage require-full` policy fails closed on hyperlinks,
tracked revisions, and other content outside the rewrite surface. Processing
such a document requires explicit `--coverage allow-partial`. JSON output is an
aggregate audit-safe summary; it excludes extracted text, detected entity text,
session mappings, key material, and internal DOCX part paths. Document output
paths never overwrite existing files. Session keys are read only from files,
never from command arguments.

## Batch processing

A directory argument anonymizes the text files inside it,
mirroring the input tree into the `--output` directory:

```bash
# Non-recursive: only files directly under docs/
anonymize -o out/ docs/

# Recursive, 8 files in flight at a time
anonymize --recursive --workers 8 -o out/ docs/
```

Directory walks process regular files only and skip likely-binary
files (a NUL byte in the first 8 KiB); explicitly named files are
always processed. The stderr summary reports how many files were
processed, failed, and skipped; any failure sets exit code 1.
`--key` and `--json` apply to single inputs only.

`--workers` overlaps file I/O across files; redaction itself is a
synchronous native call, so it is serialized on the JS thread and
the shared pipeline is reused across all workers (identical output
regardless of the worker count).

## Selective de-anonymisation

`--revert` restores only the entities you name, leaving the rest
redacted. A term matches either a placeholder token or an original
value, case-sensitive and exact; it is repeatable:

```bash
anonymize -d key.json --revert "[PERSON_1]" --revert "Jan Novák" reply.txt
```

## Scripting and agents

- Exit codes: `0` success, `1` runtime error, `2` usage error.
- The stderr summary contains entity-label counts only, never
  detected text.
- The interactive locale prompt appears only when stdin and
  stderr are TTYs and no scope flags are given; piped runs
  never block.
- `--json` offsets are UTF-16 code-unit indexes into the input.
- `--capabilities` is runtime-free and does not read document input.

## Distribution

Install or run the npm package with Node.js. A single-file compiled executable
is not currently distributed.

## License

Apache-2.0
