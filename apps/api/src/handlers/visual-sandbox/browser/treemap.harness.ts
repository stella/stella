import { createVisualCharts } from "./charts";
import { treemapFixture } from "./treemap-fixture";

const el = document.querySelector<HTMLElement>("#chart");
if (el) {
  const chart = createVisualCharts(window).treemap(el, {
    data: treemapFixture,
    value: "count",
    color: { mode: "category", field: "tier", legend: true },
    onSelect: (node) => {
      el.dataset.selected = node.id;
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
  document.querySelector("#destroy")?.addEventListener("click", () => {
    chart.destroy();
    chart.destroy();
    chart.setColorMode("citations");
  });
}
