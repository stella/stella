import type { Page } from "@playwright/test";

const TEMPORAL_CLOCK_INIT = `
{
  const temporal = globalThis.Temporal;
  if (temporal !== undefined) {
    const timeZoneId = temporal.Now.timeZoneId.bind(temporal.Now);
    const instant = () => temporal.Instant.fromEpochMilliseconds(Date.now());
    const zonedDateTimeISO = (timeZone) =>
      instant().toZonedDateTimeISO(timeZone ?? timeZoneId());

    Object.defineProperties(temporal.Now, {
      instant: { configurable: true, value: instant },
      plainDateISO: {
        configurable: true,
        value: (timeZone) => zonedDateTimeISO(timeZone).toPlainDate(),
      },
      plainDateTimeISO: {
        configurable: true,
        value: (timeZone) => zonedDateTimeISO(timeZone).toPlainDateTime(),
      },
      plainTimeISO: {
        configurable: true,
        value: (timeZone) => zonedDateTimeISO(timeZone).toPlainTime(),
      },
      zonedDateTimeISO: { configurable: true, value: zonedDateTimeISO },
    });
  }
}
`;

/** Keep native and polyfilled Temporal on Playwright's controlled page clock. */
export const setFixedBrowserTime = async (
  page: Page,
  time: Date | number | string,
): Promise<void> => {
  await page.clock.setFixedTime(time);
  await page.addInitScript({ content: TEMPORAL_CLOCK_INIT });
};
