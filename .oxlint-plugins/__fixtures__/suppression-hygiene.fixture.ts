// Passive regression fixture covering both suppression-hygiene rules.

// oxlint-disable-next-line suppression-hygiene/require-description -- fixture: descriptionless directive must be rejected
// oxlint-disable-next-line no-console
console.log("suppressed");

// oxlint-disable-next-line suppression-hygiene/no-foreign-directive -- fixture: foreign formatter directives must be rejected
// biome-ignore format: fixture proves dead formatter directives are rejected
const foreignDirective = "foreign";

// oxlint-disable-next-line suppression-hygiene/no-foreign-directive -- fixture: the legacy eslint spelling must be rejected
// eslint-disable-next-line no-console -- fixture: legacy alias of the oxlint directive
console.log("legacy spelling");

// Prose naming eslint-disable mid-sentence -- not a directive; only a leading one is flagged.

// This test intentionally uses the native console for a fixture.
// oxlint-disable-next-line no-console
console.log("documented above");

// oxlint-disable-next-line no-console -- fixture: inline reason is valid
console.log("documented inline");

// A described same-line directive and plain comments are accepted.
// expect-clean: suppression-hygiene/require-description, suppression-hygiene/no-foreign-directive
console.log("documented same line"); // oxlint-disable-line no-console -- fixture: same-line reason is valid

void foreignDirective;

// Canonical IDs leave both the directive and its reason intact.
// expect-clean: suppression-hygiene/canonical-rule-id
console.log("canonical"); // oxlint-disable-line no-console -- fixture: configured spelling

// oxlint-disable-next-line suppression-hygiene/canonical-rule-id -- fixture: alias spelling is reported on the directive
// oxlint-disable-next-line eslint/no-console -- fixture: alias maps to configured spelling
console.log("alias");
