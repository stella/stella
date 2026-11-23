//! The lists, tables and properties layer ([MS-PST] 2.3): heaps on nodes,
//! their B-trees, property contexts and table contexts.

use super::ndb::{MAX_BLOCK_DATA, Ndb, SubnodeEntry};

/// The largest heap allocation; a larger value goes to a subnode.
const MAX_ALLOCATION: usize = 3580;

const CLIENT_PROPERTY_CONTEXT: u8 = 0xBC;
const CLIENT_TABLE_CONTEXT: u8 = 0x7C;
const CLIENT_BTREE: u8 = 0xB5;

/// `NID_TYPE_LTP`: a subnode holding one large value.
const LTP_NODE_TYPE: u32 = 0x1F;

/// A property value as written.
#[derive(Clone, Debug)]
pub enum Value {
    Integer16(i16),
    Integer32(i32),
    Boolean(bool),
    Integer64(i64),
    /// A FILETIME: 100-ns intervals since 1601-01-01 UTC.
    Time(i64),
    Unicode(String),
    String8(Vec<u8>),
    Binary(Vec<u8>),
    /// An object in a subnode (an attached message): its node and size.
    Object {
        node: u32,
        size: u32,
    },
    /// A table value of the given type whose reference names no heap item:
    /// a damaged row.
    Dangling(u16),
}

/// The reference a [`Value::Dangling`] row value holds: the last item of a
/// heap page no table has.
const DANGLING_REFERENCE: u32 = 0x7FF << 5;

impl Value {
    pub fn prop_type(&self) -> u16 {
        match self {
            Self::Integer16(_) => 0x0002,
            Self::Integer32(_) => 0x0003,
            Self::Boolean(_) => 0x000B,
            Self::Integer64(_) => 0x0014,
            Self::Time(_) => 0x0040,
            Self::Unicode(_) => 0x001F,
            Self::String8(_) => 0x001E,
            Self::Binary(_) => 0x0102,
            Self::Object { .. } => 0x000D,
            Self::Dangling(kind) => *kind,
        }
    }

    fn bytes(&self) -> Vec<u8> {
        match self {
            Self::Integer16(value) => value.to_le_bytes().to_vec(),
            Self::Integer32(value) => value.to_le_bytes().to_vec(),
            Self::Boolean(value) => vec![u8::from(*value)],
            Self::Integer64(value) | Self::Time(value) => value.to_le_bytes().to_vec(),
            Self::Unicode(value) => value.encode_utf16().flat_map(u16::to_le_bytes).collect(),
            Self::String8(value) | Self::Binary(value) => value.clone(),
            Self::Object { node, size } => {
                let mut bytes = node.to_le_bytes().to_vec();
                bytes.extend_from_slice(&size.to_le_bytes());
                bytes
            }
            Self::Dangling(_) => Vec::new(),
        }
    }

    /// Held in the record itself (at most four bytes, fixed size).
    fn inline(&self) -> Option<u32> {
        match self {
            #[allow(clippy::cast_sign_loss)]
            Self::Integer16(value) => Some(u32::from(*value as u16)),
            #[allow(clippy::cast_sign_loss)]
            Self::Integer32(value) => Some(*value as u32),
            Self::Boolean(value) => Some(u32::from(*value)),
            _ => None,
        }
    }

    /// Bytes the value takes in a table row: its own (up to eight), or a
    /// four-byte reference to it.
    fn row_size(kind: u16) -> u8 {
        match kind {
            0x0002 => 2,
            0x000B => 1,
            0x0014 | 0x0040 => 8,
            _ => 4,
        }
    }
}

/// A node's subnodes, collected while its values are written, and the
/// next free subnode id.
#[derive(Default)]
pub struct Subnodes {
    pub entries: Vec<SubnodeEntry>,
    next: u32,
}

impl Subnodes {
    pub fn new() -> Self {
        Self {
            entries: Vec::new(),
            next: 0x100,
        }
    }

    /// A fresh subnode id of `kind`.
    pub fn id(&mut self, kind: u32) -> u32 {
        let node = (self.next << 5) | kind;
        self.next += 1;
        node
    }

    pub fn add(&mut self, entry: SubnodeEntry) {
        self.entries.push(entry);
    }

    /// The subnode tree, if there are subnodes.
    pub fn write(self, ndb: &mut Ndb) -> Option<u64> {
        (!self.entries.is_empty()).then(|| ndb.subnodes(self.entries))
    }
}

/// A heap on a node: allocations in pages of one block each.
struct Heap {
    client: u8,
    pages: Vec<Vec<Vec<u8>>>,
    user_root: u32,
}

impl Heap {
    fn new(client: u8) -> Self {
        Self {
            client,
            pages: vec![Vec::new()],
            user_root: 0,
        }
    }

    fn header_size(page: usize) -> usize {
        match page {
            0 => 12,
            page if page % 128 == 8 => 66,
            _ => 2,
        }
    }

    fn page_size(page: usize, allocations: &[Vec<u8>]) -> usize {
        let data = Self::header_size(page) + allocations.iter().map(Vec::len).sum::<usize>();
        data + data % 2 + 4 + 2 * (allocations.len() + 1)
    }

    /// A heap id for `bytes` (at most [`MAX_ALLOCATION`] of them).
    fn allocate(&mut self, bytes: Vec<u8>) -> u32 {
        assert!(!bytes.is_empty() && bytes.len() <= MAX_ALLOCATION);
        let last = self.pages.len() - 1;
        let fits = {
            let mut probe = self.pages[last].clone();
            probe.push(bytes.clone());
            Self::page_size(last, &probe) <= MAX_BLOCK_DATA
        };
        if !fits {
            self.pages.push(Vec::new());
        }
        let page = self.pages.len() - 1;
        self.pages[page].push(bytes);
        #[allow(clippy::cast_possible_truncation)]
        let index = self.pages[page].len() as u32;
        (index << 5) | ((page as u32) << 16)
    }

    fn blocks(&self) -> Vec<Vec<u8>> {
        self.pages
            .iter()
            .enumerate()
            .map(|(page, allocations)| {
                let mut block = vec![0_u8; Self::header_size(page)];
                let mut offsets = Vec::with_capacity(allocations.len() + 1);
                for allocation in allocations {
                    offsets.push(block.len());
                    block.extend_from_slice(allocation);
                }
                offsets.push(block.len());
                if block.len() % 2 == 1 {
                    block.push(0);
                }
                #[allow(clippy::cast_possible_truncation)]
                let page_map = block.len() as u16;
                block[..2].copy_from_slice(&page_map.to_le_bytes());
                if page == 0 {
                    block[2] = 0xEC;
                    block[3] = self.client;
                    block[4..8].copy_from_slice(&self.user_root.to_le_bytes());
                }
                #[allow(clippy::cast_possible_truncation)]
                block.extend_from_slice(&(allocations.len() as u16).to_le_bytes());
                block.extend_from_slice(&0_u16.to_le_bytes());
                for offset in offsets {
                    #[allow(clippy::cast_possible_truncation)]
                    block.extend_from_slice(&(offset as u16).to_le_bytes());
                }
                block
            })
            .collect()
    }

    fn write(self, ndb: &mut Ndb) -> u64 {
        let blocks = self.blocks();
        ndb.data_tree_of(blocks)
    }

    /// A B-tree on this heap over sorted records; the id of its header.
    fn btree(&mut self, key_size: u8, entry_size: u8, records: &[(Vec<u8>, Vec<u8>)]) -> u32 {
        let mut levels = 0_u8;
        let mut root = 0_u32;
        if !records.is_empty() {
            let mut current: Vec<(Vec<u8>, Vec<u8>)> = records.to_vec();
            loop {
                let size = current[0].0.len() + current[0].1.len();
                let per_allocation = MAX_ALLOCATION / size;
                let mut next = Vec::new();
                for chunk in current.chunks(per_allocation) {
                    let bytes: Vec<u8> = chunk
                        .iter()
                        .flat_map(|(key, data)| key.iter().chain(data.iter()).copied())
                        .collect();
                    let id = self.allocate(bytes);
                    next.push((chunk[0].0.clone(), id.to_le_bytes().to_vec()));
                }
                if next.len() == 1 {
                    root = u32::from_le_bytes([
                        next[0].1[0],
                        next[0].1[1],
                        next[0].1[2],
                        next[0].1[3],
                    ]);
                    break;
                }
                levels += 1;
                current = next;
            }
        }
        let mut header = vec![CLIENT_BTREE, key_size, entry_size, levels];
        header.extend_from_slice(&root.to_le_bytes());
        self.allocate(header)
    }

    /// A reference to `value`: in this heap, or in a new subnode.
    fn reference(&mut self, value: &Value, ndb: &mut Ndb, subnodes: &mut Subnodes) -> u32 {
        let bytes = value.bytes();
        if bytes.is_empty() {
            return 0;
        }
        if bytes.len() <= MAX_ALLOCATION {
            return self.allocate(bytes);
        }
        let node = subnodes.id(LTP_NODE_TYPE);
        let data = ndb.data_tree(&bytes);
        subnodes.add(SubnodeEntry { node, data, sub: 0 });
        node
    }
}

/// A property context's heap, its large values in `subnodes`; the id of
/// its data tree.
pub fn property_context(ndb: &mut Ndb, props: &[(u16, Value)], subnodes: &mut Subnodes) -> u64 {
    let mut heap = Heap::new(CLIENT_PROPERTY_CONTEXT);
    let mut props: Vec<&(u16, Value)> = props.iter().collect();
    props.sort_by_key(|(id, _)| *id);
    let mut records = Vec::with_capacity(props.len());
    for (id, value) in props {
        let reference = match value.inline() {
            Some(inline) => inline,
            None => heap.reference(value, ndb, subnodes),
        };
        let mut entry = value.prop_type().to_le_bytes().to_vec();
        entry.extend_from_slice(&reference.to_le_bytes());
        records.push((id.to_le_bytes().to_vec(), entry));
    }
    heap.user_root = heap.btree(2, 6, &records);
    heap.write(ndb)
}

/// A column of a table context: its property id and type.
#[derive(Clone, Copy, Debug)]
pub struct Column {
    pub id: u16,
    pub kind: u16,
}

const ROW_ID: Column = Column {
    id: 0x67F2,
    kind: 0x0003,
};
const ROW_VERSION: Column = Column {
    id: 0x67F3,
    kind: 0x0003,
};

/// A table context over `rows` (row id and values by property id); the id
/// of its heap's data tree. Values the table's columns do not name are
/// left out.
pub fn table_context(
    ndb: &mut Ndb,
    columns: &[Column],
    rows: &[(u32, Vec<(u16, Value)>)],
    subnodes: &mut Subnodes,
) -> u64 {
    let mut heap = Heap::new(CLIENT_TABLE_CONTEXT);
    // Row id and version first, then eight-, four-, two- and one-byte
    // values; existence bits in the same order.
    let mut ordered = vec![ROW_ID, ROW_VERSION];
    let mut rest: Vec<Column> = columns.to_vec();
    rest.sort_by_key(|column| (std::cmp::Reverse(Value::row_size(column.kind)), column.id));
    ordered.extend(rest);
    let mut layout = Vec::with_capacity(ordered.len());
    let mut offset = 0_usize;
    let mut ends = [0_u16; 3];
    for column in &ordered {
        let size = Value::row_size(column.kind);
        layout.push((*column, offset, size));
        offset += usize::from(size);
        #[allow(clippy::cast_possible_truncation)]
        match size {
            8 | 4 => ends[0] = offset as u16,
            2 => ends[1] = offset as u16,
            _ => ends[2] = offset as u16,
        }
    }
    if ends[1] < ends[0] {
        ends[1] = ends[0];
    }
    if ends[2] < ends[1] {
        ends[2] = ends[1];
    }
    let bitmap = ordered.len().div_ceil(8);
    let row_size = offset + bitmap;
    let mut matrix = Vec::with_capacity(rows.len() * row_size);
    for (row_id, values) in rows {
        let mut row = vec![0_u8; row_size];
        for (bit, (column, at, size)) in layout.iter().enumerate() {
            let value = if column.id == ROW_ID.id {
                #[allow(clippy::cast_possible_wrap)]
                Some(Value::Integer32(*row_id as i32))
            } else if column.id == ROW_VERSION.id {
                Some(Value::Integer32(1))
            } else {
                values
                    .iter()
                    .find(|(id, value)| *id == column.id && value.prop_type() == column.kind)
                    .map(|(_, value)| value.clone())
            };
            let Some(value) = value else { continue };
            let bytes = match value {
                Value::Integer64(_) | Value::Time(_) => value.bytes(),
                Value::Integer16(_) | Value::Integer32(_) | Value::Boolean(_) => value.bytes(),
                Value::Dangling(_) => DANGLING_REFERENCE.to_le_bytes().to_vec(),
                _ => heap.reference(&value, ndb, subnodes).to_le_bytes().to_vec(),
            };
            row[*at..*at + usize::from(*size)].copy_from_slice(&bytes[..usize::from(*size)]);
            row[offset + bit / 8] |= 0x80 >> (bit % 8);
        }
        matrix.push(row);
    }
    let mut index: Vec<(Vec<u8>, Vec<u8>)> = rows
        .iter()
        .enumerate()
        .map(|(position, (row_id, _))| {
            #[allow(clippy::cast_possible_truncation)]
            (
                row_id.to_le_bytes().to_vec(),
                (position as u32).to_le_bytes().to_vec(),
            )
        })
        .collect();
    index.sort_by(|a, b| a.0.iter().rev().cmp(b.0.iter().rev()));
    let row_index = heap.btree(4, 4, &index);
    let total = matrix.len() * row_size;
    let rows_reference = if matrix.is_empty() {
        0
    } else if total <= MAX_ALLOCATION {
        heap.allocate(matrix.concat())
    } else {
        let per_block = MAX_BLOCK_DATA / row_size;
        let blocks: Vec<Vec<u8>> = matrix.chunks(per_block).map(<[Vec<u8>]>::concat).collect();
        let node = subnodes.id(LTP_NODE_TYPE);
        let data = ndb.data_tree_of(blocks);
        subnodes.add(SubnodeEntry { node, data, sub: 0 });
        node
    };
    let mut descriptors: Vec<(u32, u16, u8, u8)> = layout
        .iter()
        .enumerate()
        .map(|(bit, (column, at, size))| {
            #[allow(clippy::cast_possible_truncation)]
            (
                (u32::from(column.id) << 16) | u32::from(column.kind),
                *at as u16,
                *size,
                bit as u8,
            )
        })
        .collect();
    descriptors.sort_by_key(|descriptor| descriptor.0);
    #[allow(clippy::cast_possible_truncation)]
    let mut info = vec![CLIENT_TABLE_CONTEXT, descriptors.len() as u8];
    for end in ends {
        info.extend_from_slice(&end.to_le_bytes());
    }
    #[allow(clippy::cast_possible_truncation)]
    info.extend_from_slice(&(row_size as u16).to_le_bytes());
    info.extend_from_slice(&row_index.to_le_bytes());
    info.extend_from_slice(&rows_reference.to_le_bytes());
    info.extend_from_slice(&0_u32.to_le_bytes());
    for (tag, at, size, bit) in descriptors {
        info.extend_from_slice(&tag.to_le_bytes());
        info.extend_from_slice(&at.to_le_bytes());
        info.push(size);
        info.push(bit);
    }
    heap.user_root = heap.allocate(info);
    heap.write(ndb)
}
