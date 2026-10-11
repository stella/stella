use std::panic::{AssertUnwindSafe, catch_unwind};

use image::{GrayImage, Luma};

use crate::{
    CleanOptions, CleanOutput, MAX_DIMENSION_AREA, UnrecognizedReason, clean_scan,
    rotation_geometry,
};

const ROBUSTNESS_SEED: u64 = 0x5EED_C1EA_5516_0001;
const DIMENSION_SEED: u64 = 0x5EED_C1EA_5516_0002;
const FILL_SEED: u64 = 0x5EED_C1EA_5516_0003;
const DETERMINISM_SEED: u64 = 0x5EED_C1EA_5516_0004;
const CASES_PER_PROPERTY: usize = 8;

#[derive(Clone, Copy)]
struct Generator {
    state: u64,
}

impl Generator {
    const fn new(seed: u64) -> Self {
        Self { state: seed }
    }

    fn next(&mut self) -> u64 {
        let mut value = self.state;
        value ^= value << 13;
        value ^= value >> 7;
        value ^= value << 17;
        self.state = value;
        value
    }

    fn range(&mut self, start: u32, end: u32) -> u32 {
        start + (self.next() % u64::from(end - start)) as u32
    }
}

fn options(output: CleanOutput, deskew: bool) -> CleanOptions {
    CleanOptions {
        output,
        content_crop: false,
        deskew,
        dpi: 300.0,
    }
}

fn generated_dimensions(generator: &mut Generator, case: usize) -> (u32, u32) {
    const EDGE_DIMENSIONS: [(u32, u32); 4] = [(1, 1), (1, 2_500), (2_500, 1), (64, 64)];
    if case < EDGE_DIMENSIONS.len() {
        return EDGE_DIMENSIONS[case];
    }
    let width = generator.range(32, 640);
    let maximum_height = (180_000 / width).clamp(32, 640);
    (width, generator.range(32, maximum_height + 1))
}

fn random_page(generator: &mut Generator, case: usize) -> GrayImage {
    let (width, height) = generated_dimensions(generator, case);
    let family = case % 4;
    let quad_tilt = generator.range(0, width.saturating_div(12).max(1));
    GrayImage::from_fn(width, height, |x, y| {
        let noise = (generator.next() & 15) as u8;
        let value = match family {
            0 => noise.saturating_mul(17),
            1 => {
                let border =
                    x < 2 || y < 2 || x.saturating_add(2) >= width || y.saturating_add(2) >= height;
                if border {
                    20
                } else {
                    235_u8.saturating_add(noise)
                }
            }
            2 => {
                let row_tilt = y.saturating_mul(quad_tilt) / height.max(1);
                let inside_page = x > width / 8 + row_tilt
                    && x < width.saturating_mul(7) / 8 - row_tilt
                    && y > height / 10
                    && y < height.saturating_mul(9) / 10;
                if inside_page {
                    220_u8.saturating_add(noise.saturating_mul(2))
                } else {
                    10_u8.saturating_add(noise)
                }
            }
            _ => {
                let gradient = x.saturating_mul(35) / width.max(1);
                205_u8.saturating_add(gradient as u8).saturating_add(noise)
            }
        };
        Luma([value])
    })
}

fn for_each_mode(mut check: impl FnMut(CleanOutput, bool)) {
    for output in [CleanOutput::Grayscale, CleanOutput::Binary] {
        for deskew in [false, true] {
            check(output, deskew);
        }
    }
}

#[test]
fn generated_scans_return_without_panicking() {
    let mut generator = Generator::new(ROBUSTNESS_SEED);
    for case in 0..CASES_PER_PROPERTY {
        let source = random_page(&mut generator, case);
        for_each_mode(|output, deskew| {
            let result = catch_unwind(AssertUnwindSafe(|| {
                clean_scan(&source, options(output, deskew))
            }));
            assert!(
                result.is_ok(),
                "seed {ROBUSTNESS_SEED:#x}, case {case}, dimensions {:?}, {output:?}, deskew {deskew}",
                source.dimensions()
            );
            if let Ok(Err(reason)) = result {
                assert!(
                    matches!(
                        reason,
                        UnrecognizedReason::NoContent
                            | UnrecognizedReason::InvalidDimensions
                            | UnrecognizedReason::InvalidPixelBuffer
                            | UnrecognizedReason::InvalidDpi
                            | UnrecognizedReason::DegeneratePageQuad
                            | UnrecognizedReason::TooLarge
                    ),
                    "seed {ROBUSTNESS_SEED:#x}, case {case}: unexpected reason {reason:?}"
                );
            }
        });
    }
}

#[test]
fn generated_output_dimensions_stay_within_the_allocation_limit() {
    let mut generator = Generator::new(DIMENSION_SEED);
    for case in 0..CASES_PER_PROPERTY {
        let source = random_page(&mut generator, case);
        for_each_mode(|output, deskew| {
            if let Ok(cleaned) = clean_scan(&source, options(output, deskew)) {
                let (width, height) = cleaned.image.dimensions();
                assert!(
                    width > 0 && height > 0,
                    "seed {DIMENSION_SEED:#x}, case {case}"
                );
                assert!(
                    width
                        .checked_mul(height)
                        .is_some_and(|area| area <= MAX_DIMENSION_AREA),
                    "seed {DIMENSION_SEED:#x}, case {case}, output {width}x{height}"
                );
            }
        });

        // Narrow inputs can have a small source area but an expanded rotation canvas. Generating
        // this probe independently avoids allocating the rejected canvas.
        let width = 80_000 + generator.range(0, 20_001);
        let height = MAX_DIMENSION_AREA / width;
        let probe = GrayImage::new(width, height);
        let angle = 3.0 + generator.range(0, 31) as f32 / 10.0;
        let geometry = rotation_geometry(&probe, angle);
        assert!(
            matches!(geometry, Err(UnrecognizedReason::TooLarge)),
            "seed {DIMENSION_SEED:#x}, case {case}, rotation probe {width}x{height} at {angle} degrees"
        );
    }
}

fn filled_page(generator: &mut Generator) -> (GrayImage, (u32, u32, u32, u32)) {
    let width = generator.range(180, 361);
    let height = generator.range(180, 361);
    let background = generator.range(200, 251) as u8;
    let contrast = generator.range(30, u32::from(background) - 19) as u8;
    let rectangle_width = generator.range(width / 6, width / 4);
    let rectangle_height = generator.range(height / 6, height / 4);
    let left = generator.range(width / 5, width - width / 5 - rectangle_width);
    let top = generator.range(height / 5, height - height / 5 - rectangle_height);
    let right = left + rectangle_width;
    let bottom = top + rectangle_height;
    let source = GrayImage::from_fn(width, height, |x, y| {
        let horizontal = x.saturating_mul(18) / width;
        let vertical = y.saturating_mul(12) / height;
        let illumination = background
            .saturating_sub(15)
            .saturating_add(horizontal as u8)
            .saturating_add(vertical as u8);
        if (left..right).contains(&x) && (top..bottom).contains(&y) {
            Luma([illumination.saturating_sub(contrast)])
        } else {
            Luma([illumination])
        }
    });
    (source, (left, top, right, bottom))
}

fn mean_region(image: &GrayImage, bounds: (u32, u32, u32, u32)) -> u32 {
    let (left, top, right, bottom) = bounds;
    let mut sum = 0_u64;
    let mut count = 0_u64;
    for y in top..bottom {
        for x in left..right {
            sum += u64::from(image.get_pixel(x, y)[0]);
            count += 1;
        }
    }
    (sum / count) as u32
}

#[test]
fn generated_solid_fill_interiors_remain_darker_than_the_page() {
    let mut generator = Generator::new(FILL_SEED);
    for case in 0..CASES_PER_PROPERTY {
        let (source, (left, top, right, bottom)) = filled_page(&mut generator);
        let inset = 8;
        let interior = (left + inset, top + inset, right - inset, bottom - inset);
        for_each_mode(|output, deskew| {
            let cleaned = clean_scan(&source, options(output, deskew))
                .unwrap_or_else(|reason| {
                    panic!(
                        "seed {FILL_SEED:#x}, case {case}, dimensions {:?}, {output:?}, deskew {deskew}: {reason:?}",
                        source.dimensions()
                    )
                });
            let page = (
                8,
                8,
                left.saturating_sub(8).max(9),
                top.saturating_sub(8).max(9),
            );
            let fill_mean = mean_region(&cleaned.image, interior);
            let page_mean = mean_region(&cleaned.image, page);
            // Bilinear deskew and illumination normalization may narrow the original contrast;
            // twelve levels still distinguish a retained fill from cleaned page background.
            assert!(
                fill_mean + 12 <= page_mean,
                "seed {FILL_SEED:#x}, case {case}, dimensions {:?}, {output:?}, deskew {deskew}: fill {fill_mean}, page {page_mean}",
                source.dimensions()
            );
        });
    }
}

#[test]
fn generated_scans_are_byte_deterministic() {
    let mut generator = Generator::new(DETERMINISM_SEED);
    for case in 0..CASES_PER_PROPERTY {
        let source = random_page(&mut generator, case);
        for_each_mode(|output, deskew| {
            let first = clean_scan(&source, options(output, deskew));
            let second = clean_scan(&source, options(output, deskew));
            match (first, second) {
                (Ok(first), Ok(second)) => {
                    assert_eq!(first.image.dimensions(), second.image.dimensions());
                    assert_eq!(
                        first.image.as_raw(),
                        second.image.as_raw(),
                        "seed {DETERMINISM_SEED:#x}, case {case}, {output:?}, deskew {deskew}"
                    );
                }
                (Err(first), Err(second)) => assert_eq!(
                    first, second,
                    "seed {DETERMINISM_SEED:#x}, case {case}, {output:?}, deskew {deskew}"
                ),
                (first, second) => panic!(
                    "seed {DETERMINISM_SEED:#x}, case {case}, {output:?}, deskew {deskew}: {first:?} != {second:?}"
                ),
            }
        });
    }
}
