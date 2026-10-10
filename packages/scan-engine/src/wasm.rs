use image::GrayImage;
use wasm_bindgen::prelude::*;

use crate::{CleanOptions, CleanOutput, UnrecognizedReason, clean_scan, gray_image};

#[wasm_bindgen]
pub struct WasmScanResult {
    status: &'static str,
    reason: &'static str,
    pixels: Vec<u8>,
    width: u32,
    height: u32,
    skew_degrees: f32,
    content_box: Vec<u32>,
    applied_quad: Vec<f32>,
}

#[wasm_bindgen]
impl WasmScanResult {
    #[wasm_bindgen(getter)]
    pub fn status(&self) -> String {
        self.status.to_owned()
    }

    #[wasm_bindgen(getter)]
    pub fn reason(&self) -> String {
        self.reason.to_owned()
    }

    #[wasm_bindgen(getter)]
    pub fn pixels(&self) -> Vec<u8> {
        self.pixels.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.width
    }

    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.height
    }

    #[wasm_bindgen(getter)]
    pub fn skew_degrees(&self) -> f32 {
        self.skew_degrees
    }

    #[wasm_bindgen(getter)]
    pub fn content_box(&self) -> Vec<u32> {
        self.content_box.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn applied_quad(&self) -> Vec<f32> {
        self.applied_quad.clone()
    }
}

fn unrecognized(reason: UnrecognizedReason) -> WasmScanResult {
    WasmScanResult {
        status: "unrecognized",
        reason: reason.code(),
        pixels: Vec::new(),
        width: 0,
        height: 0,
        skew_degrees: 0.0,
        content_box: Vec::new(),
        applied_quad: Vec::new(),
    }
}

fn rgba_to_gray(width: u32, height: u32, pixels: &[u8]) -> Result<GrayImage, UnrecognizedReason> {
    let expected = width
        .checked_mul(height)
        .and_then(|count| count.checked_mul(4))
        .and_then(|count| usize::try_from(count).ok())
        .ok_or(UnrecognizedReason::InvalidDimensions)?;
    if pixels.len() != expected {
        return Err(UnrecognizedReason::InvalidPixelBuffer);
    }
    let gray = pixels
        .chunks_exact(4)
        .map(|pixel| {
            let luminance = 0.2126 * f32::from(pixel[0])
                + 0.7152 * f32::from(pixel[1])
                + 0.0722 * f32::from(pixel[2]);
            luminance.round() as u8
        })
        .collect::<Vec<_>>();
    gray_image(width, height, &gray)
}

#[wasm_bindgen]
pub fn clean_scan_rgba(
    width: u32,
    height: u32,
    pixels: &[u8],
    dpi: f32,
    output: &str,
    content_crop: bool,
    deskew: bool,
) -> Result<WasmScanResult, JsValue> {
    let output = match output {
        "grayscale" => CleanOutput::Grayscale,
        "binary" => CleanOutput::Binary,
        _ => return Err(JsValue::from_str("invalid output mode")),
    };
    let gray = match rgba_to_gray(width, height, pixels) {
        Ok(gray) => gray,
        Err(reason) => return Ok(unrecognized(reason)),
    };
    match clean_scan(
        &gray,
        CleanOptions {
            output,
            content_crop,
            deskew,
            dpi,
        },
    ) {
        Ok(cleaned) => Ok(WasmScanResult {
            status: "cleaned",
            reason: "",
            width: cleaned.image.width(),
            height: cleaned.image.height(),
            pixels: cleaned.image.into_raw(),
            skew_degrees: cleaned.skew_degrees,
            content_box: vec![
                cleaned.content_box.x,
                cleaned.content_box.y,
                cleaned.content_box.width,
                cleaned.content_box.height,
            ],
            applied_quad: cleaned
                .applied_quad
                .map(|quad| {
                    quad.into_iter()
                        .flat_map(|point| [point.0, point.1])
                        .collect()
                })
                .unwrap_or_default(),
        }),
        Err(reason) => Ok(unrecognized(reason)),
    }
}
