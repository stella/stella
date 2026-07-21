import type { SafeId } from "@/api/lib/branded-types";
import type { SupportedLang } from "@/api/lib/locale";
import type { ViewLayout, ViewLayoutType } from "@/api/lib/views-schema";

/**
 * Layouts that every workspace must have exactly one of.
 * These views are created automatically on workspace creation
 * and cannot be deleted.
 */
export const REQUIRED_VIEW_LAYOUTS: readonly ViewLayoutType[] = [
  "overview",
  "table",
  "filesystem",
  "kanban",
];

type DefaultViewTemplate = {
  nameKey: keyof typeof VIEW_NAMES.en;
  layout: ViewLayout;
  position: number;
};

const emptyLayout = (
  type: "overview" | "table" | "filesystem" | "kanban",
): ViewLayout => {
  const base: Pick<ViewLayout, "filters" | "sorts" | "hiddenProperties"> = {
    filters: [],
    sorts: [],
    hiddenProperties: [],
  };

  if (type === "table") {
    return {
      version: 1,
      type,
      ...base,
      columnOrder: [],
      columnPinning: [],
    };
  }

  if (type === "kanban") {
    return {
      version: 1,
      type,
      ...base,
      groupByPropertyId: "_status",
    };
  }

  return { version: 1, type, ...base };
};

const VIEW_NAMES = {
  en: { overview: "Overview", table: "Table", files: "Files", todos: "Todos" },
  ar: {
    overview: "نظرة عامة",
    table: "جدول",
    files: "الملفات",
    todos: "المهام",
  },
  cs: {
    overview: "Přehled",
    table: "Tabulka",
    files: "Soubory",
    todos: "Úkoly",
  },
  de: {
    overview: "Übersicht",
    table: "Tabelle",
    files: "Dateien",
    todos: "Aufgaben",
  },
  es: {
    overview: "Resumen",
    table: "Tabla",
    files: "Archivos",
    todos: "Tareas",
  },
  et: {
    overview: "Ülevaade",
    table: "Tabel",
    files: "Failid",
    todos: "Ülesanded",
  },
  fr: {
    overview: "Aperçu",
    table: "Tableau",
    files: "Fichiers",
    todos: "Tâches",
  },
  hu: {
    overview: "Áttekintés",
    table: "Táblázat",
    files: "Fájlok",
    todos: "Feladatok",
  },
  lt: {
    overview: "Apžvalga",
    table: "Lentelė",
    files: "Failai",
    todos: "Užduotys",
  },
  lv: {
    overview: "Pārskats",
    table: "Tabula",
    files: "Faili",
    todos: "Uzdevumi",
  },
  pl: {
    overview: "Przegląd",
    table: "Tabela",
    files: "Pliki",
    todos: "Zadania",
  },
  "pt-BR": {
    overview: "Visão geral",
    table: "Tabela",
    files: "Arquivos",
    todos: "Tarefas",
  },
  sk: {
    overview: "Prehľad",
    table: "Tabuľka",
    files: "Súbory",
    todos: "Úlohy",
  },
} as const satisfies Record<SupportedLang, Record<string, string>>;

/**
 * Templates for default views. Use `getDefaultViews(lang)` to
 * get localized view definitions.
 */
const DEFAULT_VIEW_TEMPLATES: readonly DefaultViewTemplate[] = [
  { nameKey: "overview", layout: emptyLayout("overview"), position: 0 },
  { nameKey: "table", layout: emptyLayout("table"), position: 1 },
  { nameKey: "files", layout: emptyLayout("filesystem"), position: 2 },
  { nameKey: "todos", layout: emptyLayout("kanban"), position: 3 },
];

type DefaultView = {
  name: string;
  layout: ViewLayout;
  position: number;
};

type GetDefaultViewsOptions = {
  tableColumnPinning?: string[];
};

const cloneDefaultLayout = (
  layout: ViewLayout,
  options: GetDefaultViewsOptions,
): ViewLayout => {
  if (layout.type === "table") {
    return {
      ...layout,
      hiddenProperties: [...layout.hiddenProperties],
      filters: [...layout.filters],
      sorts: [...layout.sorts],
      columnOrder: [...layout.columnOrder],
      columnPinning: options.tableColumnPinning
        ? [...options.tableColumnPinning]
        : [...layout.columnPinning],
    };
  }

  return {
    ...layout,
    hiddenProperties: [...layout.hiddenProperties],
    filters: [...layout.filters],
    sorts: [...layout.sorts],
  };
};

/** Get default views with localized names. */
export const getDefaultViews = (
  lang: SupportedLang,
  options: GetDefaultViewsOptions = {},
): DefaultView[] => {
  const names = VIEW_NAMES[lang];
  return DEFAULT_VIEW_TEMPLATES.map((tmpl) => ({
    name: names[tmpl.nameKey],
    layout: cloneDefaultLayout(tmpl.layout, options),
    position: tmpl.position,
  }));
};

// Default views are seeded once, when a workspace is created, in the source
// language. Their names are re-localized to the reader's language on every
// read (see `localizeDefaultViewName`), so the persisted language is invisible
// to users and a single fixed seed language keeps the write path request-free.
export const DEFAULT_VIEW_SEED_LANG: SupportedLang = "en";

type DefaultViewRow = {
  workspaceId: SafeId<"workspace">;
  name: string;
  layout: ViewLayout;
  position: number;
};

type BuildDefaultViewRowsInput = {
  workspaceId: SafeId<"workspace">;
  // The workspace's system file property, pinned as the first column of the
  // table view. Null only for the defensive path where no file property
  // exists yet (in which case the table view is seeded with no pinned column).
  filePropertyId: string | null;
};

/**
 * Build the default workspace views as insert-ready rows for a fresh
 * workspace. Callers own the `INSERT` (and any audit trail) so this stays a
 * pure, side-effect-free transform shared by the create handler and dev seed.
 */
export const buildDefaultViewRows = ({
  workspaceId,
  filePropertyId,
}: BuildDefaultViewRowsInput): DefaultViewRow[] =>
  getDefaultViews(DEFAULT_VIEW_SEED_LANG, {
    tableColumnPinning: filePropertyId ? [filePropertyId] : [],
  }).map((view) => ({
    workspaceId,
    name: view.name,
    layout: view.layout,
    position: view.position,
  }));

// A default view's layout type → its VIEW_NAMES key.
const LAYOUT_TYPE_TO_NAME_KEY: Partial<
  Record<ViewLayoutType, keyof typeof VIEW_NAMES.en>
> = {
  overview: "overview",
  table: "table",
  filesystem: "files",
  kanban: "todos",
};

// Every localized default name per key, so an un-renamed default view can be
// recognized regardless of the language it was seeded in.
const DEFAULT_NAME_SETS: Record<
  keyof typeof VIEW_NAMES.en,
  ReadonlySet<string>
> = (() => {
  const sets = {
    overview: new Set<string>(),
    table: new Set<string>(),
    files: new Set<string>(),
    todos: new Set<string>(),
  };
  for (const names of Object.values(VIEW_NAMES)) {
    sets.overview.add(names.overview);
    sets.table.add(names.table);
    sets.files.add(names.files);
    sets.todos.add(names.todos);
  }
  return sets;
})();

/**
 * Re-localize an auto-created default view's name to `lang`.
 *
 * Default view names are persisted in the creator's language at seed time
 * (see `getDefaultViews`), so an Arabic user opening a matter created by a
 * Czech colleague would otherwise see "Přehled" instead of "نظرة عامة". On
 * read we detect an un-renamed default — its stored name still matches a
 * seeded name for its layout type, in any language — and return the current
 * language's name. User-renamed views fall through unchanged.
 *
 * Caveat: if a user deliberately renames a view to a string that collides
 * with another language's default for that layout type (e.g. renaming a
 * table view to "Table"), the rename is treated as a default and
 * re-localized on read. Acceptable given the low collision likelihood.
 */
export const localizeDefaultViewName = ({
  lang,
  layoutType,
  name,
}: {
  lang: SupportedLang;
  layoutType: ViewLayoutType;
  name: string;
}): string => {
  const nameKey = LAYOUT_TYPE_TO_NAME_KEY[layoutType];
  if (nameKey === undefined || !DEFAULT_NAME_SETS[nameKey].has(name)) {
    return name;
  }
  return VIEW_NAMES[lang][nameKey];
};
