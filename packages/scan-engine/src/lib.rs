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
const MIN_FOREGROUND_CONTRAST: u8 = 15;
const ADAPTIVE_THRESHOLD_OFFSET: i32 = 5;
const CROP_PADDING_MM: f32 = 3.0;
const MIN_EDGE_CONTRAST: u8 = 10;

fn checked_pixel_count(width: u32, height: u32) -> Result<usize, UnrecognizedReason> {
    if width == 0 || height == 0 {
        return Err(UnrecognizedReason::InvalidDimensions);
    }
    width
        .checked_mul(height)
        .filter(|area| *area <= MAX_DIMENSION_AREA)
        .and_then(|area| usize::try_from(area).ok())
        .ok_or(UnrecognizedReason::TooLarge)
}

fn bounded_image(width: u32, height: u32, value: u8) -> Result<GrayImage, UnrecognizedReason> {
    checked_pixel_count(width, height)?;
    Ok(GrayImage::from_pixel(width, height, Luma([value])))
}

fn bounded_vec<T: Clone>(width: u32, height: u32, value: T) -> Result<Vec<T>, UnrecognizedReason> {
    Ok(vec![value; checked_pixel_count(width, height)?])
}

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
    /// Corners of the detected page in the source image, clockwise from top-left.
    pub applied_quad: Option<Quad>,
    pub skew_degrees: f32,
    /// Content bounds in the returned output image.
    pub content_box: ContentBox,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UnrecognizedReason {
    NoContent,
    InvalidDimensions,
    InvalidPixelBuffer,
    InvalidDpi,
    DegeneratePageQuad,
    TooLarge,
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
            Self::TooLarge => "too-large",
        }
    }
}

pub fn gray_image(width: u32, height: u32, pixels: &[u8]) -> Result<GrayImage, UnrecognizedReason> {
    if width < 64 || height < 64 {
        return Err(UnrecognizedReason::InvalidDimensions);
    }
    checked_pixel_count(width, height).map_err(|_| UnrecognizedReason::InvalidDimensions)?;
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
    let mut output = bounded_image(width, height, 0)?;
    warp_into(
        gray,
        projection,
        Interpolation::Bilinear,
        Border::Constant(Luma([255])),
        &mut output,
    );
    Ok(output)
}

struct RotatedImage {
    image: GrayImage,
}

struct RotationGeometry {
    projection: Projection,
    width: u32,
    height: u32,
}

fn page_background(gray: &GrayImage) -> u8 {
    let mut counts = [0_u32; 256];
    for pixel in gray.pixels() {
        counts[usize::from(pixel[0])] += 1;
    }
    counts
        .iter()
        .enumerate()
        .max_by_key(|(_, count)| *count)
        .map_or(255, |(value, _)| value as u8)
}

fn high_page_level(gray: &GrayImage) -> u8 {
    let mut counts = [0_u32; 256];
    for pixel in gray.pixels() {
        counts[usize::from(pixel[0])] += 1;
    }
    let target = gray.width().saturating_mul(gray.height()).saturating_mul(9) / 10;
    let mut cumulative = 0;
    counts
        .iter()
        .position(|count| {
            cumulative += count;
            cumulative >= target
        })
        .map_or(255, |value| value as u8)
}

fn rotation_geometry(gray: &GrayImage, angle: f32) -> Result<RotationGeometry, UnrecognizedReason> {
    let center_x = gray.width() as f32 / 2.0;
    let center_y = gray.height() as f32 / 2.0;
    let rotation = Projection::translate(center_x, center_y)
        * Projection::rotate(-angle.to_radians())
        * Projection::translate(-center_x, -center_y);
    let corners = [
        (0.0, 0.0),
        (gray.width() as f32, 0.0),
        (gray.width() as f32, gray.height() as f32),
        (0.0, gray.height() as f32),
    ]
    .map(|point| rotation * point);
    let min_x = corners
        .iter()
        .map(|point| point.0)
        .fold(f32::INFINITY, f32::min)
        .floor()
        - 1.0;
    let min_y = corners
        .iter()
        .map(|point| point.1)
        .fold(f32::INFINITY, f32::min)
        .floor()
        - 1.0;
    let max_x = corners
        .iter()
        .map(|point| point.0)
        .fold(f32::NEG_INFINITY, f32::max)
        .ceil()
        + 1.0;
    let max_y = corners
        .iter()
        .map(|point| point.1)
        .fold(f32::NEG_INFINITY, f32::max)
        .ceil()
        + 1.0;
    let width = (max_x - min_x) as u32;
    let height = (max_y - min_y) as u32;
    checked_pixel_count(width, height)?;
    let projection = Projection::translate(-min_x, -min_y) * rotation;
    Ok(RotationGeometry {
        projection,
        width,
        height,
    })
}

fn rotate_centered(gray: &GrayImage, angle: f32) -> Result<RotatedImage, UnrecognizedReason> {
    let geometry = rotation_geometry(gray, angle)?;
    let background = page_background(gray);
    let mut output = bounded_image(geometry.width, geometry.height, background)?;
    warp_into(
        gray,
        geometry.projection,
        Interpolation::Bilinear,
        Border::Constant(Luma([background])),
        &mut output,
    );
    Ok(RotatedImage { image: output })
}

fn threshold_document(flattened: &GrayImage) -> Result<GrayImage, UnrecognizedReason> {
    let local_mean = box_filter_scaled(flattened, 20)?;
    let absolute_threshold = page_background(flattened).saturating_sub(MIN_FOREGROUND_CONTRAST);
    let mut output = bounded_image(flattened.width(), flattened.height(), 0)?;
    for (x, y, pixel) in output.enumerate_pixels_mut() {
        // Local contrast preserves fine strokes; the page-background threshold also preserves
        // solid marks whose interior has no local contrast.
        let value = flattened.get_pixel(x, y)[0];
        let foreground = i32::from(value)
            < i32::from(local_mean.get_pixel(x, y)[0]) - ADAPTIVE_THRESHOLD_OFFSET
            || value <= absolute_threshold;
        *pixel = Luma([if foreground { 0 } else { 255 }]);
    }
    Ok(output)
}

fn box_filter_scaled(gray: &GrayImage, radius: u32) -> Result<GrayImage, UnrecognizedReason> {
    let width = gray.width();
    let height = gray.height();
    let mut horizontal = bounded_image(width, height, 0)?;
    for y in 0..height {
        let mut sum = (0..=radius.min(width - 1))
            .map(|x| u64::from(gray.get_pixel(x, y)[0]))
            .sum::<u64>();
        for x in 0..width {
            let left = x.saturating_sub(radius);
            let right = x.saturating_add(radius).min(width - 1);
            let count = u64::from(right - left + 1);
            horizontal.put_pixel(x, y, Luma([((sum + count / 2) / count) as u8]));
            if x >= radius {
                sum -= u64::from(gray.get_pixel(x - radius, y)[0]);
            }
            if let Some(next) = x.checked_add(radius + 1).filter(|next| *next < width) {
                sum += u64::from(gray.get_pixel(next, y)[0]);
            }
        }
    }

    let mut filtered = bounded_image(width, height, 0)?;
    for x in 0..width {
        let mut sum = (0..=radius.min(height - 1))
            .map(|y| u64::from(horizontal.get_pixel(x, y)[0]))
            .sum::<u64>();
        for y in 0..height {
            let top = y.saturating_sub(radius);
            let bottom = y.saturating_add(radius).min(height - 1);
            let count = u64::from(bottom - top + 1);
            filtered.put_pixel(x, y, Luma([((sum + count / 2) / count) as u8]));
            if y >= radius {
                sum -= u64::from(horizontal.get_pixel(x, y - radius)[0]);
            }
            if let Some(next) = y.checked_add(radius + 1).filter(|next| *next < height) {
                sum += u64::from(horizontal.get_pixel(x, next)[0]);
            }
        }
    }
    Ok(filtered)
}

fn edge_barrier(gray: &GrayImage, scale_reference: u32) -> Result<Vec<bool>, UnrecognizedReason> {
    let width = gray.width();
    let height = gray.height();
    let edge_scale = (scale_reference / 500).max(1);
    let edge_dilation = (scale_reference / 250).max(1);
    let smooth = box_filter_scaled(gray, edge_scale)?;
    let mut strong_edge = bounded_vec(width, height, false)?;
    for y in 0..height {
        for x in 0..width {
            let left = smooth.get_pixel(x.saturating_sub(edge_scale), y)[0];
            let right = smooth.get_pixel(x.saturating_add(edge_scale).min(width - 1), y)[0];
            let above = smooth.get_pixel(x, y.saturating_sub(edge_scale))[0];
            let below = smooth.get_pixel(x, y.saturating_add(edge_scale).min(height - 1))[0];
            strong_edge[(y * width + x) as usize] =
                left.abs_diff(right).max(above.abs_diff(below)) >= MIN_EDGE_CONTRAST;
        }
    }
    let stride = width as usize + 1;
    let mut edge_sum = bounded_vec(width + 1, height + 1, 0_u32)?;
    for y in 0..height {
        for x in 0..width {
            let sum_index = (y as usize + 1) * stride + x as usize + 1;
            edge_sum[sum_index] = u32::from(strong_edge[(y * width + x) as usize])
                + edge_sum[sum_index - 1]
                + edge_sum[sum_index - stride]
                - edge_sum[sum_index - stride - 1];
        }
    }
    let mut barrier = bounded_vec(width, height, false)?;
    for y in 0..height {
        for x in 0..width {
            let left = x.saturating_sub(edge_dilation);
            let right = x.saturating_add(edge_dilation).min(width - 1);
            let top = y.saturating_sub(edge_dilation);
            let bottom = y.saturating_add(edge_dilation).min(height - 1);
            let top_left = top as usize * stride + left as usize;
            let top_right = top as usize * stride + right as usize + 1;
            let bottom_left = (bottom as usize + 1) * stride + left as usize;
            let bottom_right = (bottom as usize + 1) * stride + right as usize + 1;
            barrier[(y * width + x) as usize] = edge_sum[bottom_right] + edge_sum[top_left]
                - edge_sum[top_right]
                - edge_sum[bottom_left]
                > 0;
        }
    }
    Ok(barrier)
}

fn largest_open_region(barrier: &[bool], width: u32, height: u32) -> Vec<bool> {
    let mut visited = vec![false; barrier.len()];
    let mut largest = Vec::new();
    for y in 0..height {
        for x in 0..width {
            let start = (y * width + x) as usize;
            if barrier[start] || visited[start] {
                continue;
            }
            visited[start] = true;
            let mut queue = VecDeque::from([(x, y)]);
            let mut region = Vec::new();
            while let Some((current_x, current_y)) = queue.pop_front() {
                region.push((current_y * width + current_x) as usize);
                for (next_x, next_y) in [
                    (current_x.saturating_sub(1), current_y),
                    (current_x.saturating_add(1), current_y),
                    (current_x, current_y.saturating_sub(1)),
                    (current_x, current_y.saturating_add(1)),
                ] {
                    if next_x >= width || next_y >= height {
                        continue;
                    }
                    let index = (next_y * width + next_x) as usize;
                    if !barrier[index] && !visited[index] {
                        visited[index] = true;
                        queue.push_back((next_x, next_y));
                    }
                }
            }
            if region.len() > largest.len() {
                largest = region;
            }
        }
    }
    let mut selected = vec![false; barrier.len()];
    for index in largest {
        selected[index] = true;
    }
    selected
}

fn flattening_background(gray: &GrayImage) -> Result<GrayImage, UnrecognizedReason> {
    let width = gray.width();
    let height = gray.height();
    let longest_side = width.max(height);
    // Illumination is smooth while printed regions have sharp, enclosing boundaries. The edge
    // measurements scale with resolution. Normally the background is the region reachable from
    // the page boundary. If a frame blocks that boundary (or leaves only a tiny leak), the largest
    // region outside the edge barrier is the page background; smaller enclosed regions remain
    // content. If no open pixel exists, the robust page level is the only safe illumination seed.
    let barrier = edge_barrier(gray, longest_side)?;
    let illumination_radius = (longest_side / 12).max(1);

    let mut reachable = vec![false; barrier.len()];
    let mut queue = VecDeque::new();
    for x in 0..width {
        queue.push_back((x, 0));
        queue.push_back((x, height - 1));
    }
    for y in 0..height {
        queue.push_back((0, y));
        queue.push_back((width - 1, y));
    }
    while let Some((x, y)) = queue.pop_front() {
        let index = (y * width + x) as usize;
        if reachable[index] || barrier[index] {
            continue;
        }
        reachable[index] = true;
        for (next_x, next_y) in [
            (x.saturating_sub(1), y),
            (x.saturating_add(1), y),
            (x, y.saturating_sub(1)),
            (x, y.saturating_add(1)),
        ] {
            if next_x < width && next_y < height {
                queue.push_back((next_x, next_y));
            }
        }
    }
    let minimum_boundary_background = barrier.len().div_ceil(100);
    if reachable.iter().filter(|value| **value).count() < minimum_boundary_background {
        reachable = largest_open_region(&barrier, width, height);
    }
    if !reachable.iter().any(|value| *value) {
        return bounded_image(width, height, high_page_level(gray));
    }

    let mut inpainted = gray.clone();
    let mut source_queue = VecDeque::new();
    for y in 0..height {
        for x in 0..width {
            if reachable[(y * width + x) as usize]
                && [
                    (x.saturating_sub(1), y),
                    (x.saturating_add(1), y),
                    (x, y.saturating_sub(1)),
                    (x, y.saturating_add(1)),
                ]
                .into_iter()
                .any(|(next_x, next_y)| {
                    next_x < width
                        && next_y < height
                        && !reachable[(next_y * width + next_x) as usize]
                })
            {
                source_queue.push_back((x, y));
            }
        }
    }
    while let Some((x, y)) = source_queue.pop_front() {
        let value = inpainted.get_pixel(x, y)[0];
        for (next_x, next_y) in [
            (x.saturating_sub(1), y),
            (x.saturating_add(1), y),
            (x, y.saturating_sub(1)),
            (x, y.saturating_add(1)),
        ] {
            if next_x >= width || next_y >= height {
                continue;
            }
            let index = (next_y * width + next_x) as usize;
            if !reachable[index] {
                reachable[index] = true;
                inpainted.put_pixel(next_x, next_y, Luma([value]));
                source_queue.push_back((next_x, next_y));
            }
        }
    }
    box_filter_scaled(&inpainted, illumination_radius)
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
                    (current_x.saturating_sub(1), current_y.saturating_sub(1)),
                    (current_x.saturating_sub(1), current_y),
                    (current_x.saturating_sub(1), current_y.saturating_add(1)),
                    (current_x.saturating_add(1), current_y),
                    (current_x, current_y.saturating_sub(1)),
                    (current_x, current_y.saturating_add(1)),
                    (current_x.saturating_add(1), current_y.saturating_sub(1)),
                    (current_x.saturating_add(1), current_y.saturating_add(1)),
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
    requested_quad: Option<Quad>,
) -> Result<CleanedScan, UnrecognizedReason> {
    if !options.dpi.is_finite() || options.dpi <= 0.0 {
        return Err(UnrecognizedReason::InvalidDpi);
    }
    checked_pixel_count(gray.width(), gray.height())?;
    let applied_quad = requested_quad.or_else(|| detect_page_quad(gray));
    if let Some(quad) = applied_quad {
        let max_x = gray.width().saturating_sub(1) as f32;
        let max_y = gray.height().saturating_sub(1) as f32;
        if quad.iter().any(|(x, y)| {
            !x.is_finite() || !y.is_finite() || *x < 0.0 || *y < 0.0 || *x > max_x || *y > max_y
        }) || (0..4)
            .any(|index| cross(quad[index], quad[(index + 1) % 4], quad[(index + 2) % 4]) <= 0.0)
        {
            return Err(UnrecognizedReason::DegeneratePageQuad);
        }
    }
    let rectified = if let Some(quad) = applied_quad {
        let full_frame = [
            (0.0, 0.0),
            (gray.width().saturating_sub(1) as f32, 0.0),
            (
                gray.width().saturating_sub(1) as f32,
                gray.height().saturating_sub(1) as f32,
            ),
            (0.0, gray.height().saturating_sub(1) as f32),
        ];
        if quad == full_frame {
            gray.clone()
        } else {
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
        }
    } else {
        gray.clone()
    };
    let skew_degrees = if options.deskew {
        deskew_angle(&rectified)
    } else {
        0.0
    };
    let rotated = if options.deskew {
        rotate_centered(&rectified, skew_degrees)?
    } else {
        RotatedImage { image: rectified }
    };
    let straight = rotated.image;
    let background = flattening_background(&straight)?;
    let mut flattened = bounded_image(straight.width(), straight.height(), 0)?;
    for (x, y, pixel) in flattened.enumerate_pixels_mut() {
        let source_value = straight.get_pixel(x, y)[0];
        let value = f32::from(source_value);
        let base = f32::from(background.get_pixel(x, y)[0].max(1));
        *pixel = Luma([(value * 245.0 / base).min(255.0).round() as u8]);
    }
    let binary = threshold_document(&flattened)?;
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
    let pixel_count =
        checked_pixel_count(width, height).map_err(|_| UnrecognizedReason::InvalidDimensions)?;
    let expected = width
        .checked_mul(height)
        .and_then(|count| count.checked_mul(4))
        .and_then(|count| usize::try_from(count).ok())
        .ok_or(UnrecognizedReason::InvalidDimensions)?;
    if pixels.len() != expected {
        return Err(UnrecognizedReason::InvalidPixelBuffer);
    }
    let mut gray = Vec::with_capacity(pixel_count);
    for pixel in pixels.chunks_exact(4) {
        let alpha = f32::from(pixel[3]) / 255.0;
        let luminance = 0.2126 * f32::from(pixel[0])
            + 0.7152 * f32::from(pixel[1])
            + 0.0722 * f32::from(pixel[2]);
        gray.push((luminance * alpha + 255.0 * (1.0 - alpha)).round() as u8);
    }
    gray_image(width, height, &gray)
}

#[cfg(test)]
mod property_tests;

#[cfg(test)]
mod tests;
