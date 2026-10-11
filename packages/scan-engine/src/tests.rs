use image::{GrayImage, Luma};
use imageproc::geometric_transformations::{Border, Interpolation, rotate_about_center};

use crate::{
    CleanOptions, CleanOutput, UnrecognizedReason, clean_scan, content_bounds, cross, deskew_angle,
    detect_page_quad, edge_barrier, perspective, rgba_to_gray, rotate_centered, rotation_geometry,
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
fn uncertain_page_is_not_content_cropped_and_ignores_a_noise_speck() {
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
            ..options(CleanOutput::Grayscale)
        },
    )
    .expect("page should clean");
    assert!(result.applied_quad.is_none());
    assert_eq!(result.image.dimensions(), source.dimensions());
    assert!(result.content_box.x <= 150);
    assert!(result.content_box.y <= 200);
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
fn photographed_page_reports_source_quad_or_preserves_uncertain_geometry() {
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
    let Some(applied) = result.applied_quad else {
        assert!(result.image.width() >= source.width());
        assert!(result.image.height() >= source.height());
        return;
    };
    for (actual, expected) in applied.into_iter().zip(expected_source_corners) {
        assert!(
            (actual.0 - expected.0).abs() <= 12.0 && (actual.1 - expected.1).abs() <= 12.0,
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
fn scaled_edge_barrier_detects_a_physical_fill_boundary_at_each_resolution() {
    for scale_reference in [700_u32, 2_000, 4_000] {
        let edge_scale = (scale_reference / 500).max(1);
        let transition_width = edge_scale * 2;
        let boundary = 100_u32;
        let source = GrayImage::from_fn(200, 80, |x, _| {
            let value = if x < boundary - transition_width / 2 {
                245
            } else if x >= boundary + transition_width / 2 {
                190
            } else {
                let offset = x - (boundary - transition_width / 2);
                245 - (55 * offset / transition_width) as u8
            };
            Luma([value])
        });

        let barrier = edge_barrier(&source, scale_reference).expect("test image should fit");
        assert!(
            (boundary - edge_scale..=boundary + edge_scale)
                .any(|x| barrier[(40 * source.width() + x) as usize]),
            "fill boundary was missed at scale {scale_reference}"
        );
    }
}

#[test]
fn full_frame_border_preserves_grayscale_fill_and_binary_text() {
    let mut source = GrayImage::from_pixel(700, 700, Luma([245]));
    for y in 0..700 {
        for x in 0..700 {
            if x < 3 || y < 3 || x >= 697 || y >= 697 {
                source.put_pixel(x, y, Luma([25]));
            } else if (120..580).contains(&x) && (160..540).contains(&y) {
                source.put_pixel(x, y, Luma([190]));
            }
        }
    }
    for x in 120..580 {
        source.put_pixel(x, 90, Luma([25]));
    }
    for output in [CleanOutput::Binary, CleanOutput::Grayscale] {
        let result = clean_scan(&source, options(output)).expect("framed page should clean");
        match output {
            CleanOutput::Binary => assert_eq!(result.image.get_pixel(350, 350)[0], 255),
            CleanOutput::Grayscale => assert!(result.image.get_pixel(350, 350)[0] <= 210),
        }
    }
}

#[test]
fn full_frame_border_still_allows_a_smooth_shadow_to_flatten() {
    let mut source = GrayImage::from_fn(700, 700, |x, _| {
        Luma([(245.0 - 55.0 * (x as f32 / 699.0).powi(2)).round() as u8])
    });
    for y in 0..700 {
        for x in 0..700 {
            if x < 3 || y < 3 || x >= 697 || y >= 697 {
                source.put_pixel(x, y, Luma([25]));
            }
        }
    }
    for y in 345..351 {
        for x in 120..580 {
            source.put_pixel(x, y, Luma([25]));
        }
    }

    for output in [CleanOutput::Binary, CleanOutput::Grayscale] {
        let result = clean_scan(&source, options(output)).expect("shadowed frame should clean");
        let width = result.image.width();
        let height = result.image.height();
        let minimum = (height / 12..height * 5 / 12)
            .chain(height * 7 / 12..height * 11 / 12)
            .flat_map(|y| (width / 12..width * 11 / 12).map(move |x| (x, y)))
            .map(|(x, y)| result.image.get_pixel(x, y)[0])
            .min()
            .expect("page interior");
        let expected = match output {
            CleanOutput::Binary => 255,
            CleanOutput::Grayscale => 230,
        };
        assert!(
            minimum >= expected,
            "{output:?} page minimum remained {minimum}"
        );
    }
}

#[test]
fn grayscale_preserves_solid_fills_alongside_text() {
    let mut source = GrayImage::from_pixel(700, 700, Luma([245]));
    for y in 100..220 {
        for x in 100..220 {
            source.put_pixel(x, y, Luma([190]));
        }
    }
    for y in 300..305 {
        for x in 100..250 {
            source.put_pixel(x, y, Luma([30]));
        }
    }
    let result = clean_scan(&source, options(CleanOutput::Grayscale))
        .expect("filled page with text should clean");
    assert!(result.image.get_pixel(160, 160)[0] <= 200);
}

#[test]
fn binary_output_whitens_the_interior_of_a_solid_dark_region() {
    let mut source = GrayImage::from_pixel(300, 300, Luma([255]));
    for y in 100..200 {
        for x in 100..200 {
            source.put_pixel(x, y, Luma([0]));
        }
    }
    let binary = threshold_document(&source, crate::ADAPTIVE_THRESHOLD_OFFSET)
        .expect("test image should fit");
    assert_eq!(binary.get_pixel(150, 150)[0], 255);
}

#[test]
fn expanded_rotation_rejects_an_area_above_the_input_limit() {
    let source = GrayImage::from_pixel(100_000, 400, Luma([255]));

    let result = rotation_geometry(&source, 6.0);

    assert!(matches!(result, Err(UnrecognizedReason::TooLarge)));
}

#[test]
fn implausible_narrow_quad_is_rejected_before_rectification() {
    let mut source = GrayImage::from_pixel(16_000, 1_000, Luma([20]));
    for y in 150_u32..=850 {
        let distance = y.abs_diff(500);
        let half_width = 7_700 * (350 - distance) / 350;
        let start = (8_000 - half_width + y * source.width()) as usize;
        let end = (8_000 + half_width + y * source.width()) as usize;
        source.as_mut()[start..=end].fill(245);
    }

    let expected_quad = [
        (300.0, 500.0),
        (8_000.0, 150.0),
        (15_700.0, 500.0),
        (8_000.0, 850.0),
    ];
    let edge_length = |start: (f32, f32), end: (f32, f32)| {
        ((end.0 - start.0).powi(2) + (end.1 - start.1).powi(2)).sqrt()
    };
    let rectified_width = ((edge_length(expected_quad[0], expected_quad[1])
        + edge_length(expected_quad[3], expected_quad[2]))
        * 0.5)
        .round() as u32;
    let rectified_height = ((edge_length(expected_quad[0], expected_quad[3])
        + edge_length(expected_quad[1], expected_quad[2]))
        * 0.5)
        .round() as u32;
    assert!(
        rectified_width * rectified_height > super::MAX_DIMENSION_AREA,
        "detected rectification is {rectified_width}x{rectified_height}"
    );
    assert!(matches!(
        perspective(&source, expected_quad, rectified_width, rectified_height),
        Err(UnrecognizedReason::TooLarge)
    ));

    assert!(detect_page_quad(&source).is_none());
}

#[test]
fn image_allocations_use_the_bounded_constructor() {
    let source = include_str!("lib.rs");
    assert_eq!(source.matches("GrayImage::from_pixel(").count(), 1);
    for forbidden in [
        "GrayImage::new(",
        "GrayImage::from_fn(",
        "ImageBuffer::new(",
    ] {
        assert!(
            !source.contains(forbidden),
            "raw image allocation {forbidden} must use bounded_image"
        );
    }
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

#[test]
fn extreme_desk_rectangles_do_not_trigger_page_crops() {
    for (width, height) in [(650, 80), (80, 550)] {
        let mut source = GrayImage::from_pixel(800, 700, Luma([35]));
        for y in 75..75 + height {
            for x in 75..75 + width {
                source.put_pixel(x, y, Luma([240]));
            }
        }
        assert!(detect_page_quad(&source).is_none());
    }
}
#[test]
fn equally_supported_pages_are_ambiguous() {
    let mut source = GrayImage::from_pixel(800, 500, Luma([35]));
    for left in [75, 455] {
        for y in 80..420 {
            for x in left..left + 240 {
                source.put_pixel(x, y, Luma([240]));
            }
        }
    }
    for left in [75, 455] {
        for y in (130..350).step_by(30) {
            for x in left + 30..left + 210 {
                source.put_pixel(x, y, Luma([30]));
                source.put_pixel(x, y + 1, Luma([30]));
            }
        }
    }
    assert!(detect_page_quad(&source).is_none());
}
#[test]
fn darker_paper_in_a_wide_bright_scene_is_detected() {
    let mut source = GrayImage::from_pixel(900, 600, Luma([190]));
    for y in 110..490 {
        for x in 315..585 {
            source.put_pixel(x, y, Luma([145]));
        }
    }
    for y in (160..440).step_by(30) {
        for x in 350..550 {
            source.put_pixel(x, y, Luma([30]));
            source.put_pixel(x, y + 1, Luma([30]));
        }
    }
    let quad = detect_page_quad(&source).expect("dark paper boundary should be supported");
    assert!(quad.iter().all(|p| p.0 > 300.0 && p.0 < 600.0));
}
#[test]
fn concave_and_extreme_corner_quads_are_rejected() {
    assert!(
        crate::quad_score(
            crate::geometry_score(
                [(20.0, 20.0), (200.0, 20.0), (90.0, 80.0), (20.0, 200.0)],
                60000.0
            ),
            1.0,
            1.0,
            1.0
        ) < crate::MIN_QUAD_SCORE
    );
    assert!(
        crate::quad_score(
            crate::geometry_score(
                [(20.0, 20.0), (250.0, 20.0), (30.0, 200.0), (20.0, 200.0)],
                60000.0
            ),
            1.0,
            1.0,
            1.0
        ) < crate::MIN_QUAD_SCORE
    );
}
#[test]
fn partial_side_support_cannot_be_replaced_by_strong_corners() {
    let mut source = GrayImage::from_pixel(300, 200, Luma([180]));
    for y in 90..110 {
        for x in 40..110 {
            source.put_pixel(x, y, Luma([30]));
        }
    }
    assert!(crate::side_support(&source, (40.0, 90.0), (260.0, 90.0)) == 0.0);
}

#[test]
fn reduced_curved_contours_are_enclosed_instead_of_cut() {
    let outline = [
        (20.0, 20.0),
        (120.0, 20.0),
        (140.0, 70.0),
        (120.0, 120.0),
        (20.0, 120.0),
        (10.0, 70.0),
    ];
    let quad = crate::enclosing_quad(&outline).expect("convex hull should have an envelope");
    assert!(
        outline
            .iter()
            .all(|point| (0..4).all(|i| cross(quad[i], quad[(i + 1) % 4], *point) >= -0.01))
    );
}
#[test]
fn quiet_low_contrast_and_curved_edges_are_supported_but_gradients_are_not() {
    let curved = GrayImage::from_fn(300, 200, |x, y| {
        let boundary = 85 + (x.abs_diff(150) / 20).pow(2) / 3;
        Luma([if y < boundary { 180 } else { 175 }])
    });
    assert!(crate::side_support(&curved, (30.0, 85.0), (270.0, 85.0)) > 0.7);
    let gradient = GrayImage::from_fn(300, 200, |_, y| Luma([y as u8]));
    assert!(crate::side_support(&gradient, (30.0, 85.0), (270.0, 85.0)) == 0.0);
}

#[test]
fn nearly_blank_clutter_rectangles_do_not_override_content_elsewhere() {
    let mut source = GrayImage::from_pixel(600, 500, Luma([30]));
    for y in 80..420 {
        for x in 100..400 {
            source.put_pixel(x, y, Luma([235]));
        }
    }
    for y in [200, 350] {
        for x in 150..350 {
            source.put_pixel(x, y, Luma([30]));
        }
    }
    assert!(detect_page_quad(&source).is_none());
}
