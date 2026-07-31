const GRADIENT_LAYERS = [
  {
    containerId: "gradient-light",
    iosIntensity: 0.38,
    speed: 1,
    svgUrl: "/images/gradients/hero-light.svg",
  },
  {
    containerId: "gradient-dark",
    iosIntensity: 0.3,
    speed: 1,
    svgUrl: "/images/gradients/hero-dark.svg",
  },
  {
    containerId: "footer-gradient-light",
    iosIntensity: 1,
    speed: 1.6,
    svgUrl: "/images/gradients/hero-light.svg",
  },
  {
    containerId: "footer-gradient-dark",
    iosIntensity: 1,
    speed: 1.6,
    svgUrl: "/images/gradients/hero-dark.svg",
  },
] as const;

const IOS_GRADIENT_START_TRANSFORM =
  "translate3d(-2%, -3%, 0) scale3d(1.11, 1.05, 1) rotate(-0.6deg)";
const IOS_GRADIENT_TRANSFORMS = [
  IOS_GRADIENT_START_TRANSFORM,
  "translate3d(2%, 1%, 0) scale3d(1.04, 1.12, 1) rotate(0.4deg)",
  "translate3d(-1%, 3%, 0) scale3d(1.13, 1.06, 1) rotate(-0.2deg)",
  "translate3d(3%, -2%, 0) scale3d(1.06, 1.13, 1) rotate(0.5deg)",
  IOS_GRADIENT_START_TRANSFORM,
];
const IOS_GRADIENT_OPACITIES = [0.96, 1, 0.93, 1, 0.96] as const;
const IOS_GRADIENT_DURATION_MS = 20_000;

const scaledIOSGradientOpacities = (intensity: number) =>
  IOS_GRADIENT_OPACITIES.map((opacity) =>
    String(Number((opacity * intensity).toFixed(3))),
  );

type IOSGradientAnimationState = {
  animation: Animation;
  isIntersecting: boolean;
  syncOnTransitionEnd: () => void;
};

const activeIOSGradientAnimations = new Map<
  Element,
  IOSGradientAnimationState
>();
let iosGradientVisibilityObserver: IntersectionObserver | undefined;
let iosGradientThemeObserver: MutationObserver | undefined;

export const cleanupPageGradients = () => {
  for (const [
    container,
    { animation, syncOnTransitionEnd },
  ] of activeIOSGradientAnimations) {
    animation.cancel();
    container.removeEventListener("transitionend", syncOnTransitionEnd);
  }
  activeIOSGradientAnimations.clear();
  iosGradientVisibilityObserver?.disconnect();
  iosGradientVisibilityObserver = undefined;
  iosGradientThemeObserver?.disconnect();
  iosGradientThemeObserver = undefined;
};

export const initializePageGradients = () => {
  for (const { containerId, iosIntensity, speed, svgUrl } of GRADIENT_LAYERS) {
    const container = document.querySelector<HTMLElement>(`#${containerId}`);
    if (!container || container.dataset.animatedGradient === "initialized") {
      continue;
    }

    container.dataset.animatedGradient = "initialized";
    void initializeGradient(container, svgUrl, speed, iosIntensity);
  }
};

const initializeGradient = async (
  container: HTMLElement,
  svgUrl: string,
  speed: number,
  iosIntensity: number,
) => {
  if (isIOSWebKit()) {
    initializeIOSGradient(container, svgUrl, speed, iosIntensity);
    return;
  }

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

const isIOSWebKit = () => {
  const isIOSDevice = /iP(?:ad|hone|od)/u.test(navigator.userAgent);
  const isIPadDesktopMode =
    navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;

  return isIOSDevice || isIPadDesktopMode;
};

const initializeIOSGradient = (
  container: HTMLElement,
  svgUrl: string,
  speed: number,
  intensity: number,
) => {
  const image = document.createElement("img");
  image.src = svgUrl;
  image.alt = "";
  image.setAttribute("aria-hidden", "true");
  image.style.display = "block";
  image.style.width = "100%";
  image.style.height = "100%";
  image.style.objectFit = "fill";
  image.style.opacity = String(intensity);
  image.style.transform = IOS_GRADIENT_START_TRANSFORM;
  image.style.transformOrigin = "center";
  image.style.willChange = "transform";

  container.replaceChildren(image);

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return;
  }

  const animation = image.animate(
    {
      opacity: scaledIOSGradientOpacities(intensity),
      transform: IOS_GRADIENT_TRANSFORMS,
    },
    {
      duration: IOS_GRADIENT_DURATION_MS / speed,
      easing: "ease-in-out",
      iterations: Number.POSITIVE_INFINITY,
    },
  );
  const syncOnTransitionEnd = () => {
    const currentState = activeIOSGradientAnimations.get(container);
    if (currentState !== undefined) {
      syncIOSGradientAnimation(container, currentState);
    }
  };
  const state = { animation, isIntersecting: false, syncOnTransitionEnd };
  activeIOSGradientAnimations.set(container, state);
  container.addEventListener("transitionend", syncOnTransitionEnd);
  ensureIOSGradientObservers();
  syncIOSGradientAnimation(container, state);
  iosGradientVisibilityObserver?.observe(container);
};

const ensureIOSGradientObservers = () => {
  iosGradientVisibilityObserver ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const state = activeIOSGradientAnimations.get(entry.target);
      if (state === undefined) {
        continue;
      }

      state.isIntersecting = entry.isIntersecting;
      syncIOSGradientAnimation(entry.target, state);
    }
  });

  iosGradientThemeObserver ??= new MutationObserver(() => {
    for (const [container, state] of activeIOSGradientAnimations) {
      syncIOSGradientAnimation(container, state);
    }
  });
  iosGradientThemeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
};

const syncIOSGradientAnimation = (
  container: Element,
  state: IOSGradientAnimationState,
) => {
  const shouldPlay =
    container.isConnected &&
    state.isIntersecting &&
    getComputedStyle(container).opacity !== "0";

  if (shouldPlay) {
    state.animation.play();
    return;
  }

  state.animation.pause();
};
