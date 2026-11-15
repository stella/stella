import { expect, test } from "bun:test";

import { load } from "./load";

test("HTML uses document repair and parse5 serialization", () => {
  const $ = load("<table><tr><td>&eacute;&nbsp;</table>");
  expect($.html()).toBe(
    "<html><head></head><body><table><tbody><tr><td>é&nbsp;</td></tr></tbody></table></body></html>",
  );
  expect($.text()).toBe("é\u00a0");
});

test("fragments omit document wrappers", () => {
  expect(load("<p>A &amp; B</p>", undefined, false).html()).toBe(
    "<p>A &amp; B</p>",
  );
});

test("XML preserves case and self-closing elements", () => {
  for (const options of [
    { xml: true },
    { xmlMode: true },
    { xml: { xmlMode: true, withStartIndices: true, withEndIndices: true } },
  ]) {
    const $ = load('<Root><Item Key="x"/></Root>', options);
    expect($.xml()).toBe('<Root><Item Key="x"/></Root>');
    expect($("Item").attr("Key")).toBe("x");
  }
});

test("inserted markup is parsed in the destination's context", () => {
  const $ = load("<table></table>");
  $("table").append("<tr><td>A &amp; B</td></tr>");
  expect($("table").html()).toBe("<tr><td>A &amp; B</td></tr>");
});

test("email mode parses noscript content as markup", () => {
  const $ = load("<body><noscript><p>A &amp; B</p></noscript></body>", {
    scriptingEnabled: false,
  });
  expect($("noscript p").text()).toBe("A & B");
});

test("markup selectors, contexts, and roots retain HTML table repair", () => {
  const $ = load("");
  const markup = "<table><tr><td>A</td></tr></table>";
  expect($(markup).html()).toBe("<tbody><tr><td>A</td></tr></tbody>");
  expect($("tbody td", markup).text()).toBe("A");
  expect($("tbody td", null, markup).text()).toBe("A");
});

test("markup created by selection methods retains HTML table repair", () => {
  const $ = load("<p>A</p>");
  $("p").wrap("<table><tr><td></td></tr></table>");
  expect($("tbody td p").text()).toBe("A");
});
