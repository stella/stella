import { createPublicSanctionsReader } from "@/api/db/root";
import { screenPublicSanctionsSubject } from "@/api/lib/lists/sanctions/public-screening";
import { createSanctionsStartupWarmup } from "@/api/lib/lists/sanctions/startup-warmup";

/** Anonymous screening receives only the column-restricted, read-only handle. */
export const sanctionsPublicReadDb = createPublicSanctionsReader();

export const sanctionsStartupWarmup = createSanctionsStartupWarmup({
  screen: async () => {
    const result = await screenPublicSanctionsSubject({
      db: sanctionsPublicReadDb,
      subject: {
        type: "organization",
        name: "Startup matcher warmup",
        identifiers: [],
      },
      practiceJurisdictions: [],
    });
    // Only the loader's own outcomes can still change by waiting; a list
    // that is not loaded, stale or refused is terminal for startup.
    return result.map(({ lists }) =>
      lists.map((list) => ({
        ...list,
        loaderState:
          list.reason === "warming" || list.reason === "load-failed"
            ? screenPublicSanctionsSubject.warmupStartupState(list.source)
            : null,
      })),
    );
  },
  terminalize: screenPublicSanctionsSubject.warmupTerminalize,
  editionDurations: screenPublicSanctionsSubject.warmupDurations,
});
