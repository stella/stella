// Mock content shared by the scenes. It depicts user data, not interface
// text, so it is deliberately untranslated (the same rule the app's "New view"
// previews follow); every name is fictional.

export type PreviewPerson = { name: string };

export const PREVIEW_PEOPLE = {
  laura: { name: "Laura Chen" },
  tomas: { name: "Tomás Novák" },
  amira: { name: "Amira Haddad" },
  james: { name: "James Whitfield" },
} as const satisfies Record<string, PreviewPerson>;

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
