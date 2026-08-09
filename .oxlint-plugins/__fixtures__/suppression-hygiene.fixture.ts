// Passive regression fixture covering both suppression-hygiene rules.

// oxlint-disable-next-line suppression-hygiene/require-description -- fixture: descriptionless directive must be rejected
// oxlint-disable-next-line no-console
console.log("suppressed");

/* oxlint-disable suppression-hygiene/no-foreign-directive -- fixture: foreign formatter directives must be rejected */
// biome-ignore format: fixture proves dead formatter directives are rejected
const foreignDirective = "foreign";
/* oxlint-enable suppression-hygiene/no-foreign-directive */

// This test intentionally uses the native console for a fixture.
// oxlint-disable-next-line no-console
console.log("documented above");

// oxlint-disable-next-line no-console -- fixture: inline reason is valid
console.log("documented inline");

void foreignDirective;
