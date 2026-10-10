import { panic } from "better-result";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const FIXTURES_DIR = path.join(import.meta.dir, "..", "fixtures");
const ROTATION_DEGREES = 3;

const pgm = (width: number, height: number, pixels: Uint8Array) => {
  const header = new TextEncoder().encode(`P5\n${width} ${height}\n255\n`);
  const output = new Uint8Array(header.length + pixels.length);
  output.set(header);
  output.set(pixels, header.length);
  return output;
};

const blank = () => {
  const width = 64;
  const height = 64;
  return pgm(width, height, new Uint8Array(width * height).fill(255));
};

const rotatedPage = () => {
  const width = 192;
  const height = 256;
  const radians = (ROTATION_DEGREES * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const centerX = width / 2;
  const centerY = height / 2;
  const pixels = new Uint8Array(width * height).fill(245);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sourceY = -(x - centerX) * sine + (y - centerY) * cosine + centerY;
      const sourceX = (x - centerX) * cosine + (y - centerY) * sine + centerX;
      const line = Math.round((sourceY - 55) / 24);
      const lineY = 55 + line * 24;
      if (
        line >= 0 &&
        line <= 6 &&
        Math.abs(sourceY - lineY) <= 2 &&
        sourceX >= 35 &&
        sourceX < 157
      ) {
        pixels[y * width + x] = 20;
      }
    }
  }
  return pgm(width, height, pixels);
};

mkdirSync(FIXTURES_DIR, { recursive: true });
const fixtures = [
  ["blank.pgm", blank()],
  ["rotated-3-degrees.pgm", rotatedPage()],
] satisfies readonly (readonly [string, Uint8Array])[];

for (const [name, contents] of fixtures) {
  const fixturePath = path.join(FIXTURES_DIR, name);
  if (process.argv.includes("--check")) {
    if (!readFileSync(fixturePath).equals(contents)) {
      panic(`Generated fixture differs: ${name}`);
    }
    continue;
  }
  writeFileSync(fixturePath, contents);
}
