const BODY_SCOPE = ".layout-page-content";

export function findBodyPmSpans(container: ParentNode): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      `${BODY_SCOPE} span[data-pm-start][data-pm-end]`,
    ),
  );
}

export function findBodyEmptyRuns(container: ParentNode): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(`${BODY_SCOPE} .layout-empty-run`),
  );
}

export function findBodyPmAnchors(container: ParentNode): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(`${BODY_SCOPE} [data-pm-start]`),
  );
}

export function findBodyPmAnchor(
  container: ParentNode,
  pmStart: number,
): HTMLElement | null {
  if (!Number.isFinite(pmStart)) {
    return null;
  }
  return container.querySelector<HTMLElement>(
    `${BODY_SCOPE} [data-pm-start="${String(pmStart)}"]`,
  );
}
