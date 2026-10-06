import { useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";

import { panic } from "better-result";
import { IntlProvider, useFormatter, useTranslations } from "use-intl";

import { PUBLIC_CASE_LAW_COUNTRIES } from "@stll/api-contract/case-law-launch-readiness";

import { CASE_LAW_RESULTS_APP } from "../manifest";
import { createPresentationBridge } from "../shared/bridge";
import { appLocale } from "../shared/locale";
import { filterDefaults, searchFilterInput } from "./model";
import type { CaseLawView, CourtSelection, ResultRow } from "./model";
import { createCaseLawParser } from "./parse";
import "../shared/style.css";

const caseLawBridge = createPresentationBridge({
  manifest: CASE_LAW_RESULTS_APP,
  parse: createCaseLawParser(),
});
type CaseLawBridge = typeof caseLawBridge;

type SearchPage = Extract<CaseLawView, { type: "search" }>;

const ResultsTable = ({
  rows,
  bridge,
}: {
  rows: readonly ResultRow[];
  bridge: CaseLawBridge;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  if (rows.length === 0) {
    return <p role="status">{t("noResults")}</p>;
  }
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>{t("court")}</th>
            <th>{t("date")}</th>
            <th>{t("reference")}</th>
            <th>{t("open")}</th>
          </tr>
        </thead>
        <tbody>
          {[...new Map(rows.map((row) => [row.decisionId, row])).values()].map(
            (row) => (
              <tr key={row.decisionId}>
                <td>{row.court}</td>
                <td>
                  {row.decisionDate === null ? null : (
                    <bdi>
                      {format.dateTime(new Date(row.decisionDate), {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                        timeZone: "UTC",
                      })}
                    </bdi>
                  )}
                </td>
                <td>
                  <bdi>{row.caseNumber}</bdi>
                  {row.ecli !== null && (
                    <div>
                      <bdi>{row.ecli}</bdi>
                    </div>
                  )}
                  {row.snippet !== null && (
                    <p className="snippet">{row.snippet}</p>
                  )}
                </td>
                <td>
                  {(row.appUrl ?? row.url) !== null && (
                    <button
                      type="button"
                      onClick={() => {
                        const url = row.appUrl ?? row.url;
                        if (url !== null) {
                          bridge.detached(
                            bridge.openLink(url),
                            "open case-law link",
                          );
                        }
                      }}
                    >
                      {t("open")}
                    </button>
                  )}
                </td>
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  );
};

const SearchFilters = ({
  bridge,
  page,
  input,
}: {
  bridge: CaseLawBridge;
  page: SearchPage;
  input: Record<string, unknown>;
}) => {
  const t = useTranslations();
  const defaults = filterDefaults(input);
  const [filter, setFilter] = useState(() => {
    if (defaults.status === "invalid") {
      return "";
    }
    if (defaults.courts.length > 0) {
      return "current";
    }
    return defaults.court === "" ? "" : `court:${defaults.court}`;
  });
  if (defaults.status === "invalid") {
    return <p role="alert">{defaults.message}</p>;
  }
  const facets = page.facets?.court ?? [];
  return (
    <form
      className="filters"
      onSubmit={(event) => {
        event.preventDefault();
        const fields = new FormData(event.currentTarget);
        const country = fields.get("country");
        const from = fields.get("from");
        const to = fields.get("to");
        if (
          typeof country !== "string" ||
          typeof from !== "string" ||
          typeof to !== "string"
        ) {
          return;
        }
        const courtSelection = (): CourtSelection => {
          if (filter === "current") {
            return { type: "courts", names: defaults.courts };
          }
          if (filter.startsWith("court:")) {
            return { type: "court", name: filter.slice("court:".length) };
          }
          if (filter === "") {
            return { type: "all" };
          }
          const tier = facets.find(
            (entry) => filter === `tier:${entry.tierLabel}`,
          );
          if (tier === undefined) {
            return panic("Selected court tier is missing");
          }
          return {
            type: "courts",
            names: tier.courts.map(({ value }) => value),
          };
        };
        bridge.detached(
          bridge.call({
            name: "search_case_law",
            arguments: searchFilterInput({
              input,
              country,
              from,
              to,
              court: courtSelection(),
            }),
          }),
          "filter case-law results",
        );
      }}
    >
      <label>
        {t("country")}
        <select name="country" defaultValue={defaults.country}>
          {PUBLIC_CASE_LAW_COUNTRIES.map((country) => (
            <option key={country} value={country}>
              {country}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t("court")}
        <select
          value={filter}
          onChange={({ target }) => setFilter(target.value)}
        >
          <option value="">{t("all")}</option>
          {defaults.courts.length > 0 && (
            <option value="current">{defaults.courts.join(", ")}</option>
          )}
          {defaults.court !== "" && (
            <option value={`court:${defaults.court}`}>{defaults.court}</option>
          )}
          {facets.map(({ tierLabel, courts }) => (
            <optgroup key={tierLabel} label={t(tierLabel)}>
              <option
                value={`tier:${tierLabel}`}
                disabled={courts.length === 0}
              >
                {t(tierLabel)}
              </option>
              {courts.map(({ value }) => (
                <option key={value} value={`court:${value}`}>
                  {value}
                </option>
              ))}
            </optgroup>
          ))}
          {facets.length === 0 &&
            [...new Set(page.results.map(({ court }) => court))].map(
              (court) => (
                <option key={court} value={`court:${court}`}>
                  {court}
                </option>
              ),
            )}
        </select>
      </label>
      <label>
        {t("from")}
        <input
          type="text"
          inputMode="numeric"
          name="from"
          defaultValue={defaults.from}
        />
      </label>
      <label>
        {t("to")}
        <input
          type="text"
          inputMode="numeric"
          name="to"
          defaultValue={defaults.to}
        />
      </label>
      <button type="submit">{t("filter")}</button>
    </form>
  );
};

const ResultContent = ({ bridge }: { bridge: CaseLawBridge }) => {
  const { result, input } = useSyncExternalStore(
    bridge.subscribe,
    bridge.getSnapshot,
  );
  const t = useTranslations();
  switch (result.status) {
    case "idle":
    case "loading":
      return <p role="status">{t("loading")}</p>;
    case "error":
      return (
        <div role="alert">
          <p>{result.message ?? t("error")}</p>
          <button
            type="button"
            onClick={() => {
              bridge.detached(bridge.retry(), "retry case-law read");
            }}
          >
            {t("retry")}
          </button>
        </div>
      );
    case "success": {
      const { view } = result;
      switch (view.type) {
        case "unavailable":
          return (
            <p role="status">
              {view.message} {view.hint}
            </p>
          );
        case "search": {
          const page = view;
          return (
            <>
              <SearchFilters bridge={bridge} page={page} input={input} />
              {[
                ...new Map(
                  page.searches
                    .flatMap(({ warnings }) => warnings)
                    .map((warning) => [
                      `${warning.message}-${warning.hint}`,
                      warning,
                    ]),
                ).values(),
              ].map((warning) => (
                <p role="status" key={`${warning.message}-${warning.hint}`}>
                  {warning.message} {warning.hint}
                </p>
              ))}
              {page.nextStep !== undefined && (
                <p role="status">{page.nextStep}</p>
              )}
              <ResultsTable rows={page.results} bridge={bridge} />
              {page.nextCursor !== null && (
                <button
                  type="button"
                  onClick={() => {
                    bridge.detached(
                      bridge.call({
                        name: "search_case_law",
                        arguments: { ...input, cursor: page.nextCursor },
                      }),
                      "page case-law results",
                    );
                  }}
                >
                  {t("next")}
                </button>
              )}
            </>
          );
        }
        case "lookup": {
          const { rows, notices } = view;
          return (
            <>
              {[...new Set(notices)].map((message) => (
                <p role="status" key={message}>
                  {message}
                </p>
              ))}
              <ResultsTable rows={rows} bridge={bridge} />
            </>
          );
        }
        default:
          return panic("Unknown case-law result view", view satisfies never);
      }
    }
    default:
      return panic("Unknown app result state", result satisfies never);
  }
};

const App = ({ bridge }: { bridge: CaseLawBridge }) => {
  const { context } = useSyncExternalStore(
    bridge.subscribe,
    bridge.getSnapshot,
  );
  const { formattingLocale, direction, messages } = appLocale(context.locale);
  return (
    <IntlProvider locale={formattingLocale} messages={messages}>
      <main dir={direction}>
        <h1>{messages.title}</h1>
        <ResultContent bridge={bridge} />
      </main>
    </IntlProvider>
  );
};

const root = document.querySelector("#app");
if (root === null) {
  panic("Case-law app mount is missing");
}
createRoot(root).render(<App bridge={caseLawBridge} />);
caseLawBridge.detached(caseLawBridge.connect(), "connect case-law app");
