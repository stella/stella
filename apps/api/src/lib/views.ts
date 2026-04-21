import type { SupportedLang } from "@/api/lib/locale";
import type { ViewLayout, ViewLayoutType } from "@/api/lib/views-schema";

/**
 * Layouts that every workspace must have exactly one of.
 * These views are created automatically on workspace creation
 * and cannot be deleted.
 */
export const REQUIRED_VIEW_LAYOUTS: ViewLayoutType[] = [
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
      type,
      ...base,
      columnOrder: [],
      columnPinning: [],
    };
  }

  if (type === "kanban") {
    return {
      type,
      ...base,
      groupByPropertyId: "_status",
    };
  }

  return { type, ...base };
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

/** Get default views with localized names. */
export const getDefaultViews = (lang: SupportedLang): DefaultView[] => {
  const names = VIEW_NAMES[lang] ?? VIEW_NAMES.en;
  return DEFAULT_VIEW_TEMPLATES.map((tmpl) => ({
    name: names[tmpl.nameKey],
    layout: tmpl.layout,
    position: tmpl.position,
  }));
};
