import * as v from "valibot";

// oxlint-disable-next-line require-valibot-message/require-valibot-message -- fixture proves an email validator needs localized copy
const bareEmail = v.email();
// oxlint-disable-next-line require-valibot-message/require-valibot-message -- fixture proves a bounded validator needs localized copy
const bareMinimum = v.minLength(2);

// expect-clean: require-valibot-message/require-valibot-message
const translatedEmail = v.email("Enter a valid email address.");
const translatedMinimum = v.minLength(2, "Enter at least two characters.");

export { bareEmail, bareMinimum, translatedEmail, translatedMinimum };
