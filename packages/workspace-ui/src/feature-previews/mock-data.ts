// The default content shared by the scenes: one fictional English set, shown
// when the host passes no `data`. It depicts user data, not interface text,
// so it is not translated (the same rule the app's "New view" previews
// follow); hosts that want other content pass their own.

/** A person drawn as initials (assignees, reviewers, comment authors). */
export type PreviewPerson = { name: string };

export const PREVIEW_PEOPLE = {
  laura: { name: "Laura Chen" },
  tomas: { name: "Tomás Novák" },
  amira: { name: "Amira Haddad" },
} as const satisfies Record<string, PreviewPerson>;

/** A matter drawn with its icon. `color` is a matter colour token
 *  (`--option-blue`, `--option-violet`, …); `id` seeds the fallback colour. */
export type PreviewMatter = { id: string; color: string; name: string };

export const PREVIEW_MATTERS = {
  cargo: {
    id: "preview-matter-cargo",
    color: "--option-blue",
    name: "Harbour Logistics v. Meridian Freight",
  },
  acquisition: {
    id: "preview-matter-acquisition",
    color: "--option-violet",
    name: "Project Alder: share purchase",
  },
  lease: {
    id: "preview-matter-lease",
    color: "--option-amber",
    name: "Quayside warehouse lease",
  },
} as const satisfies Record<string, PreviewMatter>;
