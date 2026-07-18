const THEME_IMAGE_SELECTOR = "img[data-theme-image]";
const LOAD_THEME_IMAGES_EVENT = "stella:load-theme-images";

let themeObserver: MutationObserver | undefined;
let visibilityObserver: IntersectionObserver | undefined;
let loadEventBound = false;

export const initializeThemeImages = () => {
  syncThemeImages(document, false);

  visibilityObserver?.disconnect();
  visibilityObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (
          !entry.isIntersecting ||
          !(entry.target instanceof HTMLImageElement)
        ) {
          continue;
        }

        loadThemeImage(entry.target);
        visibilityObserver?.unobserve(entry.target);
      }
    },
    { rootMargin: "800px 0px" },
  );
  for (const image of document.querySelectorAll<HTMLImageElement>(
    `${THEME_IMAGE_SELECTOR}[data-theme-image-deferred="visible"]`,
  )) {
    if (!Object.hasOwn(image.dataset, "themeImageLoaded")) {
      visibilityObserver.observe(image);
    }
  }

  themeObserver?.disconnect();
  themeObserver = new MutationObserver(() => {
    syncThemeImages(document, false);
  });
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });

  if (loadEventBound) {
    return;
  }

  loadEventBound = true;
  document.addEventListener(LOAD_THEME_IMAGES_EVENT, (event) => {
    if (!(event.target instanceof Element)) {
      return;
    }

    syncThemeImages(event.target, true);
  });
};

const syncThemeImages = (root: ParentNode, includeDeferred: boolean) => {
  const images = root.querySelectorAll<HTMLImageElement>(THEME_IMAGE_SELECTOR);
  for (const image of images) {
    const isDeferred = Object.hasOwn(image.dataset, "themeImageDeferred");
    const wasLoaded = Object.hasOwn(image.dataset, "themeImageLoaded");
    if (isDeferred && !includeDeferred && !wasLoaded) {
      continue;
    }

    loadThemeImage(image);
  }
};

const loadThemeImage = (image: HTMLImageElement) => {
  const source = document.documentElement.classList.contains("dark")
    ? image.dataset.themeDarkSrc
    : image.dataset.themeLightSrc;
  if (source === undefined) {
    return;
  }

  if (image.getAttribute("src") !== source) {
    image.src = source;
  }
  image.dataset.themeImageLoaded = "";
};
