//! The node database layer of a Unicode PST file ([MS-PST] 2.2): blocks
//! with their trailers, data trees, subnode trees, the node and block
//! B-trees and the header. Blocks are written unencoded
//! (`NDB_CRYPT_NONE`); the allocation map is marked for rebuilding, as a
//! file whose writer did not keep it is.

pub const PAGE_SIZE: usize = 512;
const BLOCK_TRAILER: usize = 16;
pub const MAX_BLOCK_DATA: usize = 8192 - BLOCK_TRAILER;
/// The first allocation map page; the data area starts after it.
const FIRST_AMAP: u64 = 0x4400;
const HEADER_SIZE: usize = 564;

const PAGE_BBT: u8 = 0x80;
const PAGE_NBT: u8 = 0x81;
const BTREE_ENTRIES: usize = 488;

/// The CRC [MS-PST] 5.3 uses: CRC-32 (reflected 0xEDB88320), started at
/// zero and not inverted.
pub fn crc(data: &[u8]) -> u32 {
    let mut crc = 0_u32;
    for byte in data {
        let mut value = (crc ^ u32::from(*byte)) & 0xFF;
        for _ in 0..8 {
            value = if value & 1 == 1 {
                (value >> 1) ^ 0xEDB8_8320
            } else {
                value >> 1
            };
        }
        crc = value ^ (crc >> 8);
    }
    crc
}

/// A block's or page's signature ([MS-PST] 5.5).
#[allow(clippy::cast_possible_truncation)]
fn signature(offset: u64, id: u64) -> u16 {
    let value = (offset as u32) ^ (id as u32);
    ((value >> 16) as u16) ^ (value as u16)
}

#[derive(Clone, Copy, Debug)]
struct BlockEntry {
    id: u64,
    offset: u64,
    size: u16,
}

#[derive(Clone, Copy, Debug)]
struct NodeEntry {
    node: u32,
    data: u64,
    sub: u64,
    parent: u32,
}

/// One entry of a subnode tree: a node local to its parent node.
#[derive(Clone, Copy, Debug)]
pub struct SubnodeEntry {
    pub node: u32,
    pub data: u64,
    pub sub: u64,
}

pub struct Ndb {
    file: Vec<u8>,
    next_block: u64,
    next_page: u64,
    blocks: Vec<BlockEntry>,
    nodes: Vec<NodeEntry>,
}

impl Default for Ndb {
    fn default() -> Self {
        Self::new()
    }
}

impl Ndb {
    pub fn new() -> Self {
        Self {
            file: vec![0; usize::try_from(FIRST_AMAP).unwrap_or(0) + PAGE_SIZE],
            next_block: 1,
            next_page: 1,
            blocks: Vec::new(),
            nodes: Vec::new(),
        }
    }

    fn append(&mut self, bytes: &[u8], align: usize) -> u64 {
        let padding = (align - self.file.len() % align) % align;
        self.file.resize(self.file.len() + padding, 0);
        let offset = self.file.len() as u64;
        self.file.extend_from_slice(bytes);
        offset
    }

    fn block(&mut self, data: &[u8], internal: bool) -> u64 {
        assert!(!data.is_empty() && data.len() <= MAX_BLOCK_DATA);
        let id = (self.next_block << 2) | if internal { 2 } else { 0 };
        self.next_block += 1;
        let total = (data.len() + BLOCK_TRAILER).div_ceil(64) * 64;
        let mut bytes = vec![0; total];
        bytes[..data.len()].copy_from_slice(data);
        let offset = self.file.len().div_ceil(64) as u64 * 64;
        let trailer = &mut bytes[total - BLOCK_TRAILER..];
        #[allow(clippy::cast_possible_truncation)]
        trailer[0..2].copy_from_slice(&(data.len() as u16).to_le_bytes());
        trailer[2..4].copy_from_slice(&signature(offset, id).to_le_bytes());
        trailer[4..8].copy_from_slice(&crc(data).to_le_bytes());
        trailer[8..16].copy_from_slice(&id.to_le_bytes());
        let written = self.append(&bytes, 64);
        debug_assert_eq!(written, offset);
        #[allow(clippy::cast_possible_truncation)]
        self.blocks.push(BlockEntry {
            id,
            offset,
            size: data.len() as u16,
        });
        id
    }

    /// A data block holding `data` (at most [`MAX_BLOCK_DATA`] bytes).
    pub fn data_block(&mut self, data: &[u8]) -> u64 {
        self.block(data, false)
    }

    /// `data` as a data tree: one block, or an XBLOCK (or XXBLOCK) over
    /// as many blocks as it takes.
    pub fn data_tree(&mut self, data: &[u8]) -> u64 {
        let blocks: Vec<Vec<u8>> = data.chunks(MAX_BLOCK_DATA).map(<[u8]>::to_vec).collect();
        self.data_tree_of(blocks)
    }

    /// A data tree over blocks whose boundaries matter (a heap's pages, a
    /// table's rows, which never span blocks).
    pub fn data_tree_of(&mut self, blocks: Vec<Vec<u8>>) -> u64 {
        let total: usize = blocks.iter().map(Vec::len).sum();
        let ids: Vec<u64> = blocks.iter().map(|block| self.data_block(block)).collect();
        if ids.len() == 1 {
            return ids[0];
        }
        // An XBLOCK lists at most 1021 blocks; an XXBLOCK lists XBLOCKs.
        let per_block = (MAX_BLOCK_DATA - 8) / 8;
        let mut level = 1;
        let mut ids = ids;
        let mut sizes: Vec<usize> = blocks.iter().map(Vec::len).collect();
        while ids.len() > 1 || level == 1 {
            let mut next_ids = Vec::new();
            let mut next_sizes = Vec::new();
            for (chunk, chunk_sizes) in ids.chunks(per_block).zip(sizes.chunks(per_block)) {
                let chunk_total: usize = chunk_sizes.iter().sum();
                let mut bytes = vec![0x01, level];
                #[allow(clippy::cast_possible_truncation)]
                bytes.extend_from_slice(&(chunk.len() as u16).to_le_bytes());
                #[allow(clippy::cast_possible_truncation)]
                bytes.extend_from_slice(&(chunk_total as u32).to_le_bytes());
                for id in chunk {
                    bytes.extend_from_slice(&id.to_le_bytes());
                }
                next_ids.push(self.block(&bytes, true));
                next_sizes.push(chunk_total);
            }
            ids = next_ids;
            sizes = next_sizes;
            level += 1;
            assert!(
                level <= 3,
                "a data tree of {total} bytes needs more than two levels"
            );
        }
        ids[0]
    }

    /// A subnode tree: an SLBLOCK, or an SIBLOCK over SLBLOCKs.
    pub fn subnodes(&mut self, mut entries: Vec<SubnodeEntry>) -> u64 {
        entries.sort_by_key(|entry| entry.node);
        let per_block = (MAX_BLOCK_DATA - 8) / 24;
        let leaves: Vec<(u32, u64)> = entries
            .chunks(per_block)
            .map(|chunk| {
                let mut bytes = vec![0x02, 0x00];
                #[allow(clippy::cast_possible_truncation)]
                bytes.extend_from_slice(&(chunk.len() as u16).to_le_bytes());
                bytes.extend_from_slice(&[0; 4]);
                for entry in chunk {
                    bytes.extend_from_slice(&u64::from(entry.node).to_le_bytes());
                    bytes.extend_from_slice(&entry.data.to_le_bytes());
                    bytes.extend_from_slice(&entry.sub.to_le_bytes());
                }
                (chunk[0].node, self.block(&bytes, true))
            })
            .collect();
        if leaves.len() == 1 {
            return leaves[0].1;
        }
        let per_index = (MAX_BLOCK_DATA - 8) / 16;
        assert!(
            leaves.len() <= per_index,
            "too many subnodes for one SIBLOCK"
        );
        let mut bytes = vec![0x02, 0x01];
        #[allow(clippy::cast_possible_truncation)]
        bytes.extend_from_slice(&(leaves.len() as u16).to_le_bytes());
        bytes.extend_from_slice(&[0; 4]);
        for (node, id) in leaves {
            bytes.extend_from_slice(&u64::from(node).to_le_bytes());
            bytes.extend_from_slice(&id.to_le_bytes());
        }
        self.block(&bytes, true)
    }

    /// A node of the node B-tree.
    pub fn node(&mut self, node: u32, data: u64, sub: Option<u64>, parent: u32) {
        self.nodes.push(NodeEntry {
            node,
            data,
            sub: sub.unwrap_or(0),
            parent,
        });
    }

    fn page(&mut self, kind: u8, entries: &[u8], counts: [u8; 4]) -> (u64, u64) {
        let id = self.next_page;
        self.next_page += 1;
        let mut bytes = vec![0_u8; PAGE_SIZE];
        bytes[..entries.len()].copy_from_slice(entries);
        bytes[BTREE_ENTRIES..BTREE_ENTRIES + 4].copy_from_slice(&counts);
        let offset = self.file.len().div_ceil(PAGE_SIZE) as u64 * PAGE_SIZE as u64;
        bytes[496] = kind;
        bytes[497] = kind;
        bytes[498..500].copy_from_slice(&signature(offset, id).to_le_bytes());
        let crc = crc(&bytes[..496]);
        bytes[500..504].copy_from_slice(&crc.to_le_bytes());
        bytes[504..512].copy_from_slice(&id.to_le_bytes());
        let written = self.append(&bytes, PAGE_SIZE);
        debug_assert_eq!(written, offset);
        (id, offset)
    }

    /// A B-tree over `entries` (key, then its entry's bytes), as leaf pages
    /// and as many levels of intermediate pages as it takes; its root.
    fn btree(&mut self, kind: u8, entry_size: u8, entries: &[(u64, Vec<u8>)]) -> (u64, u64) {
        let per_leaf = BTREE_ENTRIES / usize::from(entry_size);
        let mut level = 0_u8;
        let mut children: Vec<(u64, u64, u64)> = Vec::new();
        let empty = [(0_u64, Vec::new())];
        let leaves: &[(u64, Vec<u8>)] = if entries.is_empty() {
            &empty[..0]
        } else {
            entries
        };
        let chunks: Vec<&[(u64, Vec<u8>)]> = if leaves.is_empty() {
            vec![&[]]
        } else {
            leaves.chunks(per_leaf).collect()
        };
        for chunk in chunks {
            let bytes: Vec<u8> = chunk.iter().flat_map(|(_, entry)| entry.clone()).collect();
            #[allow(clippy::cast_possible_truncation)]
            let (id, offset) = self.page(
                kind,
                &bytes,
                [chunk.len() as u8, per_leaf as u8, entry_size, level],
            );
            children.push((chunk.first().map_or(0, |(key, _)| *key), id, offset));
        }
        let per_index = BTREE_ENTRIES / 24;
        while children.len() > 1 {
            level += 1;
            let mut parents = Vec::new();
            for chunk in children.chunks(per_index) {
                let mut bytes = Vec::new();
                for (key, id, offset) in chunk {
                    bytes.extend_from_slice(&key.to_le_bytes());
                    bytes.extend_from_slice(&id.to_le_bytes());
                    bytes.extend_from_slice(&offset.to_le_bytes());
                }
                #[allow(clippy::cast_possible_truncation)]
                let (id, offset) = self.page(
                    kind,
                    &bytes,
                    [chunk.len() as u8, per_index as u8, 24, level],
                );
                parents.push((chunk[0].0, id, offset));
            }
            children = parents;
        }
        (children[0].1, children[0].2)
    }

    /// The finished file: both B-trees, then the header.
    pub fn finish(mut self) -> Vec<u8> {
        let mut nodes = std::mem::take(&mut self.nodes);
        nodes.sort_by_key(|node| node.node);
        let node_entries: Vec<(u64, Vec<u8>)> = nodes
            .iter()
            .map(|node| {
                let mut bytes = Vec::with_capacity(32);
                bytes.extend_from_slice(&u64::from(node.node).to_le_bytes());
                bytes.extend_from_slice(&node.data.to_le_bytes());
                bytes.extend_from_slice(&node.sub.to_le_bytes());
                bytes.extend_from_slice(&node.parent.to_le_bytes());
                bytes.extend_from_slice(&[0; 4]);
                (u64::from(node.node), bytes)
            })
            .collect();
        let mut blocks = std::mem::take(&mut self.blocks);
        blocks.sort_by_key(|block| block.id);
        let block_entries: Vec<(u64, Vec<u8>)> = blocks
            .iter()
            .map(|block| {
                let mut bytes = Vec::with_capacity(24);
                bytes.extend_from_slice(&block.id.to_le_bytes());
                bytes.extend_from_slice(&block.offset.to_le_bytes());
                bytes.extend_from_slice(&block.size.to_le_bytes());
                bytes.extend_from_slice(&1_u16.to_le_bytes());
                bytes.extend_from_slice(&[0; 4]);
                (block.id, bytes)
            })
            .collect();
        let node_root = self.btree(PAGE_NBT, 32, &node_entries);
        let block_root = self.btree(PAGE_BBT, 24, &block_entries);
        let end = self.file.len().div_ceil(PAGE_SIZE) * PAGE_SIZE;
        self.file.resize(end, 0);
        let header = self.header(end as u64, node_root, block_root);
        self.file[..HEADER_SIZE].copy_from_slice(&header);
        self.file
    }

    fn header(&self, end: u64, node_root: (u64, u64), block_root: (u64, u64)) -> Vec<u8> {
        let mut header = Vec::with_capacity(HEADER_SIZE);
        header.extend_from_slice(b"!BDN");
        header.extend_from_slice(&[0; 4]); // dwCRCPartial
        header.extend_from_slice(b"SM");
        header.extend_from_slice(&23_u16.to_le_bytes()); // wVer: Unicode
        header.extend_from_slice(&19_u16.to_le_bytes()); // wVerClient
        header.extend_from_slice(&[0x01, 0x01]); // bPlatformCreate, bPlatformAccess
        header.extend_from_slice(&[0; 8]); // dwReserved1, dwReserved2
        header.extend_from_slice(&[0; 8]); // bidUnused
        header.extend_from_slice(&self.next_page.to_le_bytes()); // bidNextP
        header.extend_from_slice(&1_u32.to_le_bytes()); // dwUnique
        for _ in 0..32 {
            header.extend_from_slice(&0x0400_u32.to_le_bytes()); // rgnid
        }
        header.extend_from_slice(&[0; 8]); // qwUnused
        // ROOT
        header.extend_from_slice(&[0; 4]); // dwReserved
        header.extend_from_slice(&end.to_le_bytes()); // ibFileEof
        header.extend_from_slice(&FIRST_AMAP.to_le_bytes()); // ibAMapLast
        header.extend_from_slice(&[0; 16]); // cbAMapFree, cbPMapFree
        header.extend_from_slice(&node_root.0.to_le_bytes());
        header.extend_from_slice(&node_root.1.to_le_bytes());
        header.extend_from_slice(&block_root.0.to_le_bytes());
        header.extend_from_slice(&block_root.1.to_le_bytes());
        header.extend_from_slice(&[0x00, 0x00, 0x00, 0x00]); // fAMapValid: rebuild
        header.extend_from_slice(&[0; 4]); // dwAlign
        header.extend_from_slice(&[0xFF; 128]); // rgbFM
        header.extend_from_slice(&[0xFF; 128]); // rgbFP
        header.push(0x80); // bSentinel
        header.push(0x00); // bCryptMethod: NDB_CRYPT_NONE
        header.extend_from_slice(&[0; 2]); // rgbReserved
        header.extend_from_slice(&(self.next_block << 2).to_le_bytes()); // bidNextB
        header.extend_from_slice(&[0; 4]); // dwCRCFull
        header.extend_from_slice(&[0; 36]);
        debug_assert_eq!(header.len(), HEADER_SIZE);
        let partial = crc(&header[8..8 + 471]);
        header[4..8].copy_from_slice(&partial.to_le_bytes());
        let full = crc(&header[8..8 + 516]);
        header[524..528].copy_from_slice(&full.to_le_bytes());
        header
    }
}
