import * as v from "valibot";

import { BROWSER_CONTROL_LIMITS } from "./browser-control";
import { BROWSER_SITE_GRANT_ORIGIN_CHARS } from "./browser-site-grants";

/**
 * Research notes the agent keeps about one website's mechanics for one
 * member: how the site's search form works, which field or filter to use,
 * what failed there and what fixed it. They are keyed on the same exact
 * HTTPS origin as a website approval (`browser-site-grants.ts`), but need
 * none: a member who answers every browser step still gains from them.
 *
 * Notes keep themselves current through use, never by age. When the agent
 * follows a note and it works, it confirms the note, which moves its
 * confirmation time; when a note no longer works, the agent replaces or
 * removes it in the same run. Over the per-website cap, the least recently
 * confirmed note goes.
 *
 * A note is about the site, never about the member's work: the API refuses
 * text that carries an e-mail address, a secret, a personal-data pattern or
 * a full address with a query string (`browserSiteNoteContentRefusal`).
 * Notes never authorize a browser step; the step gate
 * (`browser-step-gate.ts`) decides every step as before.
 */

/** What a note records about a step on the website. */
export const BROWSER_SITE_NOTE_KINDS = ["works", "failed", "fixed"] as const;

export type BrowserSiteNoteKind = (typeof BROWSER_SITE_NOTE_KINDS)[number];

/** Most notes one member keeps for one website. */
export const BROWSER_SITE_NOTES_PER_SITE_MAX = 30;

/** Most websites one member keeps notes for. */
export const BROWSER_SITE_NOTE_SITES_MAX = 100;

/** Longest step label, such as "search form" or "date filter". */
export const BROWSER_SITE_NOTE_STEP_CHARS = 80;

/** Longest note text. */
export const BROWSER_SITE_NOTE_TEXT_CHARS = 300;

/** Most changes one save carries. */
export const BROWSER_SITE_NOTE_CHANGES_MAX = BROWSER_SITE_NOTES_PER_SITE_MAX;

/** Why a note was not stored; the agent reads the code and the reason. */
export const BROWSER_SITE_NOTE_REFUSAL_CODE = {
  /** The address is not a plain HTTPS one, so it names no website. */
  notHttps: "site_note_not_https",
  /** The text names an e-mail address. */
  email: "site_note_email",
  /** The text carries an address with a query string. */
  urlQuery: "site_note_url_query",
  /** The text carries something shaped like a password, key or token. */
  secret: "site_note_secret",
  /** The text carries a phone, account or identity number. */
  personalData: "site_note_personal_data",
  /** The text carries model-control sequences or nothing legible. */
  unsafeText: "site_note_unsafe_text",
  /** No note with that id is kept for this website. */
  unknownNote: "site_note_unknown",
  /** The member already keeps notes for `BROWSER_SITE_NOTE_SITES_MAX` websites. */
  siteLimitReached: "site_note_site_limit_reached",
} as const;

export type BrowserSiteNoteRefusalCode =
  (typeof BROWSER_SITE_NOTE_REFUSAL_CODE)[keyof typeof BROWSER_SITE_NOTE_REFUSAL_CODE];

/** The content refusals, each with the reason the agent is told. */
export type BrowserSiteNoteContentRefusal = {
  code: Extract<
    BrowserSiteNoteRefusalCode,
    | "site_note_email"
    | "site_note_url_query"
    | "site_note_secret"
    | "site_note_personal_data"
  >;
  reason: string;
};

const EMAIL = /[^\s@<>()[\]",;:]+@[^\s@<>()[\]",;:]+\.[a-z]{2,}/iu;

// An address with a query string: a scheme or `www.` start, then `?` and a
// parameter. A path alone is fine ("the /search page").
const URL_WITH_QUERY =
  /(?:\b[a-z][a-z0-9+.-]*:\/\/|\bwww\.)[^\s?]*\?[^\s]*[=&]/iu;

const SECRET_PREFIXES = [
  // Provider API keys and tokens with a fixed prefix.
  /\b(?:sk|pk|rk)[-_][a-z0-9_-]{16,}/iu,
  /\bgh[pousr]_[a-z0-9]{20,}/iu,
  /\bgithub_pat_[a-z0-9_]{20,}/iu,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bxox[abprs]-[a-z0-9-]{10,}/iu,
  /\bAIza[0-9a-z_-]{30,}/iu,
  // A JSON web token: three base64url segments, the first an encoded `{"`.
  /\beyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\./iu,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
] as const;

// A credential written as a labelled value ("password: hunter2").
const LABELLED_SECRET =
  /\b(?:password|passwd|pwd|passcode|passphrase|heslo|hasło|jelszó|passwort|contraseña|mot de passe|pin|otp|token|api[ _-]?key|secret|client[ _-]?secret)\s*[:=]\s*\S+/iu;

// A long opaque run of letters and digits, the shape of a generated token:
// 24 or more without a separator, or a base64url run of 32 or more with both
// cases. Words, paths and hyphenated names break at their separators.
const OPAQUE_TOKEN = /[a-z0-9]{24,}/giu;
const BASE64URL_TOKEN = /[a-z0-9_-]{32,}/giu;

const mixesLettersAndDigits = (run: string) =>
  run.replaceAll(/\D/gu, "").length >= 4 &&
  run.replaceAll(/[^a-z]/giu, "").length >= 4;

const isBase64UrlToken = (run: string) =>
  mixesLettersAndDigits(run) && /[A-Z]/u.test(run) && /[a-z]/u.test(run);

// Nine or more digits in one run, single spaces or dashes allowed between
// them: a phone, account or card number. A date range ("1.1.2020 31.12.2020")
// breaks at its dots.
const LONG_NUMBER = /\+?\d(?:[ -]?\d){8,}/u;

// A national identity number written with its slash (six digits, then three
// or four), and an IBAN.
const IDENTITY_NUMBER = /\b\d{6}\/\d{3,4}\b/u;
const IBAN = /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}\b/u;

/**
 * Why `text` may not be kept in a site note, or null when it may. A note
 * holds how a website works, so anything that names a person, a credential
 * or one particular search (an address with its query) is refused.
 */
export const browserSiteNoteContentRefusal = (
  text: string,
): BrowserSiteNoteContentRefusal | null => {
  if (EMAIL.test(text)) {
    return {
      code: BROWSER_SITE_NOTE_REFUSAL_CODE.email,
      reason:
        "A site note cannot name an e-mail address. Describe the step without it.",
    };
  }
  if (URL_WITH_QUERY.test(text)) {
    return {
      code: BROWSER_SITE_NOTE_REFUSAL_CODE.urlQuery,
      reason:
        "A site note cannot carry an address with a query string, which records one search. Name the page or the field instead.",
    };
  }
  if (
    SECRET_PREFIXES.some((pattern) => pattern.test(text)) ||
    LABELLED_SECRET.test(text) ||
    (text.match(OPAQUE_TOKEN) ?? []).some(mixesLettersAndDigits) ||
    (text.match(BASE64URL_TOKEN) ?? []).some(isBase64UrlToken)
  ) {
    return {
      code: BROWSER_SITE_NOTE_REFUSAL_CODE.secret,
      reason:
        "A site note cannot carry a password, key or token. Sign-ins stay with the member.",
    };
  }
  if (LONG_NUMBER.test(text) || IDENTITY_NUMBER.test(text) || IBAN.test(text)) {
    return {
      code: BROWSER_SITE_NOTE_REFUSAL_CODE.personalData,
      reason:
        "A site note cannot carry a phone, account or identity number. Keep only how the website works.",
    };
  }
  return null;
};

const stepSchema = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(BROWSER_SITE_NOTE_STEP_CHARS),
  v.description(
    `The step, in a few words ("search form", "date filter"); at most ${BROWSER_SITE_NOTE_STEP_CHARS} characters.`,
  ),
);

const textSchema = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(BROWSER_SITE_NOTE_TEXT_CHARS),
  v.description(
    `What to do or avoid there, about the website only; at most ${BROWSER_SITE_NOTE_TEXT_CHARS} characters.`,
  ),
);

const kindSchema = v.pipe(
  v.picklist(BROWSER_SITE_NOTE_KINDS),
  v.description(
    "works, failed (avoid it), or fixed (what failed and the fix).",
  ),
);

const noteIdSchema = v.pipe(
  v.string(),
  v.uuid(),
  v.description("The note's id from read_site_notes or the last save."),
);

/** The content of a note, as the agent writes it. */
export const browserSiteNoteContentSchema = v.strictObject({
  kind: kindSchema,
  step: stepSchema,
  text: textSchema,
});

export type BrowserSiteNoteContent = v.InferOutput<
  typeof browserSiteNoteContentSchema
>;

/** One change to the notes for a website. */
export const browserSiteNoteChangeSchema = v.variant("type", [
  v.strictObject({
    type: v.pipe(v.literal("add"), v.description("Keep a new note.")),
    ...browserSiteNoteContentSchema.entries,
  }),
  v.strictObject({
    type: v.pipe(
      v.literal("confirm"),
      v.description("You followed it and it worked."),
    ),
    id: noteIdSchema,
  }),
  v.strictObject({
    type: v.pipe(
      v.literal("replace"),
      v.description("It no longer works; keep what works now instead."),
    ),
    id: noteIdSchema,
    ...browserSiteNoteContentSchema.entries,
  }),
  v.strictObject({
    type: v.pipe(
      v.literal("remove"),
      v.description("It no longer works and nothing replaces it."),
    ),
    id: noteIdSchema,
  }),
]);

export type BrowserSiteNoteChange = v.InferOutput<
  typeof browserSiteNoteChangeSchema
>;

/** The address the agent names a website by; only its origin is kept. */
export const browserSiteNoteUrlSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(BROWSER_CONTROL_LIMITS.urlChars),
  v.description(
    "A page address on the website, as the browser reported it; only its origin is kept.",
  ),
);

export const readBrowserSiteNotesInputSchema = v.strictObject({
  url: browserSiteNoteUrlSchema,
});

export const saveBrowserSiteNotesInputSchema = v.strictObject({
  url: browserSiteNoteUrlSchema,
  changes: v.pipe(
    v.array(browserSiteNoteChangeSchema),
    v.minLength(1),
    v.maxLength(BROWSER_SITE_NOTE_CHANGES_MAX),
    v.description(
      "Applied in order, each on its own; refusals return in `issues`.",
    ),
  ),
});

/** A note as the agent and the member read it. */
export const browserSiteNoteSchema = v.object({
  id: v.string(),
  kind: v.picklist(BROWSER_SITE_NOTE_KINDS),
  step: v.pipe(v.string(), v.maxLength(BROWSER_SITE_NOTE_STEP_CHARS)),
  text: v.pipe(v.string(), v.maxLength(BROWSER_SITE_NOTE_TEXT_CHARS)),
  /** When the note last worked, or was written (ISO 8601). */
  confirmedAt: v.string(),
});

export type BrowserSiteNote = v.InferOutput<typeof browserSiteNoteSchema>;

/** The notes for one website, the most recently confirmed first. */
export const browserSiteNotesSchema = v.object({
  origin: v.pipe(v.string(), v.maxLength(BROWSER_SITE_GRANT_ORIGIN_CHARS)),
  notes: v.pipe(
    v.array(browserSiteNoteSchema),
    v.maxLength(BROWSER_SITE_NOTES_PER_SITE_MAX),
  ),
});

export const saveBrowserSiteNotesOutputSchema = v.object({
  ...browserSiteNotesSchema.entries,
  /** The changes refused, by their position in `changes`. */
  issues: v.pipe(
    v.array(
      v.object({
        index: v.number(),
        code: v.picklist(Object.values(BROWSER_SITE_NOTE_REFUSAL_CODE)),
        reason: v.string(),
      }),
    ),
    v.maxLength(BROWSER_SITE_NOTE_CHANGES_MAX),
  ),
  /** Notes dropped to stay within the cap, least recently confirmed first. */
  pruned: v.pipe(
    v.array(v.string()),
    v.maxLength(BROWSER_SITE_NOTE_CHANGES_MAX),
  ),
});

export type SaveBrowserSiteNotesOutput = v.InferOutput<
  typeof saveBrowserSiteNotesOutputSchema
>;

/** The agent tool that reads a website's notes, on every surface. */
export const READ_SITE_NOTES_TOOL_NAME = "read_site_notes";

/** The agent tool that adds, confirms, replaces or removes notes. */
export const SAVE_SITE_NOTES_TOOL_NAME = "save_site_notes";
