import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// Fixture pages under `src/components/fixtures` opt into Tailwind by importing
// a stylesheet that declares `@import "tailwindcss"`; pages without one keep
// their hand-written styles.
export default defineConfig({ plugins: [tailwindcss()] });
