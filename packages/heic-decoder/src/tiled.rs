//! A grid photo decoded tile by tile into its preview.
//!
//! Each tile is decoded on its own (as a one-image file that carries the
//! primary image's colour information, so the decoder converts it to sRGB
//! exactly as it would the whole photo) and averaged straight into the
//! preview's pixels. What is held at once is one tile, the rows of the
//! preview its tile row reaches, and the preview: never the full canvas, so
//! a 48 MP photo costs about what a 12 MP one does.

use std::collections::VecDeque;

use heifer::heifer_isobmff::boxes::{ColorInfo, Property};
use heifer::heifer_isobmff::writer::{HeifWriter, ImageSpec};
use heifer::heifer_isobmff::{FourCC, HeifFile, ItemId};

use crate::{Limits, Preview, RGBA, Refusal, fitted_size, options};

/// One tile's coded picture, ready to be written as an image of its own.
struct CodedTile {
    width: u32,
    height: u32,
    config: heifer::heifer_isobmff::boxes::HevcConfig,
    slices: Vec<Vec<u8>>,
}

fn coded_tile(file: &HeifFile<'_>, id: ItemId) -> Result<CodedTile, Refusal> {
    let unreadable = |_| Refusal::Unreadable;
    let item = file.item(id).map_err(unreadable)?;
    if item.item_type != FourCC(*b"hvc1") {
        return Err(Refusal::Unreadable);
    }
    let (width, height) = file
        .image_size(id)
        .map_err(unreadable)?
        .ok_or(Refusal::Unreadable)?;
    let mut config = file
        .hevc_config(id)
        .map_err(unreadable)?
        .ok_or(Refusal::Unreadable)?
        .clone();
    let length_size = usize::from(config.nal_length_size);
    if !(1..=4).contains(&length_size) {
        return Err(Refusal::Unreadable);
    }
    let data = file.item_data(id).map_err(unreadable)?;
    let mut slices = Vec::new();
    let mut offset = 0;
    while offset < data.len() {
        let header = data
            .get(offset..offset + length_size)
            .ok_or(Refusal::Unreadable)?;
        let length = header
            .iter()
            .fold(0usize, |value, &byte| (value << 8) | usize::from(byte));
        offset += length_size;
        let nal = data
            .get(offset..offset + length)
            .ok_or(Refusal::Unreadable)?;
        slices.push(nal.to_vec());
        offset += length;
    }
    // The writer frames every unit with a 4-byte length.
    config.nal_length_size = 4;
    Ok(CodedTile {
        width,
        height,
        config,
        slices,
    })
}

/// The colour information the whole photo is converted from: its ICC profile,
/// else the `nclx` of the grid or of its first tile, else none (the decoder
/// then reads the HEVC stream's own).
fn photo_colour(file: &HeifFile<'_>, grid: ItemId, first_tile: ItemId) -> Option<ColorInfo> {
    if let Ok(Some(icc)) = file.icc_profile(grid) {
        return Some(ColorInfo::Icc(icc.to_vec()));
    }
    [grid, first_tile].into_iter().find_map(|id| {
        file.item_properties(id)
            .ok()?
            .find_map(|property| match property {
                Property::Color(colour @ ColorInfo::Nclx { .. }) => Some(colour.clone()),
                _ => None,
            })
    })
}

/// A tile decoded to 8-bit sRGB RGBA, with its alpha plane when it has one.
fn decode_tile(
    tile: &CodedTile,
    alpha: Option<&CodedTile>,
    colour: Option<&ColorInfo>,
    limits: Limits,
) -> Result<heifer::Image<u8>, Refusal> {
    let mut writer = HeifWriter::new();
    let image = writer.add_image(&ImageSpec {
        color: colour.cloned(),
        ..ImageSpec::new(tile.width, tile.height, tile.config.clone(), &tile.slices)
    });
    if let Some(alpha) = alpha {
        writer.add_alpha(
            image,
            &ImageSpec::new(
                alpha.width,
                alpha.height,
                alpha.config.clone(),
                &alpha.slices,
            ),
        );
    }
    let file = writer.finish();
    match heifer::decode_srgb_rgba8(&file, &options(limits)) {
        Ok(decoded) => Ok(decoded),
        Err(heifer::Error::Unsupported(_)) => {
            heifer::decode_rgba8(&file, &options(limits)).map_err(|_| Refusal::Unreadable)
        }
        Err(_) => Err(Refusal::Unreadable),
    }
}

/// For each source position along one axis, the (at most two) preview
/// positions it falls in, with the length of the overlap. Positions are
/// measured in units where a source pixel is `to` long and a preview pixel
/// `from` long, so every preview pixel gathers exactly `from` of overlap.
fn axis_map(from: u32, to: u32) -> Vec<[(u32, u64); 2]> {
    let (from, to) = (u64::from(from), u64::from(to));
    (0..from)
        .map(|source| {
            let (start, end) = (source * to, (source + 1) * to);
            let first = start / from;
            let overlap = |target: u64| {
                end.min((target + 1) * from)
                    .saturating_sub(start.max(target * from))
            };
            let second = first + 1;
            let narrow = |value: u64| u32::try_from(value).unwrap_or(u32::MAX);
            [
                (narrow(first), overlap(first)),
                (
                    narrow(second),
                    if second < to { overlap(second) } else { 0 },
                ),
            ]
        })
        .collect()
}

/// Sums of `overlap x overlap x sample` for the preview rows a band of source
/// rows reaches, finished row by row once no later source row reaches them.
struct Band {
    width: usize,
    /// The preview row `rows[0]` holds.
    first: u32,
    rows: VecDeque<Vec<u64>>,
}

impl Band {
    fn row(&mut self, target: u32) -> &mut [u64] {
        let index = (target - self.first) as usize;
        while self.rows.len() <= index {
            self.rows.push_back(vec![0; self.width * RGBA]);
        }
        &mut self.rows[index]
    }

    /// Moves the finished rows before `next` into `out` as averages.
    fn finish_before(&mut self, next: u32, total: u64, out: &mut Vec<u8>) {
        while self.first < next {
            let row = self
                .rows
                .pop_front()
                .unwrap_or_else(|| vec![0; self.width * RGBA]);
            out.extend(
                row.iter()
                    .map(|&sum| u8::try_from((sum + total / 2) / total).unwrap_or(u8::MAX)),
            );
            self.first += 1;
        }
    }
}

/// The rotation and mirroring of the grid item, applied to the preview.
fn transformed(file: &HeifFile<'_>, grid: ItemId, preview: Preview) -> Result<Preview, Refusal> {
    let mut image = heifer::Image::<u8> {
        width: preview.width,
        height: preview.height,
        bit_depth: 8,
        has_alpha: true,
        data: preview.rgba,
    };
    for property in file
        .item_properties(grid)
        .map_err(|_| Refusal::Unreadable)?
    {
        image = match *property {
            Property::Rotation(0) => image,
            Property::Rotation(quarters) => image.rotate_ccw(quarters),
            Property::Mirror(top_bottom) => image.mirror(top_bottom),
            _ => image,
        };
    }
    Ok(Preview {
        width: image.width,
        height: image.height,
        rgba: image.data,
    })
}

/// Whether the grid can be previewed tile by tile: no crop of the assembled
/// canvas (`clap`), and an alpha plane, if any, laid out as the grid is.
pub(crate) fn streamable(file: &HeifFile<'_>, grid: ItemId) -> bool {
    let cropped = file.item_properties(grid).is_ok_and(|mut properties| {
        properties.any(|property| matches!(property, Property::CleanAperture { .. }))
    });
    !cropped && alpha_tiles(file, grid).is_ok()
}

/// The alpha plane's tiles, matching the grid's one for one, or none.
fn alpha_tiles(file: &HeifFile<'_>, grid: ItemId) -> Result<Option<Vec<ItemId>>, Refusal> {
    let Some(&alpha) = file
        .auxiliary_items(grid)
        .iter()
        .find(|&&id| is_alpha(file, id))
    else {
        return Ok(None);
    };
    let (Ok(colour_grid), Ok(alpha_grid)) = (file.grid(grid), file.grid(alpha)) else {
        return Err(Refusal::Unreadable);
    };
    let tiles = file.referenced_items(alpha, b"dimg");
    if (colour_grid.rows, colour_grid.columns) != (alpha_grid.rows, alpha_grid.columns)
        || tiles.len() != file.referenced_items(grid, b"dimg").len()
    {
        return Err(Refusal::Unreadable);
    }
    Ok(Some(tiles.to_vec()))
}

/// `auxC` types of alpha planes: MPEG-B (what phones write) and HEVC.
const ALPHA_URNS: [&str; 2] = [
    "urn:mpeg:mpegB:cicp:systems:auxiliary:alpha",
    "urn:mpeg:hevc:2015:auxid:1",
];

fn is_alpha(file: &HeifFile<'_>, id: ItemId) -> bool {
    file.item_properties(id).is_ok_and(|mut properties| {
        properties.any(|property| {
            matches!(property, Property::AuxiliaryType(urn) if ALPHA_URNS.contains(&urn.as_str()))
        })
    })
}

/// The grid photo `grid` as a preview of at most `limits.max_output_pixels`,
/// its layout already checked by `check_grid`.
pub(crate) fn decode_grid_preview(
    file: &HeifFile<'_>,
    grid: ItemId,
    limits: Limits,
) -> Result<Preview, Refusal> {
    let layout = file.grid(grid).map_err(|_| Refusal::Unreadable)?;
    let tiles = file.referenced_items(grid, b"dimg").to_vec();
    let alphas = alpha_tiles(file, grid)?;
    let first_tile = *tiles.first().ok_or(Refusal::Unreadable)?;
    let colour = photo_colour(file, grid, first_tile);
    let (canvas_width, canvas_height) = (layout.output_width, layout.output_height);
    let (width, height) = fitted_size(canvas_width, canvas_height, limits.max_output_pixels);
    let xs = axis_map(canvas_width, width);
    let ys = axis_map(canvas_height, height);
    let total = u64::from(canvas_width) * u64::from(canvas_height);
    let columns = usize::from(layout.columns);
    let mut band = Band {
        width: width as usize,
        first: 0,
        rows: VecDeque::new(),
    };
    let mut out = Vec::with_capacity(width as usize * height as usize * RGBA);
    let mut top = 0u32;
    for (index, &tile_id) in tiles.iter().enumerate() {
        let tile = coded_tile(file, tile_id)?;
        let alpha = match &alphas {
            Some(alphas) => Some(coded_tile(file, alphas[index])?),
            None => None,
        };
        let decoded = decode_tile(&tile, alpha.as_ref(), colour.as_ref(), limits)?;
        if (decoded.width, decoded.height) != (tile.width, tile.height) {
            return Err(Refusal::Unreadable);
        }
        let column = u32::try_from(index % columns).map_err(|_| Refusal::Unreadable)?;
        let row = u32::try_from(index / columns).map_err(|_| Refusal::Unreadable)?;
        let (left, tile_top) = (column * tile.width, row * tile.height);
        if column == 0 && tile_top > top {
            // Every source row above this tile row has been added.
            top = tile_top;
            let next = ys
                .get(top as usize)
                .map_or(height, |&[(first, _), _]| first);
            band.finish_before(next, total, &mut out);
        }
        for y in 0..tile.height {
            let source_y = tile_top + y;
            let Some(&y_targets) = ys.get(source_y as usize) else {
                break;
            };
            let line =
                &decoded.data[(y * tile.width) as usize * RGBA..][..tile.width as usize * RGBA];
            for (target_y, weight_y) in y_targets {
                if weight_y == 0 {
                    continue;
                }
                let target = band.row(target_y);
                for x in 0..tile.width {
                    let Some(&x_targets) = xs.get((left + x) as usize) else {
                        break;
                    };
                    let pixel = &line[x as usize * RGBA..][..RGBA];
                    for (target_x, weight_x) in x_targets {
                        if weight_x == 0 {
                            continue;
                        }
                        let weight = weight_x * weight_y;
                        let sums = &mut target[target_x as usize * RGBA..][..RGBA];
                        for (sum, &sample) in sums.iter_mut().zip(pixel) {
                            *sum += weight * u64::from(sample);
                        }
                    }
                }
            }
        }
    }
    band.finish_before(height, total, &mut out);
    transformed(
        file,
        grid,
        Preview {
            width,
            height,
            rgba: out,
        },
    )
}
