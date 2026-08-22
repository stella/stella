import { panic } from "better-result";

type RgbImage = {
  data: Uint8Array;
  width: number;
  height: number;
};

const assertImageShape = ({ data, height, width }: RgbImage): void => {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    data.length !== width * height * 3
  ) {
    panic(`invalid RGB image shape: ${width}x${height}, ${data.length} bytes`);
  }
};

export const rgbaToRgb = ({
  data,
  height,
  width,
}: {
  data: Uint8Array;
  width: number;
  height: number;
}): Uint8Array => {
  const pixelCount = width * height;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    data.length !== pixelCount * 4
  ) {
    panic(`invalid RGBA image shape: ${width}x${height}, ${data.length} bytes`);
  }
  const rgb = new Uint8Array(pixelCount * 3);
  for (
    let sourceOffset = 0, targetOffset = 0;
    targetOffset < rgb.length;
    sourceOffset += 4, targetOffset += 3
  ) {
    rgb[targetOffset] = data[sourceOffset] ?? 0;
    rgb[targetOffset + 1] = data[sourceOffset + 1] ?? 0;
    rgb[targetOffset + 2] = data[sourceOffset + 2] ?? 0;
  }
  return rgb;
};

type ResizeRgbRegionOptions = RgbImage & {
  left?: number;
  top?: number;
  regionWidth?: number;
  regionHeight?: number;
  targetWidth: number;
  targetHeight: number;
};

/**
 * Crop and bilinearly resize packed RGB bytes.
 *
 * PP-OCR's reference preprocessing uses linear interpolation. Keeping this
 * primitive in tensor space avoids an image codec and native-addon boundary:
 * PDFium already provides decoded pixels, and the model consumes raw pixels.
 */
export const resizeRgbRegion = ({
  data,
  height,
  left = 0,
  width,
  regionHeight = height,
  regionWidth = width,
  targetHeight,
  targetWidth,
  top = 0,
}: ResizeRgbRegionOptions): Uint8Array => {
  assertImageShape({ data, height, width });
  if (
    ![left, top, regionWidth, regionHeight, targetWidth, targetHeight].every(
      (value) => Number.isSafeInteger(value),
    ) ||
    left < 0 ||
    top < 0 ||
    regionWidth < 1 ||
    regionHeight < 1 ||
    targetWidth < 1 ||
    targetHeight < 1 ||
    left + regionWidth > width ||
    top + regionHeight > height
  ) {
    panic(
      `invalid RGB resize: region ${left},${top} ${regionWidth}x${regionHeight} in ${width}x${height} to ${targetWidth}x${targetHeight}`,
    );
  }

  const output = new Uint8Array(targetWidth * targetHeight * 3);
  const scaleX = regionWidth / targetWidth;
  const scaleY = regionHeight / targetHeight;
  const regionRight = left + regionWidth - 1;
  const regionBottom = top + regionHeight - 1;

  for (let targetY = 0; targetY < targetHeight; targetY += 1) {
    const sourceY = Math.min(
      regionBottom,
      Math.max(top, top + (targetY + 0.5) * scaleY - 0.5),
    );
    const y0 = Math.floor(sourceY);
    const y1 = Math.min(regionBottom, y0 + 1);
    const yWeight = sourceY - y0;

    for (let targetX = 0; targetX < targetWidth; targetX += 1) {
      const sourceX = Math.min(
        regionRight,
        Math.max(left, left + (targetX + 0.5) * scaleX - 0.5),
      );
      const x0 = Math.floor(sourceX);
      const x1 = Math.min(regionRight, x0 + 1);
      const xWeight = sourceX - x0;
      const outputOffset = (targetY * targetWidth + targetX) * 3;

      for (let channel = 0; channel < 3; channel += 1) {
        const topLeft = data[(y0 * width + x0) * 3 + channel] ?? 0;
        const topRight = data[(y0 * width + x1) * 3 + channel] ?? 0;
        const bottomLeft = data[(y1 * width + x0) * 3 + channel] ?? 0;
        const bottomRight = data[(y1 * width + x1) * 3 + channel] ?? 0;
        const upper = topLeft + (topRight - topLeft) * xWeight;
        const lower = bottomLeft + (bottomRight - bottomLeft) * xWeight;
        output[outputOffset + channel] = Math.round(
          upper + (lower - upper) * yWeight,
        );
      }
    }
  }

  return output;
};
