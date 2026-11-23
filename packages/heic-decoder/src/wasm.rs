use wasm_bindgen::prelude::*;

use crate::{Limits, Refusal, decode_preview};

#[wasm_bindgen]
pub struct WasmHeicPreview {
    status: &'static str,
    width: u32,
    height: u32,
    rgba: Vec<u8>,
}

#[wasm_bindgen]
impl WasmHeicPreview {
    /// `decoded`, or the refusal: `too-large` or `unreadable`.
    #[wasm_bindgen(getter)]
    pub fn status(&self) -> String {
        self.status.to_owned()
    }

    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.width
    }

    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.height
    }

    /// The pixels, moved out: a second call returns none.
    pub fn take_rgba(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.rgba)
    }
}

fn refused(refusal: Refusal) -> WasmHeicPreview {
    WasmHeicPreview {
        status: refusal.code(),
        width: 0,
        height: 0,
        rgba: Vec::new(),
    }
}

/// Pixel limits are passed as `f64` (JavaScript numbers) and must be whole
/// and positive; anything else is a caller defect.
#[wasm_bindgen]
pub fn decode_heic_preview(
    bytes: &[u8],
    max_decoded_pixels: f64,
    max_canvas_pixels: f64,
    max_output_pixels: f64,
) -> Result<WasmHeicPreview, JsValue> {
    let limit = |value: f64| {
        if value.is_finite() && value >= 1.0 && value.fract() == 0.0 && value <= 9.0e15 {
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            Ok(value as u64)
        } else {
            Err(JsValue::from_str("pixel limits must be positive integers"))
        }
    };
    let limits = Limits {
        max_decoded_pixels: limit(max_decoded_pixels)?,
        max_canvas_pixels: limit(max_canvas_pixels)?,
        max_output_pixels: limit(max_output_pixels)?,
    };
    Ok(match decode_preview(bytes, limits) {
        Ok(preview) => WasmHeicPreview {
            status: "decoded",
            width: preview.width,
            height: preview.height,
            rgba: preview.rgba,
        },
        Err(refusal) => refused(refusal),
    })
}
