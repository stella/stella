const GRADIENT_LAYERS = [
  ["gradient-light", "/images/gradients/hero-light.svg", 1],
  ["gradient-dark", "/images/gradients/hero-dark.svg", 1],
  ["footer-gradient-light", "/images/gradients/hero-light.svg", 1.6],
  ["footer-gradient-dark", "/images/gradients/hero-dark.svg", 1.6],
] as const;

export const initializePageGradients = () => {
  for (const [containerId, svgUrl, speed] of GRADIENT_LAYERS) {
    const container = document.querySelector<HTMLElement>(`#${containerId}`);
    if (!container || container.dataset.animatedGradient === "initialized") {
      continue;
    }

    container.dataset.animatedGradient = "initialized";
    void initializeGradient(container, svgUrl, speed);
  }
};

const initializeGradient = async (
  container: HTMLElement,
  svgUrl: string,
  speed: number,
) => {
  const response = await fetch(svgUrl, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok || !container.isConnected) {
    return;
  }

  // safe-html: same-origin static SVG asset controlled by this repository.
  container.innerHTML = await response.text();

  const svg = container.querySelector("svg");
  if (svg !== null) {
    svg.style.width = "100%";
    svg.style.height = "100%";
  }

  const groups = container.querySelectorAll<SVGGElement>("svg g");
  const group = [...groups].at(-1);
  if (group === undefined) {
    return;
  }

  const rects = [...group.querySelectorAll<SVGRectElement>("rect")];
  if (rects.length === 0) {
    return;
  }

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return;
  }

  const filterId = group
    .getAttribute("filter")
    ?.match(/url\(#(?<filterId>[^)]+)\)/u)?.groups?.filterId;
  const bases = rects.map((rect) => {
    const gradientId = rect.getAttribute("fill")?.match(/#(?<gradientId>\w+)/u)
      ?.groups?.gradientId;
    if (gradientId === undefined) {
      return 0.5;
    }

    const gradient = container.querySelector(`#${gradientId}`);
    if (gradient === null) {
      return 0.5;
    }

    let maximumOpacity = 0;
    for (const stop of gradient.querySelectorAll("stop")) {
      maximumOpacity = Math.max(
        maximumOpacity,
        Number.parseFloat(stop.getAttribute("stop-opacity") ?? "0"),
      );
    }
    return maximumOpacity;
  });
  const startTime = performance.now();
  let isVisible = true;
  const visibilityObserver = new IntersectionObserver(([entry]) => {
    isVisible = entry.isIntersecting;
  });
  visibilityObserver.observe(container);

  const animate = () => {
    if (!container.isConnected) {
      visibilityObserver.disconnect();
      return;
    }
    if (!isVisible || getComputedStyle(container).opacity === "0") {
      requestAnimationFrame(animate);
      return;
    }

    const time = ((performance.now() - startTime) / 1000) * speed;
    const peak1 =
      0.3 + Math.sin(time * 0.04) * 0.25 + Math.sin(time * 0.067) * 0.1;
    const peak2 =
      0.7 + Math.sin(time * 0.053 + 2) * 0.2 + Math.cos(time * 0.037) * 0.15;
    const width1 = 0.18 + Math.sin(time * 0.03) * 0.06;
    const width2 = 0.15 + Math.cos(time * 0.045) * 0.05;
    const hueShift = Math.sin(time * 0.06) * 6.5 - 1.5;

    if (filterId !== undefined) {
      group.style.filter = `url(#${filterId}) hue-rotate(${hueShift.toFixed(1)}deg)`;
    }

    for (const [index, rect] of rects.entries()) {
      const baseOpacity = bases.at(index);
      if (baseOpacity === undefined) {
        continue;
      }

      const normalizedIndex = index / rects.length;
      const direction = index % 2 === 1 ? 1 : -1;
      const distance1 = Math.abs(normalizedIndex - peak1);
      const distance2 = Math.abs(normalizedIndex - peak2);
      const envelope = Math.max(
        Math.exp(-(distance1 * distance1) / (2 * width1 * width1)),
        Math.exp(-(distance2 * distance2) / (2 * width2 * width2)),
      );
      const breathe = Math.sin(time * 0.35 + index * 0.2) * 0.08;
      const opacity = baseOpacity + envelope * 0.45 + breathe;
      const horizontalSway =
        Math.sin(time * 0.22 + index * 0.25) * direction * 6;
      const verticalSway = Math.cos(time * 0.15 + index * 0.18) * direction * 3;
      const horizontalScale = 1 + Math.sin(time * 0.2 + index * 0.3) * 0.06;

      rect.setAttribute(
        "transform",
        `translate(${horizontalSway.toFixed(1)}, ${verticalSway.toFixed(1)}) scale(${horizontalScale.toFixed(3)}, 1)`,
      );
      rect.style.opacity = Math.min(1.2, Math.max(0.08, opacity)).toFixed(3);
    }

    requestAnimationFrame(animate);
  };

  requestAnimationFrame(animate);
};
