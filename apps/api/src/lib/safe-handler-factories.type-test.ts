import type * as publicSubject from "@/api/handlers/case-law/decisions/public-subject";
import type * as apiHandlers from "@/api/lib/api-handlers";
import type { SafeHandlerFactory } from "@/api/lib/safe-handler-factories";

type FactoriesExportedBy<TModule> = Extract<
  keyof TModule,
  `createSafe${string}Handler`
>;

type ExportedFactory =
  | FactoriesExportedBy<typeof apiHandlers>
  | FactoriesExportedBy<typeof publicSubject>;

/** `true` only when the map's keys are exactly `TExported`. */
type MapMatchesExports<TExported extends string> = [
  Exclude<TExported, SafeHandlerFactory>,
] extends [never]
  ? [Exclude<SafeHandlerFactory, TExported>] extends [never]
    ? true
    : { mappedButNotExported: Exclude<SafeHandlerFactory, TExported> }
  : { exportedButNotMapped: Exclude<TExported, SafeHandlerFactory> };

export const mapMatchesExportedFactories: MapMatchesExports<ExportedFactory> = true;

// @ts-expect-error A newly exported factory must get a scope in the map.
export const unmappedFactoryFails: MapMatchesExports<
  ExportedFactory | "createSafeUnmappedHandler"
> = true;

// @ts-expect-error A map key must name an exported factory.
export const staleMapKeyFails: MapMatchesExports<
  Exclude<ExportedFactory, "createSafeTokenHandler">
> = true;
