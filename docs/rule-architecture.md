# Prepared rule architecture

The prepared engine runs statically linked Rust rules over one immutable
document. The substrate has four boundaries:

- `RuleSpec` declares a rule identifier, required inputs, dependencies,
  support resources, diagnostic stage, and additive scaling domains.
- `RulePack` groups module-owned rules while the central registry defines only
  pack order.
- `PreparedDocument` owns access to prepared document views. A rule can read a
  view only when its specification declares the corresponding input.
- `Finding<T>` validates the span of each rule result before the result enters
  domain-specific resolution.

Current rule packs use closed enums and Rust function pointers. Registration,
activation, and execution are resolved at compile time: execution does not
load code, call into a host language, or require worker threads. This shape is
suitable for a single-threaded WebAssembly runtime and keeps identical rule
behavior across native and browser builds.

## Adding a rule

Keep the specification and hooks in the rule's module. Declare every input the
hook reads, every earlier rule whose findings it consumes, each prepared
resource it uses, and each growing input in the additive scaling contract. Add
the rule to that module's pack; change the central pack order only when a new
dependency requires it.

Rules return domain values with UTF-8 byte spans. The generic finding boundary
checks that each span is monotonic. Existing resolution then applies its own
label, confidence, overlap, and output policies. Keeping span validation before
that conversion allows future rule families to use different payloads without
coupling the rule substrate to one resolver.

## Structured document inputs

Future structured annotations should be prepared document views, not ambient
state. A view should have a closed input identifier, an owned preparation step,
and an accessor on `PreparedDocument` that checks the active `RuleSpec` before
returning it. Examples include page regions, table cells, style runs, or
caller-supplied annotations. Their source format and lifetime stay outside rule
hooks; rules receive immutable prepared data only.

## Browser offsets

Rust strings and findings use UTF-8 byte offsets. Browser strings commonly use
UTF-16 code-unit offsets. A browser boundary must therefore convert incoming
UTF-16 offsets to checked UTF-8 boundaries before preparing annotations, and
convert outgoing byte spans back through one document offset map. Rule code
must not slice Rust text with UTF-16 offsets or assume one code unit per Unicode
scalar. Invalid interior, reversed, or out-of-range offsets fail at the
boundary rather than reaching a rule.
