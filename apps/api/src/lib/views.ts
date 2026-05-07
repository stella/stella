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
  const names = VIEW_NAMES[lang] ?? VIEW_NAMES.en;
  return DEFAULT_VIEW_TEMPLATES.map((tmpl) => ({
    name: names[tmpl.nameKey],
    layout: cloneDefaultLayout(tmpl.layout, options),
    position: tmpl.position,
  }));
};
