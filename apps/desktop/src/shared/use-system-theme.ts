import { useEffect } from "react";

const suppressTransitions = () => {
  const style = document.createElement("style");
  style.textContent = "*, *::before, *::after { transition: none !important; }";
  document.head.append(style);
  void getComputedStyle(document.documentElement).opacity;
  return () => requestAnimationFrame(() => style.remove());
};

export const useSystemTheme = () => {
  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const root = document.documentElement;

    const updateTheme = () => {
      const restore = suppressTransitions();
      const isDark = mediaQuery.matches;
      root.classList.toggle("dark", isDark);
      root.style.colorScheme = isDark ? "dark" : "light";
      restore();
    };

    updateTheme();
    mediaQuery.addEventListener("change", updateTheme);

    return () => {
      mediaQuery.removeEventListener("change", updateTheme);
    };
  }, []);
};
