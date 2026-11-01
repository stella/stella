import { BROWSER_STELLA_TABS_STORAGE_KEY } from "./storage-keys";

/**
 * A stella tab the extension has heard from: the trusted origin it was on
 * and the document that sent the message. Messages to it are addressed to
 * that document, so a tab that navigated since never receives them.
 */
export type StellaTab = {
  /** Null only for a tab registered from the popup before it messaged. */
  documentId: string | null;
  origin: string;
};

type StellaTabRecord = Record<string, StellaTab>;

const parseStellaTab = (input: unknown): StellaTab | null => {
  if (
    typeof input !== "object" ||
    input === null ||
    !("origin" in input) ||
    typeof input.origin !== "string" ||
    !("documentId" in input) ||
    (input.documentId !== null && typeof input.documentId !== "string")
  ) {
    return null;
  }
  return { documentId: input.documentId, origin: input.origin };
};

export const readStellaTabs = async (): Promise<Map<number, StellaTab>> => {
  const stored = await chrome.storage.session.get(
    BROWSER_STELLA_TABS_STORAGE_KEY,
  );
  const raw: unknown = stored[BROWSER_STELLA_TABS_STORAGE_KEY];
  const tabs = new Map<number, StellaTab>();
  if (typeof raw !== "object" || raw === null) {
    return tabs;
  }
  for (const [key, value] of Object.entries(raw)) {
    const tabId = Number(key);
    const tab = parseStellaTab(value);
    if (Number.isSafeInteger(tabId) && tab !== null) {
      tabs.set(tabId, tab);
    }
  }
  return tabs;
};

let pendingWrite: Promise<unknown> = Promise.resolve();

/** Read-modify-write in order: messages from several tabs arrive at once. */
const updateStellaTabs = async <T>(
  change: (tabs: Map<number, StellaTab>) => T,
): Promise<T> => {
  const run = pendingWrite.then(async () => {
    const tabs = await readStellaTabs();
    const result = change(tabs);
    await chrome.storage.session.set({
      [BROWSER_STELLA_TABS_STORAGE_KEY]: Object.fromEntries(
        tabs,
      ) satisfies StellaTabRecord,
    });
    return result;
  });
  pendingWrite = run.catch(() => undefined);
  return await run;
};

/** Records the document a trusted stella page just messaged from. */
export const rememberStellaTab = async (
  tabId: number,
  tab: StellaTab,
): Promise<void> => {
  await updateStellaTabs((tabs) => {
    const known = tabs.get(tabId);
    if (
      tab.documentId === null &&
      known !== undefined &&
      known.origin === tab.origin
    ) {
      return;
    }
    tabs.set(tabId, tab);
  });
};

/** Returns the stella tab that closed, if it was one. */
export const forgetStellaTab = async (
  tabId: number,
): Promise<StellaTab | null> =>
  await updateStellaTabs((tabs) => {
    const known = tabs.get(tabId) ?? null;
    tabs.delete(tabId);
    return known;
  });

/** Chrome swapped one tab for another; the record moves with it. */
export const replaceStellaTab = async (
  addedTabId: number,
  removedTabId: number,
): Promise<void> => {
  await updateStellaTabs((tabs) => {
    const known = tabs.get(removedTabId);
    if (known !== undefined) {
      tabs.delete(removedTabId);
      tabs.set(addedTabId, known);
    }
  });
};

export const stellaTabsOnOrigin = (
  tabs: ReadonlyMap<number, StellaTab>,
  origin: string,
): [number, StellaTab][] =>
  [...tabs].filter(([, tab]) => tab.origin === origin);
