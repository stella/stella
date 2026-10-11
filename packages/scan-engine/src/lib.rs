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
const MIN_INK_RETENTION_PERCENT: usize = 75;
const INK_TILE_SIDE: u32 = 8;
const MIN_TILE_INK_PIXELS: usize = 16;
const PAGE_REFERENCE_TOLERANCE: u8 = 50;
const SOURCE_TILE_RETENTION_PERCENT: usize = 95;
const SOURCE_TILE_INK_FRACTION_DIVISOR: usize = 200;
const MIN_QUAD_SCORE: f32 = 0.70;
const QUAD_MARGIN_REFERENCE: f32 = 0.15;
const QUAD_MARGIN_WEIGHT: f32 = 0.20;
const QUAD_AREA_RANK_WEIGHT: f32 = 0.10;
const QUAD_CLUSTER_FRAME_FRACTION: f32 = 0.08;
const SOURCE_CONTEXT_FRACTION: f32 = 0.25;
const PAPER_COVERAGE_STEP: usize = 4;
const MAX_NATIVE_GUARD_PIXEL_CHECKS: u64 = 320_000_000;

fn quad_score(geometry: f32, support: f32, enclosure: f32, margin: f32) -> f32 {
    geometry.powf(0.20)
        * support.powf(0.35)
        * enclosure.powf(0.25)
        * margin.powf(QUAD_MARGIN_WEIGHT)
}
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
    ContentLoss,
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
            Self::ContentLoss => "content-loss",
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

fn side_length(a: Point, b: Point) -> f32 {
    ((b.0 - a.0).powi(2) + (b.1 - a.1).powi(2)).sqrt()
}

/// Continuous projective plausibility around Letter, A-series and Legal paper.
/// Convexity is an invariant; perspective and format departures reduce confidence.
fn geometry_score(quad: Quad, whole: f32) -> f32 {
    let area_fraction = polygon_area(&quad) / whole;
    let mut score = (area_fraction / 0.06)
        .min((1.0 - area_fraction) / 0.06)
        .clamp(0.0, 1.0);
    let sides = std::array::from_fn::<_, 4, _>(|i| side_length(quad[i], quad[(i + 1) % 4]));
    for i in 0..4 {
        if sides[i] <= 0.0 || cross(quad[i], quad[(i + 1) % 4], quad[(i + 2) % 4]) <= 0.0 {
            return 0.0;
        }
        let previous = quad[(i + 3) % 4];
        let next = quad[(i + 1) % 4];
        let cosine = ((previous.0 - quad[i].0) * (next.0 - quad[i].0)
            + (previous.1 - quad[i].1) * (next.1 - quad[i].1))
            / (sides[(i + 3) % 4] * sides[i]);
        if !cosine.is_finite() {
            return 0.0;
        }
        score = score
            .min(((1.0 - cosine.abs()) / (1.0 - std::f32::consts::FRAC_1_SQRT_2)).clamp(0.0, 1.0));
        let ratio = sides[i] / sides[(i + 2) % 4];
        score = score.min((ratio.min(1.0 / ratio) / 0.5).clamp(0.0, 1.0));
    }
    let ratio = (sides[0] + sides[2]) / (sides[1] + sides[3]);
    let aspect = ratio.max(1.0 / ratio);
    let format_error = [1.294_f32, std::f32::consts::SQRT_2, 1.647]
        .iter()
        .map(|paper| (aspect / paper - 1.0).abs())
        .fold(f32::INFINITY, f32::min);
    score.min(((0.40 - format_error) / 0.12).clamp(0.0, 1.0))
}

// Move each reduced hull side outward to contain the complete contour. Dropping
// curved hull vertices must never turn a page envelope into an interior crop.
fn enclosing_quad(envelope: &[Point]) -> Option<Quad> {
    let quad = reduce_quad(envelope.to_vec())?;
    let lines = std::array::from_fn::<_, 4, _>(|i| {
        let a = quad[i];
        let b = quad[(i + 1) % 4];
        let length = side_length(a, b);
        let normal = (-(b.1 - a.1) / length, (b.0 - a.0) / length);
        let level = envelope
            .iter()
            .map(|p| normal.0 * p.0 + normal.1 * p.1)
            .fold(f32::INFINITY, f32::min);
        (normal, level)
    });
    let mut corners = [(0.0, 0.0); 4];
    for i in 0..4 {
        let (a, ca) = lines[(i + 3) % 4];
        let (b, cb) = lines[i];
        let determinant = a.0 * b.1 - a.1 * b.0;
        if determinant.abs() < 0.001 {
            return None;
        }
        corners[i] = (
            (ca * b.1 - a.1 * cb) / determinant,
            (a.0 * cb - ca * b.0) / determinant,
        );
    }
    Some(corners)
}

/// Find a sharp boundary in a bounded perpendicular band along every quarter
/// of a side. Curved paper need not coincide with its enclosing straight quad.
fn side_support(gray: &GrayImage, a: Point, b: Point) -> f32 {
    let length = side_length(a, b);
    let normal = (-(b.1 - a.1) / length, (b.0 - a.0) / length);
    let band = (length * 0.08).clamp(4.0, 24.0) as i32;
    let mut quarters = [0_u32; 4];
    let sample = |point: Point| {
        if point.0 < 0.0
            || point.1 < 0.0
            || point.0 >= gray.width() as f32
            || point.1 >= gray.height() as f32
        {
            return None;
        }
        Some(gray.get_pixel(point.0 as u32, point.1 as u32)[0])
    };
    for i in 0..64 {
        let t = (i as f32 + 0.5) / 64.0;
        let p = (a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t);
        let supported = (-band..=band).step_by(2).any(|shift| {
            [2.0, 4.0, 6.0].into_iter().any(|offset| {
                let at = |distance: f32| {
                    sample((
                        p.0 + normal.0 * (shift as f32 + distance),
                        p.1 + normal.1 * (shift as f32 + distance),
                    ))
                };
                let (Some(inside), Some(outside), Some(inward), Some(outward)) =
                    (at(offset), at(-offset), at(2.0 * offset), at(-2.0 * offset))
                else {
                    return false;
                };
                let contrast = u16::from(inside.abs_diff(outside));
                let noise =
                    u16::from(inside.abs_diff(inward)) + u16::from(outside.abs_diff(outward));
                // Flanks must be quieter than the edge. Smooth illumination
                // cannot pass by merely accumulating a larger difference.
                contrast >= 3 && contrast > 2 * noise
            })
        });
        if supported {
            quarters[i / 16] += 1;
        }
    }
    let total = quarters.iter().sum::<u32>() as f32 / 64.0;
    let weakest_quarter = quarters.into_iter().min().unwrap_or(0) as f32 / 16.0;
    // Every quarter contributes: corners alone cannot stand in for a whole edge.
    (total * weakest_quarter).sqrt()
}

// A blank rectangle can be furniture or a solid illustration. Require sparse
// text-like valleys away from its boundary before treating it as a page.
fn has_page_ink(gray: &GrayImage, quad: Quad) -> bool {
    let mut samples = 0_u32;
    let mut ink = 0_u32;
    for y in (0..gray.height()).step_by(2) {
        for x in (0..gray.width()).step_by(2) {
            let p = (x as f32, y as f32);
            if !(0..4).all(|i| {
                cross(quad[i], quad[(i + 1) % 4], p) > side_length(quad[i], quad[(i + 1) % 4]) * 8.0
            }) {
                continue;
            }
            samples += 1;
            if stroke_contrast(gray, x, y) >= MIN_FOREGROUND_CONTRAST {
                ink += 1;
            }
        }
    }
    samples > 0 && (0.01..=0.50).contains(&(ink as f32 / samples as f32))
}

fn paper_coverage(gray: &GrayImage, quad: Quad) -> f32 {
    let mut histogram = [0_u32; 256];
    let mut samples = Vec::new();
    for y in (0..gray.height()).step_by(PAPER_COVERAGE_STEP) {
        for x in (0..gray.width()).step_by(PAPER_COVERAGE_STEP) {
            if !(0..4).all(|i| cross(quad[i], quad[(i + 1) % 4], (x as f32, y as f32)) >= 0.0) {
                continue;
            }
            let value = gray.get_pixel(x, y)[0];
            histogram[usize::from(value)] += 1;
            samples.push((x, y, value));
        }
    }
    if samples.is_empty() {
        return 0.0;
    }
    let floor = high_histogram_level(&histogram, samples.len() as u32)
        .saturating_sub(PAGE_REFERENCE_TOLERANCE);
    let paper = samples
        .iter()
        .filter(|&&(x, y, value)| {
            if value >= floor {
                return true;
            }
            let background = stroke_background(gray, x, y);
            background >= floor && background.saturating_sub(value) >= MIN_FOREGROUND_CONTRAST
        })
        .count();
    paper as f32 / samples.len() as f32
}

#[derive(Clone, Copy, PartialEq)]
enum QuadBoundary {
    Enclosing,
    Tight,
}

#[derive(Clone, Copy)]
struct QuadCandidate {
    quad: Quad,
    score: f32,
    rank: f32,
}

struct QuadCluster {
    best: QuadCandidate,
    enclosing: Option<QuadCandidate>,
}

/// Detects a page surrounded by a contrasting background, of either polarity.
/// Ambiguous candidates leave the original geometry untouched.
#[must_use]
pub fn detect_page_quad(gray: &GrayImage) -> Option<Quad> {
    detect_page_quad_with_budget(gray, MAX_NATIVE_GUARD_PIXEL_CHECKS)
}

fn detect_page_quad_with_budget(gray: &GrayImage, mut native_pixel_budget: u64) -> Option<Quad> {
    let scale = (750.0 / gray.width().max(gray.height()) as f32).min(1.0);
    let width = ((gray.width() as f32 * scale).round() as u32).max(1);
    let height = ((gray.height() as f32 * scale).round() as u32).max(1);
    let small = imageops::resize(gray, width, height, imageops::FilterType::Triangle);
    let smooth = box_filter(&small, 2, 2);
    let whole = width as f32 * height as f32;
    let mut clusters: Vec<QuadCluster> = Vec::new();
    let mut inverted = smooth.clone();
    imageops::invert(&mut inverted);
    for image in [&smooth, &inverted] {
        for threshold in (70..=220).step_by(5) {
            for contour in find_contours_with_threshold::<i32>(image, threshold) {
                if contour.parent.is_some() || contour.points.len() < 60 {
                    continue;
                }
                let points = contour
                    .points
                    .iter()
                    .map(|p| (p.x as f32, p.y as f32))
                    .collect::<Vec<_>>();
                // A hull can turn sparse connected texture into a convincing rectangle.
                // Score the occupied contour, not the empty area added by its convex hull.
                let area = polygon_area(&points);
                let envelope = hull(points);
                let enclosing = enclosing_quad(&envelope);
                let reduced = reduce_quad(envelope.clone()).filter(|reduced| {
                    enclosing.is_none_or(|enclosing| {
                        enclosing
                            .iter()
                            .zip(reduced)
                            .map(|(a, b)| side_length(*a, *b))
                            .sum::<f32>()
                            / 4.0
                            >= 1.0
                    })
                });
                for (quad, boundary) in [
                    (enclosing, QuadBoundary::Enclosing),
                    (reduced, QuadBoundary::Tight),
                ]
                .into_iter()
                .filter_map(|(quad, boundary)| quad.map(|quad| (quad, boundary)))
                {
                    let geometry = geometry_score(quad, whole);
                    let enclosure = (area / polygon_area(&quad)).clamp(0.0, 1.0);
                    // Reject only when perfect edge evidence cannot reach acceptance.
                    if quad_score(geometry, 1.0, enclosure, 1.0) < MIN_QUAD_SCORE {
                        continue;
                    }
                    if quad.iter().any(|p| {
                        p.0 < 0.0
                            || p.1 < 0.0
                            || p.0 > width as f32 - 1.0
                            || p.1 > height as f32 - 1.0
                    }) {
                        continue;
                    }
                    let frame_corners = quad
                        .iter()
                        .filter(|p| {
                            p.0 < 3.0
                                || p.1 < 3.0
                                || p.0 > width as f32 - 4.0
                                || p.1 > height as f32 - 4.0
                        })
                        .count();
                    if frame_corners > 1 {
                        continue;
                    }
                    let support = (0..4)
                        .map(|i| side_support(&small, quad[i], quad[(i + 1) % 4]))
                        .fold(1.0_f32, f32::min);
                    let score = quad_score(geometry, support, enclosure, 1.0);
                    if score < MIN_QUAD_SCORE {
                        continue;
                    }
                    let rank = score * (polygon_area(&quad) / whole).powf(QUAD_AREA_RANK_WEIGHT);
                    // Thresholds produce repeated contours of the same physical sheet.
                    // Cluster near-identical corners before measuring runner-up confidence.
                    let duplicate = clusters.iter_mut().find(|cluster| {
                        cluster
                            .best
                            .quad
                            .iter()
                            .zip(quad)
                            .map(|(a, b)| side_length(*a, b))
                            .sum::<f32>()
                            / 4.0
                            < width.max(height) as f32 * QUAD_CLUSTER_FRAME_FRACTION
                    });
                    let can_improve = duplicate.as_ref().is_none_or(|cluster| {
                        rank > cluster.best.rank
                            || (boundary == QuadBoundary::Enclosing
                                && cluster
                                    .enclosing
                                    .is_none_or(|existing| rank > existing.rank))
                    });
                    if !can_improve || !has_page_ink(&small, quad) {
                        continue;
                    }
                    let score = quad_score(
                        geometry,
                        support,
                        enclosure * paper_coverage(&small, quad),
                        1.0,
                    );
                    if score < MIN_QUAD_SCORE {
                        continue;
                    }
                    let rank = score * (polygon_area(&quad) / whole).powf(QUAD_AREA_RANK_WEIGHT);
                    let candidate = QuadCandidate { quad, score, rank };
                    if let Some(cluster) = duplicate {
                        if rank > cluster.best.rank {
                            cluster.best = candidate;
                        }
                        if boundary == QuadBoundary::Enclosing
                            && cluster
                                .enclosing
                                .is_none_or(|existing| rank > existing.rank)
                        {
                            cluster.enclosing = Some(candidate);
                        }
                    } else {
                        let enclosing = match boundary {
                            QuadBoundary::Enclosing => Some(candidate),
                            QuadBoundary::Tight => None,
                        };
                        clusters.push(QuadCluster {
                            best: candidate,
                            enclosing,
                        });
                    }
                }
            }
        }
    }
    if clusters.is_empty() {
        return None;
    }
    clusters.sort_by(|a, b| b.best.rank.total_cmp(&a.best.rank));
    let source_evidence = SourceContentEvidence::new(gray);
    let source_pixels = u64::from(gray.width()) * u64::from(gray.height());
    let mut candidates: Vec<QuadCandidate> = Vec::new();
    for cluster in clusters {
        // Later clusters cannot outrank an already validated runner-up.
        if candidates
            .get(1)
            .is_some_and(|runner_up| cluster.best.rank <= runner_up.rank)
        {
            break;
        }
        for candidate in [Some(cluster.best), cluster.enclosing]
            .into_iter()
            .flatten()
        {
            native_pixel_budget = native_pixel_budget.checked_sub(source_pixels)?;
            if source_evidence.retains(candidate.quad.map(|p| (p.0 / scale, p.1 / scale))) {
                candidates.push(candidate);
                candidates.sort_by(|a, b| b.rank.total_cmp(&a.rank));
                candidates.truncate(2);
                break;
            }
            if cluster
                .enclosing
                .is_none_or(|enclosing| enclosing.quad == cluster.best.quad)
            {
                break;
            }
        }
    }
    let best = candidates.first()?;
    let margin = candidates.get(1).map_or(1.0, |runner_up| {
        ((1.0 - runner_up.rank / best.rank) / QUAD_MARGIN_REFERENCE).clamp(0.0, 1.0)
    });
    if best.score * margin.powf(QUAD_MARGIN_WEIGHT) < MIN_QUAD_SCORE {
        return None;
    }
    Some(best.quad.map(|p| (p.0 / scale, p.1 / scale)))
}

struct SourceContentEvidence<'a> {
    gray: &'a GrayImage,
    backgrounds: Vec<u8>,
    page_level: u8,
}

impl<'a> SourceContentEvidence<'a> {
    fn new(gray: &'a GrayImage) -> Self {
        let backgrounds = gray
            .enumerate_pixels()
            .map(|(x, y, pixel)| {
                let background = stroke_background(gray, x, y);
                if background.saturating_sub(pixel[0]) >= MIN_FOREGROUND_CONTRAST {
                    background
                } else {
                    0
                }
            })
            .collect();
        Self {
            gray,
            backgrounds,
            page_level: high_page_level(gray, None),
        }
    }

    fn retains(&self, quad: Quad) -> bool {
        let gray = self.gray;
        // Bright source valleys add evidence of separate printed regions without
        // treating dark carpet/wood texture as paper. The post-warp guard still
        // checks all strokes, including dim text, in the selected region.
        let floor = high_page_level(gray, Some(quad))
            .max(self.page_level)
            .saturating_sub(PAGE_REFERENCE_TOLERANCE);
        let pixels = self
            .backgrounds
            .iter()
            .map(|background| *background > 0 && *background >= floor)
            .collect::<Vec<_>>();
        let count = pixels.iter().filter(|ink| **ink).count();
        let mut ink = InkEstimate {
            pixels,
            count,
            width: gray.width(),
            height: gray.height(),
        };
        // Nearby print may be a clipped continuation of this sheet. Distant bright
        // objects (for example a screen) are not evidence about its content.
        let context = (0..4)
            .map(|i| side_length(quad[i], quad[(i + 1) % 4]))
            .fold(0.0_f32, f32::max)
            * SOURCE_CONTEXT_FRACTION;
        let original_ink_count = ink.count;
        let source_width = ink.width as usize;
        let in_context = |index: usize| {
            let point = ((index % source_width) as f32, (index / source_width) as f32);
            (0..4).all(|i| {
                cross(quad[i], quad[(i + 1) % 4], point)
                    >= -context * side_length(quad[i], quad[(i + 1) % 4])
            })
        };
        let distant = ink
            .pixels
            .iter()
            .enumerate()
            .filter(|(index, pixel)| **pixel && !in_context(*index))
            .count();
        // Distant objects may veto a genuinely wrong crop when they contain most
        // of the printed evidence; only a minor distant region can be excluded.
        if distant * 100 <= ink.count * (100 - MIN_INK_RETENTION_PERCENT) {
            for (index, pixel) in ink.pixels.iter_mut().enumerate() {
                if *pixel && !in_context(index) {
                    *pixel = false;
                }
            }
            ink.count -= distant;
        }
        let minimum_tile_ink = ink
            .count
            .div_ceil(SOURCE_TILE_INK_FRACTION_DIVISOR)
            .max(MIN_TILE_INK_PIXELS);
        ink.retained_where(
            InkRetentionOptions {
                minimum_tile_ink,
                original_ink_count,
                minimum_tile_retention_percent: SOURCE_TILE_RETENTION_PERCENT,
            },
            |x, y| (0..4).all(|i| cross(quad[i], quad[(i + 1) % 4], (x as f32, y as f32)) >= 0.0),
        )
    }
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

fn high_page_level(gray: &GrayImage, quad: Option<Quad>) -> u8 {
    let mut counts = [0_u32; 256];
    let mut samples = 0_u32;
    for (x, y, pixel) in gray.enumerate_pixels() {
        if quad.is_some_and(|quad| {
            !(0..4).all(|i| cross(quad[i], quad[(i + 1) % 4], (x as f32, y as f32)) >= 0.0)
        }) {
            continue;
        }
        counts[usize::from(pixel[0])] += 1;
        samples += 1;
    }
    high_histogram_level(&counts, samples)
}

fn high_histogram_level(counts: &[u32; 256], samples: u32) -> u8 {
    let target = samples.saturating_mul(9) / 10;
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

// A text-like dark valley has lighter pixels on both sides of a narrow stroke.
// Opposing samples exclude monotonic fold gradients and broad shaded interiors.
fn stroke_contrast(gray: &GrayImage, x: u32, y: u32) -> u8 {
    stroke_background(gray, x, y).saturating_sub(gray.get_pixel(x, y)[0])
}

fn stroke_background(gray: &GrayImage, x: u32, y: u32) -> u8 {
    let mut background = 0;
    for radius in [2, 4, 8] {
        if x >= radius && x + radius < gray.width() {
            background = background
                .max(gray.get_pixel(x - radius, y)[0].min(gray.get_pixel(x + radius, y)[0]));
        }
        if y >= radius && y + radius < gray.height() {
            background = background
                .max(gray.get_pixel(x, y - radius)[0].min(gray.get_pixel(x, y + radius)[0]));
        }
    }
    background
}

struct InkEstimate {
    pixels: Vec<bool>,
    count: usize,
    width: u32,
    height: u32,
}

struct InkRetentionOptions {
    minimum_tile_ink: usize,
    original_ink_count: usize,
    minimum_tile_retention_percent: usize,
}

impl InkEstimate {
    fn from_image(source: &GrayImage) -> Self {
        let pixels: Vec<bool> = source
            .enumerate_pixels()
            .map(|(x, y, pixel)| {
                let background = stroke_background(source, x, y);
                background.saturating_sub(pixel[0]) >= MIN_FOREGROUND_CONTRAST
            })
            .collect();
        let count = pixels.iter().filter(|ink| **ink).count();
        Self {
            pixels,
            count,
            width: source.width(),
            height: source.height(),
        }
    }

    fn retained_in_bounds(
        &self,
        output: &GrayImage,
        mode: CleanOutput,
        bounds: ContentBox,
    ) -> bool {
        self.retained_where(
            InkRetentionOptions {
                minimum_tile_ink: MIN_TILE_INK_PIXELS,
                original_ink_count: self.count,
                minimum_tile_retention_percent: MIN_INK_RETENTION_PERCENT,
            },
            |x, y| {
                if x < bounds.x
                    || y < bounds.y
                    || x >= bounds.x + bounds.width
                    || y >= bounds.y + bounds.height
                {
                    return false;
                }
                match mode {
                    CleanOutput::Binary => output.get_pixel(x, y)[0] == 0,
                    CleanOutput::Grayscale => {
                        stroke_contrast(output, x, y) >= MIN_FOREGROUND_CONTRAST
                    }
                }
            },
        )
    }

    fn retained_where(
        &self,
        InkRetentionOptions {
            minimum_tile_ink,
            original_ink_count,
            minimum_tile_retention_percent,
        }: InkRetentionOptions,
        preserved: impl Fn(u32, u32) -> bool,
    ) -> bool {
        let mut source_tiles = [0_usize; (INK_TILE_SIDE * INK_TILE_SIDE) as usize];
        let mut retained_tiles = [0_usize; (INK_TILE_SIDE * INK_TILE_SIDE) as usize];
        let mut retained = 0_usize;
        for (index, ink) in self.pixels.iter().enumerate() {
            if !*ink {
                continue;
            }
            let x = (index % self.width as usize) as u32;
            let y = (index / self.width as usize) as u32;
            let tile = ((y * INK_TILE_SIDE / self.height) * INK_TILE_SIDE
                + x * INK_TILE_SIDE / self.width) as usize;
            source_tiles[tile] += 1;
            if preserved(x, y) {
                retained += 1;
                retained_tiles[tile] += 1;
            }
        }
        retained * 100 >= original_ink_count * MIN_INK_RETENTION_PERCENT
            && source_tiles
                .iter()
                .zip(retained_tiles)
                .all(|(source, retained)| {
                    *source < minimum_tile_ink
                        || retained * 100 >= source * minimum_tile_retention_percent
                })
    }

    fn retained_in(&self, output: &GrayImage, mode: CleanOutput) -> bool {
        let bounds = ContentBox {
            x: 0,
            y: 0,
            width: output.width(),
            height: output.height(),
        };
        self.retained_in_bounds(output, mode, bounds)
    }
}

#[cfg(test)]
fn retains_ink(source: &GrayImage, output: &GrayImage, mode: CleanOutput) -> bool {
    InkEstimate::from_image(source).retained_in(output, mode)
}

fn threshold_document(flattened: &GrayImage, offset: i32) -> Result<GrayImage, UnrecognizedReason> {
    let local_mean = box_filter_scaled(flattened, 20)?;
    let mut output = bounded_image(flattened.width(), flattened.height(), 0)?;
    for (x, y, pixel) in output.enumerate_pixels_mut() {
        let value = flattened.get_pixel(x, y)[0];
        let foreground = i32::from(value) < i32::from(local_mean.get_pixel(x, y)[0]) - offset
            && stroke_contrast(flattened, x, y) >= MIN_FOREGROUND_CONTRAST;
        *pixel = Luma([if foreground { 0 } else { 255 }]);
    }
    Ok(output)
}

fn threshold_strokes(source: &GrayImage) -> Result<GrayImage, UnrecognizedReason> {
    let mut output = bounded_image(source.width(), source.height(), 255)?;
    for (x, y, pixel) in output.enumerate_pixels_mut() {
        if stroke_contrast(source, x, y) >= MIN_FOREGROUND_CONTRAST {
            *pixel = Luma([0]);
        }
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
        return bounded_image(width, height, high_page_level(gray, None));
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
) -> Result<CleanedScan, UnrecognizedReason> {
    if !options.dpi.is_finite() || options.dpi <= 0.0 {
        return Err(UnrecognizedReason::InvalidDpi);
    }
    checked_pixel_count(gray.width(), gray.height())?;
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
    let rotated = if options.deskew {
        rotate_centered(&rectified, skew_degrees)?
    } else {
        RotatedImage { image: rectified }
    };
    let straight = rotated.image;
    let ink = InkEstimate::from_image(&straight);
    let background = flattening_background(&straight)?;
    let mut flattened = bounded_image(straight.width(), straight.height(), 0)?;
    for (x, y, pixel) in flattened.enumerate_pixels_mut() {
        let source_value = straight.get_pixel(x, y)[0];
        let value = f32::from(source_value);
        let base = f32::from(background.get_pixel(x, y)[0].max(1));
        *pixel = Luma([(value * 245.0 / base).min(255.0).round() as u8]);
    }
    if !ink.retained_in(&flattened, CleanOutput::Grayscale) {
        flattened = straight.clone();
    }
    let mut binary = threshold_document(&flattened, ADAPTIVE_THRESHOLD_OFFSET)?;
    if !ink.retained_in(&binary, CleanOutput::Binary) {
        binary = threshold_document(&straight, ADAPTIVE_THRESHOLD_OFFSET)?;
    }
    if !ink.retained_in(&binary, CleanOutput::Binary) {
        binary = threshold_document(&straight, 0)?;
    }
    if !ink.retained_in(&binary, CleanOutput::Binary) {
        // Dense or faint text can lower the adaptive mean beneath its stroke fringes. After
        // dropping flattening, retain local stroke contrast alone; opposing samples still
        // exclude broad shadows and filled interiors. The requested output remains binary.
        binary = threshold_strokes(&straight)?;
    }
    if options.output == CleanOutput::Binary && !ink.retained_in(&binary, CleanOutput::Binary) {
        return Err(UnrecognizedReason::ContentLoss);
    }
    let binary_content = content_bounds(&binary, options.dpi);
    let content = match (binary_content, options.output) {
        (Some(content), _) => content,
        (None, CleanOutput::Binary) => return Err(UnrecognizedReason::NoContent),
        (None, CleanOutput::Grayscale) => {
            // Grayscale also represents solid illustrations, which deliberately have no binary
            // stroke mask. Use absolute foreground only for bounds of this preserved output.
            let threshold = page_background(&flattened).saturating_sub(MIN_FOREGROUND_CONTRAST);
            let mut mask = bounded_image(flattened.width(), flattened.height(), 255)?;
            for (x, y, pixel) in mask.enumerate_pixels_mut() {
                *pixel = Luma([if flattened.get_pixel(x, y)[0] <= threshold {
                    0
                } else {
                    255
                }]);
            }
            content_bounds(&mask, options.dpi).ok_or(UnrecognizedReason::NoContent)?
        }
    };
    let selected = match options.output {
        CleanOutput::Grayscale => flattened,
        CleanOutput::Binary => binary,
    };
    if !options.content_crop || applied_quad.is_none() {
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
    let crop_bounds = ContentBox {
        x,
        y,
        width: right - x,
        height: bottom - y,
    };
    if !ink.retained_in_bounds(&selected, options.output, crop_bounds) {
        return Ok(CleanedScan {
            image: selected,
            applied_quad,
            skew_degrees,
            content_box: content,
        });
    }
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

#[cfg(test)]
mod content_tests;

#[cfg(test)]
mod preservation_tests;

#[cfg(test)]
mod quad_tests;
