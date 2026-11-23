//! Bounded HEIC/HEIF preview decoding.
//!
//! Decodes the primary image of a HEIF file coded in HEVC (an iPhone photo:
//! a grid of 512x512 tiles, 8-bit 4:2:0), or the first frame of an image
//! sequence without one, converts it to 8-bit sRGB, and scales it down to a
//! pixel budget. A grid is decoded tile by tile straight into the preview
//! (`tiled.rs`), so its memory is bounded by a tile and the preview, never by
//! the canvas. Every size is checked against the caller's limits from the
//! container before the decoder allocates anything for it.

use heifer::heifer_isobmff::{FourCC, HeifFile, ItemId};

mod tiled;
#[cfg(target_arch = "wasm32")]
mod wasm;

/// Tiles one grid may hold. A 200 MP photo in 512x512 tiles needs about 770.
pub const MAX_GRID_TILES: u32 = 4096;

pub(crate) const RGBA: usize = 4;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Limits {
    /// Pixels an image decoded whole may hold before it is scaled down, and
    /// pixels of each tile of a grid decoded tile by tile.
    pub max_decoded_pixels: u64,
    /// Pixels the canvas of a grid decoded tile by tile may hold. Memory does
    /// not grow with it; decoding time does.
    pub max_canvas_pixels: u64,
    /// Pixels of the returned image: a larger one is scaled down to fit.
    pub max_output_pixels: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Refusal {
    /// The file declares an image above `max_decoded_pixels`, or a grid that
    /// could only be assembled from more pixels than it shows.
    TooLarge,
    /// Not a HEIF file this decoder reads, or a damaged one.
    Unreadable,
}

impl Refusal {
    pub const fn code(self) -> &'static str {
        match self {
            Self::TooLarge => "too-large",
            Self::Unreadable => "unreadable",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Preview {
    pub width: u32,
    pub height: u32,
    /// `width * height * 4` bytes of 8-bit sRGB RGBA, rows top to bottom,
    /// rotation and mirroring already applied.
    pub rgba: Vec<u8>,
}

fn pixels(width: u32, height: u32) -> u64 {
    u64::from(width) * u64::from(height)
}

fn within(width: u32, height: u32, max: u64) -> Result<(), Refusal> {
    if width == 0 || height == 0 {
        return Err(Refusal::Unreadable);
    }
    if pixels(width, height) > max {
        return Err(Refusal::TooLarge);
    }
    Ok(())
}

/// The decoded size a grid commits to, checked before any tile is decoded:
/// its canvas, and tiles that cover it without a whole spare row or column.
fn check_grid(
    file: &HeifFile<'_>,
    id: ItemId,
    canvas_max: u64,
    tile_max: u64,
) -> Result<(), Refusal> {
    let grid = file.grid(id).map_err(|_| Refusal::Unreadable)?;
    within(grid.output_width, grid.output_height, canvas_max)?;
    let columns = u32::from(grid.columns);
    let rows = u32::from(grid.rows);
    if columns * rows > MAX_GRID_TILES {
        return Err(Refusal::TooLarge);
    }
    let tiles = file.referenced_items(id, b"dimg");
    if u32::try_from(tiles.len()).map_or(true, |count| count != columns * rows) {
        return Err(Refusal::Unreadable);
    }
    for &tile in tiles {
        let (tile_width, tile_height) = file
            .image_size(tile)
            .map_err(|_| Refusal::Unreadable)?
            .ok_or(Refusal::Unreadable)?;
        within(tile_width, tile_height, tile_max)?;
        let covered_width = u64::from(tile_width) * u64::from(columns);
        let covered_height = u64::from(tile_height) * u64::from(rows);
        if covered_width < u64::from(grid.output_width)
            || covered_height < u64::from(grid.output_height)
        {
            return Err(Refusal::Unreadable);
        }
        if covered_width >= u64::from(grid.output_width) + u64::from(tile_width)
            || covered_height >= u64::from(grid.output_height) + u64::from(tile_height)
        {
            return Err(Refusal::TooLarge);
        }
    }
    Ok(())
}

/// The primary image's declared size, checked against `max`.
fn check_primary(file: &HeifFile<'_>, max: u64) -> Result<(), Refusal> {
    let id = file.primary_id;
    let item = file.item(id).map_err(|_| Refusal::Unreadable)?;
    if item.item_type == FourCC(*b"grid") {
        return check_grid(file, id, max, max);
    }
    match file.image_size(id).map_err(|_| Refusal::Unreadable)? {
        Some((width, height)) => within(width, height, max),
        // Without `ispe`, the decoder's own limit bounds the coded picture.
        None => Ok(()),
    }
}

pub(crate) fn options(limits: Limits) -> heifer::Options {
    heifer::Options::new()
        .with_max_threads(1)
        .with_max_pixels(limits.max_decoded_pixels.max(1))
}

/// The primary image in sRGB, or in its own colour space when that cannot be
/// converted (an HDR transfer, a non-RGB ICC profile): a preview with
/// slightly wrong colours beats none.
fn decode_primary(bytes: &[u8], limits: Limits) -> Result<heifer::Image<u8>, Refusal> {
    let file = HeifFile::parse(bytes).map_err(|_| Refusal::Unreadable)?;
    check_primary(&file, limits.max_decoded_pixels)?;
    drop(file);
    match heifer::decode_srgb_rgba8(bytes, &options(limits)) {
        Ok(image) => Ok(image),
        Err(heifer::Error::Unsupported(_)) => {
            heifer::decode_rgba8(bytes, &options(limits)).map_err(|_| Refusal::Unreadable)
        }
        Err(_) => Err(Refusal::Unreadable),
    }
}

/// The first frame of an image sequence (`image/heic-sequence`) that has no
/// still primary image.
fn decode_first_frame(bytes: &[u8], limits: Limits) -> Result<heifer::Image<u8>, Refusal> {
    let sequence = heifer::read_sequence(bytes)
        .map_err(|_| Refusal::Unreadable)?
        .ok_or(Refusal::Unreadable)?;
    within(sequence.width, sequence.height, limits.max_decoded_pixels)?;
    let frame = heifer::decode_sequence_frame_with_options(bytes, 0, &options(limits))
        .map_err(|_| Refusal::Unreadable)?;
    Ok(heifer::Image {
        width: frame.width,
        height: frame.height,
        bit_depth: 8,
        has_alpha: frame.has_alpha,
        data: frame.to_rgba8(),
    })
}

/// The largest size with the same aspect ratio within `max` pixels, never
/// below one pixel a side.
pub(crate) fn fitted_size(width: u32, height: u32, max: u64) -> (u32, u32) {
    if pixels(width, height) <= max {
        return (width, height);
    }
    #[allow(clippy::cast_precision_loss)]
    let scale = (max as f64 / pixels(width, height) as f64).sqrt();
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let fit = |side: u32| ((f64::from(side) * scale).floor() as u32).clamp(1, side);
    let cap = |side: u32| u32::try_from(max.min(u64::from(side))).unwrap_or(side);
    match (fit(width), fit(height)) {
        // A side rounded up to one pixel leaves the other the whole budget.
        (1, _) => (1, cap(height)),
        (_, 1) => (cap(width), 1),
        fitted => fitted,
    }
}

/// Area-average resampling along one axis: each output sample is the mean of
/// the input samples its span covers, partial ones by the share covered.
/// `lines` lines of `from` samples (`stride` apart, `step` between samples)
/// become lines of `to` samples.
struct Axis {
    from: u32,
    to: u32,
}

impl Axis {
    /// For each output sample: the first input sample and the weights (in
    /// 1/65536 of the span) of the samples it covers.
    fn spans(&self) -> Vec<(usize, Vec<u32>)> {
        let from = u64::from(self.from);
        let to = u64::from(self.to);
        (0..to)
            .map(|index| {
                // Positions in units of 1/to of an input sample.
                let start = index * from;
                let end = start + from;
                let first = start / to;
                let last = (end - 1) / to;
                let weights = (first..=last)
                    .map(|sample| {
                        let covered = end.min((sample + 1) * to) - start.max(sample * to);
                        u32::try_from(covered * 65_536 / from).unwrap_or(u32::MAX)
                    })
                    .collect();
                (usize::try_from(first).unwrap_or(usize::MAX), weights)
            })
            .collect()
    }
}

fn resample_rows(rgba: &[u8], width: u32, height: u32, to_width: u32) -> Vec<u8> {
    let spans = Axis {
        from: width,
        to: to_width,
    }
    .spans();
    let (width, height, to_width) = (width as usize, height as usize, to_width as usize);
    let mut out = vec![0u8; to_width * height * RGBA];
    for row in 0..height {
        let line = &rgba[row * width * RGBA..(row + 1) * width * RGBA];
        let target = &mut out[row * to_width * RGBA..(row + 1) * to_width * RGBA];
        for (column, (first, weights)) in spans.iter().enumerate() {
            for channel in 0..RGBA {
                let sum: u64 = weights
                    .iter()
                    .enumerate()
                    .map(|(offset, &weight)| {
                        u64::from(line[(first + offset) * RGBA + channel]) * u64::from(weight)
                    })
                    .sum();
                let total: u64 = weights.iter().map(|&weight| u64::from(weight)).sum();
                target[column * RGBA + channel] =
                    u8::try_from((sum + total / 2) / total.max(1)).unwrap_or(u8::MAX);
            }
        }
    }
    out
}

fn resample_columns(rgba: &[u8], width: u32, height: u32, to_height: u32) -> Vec<u8> {
    let spans = Axis {
        from: height,
        to: to_height,
    }
    .spans();
    let (width, to_height) = (width as usize, to_height as usize);
    let stride = width * RGBA;
    let mut out = vec![0u8; stride * to_height];
    for (row, (first, weights)) in spans.iter().enumerate() {
        let total: u64 = weights.iter().map(|&weight| u64::from(weight)).sum();
        for offset in 0..stride {
            let sum: u64 = weights
                .iter()
                .enumerate()
                .map(|(index, &weight)| {
                    u64::from(rgba[(first + index) * stride + offset]) * u64::from(weight)
                })
                .sum();
            out[row * stride + offset] =
                u8::try_from((sum + total / 2) / total.max(1)).unwrap_or(u8::MAX);
        }
    }
    out
}

/// `rgba` scaled down to fit `max` pixels, or as it is when it fits.
pub fn fit_rgba(rgba: Vec<u8>, width: u32, height: u32, max: u64) -> Preview {
    let (to_width, to_height) = fitted_size(width, height, max);
    if (to_width, to_height) == (width, height) {
        return Preview {
            width,
            height,
            rgba,
        };
    }
    let rows = resample_rows(&rgba, width, height, to_width);
    drop(rgba);
    Preview {
        width: to_width,
        height: to_height,
        rgba: resample_columns(&rows, to_width, height, to_height),
    }
}

/// Decodes the image a HEIF file shows (its primary image, or the first
/// frame of a sequence without one) to 8-bit sRGB RGBA within `limits`.
pub fn decode_preview(bytes: &[u8], limits: Limits) -> Result<Preview, Refusal> {
    if let Ok(file) = HeifFile::parse(bytes) {
        let primary = file.primary_id;
        let is_grid = file
            .item(primary)
            .is_ok_and(|item| item.item_type == FourCC(*b"grid"));
        if is_grid && tiled::streamable(&file, primary) {
            check_grid(
                &file,
                primary,
                limits.max_canvas_pixels,
                limits.max_decoded_pixels,
            )?;
            return tiled::decode_grid_preview(&file, primary, limits);
        }
    }
    let image = match decode_primary(bytes, limits) {
        Err(Refusal::Unreadable) if heifer::read_sequence(bytes).is_ok_and(|s| s.is_some()) => {
            decode_first_frame(bytes, limits)?
        }
        other => other?,
    };
    let expected = usize::try_from(pixels(image.width, image.height))
        .ok()
        .and_then(|count| count.checked_mul(RGBA));
    if image.width == 0 || image.height == 0 || expected != Some(image.data.len()) {
        return Err(Refusal::Unreadable);
    }
    Ok(fit_rgba(
        image.data,
        image.width,
        image.height,
        limits.max_output_pixels.max(1),
    ))
}

#[cfg(test)]
mod tests;
