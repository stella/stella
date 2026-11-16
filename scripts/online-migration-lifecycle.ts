/**
 * The rule `check-online-migration-lifecycle.ts` applies: an online migration
 * entry may be `finalized` only when the promoted release carries the same
 * entry (its lifecycle line aside), so every database a supported release
 * runs against already holds that work. Newer entries stay `pending`. An entry
 * whose work code depends on at once may be finalized earlier only through a
 * reasoned exemption, and an exemption lapses once the release carries it.
 *
 * The comparison reads the entry module, not the definitions it imports (a
 * repair or index defined in a shared module). That bound is deliberate:
 * `finalized` work is what `migrate` builds inside the deploy, the path every
 * entry took before lifecycles existed, so a definition changed behind an
 * unchanged entry still runs before the new release serves; at worst the
 * deploy waits for it. Only `pending` work moves after the rollout, and an
 * entry is pending until a promoted release carries it.
 */

export const LIFECYCLE_LINE = /^[ \t]*lifecycle: "(pending|finalized)",\r?\n/mu;

export type LifecycleEntry = { path: string; text: string };

type LifecycleFindingsOptions = {
  entries: readonly LifecycleEntry[];
  /** The entry file at the promoted release, or `undefined` when absent. */
  readAtRelease: (path: string) => string | undefined;
  release: string;
  /** Entry paths finalized before release, with the reason. */
  exemptions: Readonly<Record<string, string>>;
};

const withoutLifecycle = (text: string) => text.replace(LIFECYCLE_LINE, "");

export const lifecycleFindings = ({
  entries,
  readAtRelease,
  release,
  exemptions,
}: LifecycleFindingsOptions): string[] => {
  const findings: string[] = [];
  const seen = new Set<string>();
  for (const { path, text } of entries) {
    seen.add(path);
    const lifecycle = LIFECYCLE_LINE.exec(text)?.[1];
    if (lifecycle === undefined) {
      findings.push(`${path}: declares no lifecycle`);
      continue;
    }
    const released = readAtRelease(path);
    const carried =
      released !== undefined &&
      withoutLifecycle(released) === withoutLifecycle(text);
    const exemption = exemptions[path];
    if (exemption !== undefined) {
      if (lifecycle !== "finalized") {
        findings.push(
          `${path}: exempted but not finalized; remove the exemption`,
        );
      } else if (carried) {
        findings.push(
          `${path}: ${release} carries this entry; remove its exemption`,
        );
      } else if (exemption.trim().length < 20) {
        findings.push(`${path}: the exemption must state why`);
      }
      continue;
    }
    if (lifecycle === "finalized" && !carried) {
      findings.push(
        `${path}: finalized, but ${release} does not carry this entry unchanged; keep it pending until a promoted release ships it`,
      );
    }
  }
  for (const path of Object.keys(exemptions)) {
    if (!seen.has(path)) {
      findings.push(`${path}: exempted, but no such entry exists`);
    }
  }
  return findings;
};
