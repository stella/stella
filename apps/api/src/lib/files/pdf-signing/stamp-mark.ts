import { pdfNumber } from "@/api/lib/files/pdf-signing/stamp-glyphs";

/**
 * The stella mark, from the two paths of
 * packages/ui/src/components/stella-mark.tsx (viewBox 0 0 40 41), as PDF
 * path operators in viewBox units: y flipped to point up as in PDF user
 * space, and each arc turned into cubic Beziers. Each path is filled on its
 * own with the nonzero rule, as the SVG fills it. Regenerate these from that
 * file whenever the mark changes.
 */
export const STELLA_MARK_WIDTH = 40;
export const STELLA_MARK_HEIGHT = 41;
const STELLA_MARK_PATH = [
  "6.580 29.700 m",
  "16.690 35.950 l",
  "18.691 37.302 21.313 37.298 23.310 35.940 c",
  "37.990 26.870 l",
  "37.990 31.740 l",
  "25.520 39.450 l",
  "23.835 40.413 21.939 40.945 20.000 41.000 c",
  "18.030 41.000 16.120 40.460 14.470 39.440 c",
  "4.370 33.190 l",
  "1.677 31.507 0.029 28.566 0.000 25.390 c",
  "0.029 22.214 1.677 19.273 4.370 17.590 c",
  "7.630 15.570 l",
  "7.620 15.560 l",
  "18.770 8.660 l",
  "18.910 8.570 19.040 8.500 19.160 8.460 c",
  "19.840 8.200 20.580 8.270 21.190 8.650 c",
  "30.780 14.580 l",
  "30.880 14.650 l",
  "32.950 15.930 l",
  "30.130 17.650 l",
  "29.030 18.340 l",
  "20.010 12.780 l",
  "19.600 13.020 l",
  "6.590 21.070 l",
  "5.159 22.053 4.268 23.646 4.180 25.380 c",
  "4.180 27.170 5.060 28.740 6.590 29.680 c",
  "h",
  "f",
  "33.340 11.750 m",
  "23.240 5.500 l",
  "21.237 4.144 18.609 4.148 16.610 5.510 c",
  "1.940 14.570 l",
  "1.940 9.710 l",
  "14.410 2.000 l",
  "16.095 1.037 17.991 0.505 19.930 0.450 c",
  "21.900 0.450 23.810 0.990 25.460 2.010 c",
  "35.560 8.260 l",
  "38.253 9.943 39.901 12.884 39.930 16.060 c",
  "39.901 19.236 38.253 22.177 35.560 23.860 c",
  "32.300 25.880 l",
  "32.310 25.890 l",
  "21.160 32.790 l",
  "21.040 32.874 20.909 32.942 20.770 32.990 c",
  "20.131 33.406 19.290 33.327 18.740 32.800 c",
  "9.150 26.870 l",
  "9.050 26.800 l",
  "6.980 25.520 l",
  "9.800 23.800 l",
  "10.900 23.110 l",
  "19.920 28.670 l",
  "20.330 28.430 l",
  "33.340 20.380 l",
  "34.771 19.397 35.662 17.804 35.750 16.070 c",
  "35.750 14.280 34.870 12.710 33.340 11.770 c",
  "h",
  "f",
] as const;

/**
 * Pale stella blue, opaque: no transparency group, so the mark prints as it
 * shows and the stamp stays PDF/A-friendly.
 */
export const STELLA_MARK_FILL = "0.85 0.91 0.96 rg";

/**
 * The mark centred in `box` and as large as it fits, as content operators
 * in the appearance space of the stamp. Draw it before the text, so the text
 * sits on top.
 */
export const drawStampMark = (box: {
  x: number;
  y: number;
  width: number;
  height: number;
}): string[] => {
  const scale = Math.min(
    box.width / STELLA_MARK_WIDTH,
    box.height / STELLA_MARK_HEIGHT,
  );
  if (!(scale > 0)) {
    return [];
  }
  const left = box.x + (box.width - STELLA_MARK_WIDTH * scale) / 2;
  const bottom = box.y + (box.height - STELLA_MARK_HEIGHT * scale) / 2;
  return [
    "q",
    STELLA_MARK_FILL,
    `${pdfNumber(scale)} 0 0 ${pdfNumber(scale)} ${pdfNumber(left)} ${pdfNumber(bottom)} cm`,
    ...STELLA_MARK_PATH,
    "Q",
  ];
};
