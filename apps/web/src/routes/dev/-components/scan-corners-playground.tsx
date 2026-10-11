import { useState } from "react";

import { panic } from "better-result";

import { scanEngine } from "@stll/scan-engine";
import type {
  RasterizedScanPage,
  ScanCornerSuggestion,
} from "@stll/scan-engine/types";
import { Button } from "@stll/ui/button";

import { PageOrganizerScanCorners } from "@/components/pdf/page-organizer-scan-corners";
import { detached } from "@/lib/detached";
import { reviewPage } from "@/lib/pdf/page-editor/clean-scan.logic";
import type { CleanScanPageReview } from "@/lib/pdf/page-editor/clean-scan.logic";

const WIDTH = 240;
const HEIGHT = 320;
const fullFrame = {
  type: "full-frame",
  corners: {
    topLeft: { x: 0, y: 0 },
    topRight: { x: WIDTH - 1, y: 0 },
    bottomRight: { x: WIDTH - 1, y: HEIGHT - 1 },
    bottomLeft: { x: 0, y: HEIGHT - 1 },
  },
} as const satisfies ScanCornerSuggestion;

const fixturePage = (): RasterizedScanPage => {
  const pixels = new Uint8ClampedArray(WIDTH * HEIGHT * 4).fill(255);
  for (let y = 50; y < 250; y += 30) {
    for (let row = y; row < y + 5; row++) {
      for (let x = 30; x < 210; x++) {
        const offset = (row * WIDTH + x) * 4;
        pixels[offset] = 30;
        pixels[offset + 1] = 30;
        pixels[offset + 2] = 30;
      }
    }
  }
  return {
    pixels,
    width: WIDTH,
    height: HEIGHT,
    pageSize: { widthPoints: 612, heightPoints: 792 },
    dpi: 144,
    rotation: 0,
  };
};

export const ScanCornersPlayground = () => {
  const [page] = useState(fixturePage);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<ScanCornerSuggestion>(fullFrame);
  const [corners, setCorners] = useState(suggestion.corners);
  const [review, setReview] = useState<CleanScanPageReview | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const detectFixture = async () => {
    const result = await scanEngine.detect(page);
    if (result.isErr()) {
      setFailure(result.error.message);
      return;
    }
    setSuggestion(result.value);
    setCorners(result.value.corners);
  };
  const cleanFixture = async () => {
    const result = await reviewPage({
      engine: scanEngine,
      pageId: "fixture",
      page,
      options: {
        output: "grayscale",
        contentCrop: "off",
        deskew: "off",
        corners,
      },
    });
    if (result.isErr()) {
      setFailure(result.error.message);
      return;
    }
    setReview(result.value);
  };

  return (
    <div className="max-w-lg space-y-4 p-6">
      <canvas
        hidden
        width={WIDTH}
        height={HEIGHT}
        ref={(canvas) => {
          if (!canvas) {
            return;
          }
          const context =
            canvas.getContext("2d") ??
            panic("Canvas rendering requires a 2D context");
          context.putImageData(
            new ImageData(new Uint8ClampedArray(page.pixels), WIDTH, HEIGHT),
            0,
            0,
          );
          setImageUrl(canvas.toDataURL());
        }}
      />
      {imageUrl && (
        <PageOrganizerScanCorners
          key={JSON.stringify(suggestion)}
          width={WIDTH}
          height={HEIGHT}
          imageUrl={imageUrl}
          suggestion={suggestion}
          onChange={setCorners}
        />
      )}
      <div className="flex gap-2">
        <Button
          onClick={() => detached(detectFixture(), "scan-corners.detect")}
        >
          Detect fixture corners
        </Button>
        <Button onClick={() => detached(cleanFixture(), "scan-corners.clean")}>
          Clean fixture with chosen corners
        </Button>
      </div>
      {review?.type === "preview" && (
        <canvas
          aria-label="Cleaned fixture scan"
          className="w-full"
          width={review.scan.image.width}
          height={review.scan.image.height}
          ref={(canvas) => {
            if (!canvas) {
              return;
            }
            const context =
              canvas.getContext("2d") ??
              panic("Canvas rendering requires a 2D context");
            const { width, height, pixels } = review.scan.image;
            const image = context.createImageData(width, height);
            for (const [index, value] of pixels.entries()) {
              const offset = index * 4;
              image.data[offset] = value;
              image.data[offset + 1] = value;
              image.data[offset + 2] = value;
              image.data[offset + 3] = 255;
            }
            context.putImageData(image, 0, 0);
          }}
        />
      )}
      <output className="text-sm" aria-live="polite">
        {failure ?? review?.type}
      </output>
    </div>
  );
};
