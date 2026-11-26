import {
  DESKTOP_ACTIVITY_REVIEW_LIMIT,
  type DesktopMatterResolution,
  isDesktopMatterId,
} from "@stll/api-contract/desktop-time-entries";

/** Resolves matter ids under the member's own access, in requests the
 * contract bounds, through the calling window's own command. An id that is
 * not a matter id names no matter and is never asked for. */
export const resolveMatters = async (
  ids: readonly string[],
  resolve: (chunk: string[]) => Promise<DesktopMatterResolution[]>,
) => {
  const asked = ids.filter(isDesktopMatterId);
  const requests: Promise<DesktopMatterResolution[]>[] = [];
  for (
    let start = 0;
    start < asked.length;
    start += DESKTOP_ACTIVITY_REVIEW_LIMIT
  ) {
    requests.push(
      resolve(asked.slice(start, start + DESKTOP_ACTIVITY_REVIEW_LIMIT)),
    );
  }
  return (await Promise.all(requests)).flat();
};
