import { renderToStaticMarkup } from "react-dom/server";

import { expect, test } from "bun:test";

import { AvailableCoverageSection } from "./available-coverage-section";

test("an unavailable coverage section renders nothing and never renders its content", () => {
  const markup = renderToStaticMarkup(
    <AvailableCoverageSection data={null}>
      {() => {
        throw new Error("Unavailable content must not render");
      }}
    </AvailableCoverageSection>,
  );

  expect(markup).toBe("");
});

test("an available coverage section renders its data, including an empty result", () => {
  for (const data of [[], ["Supreme Court"]]) {
    const markup = renderToStaticMarkup(
      <AvailableCoverageSection data={data}>
        {(courts) => <section>{courts.join(", ")}</section>}
      </AvailableCoverageSection>,
    );

    expect(markup).toBe(`<section>${data.join(", ")}</section>`);
  }
});

test("mixed coverage sections render only the available data", () => {
  const markup = renderToStaticMarkup(
    <>
      {[
        { id: "unavailable-first", data: null },
        { id: "supreme", data: ["Supreme Court"] },
        { id: "unavailable-second", data: null },
        { id: "appeal", data: ["Court of Appeal"] },
      ].map(({ id, data }) => (
        <AvailableCoverageSection key={id} data={data}>
          {(courts) => <section>{courts.join(", ")}</section>}
        </AvailableCoverageSection>
      ))}
    </>,
  );

  expect(markup).toBe(
    "<section>Supreme Court</section><section>Court of Appeal</section>",
  );
});
