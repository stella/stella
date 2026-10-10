use image::{GrayImage, Luma};
use imageproc::geometric_transformations::{Border, Interpolation, rotate_about_center};

use crate::{
    CleanOptions, CleanOutput, UnrecognizedReason, clean_scan, content_bounds, deskew_angle,
    detect_page_quad, perspective, rgba_to_gray,
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
