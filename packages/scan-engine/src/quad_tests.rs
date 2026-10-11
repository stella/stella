use image::{GrayImage, Luma};

use crate::{MIN_QUAD_SCORE, detect_page_quad, geometry_score, quad_score};

#[test]
fn quad_evidence_combines_continuously_and_missing_evidence_cannot_pass() {
    assert!(quad_score(1.0, 0.65, 0.90, 0.70) >= MIN_QUAD_SCORE);
    assert!(quad_score(1.0, 0.30, 0.70, 0.40) < MIN_QUAD_SCORE);
    for missing in 0..4 {
        let mut evidence = [1.0; 4];
        evidence[missing] = 0.0;
        assert_eq!(
            quad_score(evidence[0], evidence[1], evidence[2], evidence[3]),
            0.0
        );
    }
    assert!(quad_score(1.0, 0.75, 0.9, 0.5) < quad_score(1.0, 0.8, 0.9, 0.5));
}

#[test]
fn projective_departures_reduce_geometry_confidence_without_a_hard_angle_cutoff() {
    let square = [(20.0, 20.0), (180.0, 20.0), (180.0, 240.0), (20.0, 240.0)];
    let perspective = [(20.0, 20.0), (180.0, 20.0), (80.0, 240.0), (20.0, 240.0)];
    assert_eq!(geometry_score(square, 100_000.0), 1.0);
    assert!(geometry_score(perspective, 100_000.0) > 0.0);
    assert!(geometry_score(perspective, 100_000.0) < geometry_score(square, 100_000.0));
}

#[test]
fn distant_bright_screen_does_not_veto_a_supported_page() {
    let mut source = GrayImage::from_pixel(600, 600, Luma([35]));
    for y in 60..340 {
        for x in 200..400 {
            source.put_pixel(x, y, Luma([240]));
        }
    }
    for y in (100..300).step_by(30) {
        for x in 230..370 {
            source.put_pixel(x, y, Luma([30]));
            source.put_pixel(x, y + 1, Luma([30]));
        }
    }
    let control = detect_page_quad(&source).expect("supported control page");
    for y in 500..560 {
        for x in 240..360 {
            source.put_pixel(x, y, Luma([240]));
        }
    }
    for y in (512..548).step_by(6) {
        for x in 252..348 {
            source.put_pixel(x, y, Luma([30]));
        }
    }
    let quad = detect_page_quad(&source).expect("distant screen is outside the page context");
    assert_eq!(quad, control);
}

#[test]
fn page_relative_brightness_excludes_texture_below_the_paper_tolerance() {
    let mut source = GrayImage::from_pixel(800, 800, Luma([145]));
    for y in (20..780).step_by(12) {
        for x in 20..780 {
            source.put_pixel(x, y, Luma([95]));
        }
    }
    for y in 280..510 {
        for x in 320..480 {
            source.put_pixel(x, y, Luma([205]));
        }
    }
    for y in (315..480).step_by(25) {
        for x in 345..455 {
            source.put_pixel(x, y, Luma([60]));
            source.put_pixel(x, y + 1, Luma([60]));
        }
    }
    let quad = detect_page_quad(&source).expect("dim textured scene must not veto a bright page");
    assert!(
        quad.iter()
            .all(|p| p.0 > 300.0 && p.0 < 500.0 && p.1 > 260.0 && p.1 < 530.0)
    );
}

#[test]
fn frame_connected_scene_rectangle_cannot_override_an_interior_page() {
    let mut source = GrayImage::from_pixel(600, 600, Luma([35]));
    for y in 0..540 {
        for x in 0..450 {
            source.put_pixel(x, y, Luma([180]));
        }
    }
    for y in (30..510).step_by(25) {
        for x in 20..430 {
            source.put_pixel(x, y, Luma([155]));
        }
    }
    for y in 140..380 {
        for x in 160..320 {
            source.put_pixel(x, y, Luma([240]));
        }
    }
    for y in (180..350).step_by(25) {
        for x in 180..300 {
            source.put_pixel(x, y, Luma([30]));
            source.put_pixel(x, y + 1, Luma([30]));
        }
    }
    let quad = detect_page_quad(&source).expect("interior page remains supported");
    assert!(
        quad.iter()
            .all(|p| p.0 > 140.0 && p.0 < 340.0 && p.1 > 120.0 && p.1 < 400.0)
    );
}

#[test]
fn a_crop_cannot_discard_dominant_distant_printed_evidence_as_scene_clutter() {
    let mut source = GrayImage::from_pixel(600, 600, Luma([35]));
    for y in 300..580 {
        for x in 200..400 {
            source.put_pixel(x, y, Luma([245]));
        }
    }
    for y in [340, 420, 500] {
        for x in 230..370 {
            source.put_pixel(x, y, Luma([30]));
            source.put_pixel(x, y + 1, Luma([30]));
        }
    }
    assert!(
        detect_page_quad(&source).is_some(),
        "control candidate must be recognized"
    );
    for y in 40..85 {
        for x in 150..450 {
            source.put_pixel(x, y, Luma([245]));
        }
    }
    for y in (45..80).step_by(5) {
        for x in 160..440 {
            source.put_pixel(x, y, Luma([30]));
            source.put_pixel(x, y + 1, Luma([30]));
        }
    }
    assert!(
        detect_page_quad(&source).is_none(),
        "most printed evidence is outside the page context"
    );
}

#[test]
fn dim_print_beside_a_crop_is_not_hidden_by_bright_page_reference() {
    let mut source = GrayImage::from_pixel(600, 600, Luma([35]));
    for y in 100..500 {
        for x in 100..400 {
            source.put_pixel(x, y, Luma([if x < 170 { 200 } else { 240 }]));
        }
    }
    for y in (140..460).step_by(30) {
        for x in 120..380 {
            source.put_pixel(x, y, Luma([60]));
            source.put_pixel(x, y + 1, Luma([60]));
        }
    }
    let complete = [(99.0, 99.0), (400.0, 99.0), (400.0, 500.0), (99.0, 500.0)];
    let clipped = [(170.0, 99.0), (400.0, 99.0), (400.0, 500.0), (170.0, 500.0)];
    assert!(crate::SourceContentEvidence::new(&source).retains(complete));
    assert!(!crate::SourceContentEvidence::new(&source).retains(clipped));
}

#[test]
fn curved_sheet_recovers_an_enclosing_boundary_when_tight_corners_cut_print() {
    let mut source = GrayImage::from_pixel(600, 600, Luma([35]));
    for y in 70_u32..530 {
        let left = 135 + y.abs_diff(300) / 23;
        for x in left..450 {
            source.put_pixel(x, y, Luma([240]));
        }
    }
    for y in (110..500).step_by(20) {
        for x in 170..420 {
            source.put_pixel(x, y, Luma([40]));
            source.put_pixel(x, y + 1, Luma([40]));
        }
    }
    for y in (280..320).step_by(4) {
        for x in 138..160 {
            source.put_pixel(x, y, Luma([40]));
        }
    }
    assert!(crate::detect_page_quad_with_budget(&source, 0).is_none());
    let quad = detect_page_quad(&source).expect("curved complete sheet must remain detectable");
    for y in (280..320).step_by(4) {
        assert!((0..4).all(|i| crate::cross(quad[i], quad[(i + 1) % 4], (138.0, y as f32)) >= 0.0));
    }
}

#[test]
fn enclosure_confidence_penalizes_scene_extensions_without_penalizing_dark_paper() {
    let mut source = GrayImage::from_pixel(400, 400, Luma([35]));
    for y in 80..320 {
        for x in 120..280 {
            source.put_pixel(x, y, Luma([240]));
        }
    }
    let page = [(120.0, 80.0), (279.0, 80.0), (279.0, 319.0), (120.0, 319.0)];
    let scene = [(40.0, 40.0), (359.0, 40.0), (359.0, 359.0), (40.0, 359.0)];
    assert!(crate::paper_coverage(&source, page) > 0.99);
    assert!(crate::paper_coverage(&source, scene) < 0.5);
    let mut dark = GrayImage::from_pixel(400, 400, Luma([240]));
    for y in 80..320 {
        for x in 120..280 {
            dark.put_pixel(x, y, Luma([80]));
        }
    }
    for y in (110..300).step_by(20) {
        for x in 145..255 {
            dark.put_pixel(x, y, Luma([20]));
        }
    }
    assert!(crate::paper_coverage(&dark, page) > 0.99);
}
