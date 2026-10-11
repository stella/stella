use image::{GrayImage, Luma};
use imageproc::geometric_transformations::{Border, Interpolation, rotate_about_center};

use crate::{
    CleanOptions, CleanOutput, UnrecognizedReason, clean_scan, content_bounds, cross, deskew_angle,
    detect_page_quad, perspective, rgba_to_gray, rotate_centered, rotation_geometry,
    threshold_document,
};

fn text_page() -> GrayImage {
    let mut image = GrayImage::from_pixel(600, 800, Luma([245]));
    for y in (150..650).step_by(45) {
        for row in y..y + 7 {
            for x in 100..500 {
                image.put_pixel(x, row, Luma([25]));
            }
        }
    }
    image
}

fn options(output: CleanOutput) -> CleanOptions {
    CleanOptions {
        output,
        content_crop: false,
        deskew: false,
        dpi: 300.0,
    }
}

#[test]
fn deskew_reports_rotation_sign_and_half_degree_accuracy() {
    let source = text_page();
    for expected in [-4.0_f32, 3.0] {
        let rotated = rotate_about_center(
            &source,
            expected.to_radians(),
            Interpolation::Bilinear,
            Border::Constant(Luma([245])),
        );
        let actual = deskew_angle(&rotated);
        assert_eq!(actual.signum(), expected.signum());
        assert!(
            (actual - expected).abs() <= 0.5,
            "expected {expected}, got {actual}"
        );
    }
}

#[test]
fn deskewed_output_is_straight() {
    let rotated = rotate_about_center(
        &text_page(),
        4.0_f32.to_radians(),
        Interpolation::Bilinear,
        Border::Constant(Luma([245])),
    );
    let result = clean_scan(
        &rotated,
        CleanOptions {
            deskew: true,
            ..options(CleanOutput::Grayscale)
        },
    )
    .expect("rotated page should clean");

    let remaining = deskew_angle(&result.image);
    assert!(
        remaining.abs() <= 0.5,
        "expected straight output, got {remaining} degrees"
    );
}

#[test]
fn deskew_without_content_crop_preserves_edge_content() {
    let mut source = text_page();
    for x in 0..source.width() {
        source.put_pixel(x, 0, Luma([20]));
        source.put_pixel(x, source.height() - 1, Luma([20]));
    }
    for y in 0..source.height() {
        source.put_pixel(0, y, Luma([20]));
        source.put_pixel(source.width() - 1, y, Luma([20]));
    }
    assert!((0..source.width()).any(|x| source.get_pixel(x, 0)[0] < 100));
    assert!((0..source.width()).any(|x| source.get_pixel(x, source.height() - 1)[0] < 100));
    assert!((0..source.height()).any(|y| source.get_pixel(0, y)[0] < 100));
    assert!((0..source.height()).any(|y| source.get_pixel(source.width() - 1, y)[0] < 100));

    let before = clean_scan(&source, options(CleanOutput::Grayscale))
        .expect("unrotated edge content should clean")
        .image
        .pixels()
        .filter(|pixel| pixel[0] < 128)
        .count();
    let rotated = rotate_centered(&source, -3.0)
        .expect("normal page rotation should fit")
        .image;
    let result = clean_scan(
        &rotated,
        CleanOptions {
            deskew: true,
            ..options(CleanOutput::Grayscale)
        },
    )
    .expect("edge content should clean");
    let after = result.image.pixels().filter(|pixel| pixel[0] < 128).count();

    assert!(result.image.width() > rotated.width());
    assert!(result.image.height() > rotated.height());
    assert!(
        after.abs_diff(before) <= before / 5,
        "before {before}, after {after}"
    );
    assert!(
        result
            .image
            .rows()
            .next()
            .expect("top row")
            .all(|pixel| pixel[0] >= 240)
    );
    assert!(
        result
            .image
            .rows()
            .next_back()
            .expect("bottom row")
            .all(|pixel| pixel[0] >= 240)
    );
    assert!(
        result
            .image
            .rows()
            .all(|mut row| row.next().expect("left pixel")[0] >= 240)
    );
    assert!(
        result
            .image
            .rows()
            .all(|mut row| row.next_back().expect("right pixel")[0] >= 240)
    );
}

#[test]
fn content_crop_uses_physical_padding_and_ignores_a_noise_speck() {
    let mut binary = GrayImage::from_pixel(500, 500, Luma([255]));
    for y in 200..240 {
        for x in 150..350 {
            binary.put_pixel(x, y, Luma([0]));
        }
    }
    binary.put_pixel(2, 2, Luma([0]));
    let bounds = content_bounds(&binary, 300.0).expect("main component should be recognized");
    assert_eq!(
        (bounds.x, bounds.y, bounds.width, bounds.height),
        (150, 200, 200, 40)
    );

    let mut source = GrayImage::from_pixel(500, 500, Luma([245]));
    for y in 200..240 {
        for x in 150..350 {
            source.put_pixel(x, y, Luma([0]));
        }
    }
    let result = clean_scan(
        &source,
        CleanOptions {
            content_crop: true,
            ..options(CleanOutput::Binary)
        },
    )
    .expect("page should clean");
    // Three millimetres at 300 DPI rounds to 35 pixels on each available side.
    assert_eq!(result.image.width(), result.content_box.width + 70);
    assert_eq!(result.image.height(), result.content_box.height + 70);
    assert_eq!((result.content_box.x, result.content_box.y), (35, 35));
}

#[test]
fn content_crop_recognizes_a_thin_diagonal_stroke() {
    let mut source = GrayImage::from_pixel(64, 64, Luma([255]));
    for coordinate in 10..=50 {
        source.put_pixel(coordinate, coordinate, Luma([0]));
    }
    let detected = content_bounds(&source, 300.0).expect("diagonal should exceed the dust limit");
    assert_eq!(
        (detected.x, detected.y, detected.width, detected.height),
        (10, 10, 41, 41)
    );

    let result = clean_scan(
        &source,
        CleanOptions {
            content_crop: true,
            ..options(CleanOutput::Binary)
        },
    )
    .expect("diagonal stroke should be recognized as content");

    assert!(result.content_box.x <= 10);
    assert!(result.content_box.y <= 10);
    assert!(result.content_box.x + result.content_box.width > 50);
    assert!(result.content_box.y + result.content_box.height > 50);
}

#[test]
fn content_crop_includes_a_thin_diagonal_stroke_next_to_other_content() {
    let mut source = GrayImage::from_pixel(128, 128, Luma([245]));
    for coordinate in 10..=30 {
        source.put_pixel(coordinate, coordinate, Luma([25]));
    }
    for y in 80..85 {
        for x in 80..=110 {
            source.put_pixel(x, y, Luma([25]));
        }
    }

    let result = clean_scan(
        &source,
        CleanOptions {
            content_crop: true,
            ..options(CleanOutput::Binary)
        },
    )
    .expect("page content should clean");

    assert!(result.content_box.x <= 10);
    assert!(result.content_box.y <= 10);
    assert!(result.content_box.x + result.content_box.width > 110);
    assert!(result.content_box.y + result.content_box.height > 84);
}

#[test]
fn photographed_page_keeps_its_aspect_ratio() {
    let mut source = GrayImage::from_pixel(900, 700, Luma([20]));
    let quad = [(210, 80), (660, 110), (700, 610), (180, 590)];
    for y in 80_u32..=610 {
        for x in 180_u32..=700 {
            let left = 210.0 + (180.0 - 210.0) * (y - 80) as f32 / 510.0;
            let right = 660.0 + (700.0 - 660.0) * y.saturating_sub(110) as f32 / 500.0;
            if x as f32 >= left && x as f32 <= right {
                source.put_pixel(x, y, Luma([245]));
            }
        }
    }
    for y in (180..520).step_by(45) {
        for row in y..y + 6 {
            for x in 280..600 {
                source.put_pixel(x, row, Luma([30]));
            }
        }
    }

    let detected = detect_page_quad(&source).expect("page quad should be detected");
    assert_ne!(
        detected,
        [(0.0, 0.0), (899.0, 0.0), (899.0, 699.0), (0.0, 699.0)]
    );
    let result = clean_scan(&source, options(CleanOutput::Grayscale))
        .expect("photographed page should clean");
    assert!(result.applied_quad.is_some());
    let aspect = result.image.width() as f32 / result.image.height() as f32;
    let expected = (quad[1].0 - quad[0].0) as f32 / (quad[3].1 - quad[0].1) as f32;
    assert!(
        (aspect - expected).abs() < 0.12,
        "expected aspect {expected}, got {aspect}"
    );
}

#[test]
fn photographed_page_reports_source_quad_after_deskew_and_crop() {
    let mut source = GrayImage::from_pixel(700, 600, Luma([20]));
    let page_quad = [(170.0, 70.0), (570.0, 95.0), (600.0, 535.0), (135.0, 510.0)];
    let expected_source_corners = [(171.0, 73.0), (569.0, 97.0), (598.0, 523.0), (138.0, 509.0)];
    for y in 70_u32..=535 {
        for x in 135_u32..=600 {
            let point = (x as f32, y as f32);
            if (0..4).all(|index| cross(page_quad[index], page_quad[(index + 1) % 4], point) >= 0.0)
            {
                source.put_pixel(x, y, Luma([245]));
            }
        }
    }
    for y in (180..430).step_by(40) {
        for row in y..y + 6 {
            for x in 240..500 {
                source.put_pixel(x, row, Luma([30]));
            }
        }
    }

    let result = clean_scan(
        &source,
        CleanOptions {
            content_crop: true,
            deskew: true,
            ..options(CleanOutput::Grayscale)
        },
    )
    .expect("photographed page should clean");
    let applied = result.applied_quad.expect("page quad should be detected");
    for (actual, expected) in applied.into_iter().zip(expected_source_corners) {
        assert!(
            (actual.0 - expected.0).abs() <= 1.0 && (actual.1 - expected.1).abs() <= 1.0,
            "expected source corner {expected:?}, got {actual:?}"
        );
    }
    assert!(result.content_box.x + result.content_box.width <= result.image.width());
    assert!(result.content_box.y + result.content_box.height <= result.image.height());
}

#[test]
fn flattening_removes_a_background_gradient_without_losing_text() {
    let mut source = GrayImage::from_fn(600, 800, |x, _| Luma([180 + (60 * x / 599) as u8]));
    for y in 350..365 {
        for x in 100..500 {
            source.put_pixel(x, y, Luma([25]));
        }
    }
    let result = clean_scan(&source, options(CleanOutput::Binary)).expect("page should clean");

    assert!(
        result
            .image
            .enumerate_pixels()
            .filter(|(x, y, _)| (80..520).contains(x) && (*y < 300 || *y > 420))
            .all(|(_, _, pixel)| pixel[0] == 255)
    );
    assert!(
        result
            .image
            .enumerate_pixels()
            .any(|(x, y, pixel)| (100..500).contains(&x)
                && (350..365).contains(&y)
                && pixel[0] == 0)
    );
}

#[test]
fn flattening_preserves_sharp_solid_fills_at_each_resolution_and_output_mode() {
    for size in [700_u32, 2_000, 4_000] {
        let mut source = GrayImage::from_pixel(size, size, Luma([245]));
        let fill_size = size * 6 / 35;
        let margin = size / 10;
        let gap = size / 7;
        let fills = [
            (margin, margin, 190_u8),
            (margin + fill_size + gap, margin, 120),
            (margin, margin + fill_size + gap, 80),
            (margin + fill_size + gap, margin + fill_size + gap, 25),
        ];
        for (left, top, value) in fills {
            for y in top..top + fill_size {
                for x in left..left + fill_size {
                    source.put_pixel(x, y, Luma([value]));
                }
            }
        }

        for output in [CleanOutput::Binary, CleanOutput::Grayscale] {
            let result = clean_scan(&source, options(output)).expect("dark regions should clean");
            for (left, top, value) in fills {
                let expected_maximum = match output {
                    CleanOutput::Binary => 0,
                    CleanOutput::Grayscale => value.saturating_add(10),
                };
                assert!(
                    result
                        .image
                        .get_pixel(left + fill_size / 2, top + fill_size / 2)[0]
                        <= expected_maximum,
                    "{output:?} centre at size {size} was not retained for value {value}"
                );
                let inset = (size / 140).max(1);
                let interior_side = fill_size - 2 * inset;
                let dark_interior = (top + inset..top + fill_size - inset)
                    .flat_map(|y| (left + inset..left + fill_size - inset).map(move |x| (x, y)))
                    .filter(|(x, y)| result.image.get_pixel(*x, *y)[0] <= expected_maximum)
                    .count();
                assert!(
                    dark_interior >= (interior_side * interior_side * 90 / 100) as usize,
                    "{output:?} output at size {size} retained {dark_interior} dark pixels for value {value}"
                );
            }
        }
    }
}

#[test]
fn flattening_removes_smooth_shadow_and_vignette_at_each_resolution() {
    for size in [700_u32, 2_000, 4_000] {
        let last = size - 1;
        let centre = size as f32 / 2.0;
        let corner_distance = centre * 2.0_f32.sqrt();
        let mut source = GrayImage::from_fn(size, size, |x, y| {
            let shadow = 55.0 * (x as f32 / last as f32).powi(2);
            let dx = (x as f32 - centre) / corner_distance;
            let dy = (y as f32 - centre) / corner_distance;
            let vignette = 25.0 * (dx * dx + dy * dy).min(1.0);
            Luma([(245.0_f32 - shadow - vignette).round() as u8])
        });
        let text_top = size * 33 / 70;
        let text_height = (size / 175).max(4);
        let text_left = size / 7;
        let text_right = size * 6 / 7;
        for y in text_top..text_top + text_height {
            for x in text_left..text_right {
                source.put_pixel(x, y, Luma([25]));
            }
        }

        for output in [CleanOutput::Binary, CleanOutput::Grayscale] {
            let result = clean_scan(&source, options(output)).expect("shadowed page should clean");
            let text_guard = size / 35;
            let minimum_page = result
                .image
                .enumerate_pixels()
                .filter(|(_, y, _)| {
                    *y + text_guard < text_top || *y > text_top + text_height + text_guard
                })
                .map(|(_, _, pixel)| pixel[0])
                .min()
                .expect("page pixels");
            let expected_page_minimum = match output {
                CleanOutput::Binary => 255,
                CleanOutput::Grayscale => 230,
            };
            assert!(
                minimum_page >= expected_page_minimum,
                "{output:?} page minimum {minimum_page} at size {size}"
            );
            let text_maximum = match output {
                CleanOutput::Binary => 0,
                CleanOutput::Grayscale => 30,
            };
            let retained_text = (text_top..text_top + text_height)
                .map(|y| {
                    (text_left..text_right)
                        .filter(|x| result.image.get_pixel(*x, y)[0] <= text_maximum)
                        .count()
                })
                .max()
                .expect("text rows");
            assert!(
                retained_text >= ((text_right - text_left) * 9 / 10) as usize,
                "{output:?} retained {retained_text} crisp text pixels at size {size}"
            );
        }
    }
}

#[test]
fn binary_output_preserves_the_interior_of_a_solid_dark_region() {
    let mut source = GrayImage::from_pixel(300, 300, Luma([255]));
    for y in 100..200 {
        for x in 100..200 {
            source.put_pixel(x, y, Luma([0]));
        }
    }

    let binary = threshold_document(&source);
    assert_eq!(binary.get_pixel(150, 150)[0], 0);
    let dark_interior = (110..190)
        .flat_map(|y| (110..190).map(move |x| (x, y)))
        .filter(|(x, y)| binary.get_pixel(*x, *y)[0] == 0)
        .count();
    assert!(dark_interior >= 80 * 80 * 95 / 100);
}

#[test]
fn expanded_rotation_rejects_an_area_above_the_input_limit() {
    let source = GrayImage::from_pixel(100_000, 400, Luma([255]));

    let result = rotation_geometry(&source, 6.0);

    assert!(matches!(result, Err(UnrecognizedReason::TooLarge)));
}

#[test]
fn transparent_rgba_is_composited_over_white() {
    let mut pixels = vec![0; 64 * 64 * 4];
    for pixel in pixels.chunks_exact_mut(4) {
        pixel.copy_from_slice(&[0, 0, 0, 0]);
    }
    pixels[0..4].copy_from_slice(&[0, 0, 0, 255]);
    pixels[8..12].copy_from_slice(&[0, 0, 0, 128]);
    let result = rgba_to_gray(64, 64, &pixels).expect("valid RGBA pixels should convert");

    assert_eq!(result.get_pixel(0, 0)[0], 0);
    assert_eq!(result.get_pixel(1, 0)[0], 255);
    assert_eq!(result.get_pixel(2, 0)[0], 127);
}

#[test]
fn binary_output_contains_only_black_and_white() {
    let result = clean_scan(&text_page(), options(CleanOutput::Binary)).expect("page should clean");
    assert!(
        result
            .image
            .pixels()
            .all(|pixel| matches!(pixel[0], 0 | 255))
    );
}

#[test]
fn grayscale_output_keeps_intermediate_levels() {
    let result =
        clean_scan(&text_page(), options(CleanOutput::Grayscale)).expect("page should clean");
    assert!(
        result
            .image
            .pixels()
            .any(|pixel| pixel[0] > 0 && pixel[0] < 255)
    );
}

#[test]
fn identity_perspective_is_a_no_op() {
    let source = text_page();
    let quad = [
        (0.0, 0.0),
        (source.width() as f32 - 1.0, 0.0),
        (source.width() as f32 - 1.0, source.height() as f32 - 1.0),
        (0.0, source.height() as f32 - 1.0),
    ];
    let result = perspective(&source, quad, source.width(), source.height())
        .expect("identity quad should be valid");
    assert_eq!(result, source);
}

#[test]
fn blank_page_is_unrecognized() {
    let blank = GrayImage::from_pixel(500, 700, Luma([255]));
    let result = clean_scan(&blank, options(CleanOutput::Grayscale));
    assert!(matches!(result, Err(UnrecognizedReason::NoContent)));
}

#[test]
fn full_frame_page_does_not_apply_a_quad() {
    let result = clean_scan(&text_page(), options(CleanOutput::Grayscale))
        .expect("flatbed page should clean");
    assert_eq!(result.applied_quad, None);
}
