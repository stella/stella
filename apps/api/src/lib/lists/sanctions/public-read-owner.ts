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
    return result
      .unwrap("Startup screening failure must be retried by the warmup owner")
      .lists.map((list) => ({
        ...list,
        loaderState:
          list.reason === null
            ? null
            : screenPublicSanctionsSubject.warmupStartupState(list.source),
      }));
  },
  terminalize: screenPublicSanctionsSubject.warmupTerminalize,
});
