use std::panic::{AssertUnwindSafe, catch_unwind};

use heifer::heifer_isobmff::HeifFile;
use heifer::heifer_isobmff::writer::{HeifWriter, ImageSpec};

use crate::{Limits, MAX_GRID_TILES, Preview, Refusal, decode_preview, fit_rgba};

const SEED: u64 = 0x4845_4943_0000_0001;
const MUTATIONS: usize = 400;

const GENEROUS: Limits = Limits {
    max_decoded_pixels: 50_000_000,
    max_canvas_pixels: 50_000_000,
    max_output_pixels: 50_000_000,
};

struct Generator(u64);

impl Generator {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn below(&mut self, bound: usize) -> usize {
        usize::try_from(self.next() % u64::try_from(bound.max(1)).unwrap_or(1)).unwrap_or(0)
    }
}

/// A smooth synthetic picture: red across, green down, blue a diagonal band.
fn picture(width: u32, height: u32) -> Vec<u8> {
    let mut rgba = Vec::with_capacity((width * height) as usize * 4);
    for y in 0..height {
        for x in 0..width {
            let red = u8::try_from(x * 255 / width.max(2).saturating_sub(1).max(1)).unwrap_or(255);
            let green =
                u8::try_from(y * 255 / height.max(2).saturating_sub(1).max(1)).unwrap_or(255);
            let blue = u8::try_from((x + y) * 255 / (width + height)).unwrap_or(255);
            rgba.extend_from_slice(&[red, green, blue, 255]);
        }
    }
    rgba
}

fn heic(width: u32, height: u32) -> Vec<u8> {
    heifer::encode_rgba8(
        width,
        height,
        &picture(width, height),
        &heifer::EncodeOptions::new()
            .with_quality(90)
            .with_max_threads(1),
    )
    .expect("the test picture encodes")
}

fn psnr(a: &[u8], b: &[u8]) -> f64 {
    assert_eq!(a.len(), b.len());
    let squared: f64 = a
        .iter()
        .zip(b)
        .enumerate()
        .filter(|(index, _)| index % 4 != 3)
        .map(|(_, (x, y))| (f64::from(*x) - f64::from(*y)).powi(2))
        .sum();
    let mean = squared / (a.len() as f64 * 0.75);
    if mean == 0.0 {
        f64::INFINITY
    } else {
        10.0 * (255.0 * 255.0 / mean).log10()
    }
}

/// Offset of the first box of `kind` in `bytes` (its size field).
fn find_box(bytes: &[u8], kind: &[u8; 4]) -> Option<usize> {
    bytes
        .windows(4)
        .position(|window| window == kind)
        .and_then(|position| position.checked_sub(4))
}

#[test]
fn decodes_a_single_image_at_its_own_size() {
    let preview = decode_preview(&heic(320, 200), GENEROUS).expect("decodes");
    assert_eq!((preview.width, preview.height), (320, 200));
    assert_eq!(preview.rgba.len(), 320 * 200 * 4);
    let quality = psnr(&preview.rgba, &picture(320, 200));
    assert!(quality > 40.0, "{quality} dB");
}

#[test]
fn decodes_a_tiled_grid_as_one_picture() {
    // Larger than one 512x512 tile in both directions: a 3x2 grid.
    let bytes = heic(1100, 700);
    let file = heifer::heifer_isobmff::HeifFile::parse(&bytes).expect("parses");
    let primary = file.item(file.primary_id).expect("primary");
    assert_eq!(&primary.item_type.0, b"grid");
    let preview = decode_preview(&bytes, GENEROUS).expect("decodes");
    assert_eq!((preview.width, preview.height), (1100, 700));
    let quality = psnr(&preview.rgba, &picture(1100, 700));
    assert!(quality > 40.0, "{quality} dB");
}

#[test]
fn scales_a_larger_image_down_to_the_output_budget() {
    let limits = Limits {
        max_decoded_pixels: 1_000_000,
        max_canvas_pixels: 1_000_000,
        max_output_pixels: 100_000,
    };
    let preview = decode_preview(&heic(1100, 700), limits).expect("decodes");
    assert!(u64::from(preview.width) * u64::from(preview.height) <= 100_000);
    // The shape is kept to within a pixel.
    let ratio = f64::from(preview.width) / f64::from(preview.height);
    assert!((ratio - 1100.0 / 700.0).abs() < 0.01, "{ratio}");
    assert_eq!(
        preview.rgba.len(),
        preview.width as usize * preview.height as usize * 4
    );
}

#[test]
fn refuses_a_single_image_over_the_decoded_budget_before_decoding() {
    let bytes = heic(320, 200);
    let at_budget = Limits {
        max_decoded_pixels: 320 * 200,
        max_canvas_pixels: 1,
        max_output_pixels: 1,
    };
    assert!(decode_preview(&bytes, at_budget).is_ok());
    let below = Limits {
        max_decoded_pixels: 320 * 200 - 1,
        ..at_budget
    };
    assert_eq!(decode_preview(&bytes, below), Err(Refusal::TooLarge));
}

#[test]
fn bounds_a_grid_by_its_canvas_and_each_tile_not_by_the_decoded_budget() {
    let bytes = heic(1100, 700);
    // A whole decode of the canvas would need 770,000 pixels; tile by tile,
    // only a 512x512 tile is ever decoded.
    let tiles_only = Limits {
        max_decoded_pixels: 512 * 512,
        max_canvas_pixels: 1100 * 700,
        max_output_pixels: 10_000,
    };
    assert!(decode_preview(&bytes, tiles_only).is_ok());
    let small_canvas = Limits {
        max_canvas_pixels: 1100 * 700 - 1,
        ..tiles_only
    };
    assert_eq!(decode_preview(&bytes, small_canvas), Err(Refusal::TooLarge));
    let small_tiles = Limits {
        max_decoded_pixels: 512 * 512 - 1,
        ..tiles_only
    };
    assert_eq!(decode_preview(&bytes, small_tiles), Err(Refusal::TooLarge));
}

/// A grid of `columns` x `rows` copies of one coded tile, cropped to
/// `width` x `height`: a large photo made without encoding one.
fn repeated_grid(tile_source: &[u8], columns: u16, rows: u16, width: u32, height: u32) -> Vec<u8> {
    let source = HeifFile::parse(tile_source).expect("parses");
    let tile = source.primary_id;
    let (tile_width, tile_height) = source.image_size(tile).expect("ispe").expect("ispe");
    let config = source
        .hevc_config(tile)
        .expect("hvcC")
        .expect("hvcC")
        .clone();
    let data = source.item_data(tile).expect("data");
    let length = usize::from(config.nal_length_size);
    let mut slices = Vec::new();
    let mut offset = 0;
    while offset < data.len() {
        let size = data[offset..offset + length]
            .iter()
            .fold(0usize, |value, &byte| (value << 8) | usize::from(byte));
        slices.push(data[offset + length..offset + length + size].to_vec());
        offset += length + size;
    }
    let mut writer = HeifWriter::new();
    let ids: Vec<_> = (0..u32::from(columns) * u32::from(rows))
        .map(|_| {
            writer.add_image(&ImageSpec {
                hidden: true,
                ..ImageSpec::new(tile_width, tile_height, config.clone(), &slices)
            })
        })
        .collect();
    let grid = writer.add_grid(rows, columns, width, height, &ids, None, None);
    writer.set_primary(grid);
    writer.finish()
}

#[test]
fn previews_a_48_megapixel_grid_tile_by_tile() {
    // One 512x512 tile repeated as iPhone's 48 MP layout: 16 x 12 tiles
    // cropped to 8064 x 6048.
    let tile = heic(512, 512);
    let bytes = repeated_grid(&tile, 16, 12, 8064, 6048);
    let limits = Limits {
        max_decoded_pixels: 25_000_000,
        max_canvas_pixels: 200_000_000,
        max_output_pixels: 8_000_000,
    };
    let preview = decode_preview(&bytes, limits).expect("decodes");
    assert!(u64::from(preview.width) * u64::from(preview.height) <= 8_000_000);
    let ratio = f64::from(preview.width) / f64::from(preview.height);
    assert!((ratio - 8064.0 / 6048.0).abs() < 0.01, "{ratio}");
    // The top-left preview pixel averages the tile's own top-left corner.
    let corner = &preview.rgba[..4];
    assert!(corner[0] < 8 && corner[1] < 8, "{corner:?}");
}

#[test]
fn tile_by_tile_matches_the_whole_picture_scaled_down() {
    let bytes = heic(1100, 700);
    let limits = Limits {
        max_decoded_pixels: 50_000_000,
        max_canvas_pixels: 50_000_000,
        max_output_pixels: 300_000,
    };
    let tiled = decode_preview(&bytes, limits).expect("decodes");
    let whole = heifer::decode_srgb_rgba8(&bytes, &heifer::Options::new().with_max_threads(1))
        .expect("decodes whole");
    let reference = fit_rgba(whole.data, whole.width, whole.height, 300_000);
    assert_eq!(
        (tiled.width, tiled.height),
        (reference.width, reference.height)
    );
    // Both average the same areas; they differ only by rounding.
    let quality = psnr(&tiled.rgba, &reference.rgba);
    assert!(quality > 48.0, "{quality} dB");
}

#[test]
fn refuses_a_grid_that_declares_a_canvas_over_the_budget() {
    let mut bytes = heic(1100, 700);
    let grid = grid_payload(&bytes);
    // version, flags, rows - 1, columns - 1, then width and height: 32-bit
    // when flags bit 0 is set, else 16-bit.
    if bytes[grid + 1] & 1 == 0 {
        bytes[grid + 4..grid + 6].copy_from_slice(&u16::MAX.to_be_bytes());
        bytes[grid + 6..grid + 8].copy_from_slice(&u16::MAX.to_be_bytes());
    } else {
        bytes[grid + 4..grid + 8].copy_from_slice(&100_000u32.to_be_bytes());
        bytes[grid + 8..grid + 12].copy_from_slice(&100_000u32.to_be_bytes());
    }
    assert_eq!(decode_preview(&bytes, GENEROUS), Err(Refusal::TooLarge));
}

#[test]
fn refuses_a_grid_with_more_tiles_than_it_shows() {
    let mut bytes = heic(1100, 700);
    let grid = grid_payload(&bytes);
    // 256x256 tiles of 512x512 for a 1100x700 canvas.
    bytes[grid + 2] = 255;
    bytes[grid + 3] = 255;
    assert_eq!(decode_preview(&bytes, GENEROUS), Err(Refusal::TooLarge));
    const { assert!(256 * 256 > MAX_GRID_TILES) };
}

#[test]
fn refuses_a_grid_whose_tiles_do_not_match_its_layout() {
    let mut bytes = heic(1100, 700);
    let grid = grid_payload(&bytes);
    // One row and one column: one tile for a canvas six tiles cover.
    bytes[grid + 2] = 0;
    bytes[grid + 3] = 0;
    assert_eq!(decode_preview(&bytes, GENEROUS), Err(Refusal::Unreadable));
}

/// Offset of the grid item's payload (its `version` byte) inside `bytes`.
fn grid_payload(bytes: &[u8]) -> usize {
    let file = heifer::heifer_isobmff::HeifFile::parse(bytes).expect("parses");
    let data = file
        .item_data(file.primary_id)
        .expect("grid data")
        .into_owned();
    bytes
        .windows(data.len())
        .position(|window| window == data.as_slice())
        .expect("the grid payload is stored in the file")
}

#[test]
fn refuses_files_that_are_not_heif() {
    for bytes in [
        &b""[..],
        &[0u8; 64][..],
        b"\x89PNG\r\n\x1a\n",
        b"\x00\x00\x00\x18ftypmif1\x00\x00\x00\x00mif1heic",
    ] {
        assert_eq!(decode_preview(bytes, GENEROUS), Err(Refusal::Unreadable));
    }
}

#[test]
fn refuses_every_truncation_of_the_header() {
    let bytes = heic(1100, 700);
    let mdat = find_box(&bytes, b"mdat").expect("mdat");
    for length in 0..mdat.min(4096) {
        let result = catch_unwind(AssertUnwindSafe(|| {
            decode_preview(&bytes[..length], GENEROUS)
        }));
        assert_eq!(result.ok(), Some(Err(Refusal::Unreadable)), "{length}");
    }
}

#[test]
fn mutated_files_decode_within_limits_or_are_refused() {
    let sources = [heic(1100, 700), heic(96, 64)];
    let mut generator = Generator(SEED);
    let limits = Limits {
        max_decoded_pixels: 1_000_000,
        max_canvas_pixels: 1_000_000,
        max_output_pixels: 250_000,
    };
    for _ in 0..MUTATIONS {
        let mut bytes = sources[generator.below(sources.len())].clone();
        let header = find_box(&bytes, b"mdat").unwrap_or(bytes.len());
        match generator.below(4) {
            0 => {
                let length = generator.below(bytes.len());
                bytes.truncate(length);
            }
            1 => {
                for _ in 0..1 + generator.below(8) {
                    let index = generator.below(header);
                    bytes[index] ^= 1 << generator.below(8);
                }
            }
            2 => {
                let index = generator.below(header.saturating_sub(4));
                let value = [0u32, 1, u32::MAX, 0x7fff_ffff, 65_535][generator.below(5)];
                bytes[index..index + 4].copy_from_slice(&value.to_be_bytes());
            }
            _ => {
                for _ in 0..1 + generator.below(64) {
                    let index = generator.below(bytes.len());
                    bytes[index] = u8::try_from(generator.next() & 0xff).unwrap_or(0);
                }
            }
        }
        let result = catch_unwind(AssertUnwindSafe(|| decode_preview(&bytes, limits)));
        match result {
            Ok(Ok(Preview {
                width,
                height,
                rgba,
            })) => {
                assert!(u64::from(width) * u64::from(height) <= limits.max_output_pixels);
                assert_eq!(rgba.len(), width as usize * height as usize * 4);
            }
            Ok(Err(_)) => {}
            Err(_) => panic!("a mutated file panicked the decoder"),
        }
    }
}

#[test]
fn fitting_keeps_an_image_that_fits_untouched() {
    let rgba = picture(40, 30);
    let preview = fit_rgba(rgba.clone(), 40, 30, 1200);
    assert_eq!((preview.width, preview.height), (40, 30));
    assert_eq!(preview.rgba, rgba);
}

#[test]
fn fitting_averages_whole_blocks_exactly() {
    // 4x2 -> 2x1: each output pixel is the mean of a 2x2 block.
    let rgba = vec![
        0, 0, 0, 255, 100, 100, 100, 255, 10, 20, 30, 255, 30, 40, 50, 255, //
        200, 200, 200, 255, 100, 100, 100, 255, 50, 60, 70, 255, 70, 80, 90, 255,
    ];
    let preview = fit_rgba(rgba, 4, 2, 2);
    assert_eq!((preview.width, preview.height), (2, 1));
    assert_eq!(preview.rgba, vec![100, 100, 100, 255, 40, 50, 60, 255]);
}

#[test]
fn fitting_a_uniform_image_keeps_its_colour_at_any_ratio() {
    let rgba = [17u8, 130, 251, 200].repeat(97 * 61);
    for max in [1, 2, 7, 100, 1000, 97 * 61 - 1] {
        let preview = fit_rgba(rgba.clone(), 97, 61, max);
        assert!(u64::from(preview.width) * u64::from(preview.height) <= max);
        assert!(preview.width >= 1 && preview.height >= 1);
        for pixel in preview.rgba.as_chunks::<4>().0 {
            assert_eq!(pixel, &[17, 130, 251, 200]);
        }
    }
}
