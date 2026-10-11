use image::{GrayImage, Luma};

use crate::{
    CleanOptions, CleanOutput, InkEstimate, InkRetentionOptions, clean_scan, threshold_document,
    threshold_strokes,
};

#[test]
fn dense_faint_strokes_survive_when_the_adaptive_mean_erases_them() {
    let mut source = GrayImage::from_pixel(256, 256, Luma([245]));
    for y in 64..192 {
        for x in 64..192 {
            if x % 4 != 3 {
                source.put_pixel(x, y, Luma([230]));
            }
        }
    }
    let ink = InkEstimate::from_image(&source);
    let adaptive = threshold_document(&source, crate::ADAPTIVE_THRESHOLD_OFFSET)
        .expect("fixture fits the image limit");
    assert!(!ink.retained_in(&adaptive, CleanOutput::Binary));
    let strokes = threshold_strokes(&source).expect("fixture fits the image limit");
    assert!(ink.retained_in(&strokes, CleanOutput::Binary));
    assert_eq!(strokes.get_pixel(129, 128)[0], 0);

    let result = clean_scan(
        &source,
        CleanOptions {
            output: CleanOutput::Binary,
            content_crop: false,
            deskew: false,
            dpi: 300.0,
        },
    )
    .expect("faint strokes should degrade to local stroke binarisation");
    assert!(ink.retained_in(&result.image, CleanOutput::Binary));
    assert!(
        result
            .image
            .pixels()
            .all(|pixel| matches!(pixel[0], 0 | 255))
    );
}

#[test]
fn local_stroke_fallback_excludes_smooth_shadows_and_subthreshold_noise() {
    let mut source = GrayImage::from_fn(256, 256, |x, _| Luma([180 + (x / 8) as u8]));
    source.put_pixel(40, 40, Luma([171])); // Fourteen levels below the local background.
    for y in 100..180 {
        source.put_pixel(128, y, Luma([180])); // Fifteen levels below the darker opposing sample.
    }
    let binary = threshold_strokes(&source).expect("fixture fits the image limit");
    assert_eq!(binary.get_pixel(40, 40)[0], 255);
    assert_eq!(binary.get_pixel(128, 140)[0], 0);
    assert_eq!(binary.pixels().filter(|pixel| pixel[0] == 0).count(), 80);
    assert!(binary.pixels().all(|pixel| matches!(pixel[0], 0 | 255)));
}

#[test]
fn retaining_most_ink_globally_does_not_hide_a_missing_text_region() {
    let mut source = GrayImage::from_pixel(256, 256, Luma([245]));
    for x in [40, 104, 168, 232] {
        for y in 8..24 {
            source.put_pixel(x, y, Luma([30]));
        }
    }
    let ink = InkEstimate::from_image(&source);
    let mut binary = threshold_strokes(&source).expect("fixture fits the image limit");
    assert!(ink.retained_in(&binary, CleanOutput::Binary));
    for y in 8..24 {
        binary.put_pixel(232, y, Luma([255]));
    }
    assert_eq!(binary.pixels().filter(|pixel| pixel[0] == 0).count(), 48);
    assert!(!ink.retained_in(&binary, CleanOutput::Binary));
}

#[test]
fn local_stroke_fallback_leaves_solid_illustration_interiors_white() {
    let mut source = GrayImage::from_pixel(256, 256, Luma([245]));
    for y in 64..192 {
        for x in 64..192 {
            source.put_pixel(x, y, Luma([30]));
        }
    }
    let binary = threshold_strokes(&source).expect("fixture fits the image limit");
    assert_eq!(binary.get_pixel(128, 128)[0], 255);
}

#[test]
fn distant_context_exclusion_cannot_compound_the_global_loss_allowance() {
    for original_count in [64_usize, 128, 256] {
        let mut ink = InkEstimate {
            pixels: vec![true; original_count],
            count: original_count,
            width: original_count as u32,
            height: 1,
        };
        let scoped_count = original_count * 3 / 4;
        for pixel in &mut ink.pixels[scoped_count..] {
            *pixel = false;
        }
        ink.count = scoped_count;
        let preserved = |x: u32, _: u32| (x as usize) < scoped_count * 3 / 4;
        // Disable tile checks here to isolate the original global denominator.
        assert!(ink.retained_where(
            InkRetentionOptions {
                minimum_tile_ink: usize::MAX,
                original_ink_count: scoped_count,
                minimum_tile_retention_percent: 75
            },
            preserved
        ));
        assert!(!ink.retained_where(
            InkRetentionOptions {
                minimum_tile_ink: usize::MAX,
                original_ink_count: original_count,
                minimum_tile_retention_percent: 75
            },
            preserved
        ));
        assert!(ink.retained_where(
            InkRetentionOptions {
                minimum_tile_ink: usize::MAX,
                original_ink_count: original_count,
                minimum_tile_retention_percent: 75
            },
            |_, _| true
        ));
    }
}

#[test]
fn source_tile_loss_boundary_is_stricter_than_processing_retention() {
    let mut pixels = vec![false; 800 * 800];
    pixels[..100].fill(true);
    let ink = InkEstimate {
        pixels,
        count: 100,
        width: 800,
        height: 800,
    };
    for retained in [94, 95, 100] {
        let options = InkRetentionOptions {
            minimum_tile_ink: 16,
            original_ink_count: 100,
            minimum_tile_retention_percent: crate::SOURCE_TILE_RETENTION_PERCENT,
        };
        assert_eq!(
            ink.retained_where(options, |x, _| x < retained),
            retained >= 95
        );
    }
}

#[test]
fn zero_offset_adaptive_retry_preserves_faint_dense_strokes_without_smooth_fill() {
    let mut source = GrayImage::from_pixel(160, 160, Luma([200]));
    for y in 40..120 {
        for x in 40..120 {
            if x % 4 < 3 {
                source.put_pixel(x, y, Luma([185]));
            }
        }
    }
    let preferred =
        threshold_document(&source, crate::ADAPTIVE_THRESHOLD_OFFSET).expect("bounded image");
    let retry = threshold_document(&source, 0).expect("bounded image");
    let ink = InkEstimate::from_image(&source);
    assert!(!ink.retained_in(&preferred, CleanOutput::Binary));
    assert!(ink.retained_in(&retry, CleanOutput::Binary));
    assert_eq!(retry.get_pixel(20, 20)[0], 255);
}
