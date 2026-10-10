//! Pure scan cleanup pipeline.

use std::collections::VecDeque;

use image::{GrayImage, Luma, imageops};
use imageproc::{
    contours::find_contours_with_threshold,
    contrast::adaptive_threshold,
    filter::box_filter,
    geometric_transformations::{Border, Interpolation, Projection, warp_into},
};

#[cfg(target_arch = "wasm32")]
mod wasm;

pub type Point = (f32, f32);
pub type Quad = [Point; 4];

const MAX_DIMENSION_AREA: u32 = 40_000_000;
const MAX_DESKEW_TENTHS: i32 = 60;
const DESKEW_TENTHS: f32 = 0.1;
const CROP_PADDING_MM: f32 = 3.0;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CleanOutput {
    Grayscale,
    Binary,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ContentBox {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Copy, Debug)]
pub struct CleanOptions {
    pub output: CleanOutput,
    pub content_crop: bool,
    pub deskew: bool,
    pub dpi: f32,
}

#[derive(Debug)]
pub struct CleanedScan {
    pub image: GrayImage,
    pub applied_quad: Option<Quad>,
    pub skew_degrees: f32,
    pub content_box: ContentBox,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UnrecognizedReason {
    NoContent,
    InvalidDimensions,
    InvalidPixelBuffer,
    InvalidDpi,
    DegeneratePageQuad,
}

impl UnrecognizedReason {
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::NoContent => "no-content",
            Self::InvalidDimensions => "invalid-dimensions",
            Self::InvalidPixelBuffer => "invalid-pixel-buffer",
            Self::InvalidDpi => "invalid-dpi",
            Self::DegeneratePageQuad => "degenerate-page-quad",
        }
    }
}

pub fn gray_image(width: u32, height: u32, pixels: &[u8]) -> Result<GrayImage, UnrecognizedReason> {
    if width < 64
        || height < 64
        || width
            .checked_mul(height)
            .is_none_or(|area| area > MAX_DIMENSION_AREA)
    {
        return Err(UnrecognizedReason::InvalidDimensions);
    }
    GrayImage::from_raw(width, height, pixels.to_vec())
        .ok_or(UnrecognizedReason::InvalidPixelBuffer)
}

fn cross(a: Point, b: Point, c: Point) -> f32 {
    (b.0 - a.0) * (c.1 - a.1) - (b.1 - a.1) * (c.0 - a.0)
}

fn hull(mut points: Vec<Point>) -> Vec<Point> {
    points.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.total_cmp(&b.1)));
    points.dedup();
    if points.len() < 4 {
        return points;
    }
    let mut low = Vec::new();
    for point in &points {
        while low.len() > 1 && cross(low[low.len() - 2], low[low.len() - 1], *point) <= 0.0 {
            low.pop();
        }
        low.push(*point);
    }
    let mut high = Vec::new();
    for point in points.iter().rev() {
        while high.len() > 1 && cross(high[high.len() - 2], high[high.len() - 1], *point) <= 0.0 {
            high.pop();
        }
        high.push(*point);
    }
    low.pop();
    high.pop();
    low.extend(high);
    low
}

fn polygon_area(points: &[Point]) -> f32 {
    points
        .iter()
        .zip(points.iter().cycle().skip(1))
        .take(points.len())
        .map(|(a, b)| a.0 * b.1 - a.1 * b.0)
        .sum::<f32>()
        .abs()
        * 0.5
}

fn reduce_quad(mut points: Vec<Point>) -> Option<Quad> {
    while points.len() > 4 {
        let count = points.len();
        let index = (0..count).min_by(|left, right| {
            cross(
                points[(left + count - 1) % count],
                points[*left],
                points[(left + 1) % count],
            )
            .abs()
            .total_cmp(
                &cross(
                    points[(right + count - 1) % count],
                    points[*right],
                    points[(right + 1) % count],
                )
                .abs(),
            )
        })?;
        points.remove(index);
    }
    if points.len() != 4 {
        return None;
    }
    let start = (0..4).min_by(|left, right| {
        (points[*left].0 + points[*left].1).total_cmp(&(points[*right].0 + points[*right].1))
    })?;
    Some(std::array::from_fn(|index| points[(start + index) % 4]))
}

/// Detects a page surrounded by a contrasting background.
///
/// A contour which fills the frame is deliberately ignored: flatbed scans already have the
/// desired geometry and must not report a spurious applied quadrilateral.
#[must_use]
pub fn detect_page_quad(gray: &GrayImage) -> Option<Quad> {
    let scale = (750.0 / gray.width().max(gray.height()) as f32).min(1.0);
    let width = ((gray.width() as f32 * scale).round() as u32).max(1);
    let height = ((gray.height() as f32 * scale).round() as u32).max(1);
    let small = imageops::resize(gray, width, height, imageops::FilterType::Triangle);
    let smooth = box_filter(&small, 2, 2);
    let whole = smooth.width() as f32 * smooth.height() as f32;
    let mut best = None;
    let mut best_score = 0.0;
    for threshold in [110, 135, 155, 175, 195, 215] {
        for contour in find_contours_with_threshold::<i32>(&smooth, threshold) {
            if contour.parent.is_some() || contour.points.len() < 100 {
                continue;
            }
            let points = contour
                .points
                .iter()
                .map(|point| (point.x as f32, point.y as f32))
                .collect();
            let envelope = hull(points);
            let area = polygon_area(&envelope);
            if area < whole * 0.1 || area > whole * 0.94 {
                continue;
            }
            let Some(quad) = reduce_quad(envelope) else {
                continue;
            };
            let quad_area = polygon_area(&quad);
            if quad_area / area < 0.86 {
                continue;
            }
            let border_points = quad
                .iter()
                .filter(|point| {
                    point.0 < 3.0
                        || point.1 < 3.0
                        || point.0 > smooth.width() as f32 - 4.0
                        || point.1 > smooth.height() as f32 - 4.0
                })
                .count();
            if border_points > 1 {
                continue;
            }
            let score = quad_area * (quad_area / area).powi(3);
            if score > best_score {
                best_score = score;
                best = Some(quad.map(|point| (point.0 / scale, point.1 / scale)));
            }
        }
    }
    best
}

/// Returns the clockwise angle of the page content in degrees.
#[must_use]
pub fn deskew_angle(gray: &GrayImage) -> f32 {
    let scale = (750.0 / gray.width().max(gray.height()) as f32).min(1.0);
    let width = ((gray.width() as f32 * scale).round() as u32).max(1);
    let height = ((gray.height() as f32 * scale).round() as u32).max(1);
    let small = imageops::resize(gray, width, height, imageops::FilterType::Triangle);
    let binary = adaptive_threshold(&small, 12, 0);
    let points: Vec<Point> = binary
        .enumerate_pixels()
        .filter(|(x, y, pixel)| {
            pixel[0] == 0
                && *x > 20
                && *y > 20
                && *x + 20 < binary.width()
                && *y + 20 < binary.height()
                && *x % 2 == 0
        })
        .map(|(x, y, _)| (x as f32, y as f32))
        .collect();
    let mut best_angle = 0.0;
    let mut best_score = 0_u64;
    for step in -MAX_DESKEW_TENTHS..=MAX_DESKEW_TENTHS {
        let angle = step as f32 * DESKEW_TENTHS;
        let slope = angle.to_radians().tan();
        let mut rows = vec![0_u32; binary.height() as usize + 200];
        for (x, y) in &points {
            let row = (y - x * slope + 100.0).round() as isize;
            if let Ok(index) = usize::try_from(row)
                && index < rows.len()
            {
                rows[index] += 1;
            }
        }
        let score = rows.iter().map(|count| u64::from(*count).pow(2)).sum();
        if score > best_score {
            best_score = score;
            best_angle = angle;
        }
    }
    best_angle
}

pub fn perspective(
    gray: &GrayImage,
    corners: Quad,
    width: u32,
    height: u32,
) -> Result<GrayImage, UnrecognizedReason> {
    let destination = [
        (0.0, 0.0),
        (width.saturating_sub(1) as f32, 0.0),
        (
            width.saturating_sub(1) as f32,
            height.saturating_sub(1) as f32,
        ),
        (0.0, height.saturating_sub(1) as f32),
    ];
    if gray.dimensions() == (width, height)
        && corners.iter().zip(destination).all(|(source, target)| {
            (source.0 - target.0).abs() < f32::EPSILON && (source.1 - target.1).abs() < f32::EPSILON
        })
    {
        return Ok(gray.clone());
    }
    let projection = Projection::from_control_points(corners, destination)
        .ok_or(UnrecognizedReason::DegeneratePageQuad)?;
    let mut output = GrayImage::new(width, height);
    warp_into(
        gray,
        projection,
        Interpolation::Bilinear,
        Border::Constant(Luma([255])),
        &mut output,
    );
    Ok(output)
}

fn rotate_centered(gray: &GrayImage, angle: f32) -> GrayImage {
    let center_x = gray.width() as f32 / 2.0;
    let center_y = gray.height() as f32 / 2.0;
    let projection = Projection::translate(center_x, center_y)
        * Projection::rotate(-angle.to_radians())
        * Projection::translate(-center_x, -center_y);
    let mut output = GrayImage::new(gray.width(), gray.height());
    warp_into(
        gray,
        projection,
        Interpolation::Bilinear,
        Border::Constant(Luma([255])),
        &mut output,
    );
    output
}

fn content_bounds(binary: &GrayImage, dpi: f32) -> Option<ContentBox> {
    let width = binary.width();
    let height = binary.height();
    let mut visited = vec![false; (width * height) as usize];
    // About 0.02 mm²: removes isolated dust without discarding punctuation at normal scan DPIs.
    let minimum_component = ((dpi / 25.4).powi(2) * 0.02).round().max(4.0) as usize;
    let mut bounds: Option<(u32, u32, u32, u32)> = None;
    for y in 0..height {
        for x in 0..width {
            let index = (y * width + x) as usize;
            if visited[index] || binary.get_pixel(x, y)[0] != 0 {
                continue;
            }
            visited[index] = true;
            let mut queue = VecDeque::from([(x, y)]);
            let mut component_size = 0;
            let mut component_bounds = (x, y, x, y);
            while let Some((current_x, current_y)) = queue.pop_front() {
                component_size += 1;
                component_bounds.0 = component_bounds.0.min(current_x);
                component_bounds.1 = component_bounds.1.min(current_y);
                component_bounds.2 = component_bounds.2.max(current_x);
                component_bounds.3 = component_bounds.3.max(current_y);
                for (next_x, next_y) in [
                    (current_x.saturating_sub(1), current_y),
                    (current_x.saturating_add(1), current_y),
                    (current_x, current_y.saturating_sub(1)),
                    (current_x, current_y.saturating_add(1)),
                ] {
                    if next_x >= width || next_y >= height {
                        continue;
                    }
                    let next_index = (next_y * width + next_x) as usize;
                    if !visited[next_index] && binary.get_pixel(next_x, next_y)[0] == 0 {
                        visited[next_index] = true;
                        queue.push_back((next_x, next_y));
                    }
                }
            }
            if component_size < minimum_component {
                continue;
            }
            let current = bounds.get_or_insert(component_bounds);
            current.0 = current.0.min(component_bounds.0);
            current.1 = current.1.min(component_bounds.1);
            current.2 = current.2.max(component_bounds.2);
            current.3 = current.3.max(component_bounds.3);
        }
    }
    bounds.map(|(left, top, right, bottom)| ContentBox {
        x: left,
        y: top,
        width: right - left + 1,
        height: bottom - top + 1,
    })
}

pub fn clean_scan(
    gray: &GrayImage,
    options: CleanOptions,
) -> Result<CleanedScan, UnrecognizedReason> {
    if !options.dpi.is_finite() || options.dpi <= 0.0 {
        return Err(UnrecognizedReason::InvalidDpi);
    }
    let applied_quad = detect_page_quad(gray);
    let rectified = if let Some(quad) = applied_quad {
        let edge_length = |start: Point, end: Point| {
            ((end.0 - start.0).powi(2) + (end.1 - start.1).powi(2)).sqrt()
        };
        let width = ((edge_length(quad[0], quad[1]) + edge_length(quad[3], quad[2])) * 0.5)
            .round()
            .max(1.0) as u32;
        let height = ((edge_length(quad[0], quad[3]) + edge_length(quad[1], quad[2])) * 0.5)
            .round()
            .max(1.0) as u32;
        perspective(gray, quad, width, height)?
    } else {
        gray.clone()
    };
    let skew_degrees = if options.deskew {
        deskew_angle(&rectified)
    } else {
        0.0
    };
    let straight = if options.deskew {
        rotate_centered(&rectified, skew_degrees)
    } else {
        rectified
    };
    // Radius 32 produces the requested 65 by 65 local background window.
    let background = box_filter(&straight, 32, 32);
    let flattened = GrayImage::from_fn(straight.width(), straight.height(), |x, y| {
        let value = f32::from(straight.get_pixel(x, y)[0]);
        let base = f32::from(background.get_pixel(x, y)[0].max(1));
        Luma([(value * 245.0 / base).min(255.0).round() as u8])
    });
    // Radius 20 produces the requested 41 by 41 adaptive threshold window.
    let binary = adaptive_threshold(&flattened, 20, 0);
    let content = content_bounds(&binary, options.dpi).ok_or(UnrecognizedReason::NoContent)?;
    let selected = match options.output {
        CleanOutput::Grayscale => flattened,
        CleanOutput::Binary => binary,
    };
    if !options.content_crop {
        return Ok(CleanedScan {
            image: selected,
            applied_quad,
            skew_degrees,
            content_box: content,
        });
    }
    let padding = (CROP_PADDING_MM * options.dpi / 25.4).round() as u32;
    let x = content.x.saturating_sub(padding);
    let y = content.y.saturating_sub(padding);
    let right = content
        .x
        .saturating_add(content.width)
        .saturating_add(padding)
        .min(selected.width());
    let bottom = content
        .y
        .saturating_add(content.height)
        .saturating_add(padding)
        .min(selected.height());
    let image = imageops::crop_imm(&selected, x, y, right - x, bottom - y).to_image();
    Ok(CleanedScan {
        image,
        applied_quad,
        skew_degrees,
        content_box: ContentBox {
            x: content.x - x,
            y: content.y - y,
            width: content.width,
            height: content.height,
        },
    })
}

#[cfg(any(target_arch = "wasm32", test))]
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
            let alpha = f32::from(pixel[3]) / 255.0;
            let luminance = 0.2126 * f32::from(pixel[0])
                + 0.7152 * f32::from(pixel[1])
                + 0.0722 * f32::from(pixel[2]);
            (luminance * alpha + 255.0 * (1.0 - alpha)).round() as u8
        })
        .collect::<Vec<_>>();
    gray_image(width, height, &gray)
}

#[cfg(test)]
mod tests;
