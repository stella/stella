import { Profiler, useRef } from "react";
import type { PropsWithChildren } from "react";

import { panic } from "better-result";

/** Far above what one DOM test commits; far below a runaway loop. */
const DEFAULT_MAX_COMMITS = 400;

/**
 * Fails a DOM test fast when the tree under it never settles. A component
 * that hands a fresh object to something that stores it in state (a Base UI
 * `items` prop, a query key) re-renders forever; inside `act` that loop never
 * returns, and the test grows until the machine runs out of memory instead of
 * failing. Past `maxCommits` commits the guard throws from the commit phase,
 * which React reports as an error and which unmounts the root, ending the
 * loop with a message that names it.
 */
export const RenderLoopGuard = ({
  children,
  maxCommits = DEFAULT_MAX_COMMITS,
}: PropsWithChildren<{ maxCommits?: number }>) => {
  const commits = useRef(0);
  return (
    <Profiler
      id="render-loop-guard"
      onRender={() => {
        commits.current += 1;
        if (commits.current > maxCommits) {
          panic(
            `Render loop: more than ${maxCommits} commits in one test. ` +
              "Something re-renders without settling.",
          );
        }
      }}
    >
      {children}
    </Profiler>
  );
};
