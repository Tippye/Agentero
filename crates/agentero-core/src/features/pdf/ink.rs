//! Portable sidecar ink for `marks/ink/p<page>.json`; never modifies a source PDF.
//!
//! Positions and widths are PDF points in the visible crop's unrotated, top-left,
//! y-down space, matching EmbedPDF annotations. Page numbers are one-based.
//! Keep tombstones until every replica has acknowledged them; omission is not deletion.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const INK_VERSION: u32 = 1;

#[derive(Debug, thiserror::Error)]
pub enum InkError {
    #[error("invalid ink: {0}")]
    Invalid(&'static str),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

type Result<T> = std::result::Result<T, InkError>;

fn require(ok: bool, message: &'static str) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(InkError::Invalid(message))
    }
}

/// Lamport counter, incremented above all observed revisions when editing an ID.
/// Actor is a stable, non-nil replica UUID. Wall clocks never determine winners.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InkRevision {
    pub counter: u64,
    pub actor: Uuid,
}

impl InkRevision {
    fn validate(self) -> Result<()> {
        require(self.counter > 0 && !self.actor.is_nil(), "invalid revision")
    }

    pub fn next(self, actor: Uuid) -> Result<Self> {
        self.validate()?;
        let next = Self {
            counter: self
                .counter
                .checked_add(1)
                .ok_or(InkError::Invalid("revision exhausted"))?,
            actor,
        };
        next.validate()?;
        Ok(next)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InkTool {
    Pen,
    Highlighter,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InkPoint {
    pub x: f64,
    pub y: f64,
    /// Normalized [0, 1]; None means unavailable, not zero pressure.
    pub pressure: Option<f64>,
    /// Milliseconds since stroke start, not a wall clock. Present samples must
    /// be nondecreasing; the first observed sample may be later than zero.
    pub elapsed_ms: Option<u64>,
    /// Degrees in [-90, 90] about each device axis; unavailable as a pair.
    pub tilt: Option<[f64; 2]>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InkStroke {
    pub id: Uuid,
    pub page: u32,
    pub revision: InkRevision,
    pub tool: InkTool,
    /// RGBA bytes, including opacity, independent of any platform color syntax.
    pub color: [u8; 4],
    pub base_width: f64,
    pub points: Vec<InkPoint>,
    /// Unix milliseconds, metadata only; updated_at_ms >= created_at_ms.
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}

impl InkStroke {
    pub fn validate(&self) -> Result<()> {
        require(
            !self.id.is_nil() && self.page > 0,
            "invalid stroke ID or page",
        )?;
        self.revision.validate()?;
        require(
            self.base_width.is_finite() && self.base_width > 0.0,
            "invalid width",
        )?;
        require(!self.points.is_empty(), "empty stroke")?; // A single point is a dot.
        require(
            self.updated_at_ms >= self.created_at_ms,
            "timestamps reversed",
        )?;
        let mut previous_time = None;
        for point in &self.points {
            finite_point([point.x, point.y])?;
            if let Some(pressure) = point.pressure {
                require(
                    pressure.is_finite() && (0.0..=1.0).contains(&pressure),
                    "invalid pressure",
                )?;
            }
            if let Some(tilt) = point.tilt {
                require(
                    tilt.iter()
                        .all(|v| v.is_finite() && (-90.0..=90.0).contains(v)),
                    "invalid tilt",
                )?;
            }
            if let Some(time) = point.elapsed_ms {
                require(
                    previous_time.is_none_or(|previous| time >= previous),
                    "sample times reversed",
                )?;
                previous_time = Some(time);
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InkTombstone {
    pub id: Uuid,
    pub revision: InkRevision,
    /// Unix milliseconds, metadata only.
    pub deleted_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InkPage {
    pub version: u32,
    pub page: u32,
    pub strokes: Vec<InkStroke>,
    pub tombstones: Vec<InkTombstone>,
}

impl InkPage {
    pub fn new(page: u32) -> Result<Self> {
        let document = Self {
            version: INK_VERSION,
            page,
            strokes: vec![],
            tombstones: vec![],
        };
        document.validate()?;
        Ok(document)
    }

    /// Duplicates (including a live/deleted ID) are allowed at ingress and
    /// resolved by merge. Every record, even a losing one, must be valid.
    pub fn validate(&self) -> Result<()> {
        require(self.version == INK_VERSION, "unsupported ink version")?;
        require(self.page > 0, "invalid page")?;
        for stroke in &self.strokes {
            stroke.validate()?;
            require(stroke.page == self.page, "stroke belongs to another page")?;
        }
        for tombstone in &self.tombstones {
            require(!tombstone.id.is_nil(), "invalid tombstone ID")?;
            tombstone.revision.validate()?;
        }
        Ok(())
    }

    /// Validated, normalized ingress; do not use raw serde decoding as validation.
    pub fn from_json(json: &str) -> Result<Self> {
        let page: Self = serde_json::from_str(json)?;
        page.merge(&page)
    }

    pub fn to_json(&self) -> Result<String> {
        Ok(serde_json::to_string(&self.merge(self)?)?)
    }

    /// Per-ID maximum under (counter, deleted, actor, canonical typed JSON).
    /// Deletion wins concurrent equal counters, regardless of actor. A strictly
    /// higher counter may intentionally restore a stroke. Payload breaks even
    /// malformed writer conflicts that reuse the exact same revision.
    /// The total order makes merge associative, commutative and idempotent on
    /// normalized pages. Output is UUID-sorted and retains winning tombstones.
    pub fn merge(&self, other: &Self) -> Result<Self> {
        self.validate()?;
        other.validate()?;
        require(self.page == other.page, "cannot merge different pages")?;
        #[derive(Clone, Copy, Serialize)]
        enum Record<'a> {
            Stroke(&'a InkStroke),
            Deleted(&'a InkTombstone),
        }
        let mut winners = BTreeMap::new();
        for page in [self, other] {
            let records = page
                .strokes
                .iter()
                .map(Record::Stroke)
                .chain(page.tombstones.iter().map(Record::Deleted));
            for record in records {
                let (id, revision, deleted) = match record {
                    Record::Stroke(s) => (s.id, s.revision, false),
                    Record::Deleted(t) => (t.id, t.revision, true),
                };
                // Structs have fixed field order, no maps; finite floats were checked.
                let rank = (
                    revision.counter,
                    deleted,
                    revision.actor,
                    serde_json::to_string(&record)?,
                );
                let winner = winners.entry(id).or_insert_with(|| (rank.clone(), record));
                if rank > winner.0 {
                    *winner = (rank, record);
                }
            }
        }
        let mut merged = Self::new(self.page)?;
        for (_, (_, record)) in winners {
            match record {
                Record::Stroke(s) => merged.strokes.push(s.clone()),
                Record::Deleted(t) => merged.tombstones.push(t.clone()),
            }
        }
        Ok(merged)
    }
}

fn finite_point(point: [f64; 2]) -> Result<[f64; 2]> {
    require(point.iter().all(|v| v.is_finite()), "nonfinite coordinate")?;
    Ok(point)
}

/// Visible box (CropBox intersected with MediaBox), in PDF user space: lower-left
/// origin, y-up. The caller supplies the resolved visible box, not screen pixels.
#[derive(Debug, Clone, Copy)]
pub struct PdfCropBox {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Maps crop-relative page points to viewport input units (e.g. CSS pixels).
/// `origin` includes scrolling/panning; `scale` must use those same input units.
/// Rotation is total clockwise quarter-turns (/Rotate plus viewer rotation).
/// Coordinates outside the crop are preserved; callers decide clipping policy.
#[derive(Debug, Clone, Copy)]
pub struct PageTransform {
    crop: PdfCropBox,
    origin: [f64; 2],
    scale: f64,
    rotation: u8,
}

impl PageTransform {
    pub fn new(crop: PdfCropBox, origin: [f64; 2], scale: f64, rotation: u8) -> Result<Self> {
        finite_point([crop.x, crop.y])?;
        finite_point([crop.width, crop.height])?;
        finite_point([crop.x + crop.width, crop.y + crop.height])?;
        finite_point(origin)?;
        require(crop.width > 0.0 && crop.height > 0.0, "empty crop")?;
        require(scale.is_finite() && scale > 0.0, "invalid scale")?;
        require(rotation < 4, "rotation must be 0..3")?;
        Ok(Self {
            crop,
            origin,
            scale,
            rotation,
        })
    }

    pub fn pdf_user_to_page(&self, point: [f64; 2]) -> Result<[f64; 2]> {
        let [x, y] = finite_point(point)?;
        finite_point([x - self.crop.x, self.crop.y + self.crop.height - y])
    }

    pub fn page_to_pdf_user(&self, point: [f64; 2]) -> Result<[f64; 2]> {
        let [x, y] = finite_point(point)?;
        finite_point([x + self.crop.x, self.crop.y + self.crop.height - y])
    }

    pub fn page_to_viewport(&self, point: [f64; 2]) -> Result<[f64; 2]> {
        let [x, y] = finite_point(point)?;
        let (w, h) = (self.crop.width, self.crop.height);
        let [x, y] = match self.rotation {
            0 => [x, y],
            1 => [h - y, x],
            2 => [w - x, h - y],
            _ => [y, w - x],
        };
        finite_point([
            self.origin[0] + x * self.scale,
            self.origin[1] + y * self.scale,
        ])
    }

    pub fn viewport_to_page(&self, point: [f64; 2]) -> Result<[f64; 2]> {
        let [x, y] = finite_point(point)?;
        let (x, y) = (
            (x - self.origin[0]) / self.scale,
            (y - self.origin[1]) / self.scale,
        );
        let (w, h) = (self.crop.width, self.crop.height);
        finite_point(match self.rotation {
            0 => [x, y],
            1 => [y, h - x],
            2 => [w - x, h - y],
            _ => [w - y, x],
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stroke(id: u128, counter: u64, actor: u128) -> InkStroke {
        InkStroke {
            id: Uuid::from_u128(id),
            page: 2,
            revision: InkRevision {
                counter,
                actor: Uuid::from_u128(actor),
            },
            tool: InkTool::Pen,
            color: [10, 20, 30, 255],
            base_width: 1.5,
            points: vec![InkPoint {
                x: 12.5,
                y: 30.0,
                pressure: None,
                elapsed_ms: Some(0),
                tilt: None,
            }],
            created_at_ms: 100,
            updated_at_ms: 100,
        }
    }

    fn page(strokes: Vec<InkStroke>, tombstones: Vec<InkTombstone>) -> InkPage {
        InkPage {
            version: INK_VERSION,
            page: 2,
            strokes,
            tombstones,
        }
    }

    #[test]
    fn merge_converges_with_duplicates_conflicts_deletion_and_restore() {
        let original = stroke(1, 1, 10);
        let mut concurrent = stroke(1, 1, 20);
        concurrent.updated_at_ms = 101; // Actor resolves equal counters, not time.
        let a = page(
            vec![original.clone(), stroke(2, 1, 10), original.clone()],
            vec![],
        );
        let b = page(vec![concurrent.clone(), stroke(3, 1, 20)], vec![]);
        let ab = a.merge(&b).unwrap();
        assert_eq!(ab, b.merge(&a).unwrap());
        assert_eq!(
            ab.strokes,
            vec![concurrent, stroke(2, 1, 10), stroke(3, 1, 20)]
        );
        assert_eq!(ab, ab.merge(&ab).unwrap());
        let deleted = InkTombstone {
            id: original.id,
            revision: InkRevision {
                counter: 1,
                actor: Uuid::from_u128(1),
            },
            deleted_at_ms: 0,
        };
        let c = page(vec![], vec![deleted.clone()]);
        let abc = ab.merge(&c).unwrap();
        assert_eq!(abc, a.merge(&b.merge(&c).unwrap()).unwrap());
        assert_eq!(abc, c.merge(&ab).unwrap());
        assert_eq!(abc.tombstones, vec![deleted]);
        assert!(!abc.strokes.iter().any(|s| s.id == original.id));
        assert_eq!(abc, abc.merge(&a).unwrap()); // A stale replica cannot resurrect it.
        let restored = stroke(1, 2, 10);
        let result = abc.merge(&page(vec![restored.clone()], vec![])).unwrap();
        assert!(result.tombstones.is_empty());
        assert_eq!(result.strokes[0], restored);
    }

    #[test]
    fn exact_revision_payload_ties_and_json_are_deterministic() {
        let a = page(vec![stroke(1, 1, 10)], vec![]);
        let mut b = a.clone();
        b.strokes[0].color[0] = 99;
        assert_eq!(a.merge(&b).unwrap(), b.merge(&a).unwrap());
        let merged = a.merge(&b).unwrap();
        assert_eq!(
            InkPage::from_json(&merged.to_json().unwrap()).unwrap(),
            merged
        );
        let mut skewed = stroke(1, 2, 1);
        skewed.updated_at_ms = u64::MAX;
        let latest = stroke(1, 3, 1);
        assert_eq!(
            page(vec![skewed], vec![])
                .merge(&page(vec![latest.clone()], vec![]))
                .unwrap()
                .strokes,
            vec![latest]
        );
    }

    #[test]
    fn validates_floats_pressure_time_revision_and_page_before_merge() {
        let good = stroke(1, 1, 10);
        for value in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            let mut bad = good.clone();
            bad.points[0].x = value;
            assert!(bad.validate().is_err());
            bad = good.clone();
            bad.points[0].pressure = Some(value);
            assert!(bad.validate().is_err());
            bad = good.clone();
            bad.base_width = value;
            assert!(bad.validate().is_err());
        }
        let mut bad = good.clone();
        bad.points[0].pressure = Some(1.01);
        assert!(bad.validate().is_err());
        bad = good.clone();
        bad.points[0].tilt = Some([0.0, 91.0]);
        assert!(bad.validate().is_err());
        bad = good.clone();
        bad.points[0].elapsed_ms = Some(10);
        bad.points.extend([
            InkPoint {
                elapsed_ms: None,
                ..good.points[0]
            },
            InkPoint {
                elapsed_ms: Some(9),
                ..good.points[0]
            },
        ]);
        assert!(bad.validate().is_err());
        bad.points[2].elapsed_ms = Some(10);
        assert!(bad.validate().is_ok()); // Equal times and unavailable pressure are valid.
        bad.revision.counter = 0;
        assert!(page(vec![bad], vec![])
            .merge(&page(vec![good], vec![]))
            .is_err());
        assert!(InkPage::new(0).is_err());
        assert!(InkRevision {
            counter: u64::MAX,
            actor: Uuid::from_u128(1)
        }
        .next(Uuid::from_u128(1))
        .is_err());
        assert!(InkPage::new(1)
            .unwrap()
            .merge(&InkPage::new(2).unwrap())
            .is_err());
    }

    #[test]
    fn crop_rotation_zoom_and_viewport_round_trip() {
        let crop = PdfCropBox {
            x: -20.0,
            y: 30.0,
            width: 200.0,
            height: 100.0,
        };
        // Known positions detect a shared forward/inverse rotation error.
        let expected = [[127.0, 39.0], [177.0, -11.0], [427.0, 39.0], [177.0, 289.0]];
        for rotation in 0..4 {
            let transform = PageTransform::new(crop, [77.0, -61.0], 2.0, rotation).unwrap();
            assert_eq!(
                transform.pdf_user_to_page([5.0, 80.0]).unwrap(),
                [25.0, 50.0]
            );
            assert_eq!(
                transform.page_to_pdf_user([25.0, 50.0]).unwrap(),
                [5.0, 80.0]
            );
            assert_eq!(
                transform.page_to_viewport([25.0, 50.0]).unwrap(),
                expected[rotation as usize]
            );
            for point in [[0.0, 0.0], [200.0, 100.0], [25.0, 50.0], [-10.0, 120.0]] {
                assert_eq!(
                    transform
                        .viewport_to_page(transform.page_to_viewport(point).unwrap())
                        .unwrap(),
                    point
                );
            }
            assert!(transform.viewport_to_page([f64::NAN, 0.0]).is_err());
            assert!(transform.page_to_viewport([f64::MAX, f64::MAX]).is_err());
        }
        for scale in [0.0, -1.0, f64::INFINITY, f64::NAN] {
            assert!(PageTransform::new(crop, [0.0, 0.0], scale, 0).is_err());
        }
        assert!(PageTransform::new(crop, [0.0, 0.0], 1.0, 4).is_err());
        assert!(PageTransform::new(PdfCropBox { width: 0.0, ..crop }, [0.0, 0.0], 1.0, 0).is_err());
    }
}
