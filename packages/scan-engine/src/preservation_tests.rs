use image::{GrayImage, Luma};

use crate::{CleanOutput, retains_ink, threshold_document};

#[test]
fn binary_retains_thin_strokes_across_smooth_shadow_levels() {
    for shade in [45_u8, 90, 135, 180, 225] {
        for stroke_width in 1..=8 {
            let mut source = GrayImage::from_fn(180, 120, |x, _| {
                Luma([shade.saturating_add((x / 12) as u8)])
            });
            for y in 40..40 + stroke_width {
                for x in 30..150 {
                    source.put_pixel(x, y, Luma([shade.saturating_sub(35)]));
                }
            }
            let binary = threshold_document(&source, crate::ADAPTIVE_THRESHOLD_OFFSET)
                .expect("bounded fixture");
            assert!(
                retains_ink(&source, &binary, CleanOutput::Binary),
                "shade {shade}, width {stroke_width}"
            );
            assert_eq!(binary.get_pixel(80, 90)[0], 255);
            assert_eq!(binary.get_pixel(80, 40)[0], 0);
        }
    }
}

#[test]
fn broad_smooth_fold_valleys_do_not_become_black_blocks() {
    let source = GrayImage::from_fn(240, 120, |x, _| Luma([60 + (x.abs_diff(120) / 2) as u8]));
    let binary =
        threshold_document(&source, crate::ADAPTIVE_THRESHOLD_OFFSET).expect("bounded fixture");
    assert!(binary.pixels().all(|pixel| pixel[0] == 255));
}

#[test]
fn retention_guard_detects_erasure_and_enforces_the_documented_fraction() {
    let mut source = GrayImage::from_pixel(120, 120, Luma([240]));
    for y in [20, 40, 60, 80] {
        for x in 20..100 {
            source.put_pixel(x, y, Luma([30]));
        }
    }
    let mut output =
        threshold_document(&source, crate::ADAPTIVE_THRESHOLD_OFFSET).expect("bounded fixture");
    assert!(retains_ink(&source, &output, CleanOutput::Binary));
    for y in [20, 40, 60, 80] {
        for x in (20..100).step_by(4) {
            output.put_pixel(x, y, Luma([255]));
        }
    }
    assert!(retains_ink(&source, &output, CleanOutput::Binary));
    for y in [20, 40, 60, 80] {
        for x in (21..100).step_by(4) {
            output.put_pixel(x, y, Luma([255]));
        }
    }
    assert!(!retains_ink(&source, &output, CleanOutput::Binary));
    assert!(!retains_ink(
        &source,
        &GrayImage::from_pixel(120, 120, Luma([255])),
        CleanOutput::Grayscale
    ));
}

#[test]
fn grayscale_falls_back_when_flattening_erases_faint_text() {
    use crate::{CleanOptions, clean_scan, flattening_background};

    let mut source = GrayImage::from_pixel(220, 180, Luma([255]));
    // Low contrast strokes are below the smoothed edge barrier's seed threshold.
    for y in [40, 65, 90, 115] {
        for x in 30..190 {
            source.put_pixel(x, y, Luma([240]));
        }
    }
    // Smooth dark desk clutter at the boundary cannot be mistaken for text valleys.
    for y in 0..180 {
        for x in 0..12 {
            source.put_pixel(x, y, Luma([160 + x as u8 * 6]));
        }
    }
    let background = flattening_background(&source).expect("bounded fixture");
    let flattened = GrayImage::from_fn(source.width(), source.height(), |x, y| {
        let value = f32::from(source.get_pixel(x, y)[0]);
        let base = f32::from(background.get_pixel(x, y)[0].max(1));
        Luma([(value * 245.0 / base).min(255.0).round() as u8])
    });
    assert!(
        !retains_ink(&source, &flattened, CleanOutput::Grayscale),
        "fixture must reach the faulty flattening boundary"
    );
    let cleaned = clean_scan(
        &source,
        CleanOptions {
            output: CleanOutput::Grayscale,
            content_crop: false,
            deskew: false,
            dpi: 300.0,
        },
    )
    .expect("faint text should survive fallback");
    assert!(cleaned.applied_quad.is_none());
    assert!(
        cleaned.image == source,
        "fallback must preserve every source pixel"
    );
}

#[test]
fn grayscale_recognizes_solid_illustrations_without_narrow_text() {
    use crate::{CleanOptions, clean_scan};
    let mut source = GrayImage::from_pixel(240, 240, Luma([245]));
    for y in 80..160 {
        for x in 80..160 {
            source.put_pixel(x, y, Luma([100]));
        }
    }
    let cleaned = clean_scan(
        &source,
        CleanOptions {
            output: CleanOutput::Grayscale,
            content_crop: false,
            deskew: false,
            dpi: 300.0,
        },
    )
    .expect("grayscale solid illustration is meaningful content");
    assert!(cleaned.image.get_pixel(120, 120)[0] <= 120);
    assert!(cleaned.content_box.width >= 70);
}

#[test]
fn dominant_desk_strokes_cannot_hide_erasure_in_a_separate_text_region() {
    use crate::{ContentBox, InkEstimate};
    for minor_strokes in [1, 2, 4] {
        let mut source = GrayImage::from_pixel(256, 256, Luma([240]));
        for y in (20..100).step_by(4) {
            for x in 20..100 {
                source.put_pixel(x, y, Luma([20]));
            }
        }
        for row in 0..minor_strokes {
            for x in 200..224 {
                source.put_pixel(x, 202 + row * 4, Luma([20]));
            }
        }
        let estimate = InkEstimate::from_image(&source);
        let mut binary =
            threshold_document(&source, crate::ADAPTIVE_THRESHOLD_OFFSET).expect("bounded fixture");
        let erased = (0..minor_strokes)
            .flat_map(|row| (200..224).map(move |x| (x, 202 + row * 4)))
            .filter(|(x, y)| binary.get_pixel(*x, *y)[0] == 0)
            .count();
        assert!(erased >= 16, "minor region must reach the spatial guard");
        assert!(
            (estimate.count - erased) * 100 >= estimate.count * 75,
            "global retention alone must pass this fixture"
        );
        for row in 0..minor_strokes {
            for x in 200..224 {
                binary.put_pixel(x, 202 + row * 4, Luma([255]));
            }
        }
        assert!(!estimate.retained_in(&binary, CleanOutput::Binary));
        let intact_binary =
            threshold_document(&source, crate::ADAPTIVE_THRESHOLD_OFFSET).expect("bounded fixture");
        assert!(!estimate.retained_in_bounds(
            &intact_binary,
            CleanOutput::Binary,
            ContentBox {
                x: 0,
                y: 0,
                width: 128,
                height: 128
            }
        ));
        let mut grayscale = source.clone();
        for row in 0..minor_strokes {
            for x in 200..224 {
                grayscale.put_pixel(x, 202 + row * 4, Luma([240]));
            }
        }
        assert!(!estimate.retained_in(&grayscale, CleanOutput::Grayscale));
    }
}

#[test]
fn plausible_text_rectangles_cannot_crop_separate_exterior_text_regions() {
    use crate::{CleanOptions, clean_scan, detect_page_quad, stroke_contrast};

    let mut rectangle = GrayImage::from_pixel(450, 450, Luma([80]));
    // Narrow dark texture on a dim surface must not veto the bright page candidate.
    for y in (12..438).step_by(20) {
        for x in 12..438 {
            if !(110..322).contains(&x) || !(54..362).contains(&y) {
                rectangle.put_pixel(x, y, Luma([20]));
            }
        }
    }
    for y in 64..352 {
        for x in 120..312 {
            rectangle.put_pixel(x, y, Luma([245]));
        }
    }
    for top in (100..320).step_by(25) {
        for y in top..top + 4 {
            for x in 140..292 {
                rectangle.put_pixel(x, y, Luma([25]));
            }
        }
    }
    assert!(
        detect_page_quad(&rectangle).is_some(),
        "textured dark background must still allow the bright control page to be isolated"
    );
    for (left, top) in [(30, 210), (360, 210), (190, 20), (190, 400)] {
        let mut source = rectangle.clone();
        for y in top - 6..top + 9 {
            for x in left - 5..left + 65 {
                source.put_pixel(x, y, Luma([245]));
            }
        }
        for y in top..top + 2 {
            for x in left..left + 60 {
                source.put_pixel(x, y, Luma([10]));
            }
        }
        assert!(
            detect_page_quad(&source).is_none(),
            "exterior text at ({left}, {top}) must prevent cropping the larger rectangle"
        );
        let cleaned = clean_scan(
            &source,
            CleanOptions {
                output: CleanOutput::Grayscale,
                content_crop: true,
                deskew: false,
                dpi: 300.0,
            },
        )
        .expect("separate text regions should survive conservative cleanup");
        assert!(cleaned.applied_quad.is_none());
        assert_eq!(cleaned.image.dimensions(), source.dimensions());
        let retained = (top..top + 2)
            .flat_map(|y| (left..left + 60).map(move |x| (x, y)))
            .filter(|(x, y)| stroke_contrast(&cleaned.image, *x, *y) >= 15)
            .count();
        assert!(
            retained >= 120 * 75 / 100,
            "exterior text at ({left}, {top}) retained {retained} of 120 stroke pixels"
        );
    }
}
