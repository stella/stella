use image::{GrayImage, Luma};
use imageproc::geometric_transformations::{Border, Interpolation, rotate_about_center};

use crate::{
    CleanOptions, CleanOutput, UnrecognizedReason, clean_scan, content_bounds, deskew_angle,
    perspective,
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
