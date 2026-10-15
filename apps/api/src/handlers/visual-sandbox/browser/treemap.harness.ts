import { createVisualCharts } from "./charts";
import { treemapFixture } from "./treemap-fixture";

const el = document.querySelector<HTMLElement>("#chart");
if (el) {
  let chart = createVisualCharts(window).treemap(el, {
    data: treemapFixture,
    value: "count",
    color: { mode: "category", field: "tier", legend: true },
    onSelect: (node) => {
      Object.assign(el.dataset, { selected: node.id });
    },
  });
  document
    .querySelector("#color")
    ?.addEventListener("click", () => chart.setColorMode("treatment"));
  document
    .querySelector("#citations")
    ?.addEventListener("click", () => chart.setColorMode("citations"));
  document
    .querySelector("#category")
    ?.addEventListener("click", () => chart.setColorMode("category"));
  document.querySelector("#empty")?.addEventListener("click", () => {
    chart.destroy();
    Reflect.deleteProperty(el.dataset, "selected");
    chart = createVisualCharts(window).treemap(el, {
      data: {
        type: "group",
        id: "empty-root",
        label: "empty-root",
        children: [],
      },
      value: "count",
      color: { mode: "category", field: "tier", legend: true },
      onSelect: (node) => {
        Object.assign(el.dataset, { selected: node.id });
      },
    });
  });
  document.querySelector("#destroy")?.addEventListener("click", () => {
    chart.destroy();
    chart.destroy();
    chart.setColorMode("citations");
  });
}
