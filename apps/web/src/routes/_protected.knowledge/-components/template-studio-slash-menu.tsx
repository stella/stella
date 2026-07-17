import type { MouseEvent as ReactMouseEvent, RefObject } from "react";
import { useCallback, useMemo, useRef, useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { LucideIcon } from "lucide-react";
import {
  BracesIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  SplitIcon,
  TextQuoteIcon,
} from "lucide-react";
import type { Transaction } from "prosemirror-state";
import { TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { useDebounce } from "use-debounce";
import { useTranslations } from "use-intl";

import type {
  TemplateSlashMenuKeyAction,
  TemplateSlashMenuState,
} from "@stll/folio-react";
import {
  clearTemplateSlashMenu,
  consumeTemplateSlashQuery,
  getFolioCaretViewportRect,
  getTemplateDirectives,
  getTemplateSlashMenu,
  resetTemplateSlashQuery,
} from "@stll/folio-react";
import { isSafeFieldPath } from "@stll/template-conditions";
import { DirectionalIcon } from "@stll/ui/components/directional-icon";
import {
  MenuPreviewLayout,
  PreviewPane,
} from "@stll/ui/components/preview-pane";
import { stellaToast } from "@stll/ui/components/toast";
import { containedHandler } from "@stll/ui/hooks/use-contained-handler";
import { cn } from "@stll/ui/lib/utils";

import { useExternalSyncEffect } from "@/hooks/use-effect";
import type { TranslationKey } from "@/i18n/types";
import { api } from "@/lib/api";
import { userErrorMessage } from "@/lib/errors/user-safe";
import { toSafeId } from "@/lib/safe-id";
import { inputTypeValueKind, VALUE_TYPE_META } from "@/lib/value-types";
import {
  sanitizeFieldPath,
  slugify,
} from "@/routes/_protected.knowledge/-components/template-studio-model";
import {
  useTemplateStudioStore,
  type StudioField,
} from "@/routes/_protected.knowledge/-components/template-studio-store";
import {
  clausesOptions as clauseLibraryOptions,
  knowledgeKeys,
} from "@/routes/_protected.knowledge/-queries";

type SlashMenuPopoverProps = {
  slash: SlashMenu;
  rows: SlashRows;
  highlight: number;
  fields: StudioField[];
  onHighlight: (index: number) => void;
  onActivateRoot: (item: SlashRootItem) => void;
  onActivateField: (path: string) => void;
  onActivateClause: (clause: SlashClause) => void;
  onBack: () => void;
};

export const TemplateStudioSlashMenu = ({
  slash,
  rows,
  highlight,
  fields,
  onHighlight,
  onActivateRoot,
  onActivateField,
  onActivateClause,
  onBack,
}: SlashMenuPopoverProps) => {
  const t = useTranslations();
  const empty =
    rows.view === "clauses"
      ? t("clauses.noResults")
      : t("templates.studio.slashEmpty");
  return (
    <div
      className="bg-popover text-popover-foreground absolute z-50 flex flex-col rounded-md border text-sm shadow-lg/5 transition-opacity duration-100 starting:opacity-0"
      role="listbox"
      style={{
        left: slash.left,
        top: slash.top,
        transform:
          slash.placement === "above"
            ? `translate(0, calc(-100% - ${SLASH_MENU_OFFSET_PX}px))`
            : `translate(0, ${SLASH_MENU_OFFSET_PX}px)`,
      }}
    >
      <SlashMenuHeader query={slash.query} view={rows.view} onBack={onBack} />
      <MenuPreviewLayout
        className="min-h-0"
        preview={
          <PreviewPane>
            <SlashPreview fields={fields} highlight={highlight} rows={rows} />
          </PreviewPane>
        }
      >
        <div className="max-h-[min(18rem,60vh)] min-h-0 w-56 overflow-y-auto p-1">
          {rows.items.length === 0 && (
            <p className="text-muted-foreground px-2 py-1.5 text-xs">{empty}</p>
          )}
          <SlashMenuRows
            fields={fields}
            highlight={highlight}
            rows={rows}
            onActivateClause={onActivateClause}
            onActivateField={onActivateField}
            onActivateRoot={onActivateRoot}
            onHighlight={onHighlight}
          />
        </div>
      </MenuPreviewLayout>
      <div className="text-muted-foreground border-t px-3 py-1 text-[11px] leading-snug">
        {t("templates.studio.slashFooter")}
      </div>
    </div>
  );
};

/** Gap (px) between the caret and the menu's top-left corner. */
const SLASH_MENU_OFFSET_PX = 2;
/** Rough rendered height of the menu, used to choose above or below. */
const SLASH_MENU_EST_HEIGHT_PX = 280;
const SLASH_MENU_LIST_WIDTH_PX = 224;
const SLASH_MENU_PREVIEW_WIDTH_PX = 256 + 9;
const SLASH_MENU_WIDTH_PX =
  SLASH_MENU_LIST_WIDTH_PX + SLASH_MENU_PREVIEW_WIDTH_PX;
const SLASH_MENU_PREVIEW_BREAKPOINT_PX = 640;
const SLASH_MENU_MAX_FIELDS = 50;
const SLASH_MENU_CLAUSE_LIMIT = 50;

type SlashMenu = {
  from: number;
  query: string;
  left: number;
  top: number;
  placement: "above" | "below";
};

type SlashView = "root" | "fields" | "clauses";

type SlashRootItem =
  | { kind: "create-field"; path: string }
  | { kind: "create-condition" }
  | { kind: "field"; path: string; label: string }
  | { kind: "open-fields" }
  | { kind: "open-clauses" };

type SlashClause = {
  id: string;
  title: string;
  currentVersion: number;
  description: string | null;
};

type SlashRows =
  | { view: "root"; items: SlashRootItem[] }
  | { view: "fields"; items: StudioField[] }
  | { view: "clauses"; items: SlashClause[] };

const createFieldPathFromQuery = (trimmed: string): string => {
  if (trimmed === "") {
    return "field";
  }
  if (isSafeFieldPath(trimmed)) {
    return trimmed;
  }
  const sanitized = sanitizeFieldPath(trimmed);
  return isSafeFieldPath(sanitized) ? sanitized : "field";
};

const uniqueFieldPath = (base: string, fields: StudioField[]): string => {
  let path = base;
  for (let n = 2; fields.some((field) => field.path === path); n++) {
    path = `${base}_${n}`;
  }
  return path;
};

const buildSlashRootItems = (
  query: string,
  fields: StudioField[],
): SlashRootItem[] => {
  const trimmed = query.trim();
  const needle = trimmed.toLowerCase();
  const matches = (...keywords: string[]): boolean =>
    keywords.some((keyword) => keyword.includes(needle));

  if (trimmed === "") {
    const items: SlashRootItem[] = [
      { kind: "create-field", path: uniqueFieldPath("field", fields) },
      { kind: "create-condition" },
    ];
    if (fields.length > 0) {
      items.push({ kind: "open-fields" });
    }
    items.push({ kind: "open-clauses" });
    return items;
  }

  const createPath = createFieldPathFromQuery(trimmed);
  const reuseExact = fields.some((field) => field.path === createPath);
  const items: SlashRootItem[] = matchingSlashFields(query, fields).map(
    (field) => ({
      kind: "field" as const,
      path: field.path,
      label: field.label === "" ? field.path : field.label,
    }),
  );
  if (matches("clause")) {
    items.push({ kind: "open-clauses" });
  }
  if (matches("condition", "if")) {
    items.push({ kind: "create-condition" });
  }
  if (!reuseExact) {
    items.push({ kind: "create-field", path: createPath });
  }
  return items;
};

const matchingSlashFields = (
  query: string,
  fields: StudioField[],
): StudioField[] => {
  const needle = query.trim().toLowerCase();
  const matches = (field: StudioField): boolean => {
    if (needle === "") {
      return true;
    }
    const label = field.label === "" ? field.path : field.label;
    return (
      field.path.toLowerCase().includes(needle) ||
      label.toLowerCase().includes(needle)
    );
  };
  return fields.filter(matches).slice(0, SLASH_MENU_MAX_FIELDS);
};

const slashRowCount = (
  view: SlashView,
  query: string,
  fields: StudioField[],
  clauseCount: number,
): number => {
  if (view === "fields") {
    return matchingSlashFields(query, fields).length;
  }
  if (view === "clauses") {
    return clauseCount;
  }
  return buildSlashRootItems(query, fields).length;
};

type UseTemplateStudioSlashMenuOptions = {
  activeOrganizationId: string;
  templateId: string;
  editorViewRef: RefObject<EditorView | null>;
  overlayHostRef: RefObject<HTMLDivElement | null>;
  insertCondition: () => void;
  markDirty: () => void;
  upsertField: (path: string, patch: Partial<StudioField>) => void;
};

/** Owns the Folio slash-command bridge, clause search, insertion, and menu UI state. */
export const useTemplateStudioSlashMenu = ({
  activeOrganizationId,
  templateId,
  editorViewRef,
  overlayHostRef,
  insertCondition,
  markDirty,
  upsertField,
}: UseTemplateStudioSlashMenuOptions) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const [slash, setSlashState] = useState<SlashMenu | null>(null);
  const [slashView, setSlashViewState] = useState<SlashView>("root");
  const [slashHighlight, setSlashHighlightState] = useState(0);
  const slashViewRef = useRef<SlashView>("root");
  const slashHighlightRef = useRef(0);
  const slashFromRef = useRef<number | null>(null);
  const setSlashView = useCallback((view: SlashView) => {
    slashViewRef.current = view;
    setSlashViewState(view);
  }, []);
  const setSlashHighlight = useCallback((index: number) => {
    slashHighlightRef.current = index;
    setSlashHighlightState(index);
  }, []);
  const studioFields = useTemplateStudioStore((state) => state.fields);

  const slashClausesEnabled = slash !== null && slashView === "clauses";
  const [debouncedClauseSearch] = useDebounce(
    slashView === "clauses" ? (slash?.query ?? "") : "",
    120,
  );
  const { data: slashClauseData } = useQuery({
    ...clauseLibraryOptions(activeOrganizationId, {
      search: debouncedClauseSearch,
      limit: SLASH_MENU_CLAUSE_LIMIT,
    }),
    enabled: slashClausesEnabled,
  });
  const slashClauses: SlashClause[] = useMemo(
    () =>
      slashClauseData && "items" in slashClauseData
        ? slashClauseData.items
        : [],
    [slashClauseData],
  );
  const slashClausesRef = useRef<SlashClause[]>(slashClauses);
  const debouncedClauseSearchRef = useRef(debouncedClauseSearch);
  useExternalSyncEffect(() => {
    slashClausesRef.current = slashClauses;
    debouncedClauseSearchRef.current = debouncedClauseSearch;
  }, [slashClauses, debouncedClauseSearch]);

  const slashRows = useMemo((): SlashRows => {
    if (slash === null) {
      return { view: "root", items: [] };
    }
    if (slashView === "fields") {
      return {
        view: "fields",
        items: matchingSlashFields(slash.query, studioFields),
      };
    }
    if (slashView === "clauses") {
      return { view: "clauses", items: slashClauses };
    }
    return {
      view: "root",
      items: buildSlashRootItems(slash.query, studioFields),
    };
  }, [slash, slashView, studioFields, slashClauses]);

  const positionSlashMenu = useCallback(
    (from: number) => {
      const host = overlayHostRef.current;
      if (!host) {
        return;
      }
      let attempts = 0;
      const read = () => {
        const liveView = editorViewRef.current;
        const live = liveView ? getTemplateSlashMenu(liveView.state) : null;
        if (
          liveView === null ||
          live === null ||
          !live.active ||
          live.from !== from
        ) {
          return;
        }
        const rect = getFolioCaretViewportRect(liveView);
        if (!rect) {
          attempts += 1;
          if (attempts < 10) {
            // eslint-disable-next-line react/react-compiler -- recursive local function is not a reactive dependency
            requestAnimationFrame(read);
          }
          return;
        }
        const hostRect = host.getBoundingClientRect();
        const caretLeft = rect.left - hostRect.left;
        const caretTop = rect.top - hostRect.top;
        const caretBottom = rect.bottom - hostRect.top;
        const fitsAbove =
          caretTop - SLASH_MENU_OFFSET_PX - SLASH_MENU_EST_HEIGHT_PX >= 0;
        const placement = fitsAbove ? "above" : "below";
        const renderedWidth =
          window.innerWidth >= SLASH_MENU_PREVIEW_BREAKPOINT_PX
            ? SLASH_MENU_WIDTH_PX
            : SLASH_MENU_LIST_WIDTH_PX;
        const left = Math.max(
          0,
          Math.min(caretLeft, host.clientWidth - renderedWidth),
        );
        setSlashState((previous) =>
          previous === null
            ? previous
            : {
                ...previous,
                left,
                top: placement === "below" ? caretBottom : caretTop,
                placement,
              },
        );
      };
      requestAnimationFrame(read);
    },
    [editorViewRef, overlayHostRef],
  );

  const onSlashMenuChange = (state: TemplateSlashMenuState) => {
    if (!state.active) {
      setSlashState(null);
      setSlashView("root");
      slashFromRef.current = null;
      return;
    }
    const isNewTrigger = slashFromRef.current !== state.from;
    slashFromRef.current = state.from;
    setSlashState((previous) => ({
      from: state.from,
      query: state.query,
      left: previous?.left ?? 0,
      top: previous?.top ?? 0,
      placement: previous?.placement ?? "below",
    }));
    setSlashHighlight(0);
    if (isNewTrigger) {
      positionSlashMenu(state.from);
    }
  };

  const dismissSlash = useCallback(() => {
    const view = editorViewRef.current;
    if (view && getTemplateSlashMenu(view.state).active) {
      view.dispatch(clearTemplateSlashMenu(view.state.tr));
    }
    setSlashState(null);
    setSlashView("root");
    slashFromRef.current = null;
  }, [editorViewRef, setSlashView]);

  const slashInsertNewField = (
    view: EditorView,
    consumed: { tr: Transaction; from: number },
    path: string,
  ) => {
    const tr = consumed.tr.insertText(`{{${path}}}`, consumed.from);
    const namePos = consumed.from + 2;
    tr.setSelection(
      TextSelection.create(tr.doc, namePos, namePos + path.length),
    ).scrollIntoView();
    view.dispatch(tr);
    view.focus();
    upsertField(path, {});
    markDirty();
  };

  const enterSlashSubmenu = (next: SlashView) => {
    const editor = editorViewRef.current;
    if (editor) {
      const tr = resetTemplateSlashQuery(editor.state);
      if (tr !== null) {
        editor.dispatch(tr);
      }
    }
    setSlashView(next);
    setSlashHighlight(0);
  };

  const activateSlashRoot = (item: SlashRootItem) => {
    if (item.kind === "open-fields") {
      enterSlashSubmenu("fields");
      return;
    }
    if (item.kind === "open-clauses") {
      enterSlashSubmenu("clauses");
      return;
    }
    const view = editorViewRef.current;
    if (!view) {
      return;
    }
    const consumed = consumeTemplateSlashQuery(view.state);
    if (consumed === null) {
      return;
    }
    if (item.kind === "create-field") {
      slashInsertNewField(view, consumed, item.path);
      dismissSlash();
      return;
    }
    if (item.kind === "field") {
      view.dispatch(
        consumed.tr
          .insertText(`{{${item.path}}}`, consumed.from)
          .scrollIntoView(),
      );
      view.focus();
      markDirty();
      dismissSlash();
      return;
    }
    view.dispatch(consumed.tr.scrollIntoView());
    insertCondition();
    dismissSlash();
  };

  const activateSlashField = (path: string) => {
    const view = editorViewRef.current;
    if (!view) {
      return;
    }
    const consumed = consumeTemplateSlashQuery(view.state);
    if (consumed === null) {
      return;
    }
    view.dispatch(
      consumed.tr.insertText(`{{${path}}}`, consumed.from).scrollIntoView(),
    );
    view.focus();
    markDirty();
    dismissSlash();
  };

  const uniqueClauseSlotName = (base: string): string => {
    const view = editorViewRef.current;
    const seed = base === "" ? "clause" : base;
    const taken = new Set([
      ...(view
        ? getTemplateDirectives(view.state).flatMap((directive) =>
            directive.kind === "clause" ? [directive.expr] : [],
          )
        : []),
      ...useTemplateStudioStore
        .getState()
        .pendingSlotRenames.flatMap((step) => [step.fromSlot, step.slotName]),
    ]);
    let candidate = seed;
    for (let n = 2; taken.has(candidate); n++) {
      candidate = `${seed}_${n}`;
    }
    return candidate;
  };

  const linkClauseToSlot = async (clauseId: string, slotName: string) => {
    const response = await api
      .templates({ templateId: toSafeId<"template">(templateId) })
      .clauses.put({ clauseId: toSafeId<"clause">(clauseId), slotName });
    if (response.error) {
      stellaToast.add({
        type: "error",
        title: t("clauses.linkFailed"),
        description: userErrorMessage(
          response.error,
          t("common.unexpectedError"),
        ),
      });
      return;
    }
    void queryClient.invalidateQueries({
      queryKey: knowledgeKeys.templates.clauses(
        activeOrganizationId,
        templateId,
      ),
    });
  };

  const activateSlashClause = (clause: { id: string; title: string }) => {
    const view = editorViewRef.current;
    if (!view) {
      return;
    }
    const live = getTemplateSlashMenu(view.state);
    if (live.active && debouncedClauseSearchRef.current !== live.query) {
      return;
    }
    const consumed = consumeTemplateSlashQuery(view.state);
    if (consumed === null) {
      return;
    }
    const slotName = uniqueClauseSlotName(slugify(clause.title));
    view.dispatch(
      consumed.tr
        .insertText(`{{@clause:${slotName}}}`, consumed.from)
        .scrollIntoView(),
    );
    view.focus();
    markDirty();
    dismissSlash();
    void linkClauseToSlot(clause.id, slotName);
  };

  const onSlashMenuKeyAction = (
    action: TemplateSlashMenuKeyAction,
  ): boolean => {
    const view = editorViewRef.current;
    const live = view ? getTemplateSlashMenu(view.state) : null;
    if (live === null || !live.active) {
      return false;
    }
    const currentView = slashViewRef.current;
    if (action === "back") {
      if (currentView === "root") {
        return false;
      }
      enterSlashSubmenu("root");
      return true;
    }
    if (action === "dismiss") {
      if (currentView === "root") {
        return false;
      }
      enterSlashSubmenu("root");
      return true;
    }
    const rowCount = slashRowCount(
      currentView,
      live.query,
      useTemplateStudioStore.getState().fields,
      slashClausesRef.current.length,
    );
    if (rowCount === 0) {
      return action === "up" || action === "down" || action === "commit";
    }
    if (action === "up") {
      setSlashHighlight((slashHighlightRef.current - 1 + rowCount) % rowCount);
      return true;
    }
    if (action === "down") {
      setSlashHighlight((slashHighlightRef.current + 1) % rowCount);
      return true;
    }
    const index = Math.min(slashHighlightRef.current, rowCount - 1);
    if (currentView === "root") {
      const items = buildSlashRootItems(
        live.query,
        useTemplateStudioStore.getState().fields,
      );
      const item = items.at(index);
      if (item === undefined) {
        return false;
      }
      if (action === "forward") {
        if (item.kind === "open-fields" || item.kind === "open-clauses") {
          activateSlashRoot(item);
          return true;
        }
        return false;
      }
      activateSlashRoot(item);
      return true;
    }
    if (action === "forward") {
      return false;
    }
    if (currentView === "fields") {
      const field = matchingSlashFields(
        live.query,
        useTemplateStudioStore.getState().fields,
      ).at(index);
      if (field === undefined) {
        return false;
      }
      activateSlashField(field.path);
      return true;
    }
    const clause = slashClausesRef.current.at(index);
    if (clause === undefined) {
      return false;
    }
    activateSlashClause(clause);
    return true;
  };

  const slashShown = slash !== null;
  useExternalSyncEffect(() => {
    if (!slashShown) {
      return undefined;
    }
    const host = overlayHostRef.current;
    const dismiss = (event: Event) => {
      if (
        event.target instanceof Element &&
        event.target.closest('[role="listbox"]')
      ) {
        return;
      }
      dismissSlash();
    };
    host?.addEventListener("wheel", dismiss, { capture: true, passive: true });
    host?.addEventListener("touchmove", dismiss, {
      capture: true,
      passive: true,
    });
    host?.addEventListener("contextmenu", dismiss, { capture: true });
    return () => {
      host?.removeEventListener("wheel", dismiss, { capture: true });
      host?.removeEventListener("touchmove", dismiss, { capture: true });
      host?.removeEventListener("contextmenu", dismiss, { capture: true });
    };
  }, [slashShown, dismissSlash, overlayHostRef]);

  return {
    onSlashMenuChange,
    onSlashMenuKeyAction,
    renderState:
      slash === null
        ? null
        : {
            slash,
            rows: slashRows,
            highlight: slashHighlight,
            fields: studioFields,
            onHighlight: setSlashHighlight,
            onActivateRoot: activateSlashRoot,
            onActivateField: activateSlashField,
            onActivateClause: activateSlashClause,
            onBack: () => enterSlashSubmenu("root"),
          },
  };
};

const keepEditorFocus = (event: { preventDefault: () => void }) => {
  event.preventDefault();
};

const SlashMenuHeader = ({
  view,
  query,
  onBack,
}: {
  view: SlashView;
  query: string;
  onBack: () => void;
}) => {
  const t = useTranslations();
  if (view === "root") {
    return (
      <p className="text-muted-foreground truncate border-b px-3 py-1.5 text-[11px] leading-snug">
        {query === "" ? t("templates.studio.slashHint") : `/${query}`}
      </p>
    );
  }
  const label =
    view === "fields"
      ? t("templates.studio.existingField")
      : t("common.clauses");
  return (
    <button
      className="text-muted-foreground hover:text-foreground flex items-center gap-1 border-b px-3 py-1.5 text-start text-[11px] leading-snug"
      onClick={onBack}
      onMouseDown={keepEditorFocus}
      type="button"
    >
      <DirectionalIcon className="size-3 shrink-0" icon={ChevronLeftIcon} />
      <span className="truncate">
        {label}
        {query === "" ? "" : ` · ${query}`}
      </span>
    </button>
  );
};

const SlashMenuRows = ({
  rows,
  highlight,
  fields,
  onHighlight,
  onActivateRoot,
  onActivateField,
  onActivateClause,
}: {
  rows: SlashRows;
  highlight: number;
  fields: StudioField[];
  onHighlight: (index: number) => void;
  onActivateRoot: (item: SlashRootItem) => void;
  onActivateField: (path: string) => void;
  onActivateClause: (clause: SlashClause) => void;
}) => {
  if (rows.view === "root") {
    return (
      <SlashRootRows
        highlight={highlight}
        rows={rows.items}
        onActivateRoot={onActivateRoot}
        onHighlight={onHighlight}
      />
    );
  }
  if (rows.view === "fields") {
    return (
      <>
        {rows.items.map((field, index) => (
          <SlashMenuRow
            key={field.path}
            face={slashFieldFace(field, fields)}
            selected={index === highlight}
            onHighlight={() => onHighlight(index)}
            onSelect={() => onActivateField(field.path)}
          />
        ))}
      </>
    );
  }
  return (
    <>
      {rows.items.map((clause, index) => (
        <SlashMenuRow
          key={clause.id}
          face={{ icon: TextQuoteIcon, label: clause.title, hint: undefined }}
          selected={index === highlight}
          onHighlight={() => onHighlight(index)}
          onSelect={() => onActivateClause(clause)}
        />
      ))}
    </>
  );
};

const SlashRootRows = ({
  rows,
  highlight,
  onHighlight,
  onActivateRoot,
}: {
  rows: SlashRootItem[];
  highlight: number;
  onHighlight: (index: number) => void;
  onActivateRoot: (item: SlashRootItem) => void;
}) => {
  const t = useTranslations();
  return (
    <>
      {rows.map((item, index) => {
        const previous = rows.at(index - 1);
        const group = SLASH_ROOT_GROUP[item.kind];
        const showLabel =
          index === 0 ||
          previous === undefined ||
          SLASH_ROOT_GROUP[previous.kind] !== group;
        let face: SlashRowFace;
        if (item.kind === "field") {
          face = {
            icon: BracesIcon,
            label: item.label,
            hint: item.label === item.path ? undefined : item.path,
          };
        } else {
          const rootFace = slashRootFace(item);
          face = {
            icon: rootFace.icon,
            label: t(rootFace.labelKey),
            hint: rootFace.hint,
          };
        }
        return (
          <div key={slashRootKey(item)}>
            {showLabel && (
              <p className="text-muted-foreground px-2 pt-1.5 pb-0.5 text-[10px] font-medium tracking-wide uppercase">
                {t(SLASH_GROUP_LABEL[group])}
              </p>
            )}
            <SlashMenuRow
              chevron={
                item.kind === "open-fields" || item.kind === "open-clauses"
              }
              face={face}
              selected={index === highlight}
              onHighlight={() => onHighlight(index)}
              onSelect={() => onActivateRoot(item)}
            />
          </div>
        );
      })}
    </>
  );
};

type SlashRowFace = {
  icon: LucideIcon;
  label: string;
  hint: string | undefined;
};

const SlashMenuRow = ({
  face,
  selected,
  chevron = false,
  onHighlight,
  onSelect,
}: {
  face: SlashRowFace;
  selected: boolean;
  chevron?: boolean;
  onHighlight: () => void;
  onSelect: () => void;
}) => {
  const { icon: Icon, label, hint } = face;
  const rowRef = useRef<HTMLButtonElement | null>(null);
  useExternalSyncEffect(() => {
    if (selected) {
      rowRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [selected]);
  return (
    <button
      aria-selected={selected}
      className={cn(
        "flex w-full items-center gap-2 rounded-sm px-2 py-1 text-start",
        selected ? "bg-accent text-accent-foreground" : "text-foreground",
      )}
      // eslint-disable-next-line react/react-compiler -- containedHandler defers the ref read into the click handler
      onClick={containedHandler(rowRef, onSelect)}
      // eslint-disable-next-line react/react-compiler -- containedHandler defers the ref read into the mousedown handler
      onMouseDown={containedHandler(rowRef, (event: ReactMouseEvent) =>
        event.preventDefault(),
      )}
      onMouseEnter={onHighlight}
      ref={rowRef}
      role="option"
      tabIndex={-1}
      type="button"
    >
      <Icon className="text-muted-foreground size-3.5 shrink-0" />
      <span className="flex-1 truncate" dir="auto">
        {label}
      </span>
      {hint !== undefined && (
        <span className="text-muted-foreground shrink-0 truncate font-mono text-[10px]">
          {hint}
        </span>
      )}
      {chevron && (
        <DirectionalIcon
          className="text-muted-foreground size-3.5 shrink-0"
          icon={ChevronRightIcon}
        />
      )}
    </button>
  );
};

const SlashPreview = ({
  rows,
  highlight,
  fields,
}: {
  rows: SlashRows;
  highlight: number;
  fields: StudioField[];
}) => {
  const t = useTranslations();
  if (rows.view === "clauses") {
    const clause = rows.items.at(highlight);
    if (clause === undefined) {
      return <SlashPreviewEmpty />;
    }
    return <SlashClausePreview clause={clause} />;
  }
  if (rows.view === "fields") {
    const field = rows.items.at(highlight);
    if (field === undefined) {
      return <SlashPreviewEmpty />;
    }
    return (
      <SlashTextPreview
        body={t("templates.studio.conceptField")}
        marker={`{{${field.path}}}`}
        title={slashFieldFace(field, fields).label}
      />
    );
  }
  const item = rows.items.at(highlight);
  if (item === undefined) {
    return <SlashPreviewEmpty />;
  }
  return <SlashRootPreview item={item} />;
};

const SlashPreviewEmpty = () => {
  const t = useTranslations();
  return (
    <div className="text-muted-foreground flex h-full items-center justify-center text-center text-xs text-balance">
      {t("templates.studio.previewHint")}
    </div>
  );
};

const SlashRootPreview = ({ item }: { item: SlashRootItem }) => {
  const t = useTranslations();
  if (item.kind === "create-field") {
    return (
      <SlashTextPreview
        body={t("templates.studio.conceptField")}
        marker={`{{${item.path}}}`}
        title={t("templates.studio.makeField")}
      />
    );
  }
  if (item.kind === "create-condition") {
    return (
      <SlashTextPreview
        body={t("templates.studio.conceptCondition")}
        marker="{{#if …}} … {{/if}}"
        title={t("templates.studio.showOnlyIf")}
      />
    );
  }
  if (item.kind === "open-fields") {
    return (
      <SlashTextPreview
        body={t("templates.studio.conceptField")}
        marker="{{ … }}"
        title={t("templates.studio.existingField")}
      />
    );
  }
  return (
    <SlashTextPreview
      body={t("templates.studio.conceptClause")}
      marker="{{@clause: … }}"
      title={t("common.clauses")}
    />
  );
};

const SlashTextPreview = ({
  marker,
  title,
  body,
}: {
  marker: string;
  title: string;
  body: string;
}) => (
  <div className="flex h-full flex-col gap-1.5 overflow-hidden text-xs">
    <code className="bg-primary/10 text-primary w-fit rounded px-1 py-0.5 text-[10px]">
      {marker}
    </code>
    <p className="text-foreground font-medium">{title}</p>
    <p className="text-muted-foreground leading-snug">{body}</p>
  </div>
);

const SlashClausePreview = ({ clause }: { clause: SlashClause }) => {
  const t = useTranslations();
  const description = clause.description?.trim();
  return (
    <div className="flex h-full flex-col gap-1.5 overflow-hidden text-xs">
      <p className="text-foreground font-medium" dir="auto">
        {clause.title}
      </p>
      <p className="text-muted-foreground">
        {t("common.versionLabel", { version: String(clause.currentVersion) })}
      </p>
      <p className="text-muted-foreground leading-snug" dir="auto">
        {description && description.length > 0
          ? description
          : t("templates.studio.conceptClause")}
      </p>
    </div>
  );
};

const SLASH_ROOT_GROUP = {
  "create-field": "primary",
  "create-condition": "primary",
  field: "reuse",
  "open-fields": "reuse",
  "open-clauses": "reuse",
} as const satisfies Record<SlashRootItem["kind"], "primary" | "reuse">;

const SLASH_GROUP_LABEL = {
  primary: "templates.studio.slashGroupInsert",
  reuse: "templates.studio.slashGroupReuse",
} as const satisfies Record<"primary" | "reuse", TranslationKey>;

const slashRootKey = (item: SlashRootItem): string => {
  if (item.kind === "create-field") {
    return `create-field:${item.path}`;
  }
  if (item.kind === "field") {
    return `field:${item.path}`;
  }
  return item.kind;
};

type SlashRootLabelKey =
  | "templates.studio.makeField"
  | "templates.studio.showOnlyIf"
  | "templates.studio.existingField"
  | "common.clauses";

type SlashRootFace = {
  icon: LucideIcon;
  labelKey: SlashRootLabelKey;
  hint: string | undefined;
};

const slashRootFace = (item: SlashRootItem): SlashRootFace => {
  if (item.kind === "create-field") {
    return {
      icon: BracesIcon,
      labelKey: "templates.studio.makeField",
      hint: "{{ }}",
    };
  }
  if (item.kind === "create-condition") {
    return {
      icon: SplitIcon,
      labelKey: "templates.studio.showOnlyIf",
      hint: "{{#if}}",
    };
  }
  if (item.kind === "open-fields") {
    return {
      icon: BracesIcon,
      labelKey: "templates.studio.existingField",
      hint: undefined,
    };
  }
  return {
    icon: TextQuoteIcon,
    labelKey: "common.clauses",
    hint: undefined,
  };
};

const slashFieldFace = (
  field: StudioField,
  fields: StudioField[],
): SlashRowFace => {
  const match = fields.find((candidate) => candidate.path === field.path);
  const icon = match
    ? VALUE_TYPE_META[inputTypeValueKind(match.inputType)].icon
    : BracesIcon;
  const label = field.label === "" ? field.path : field.label;
  return {
    icon,
    label,
    hint: label === field.path ? undefined : field.path,
  };
};
