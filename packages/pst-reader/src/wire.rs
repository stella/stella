//! What the reader hands its host: a mailbox's folders and messages, and one
//! message's properties, recipients and attachments, as MAPI properties in a
//! small binary layout (little-endian throughout). The host decodes strings
//! and bodies and writes the message as an email; nothing here interprets a
//! property beyond its type.
//!
//! ```text
//! listing    = "PSTL" 01 u32:count folder* u32:count row* u8:truncated
//! folder     = u32:parent (0xFFFFFFFF: none) u32:depth props
//! row        = u32:folder u32:node props
//! message    = "PSTM" 01 body
//! body       = props u32:count props* u32:count attachment* u8:attachments-truncated
//! attachment = props u8:kind (0 none, 1 bytes, 2 message) [u32:length bytes | body]
//! props      = u32:count (u16:id u16:type u32:length bytes)*
//! ```
//!
//! Property values: 16-, 32- and 64-bit integers and times as their
//! little-endian bytes, booleans as one byte, Unicode strings as UTF-8,
//! 8-bit strings and binary values as stored.

use outlook_pst::ltp::prop_context::PropertyValue;

pub const LISTING_MAGIC: &[u8; 4] = b"PSTL";
pub const MESSAGE_MAGIC: &[u8; 4] = b"PSTM";
pub const WIRE_VERSION: u8 = 1;

pub const TYPE_INTEGER16: u16 = 0x0002;
pub const TYPE_INTEGER32: u16 = 0x0003;
pub const TYPE_BOOLEAN: u16 = 0x000B;
pub const TYPE_INTEGER64: u16 = 0x0014;
pub const TYPE_STRING8: u16 = 0x001E;
pub const TYPE_UNICODE: u16 = 0x001F;
pub const TYPE_TIME: u16 = 0x0040;
pub const TYPE_BINARY: u16 = 0x0102;

/// One property as the host receives it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Prop {
    pub id: u16,
    pub kind: u16,
    pub bytes: Vec<u8>,
}

impl Prop {
    /// The property as handed on, or none for a type the host never reads.
    pub fn from_value(id: u16, value: &PropertyValue) -> Option<Self> {
        let (kind, bytes) = match value {
            PropertyValue::Integer16(value) => (TYPE_INTEGER16, value.to_le_bytes().to_vec()),
            PropertyValue::Integer32(value) => (TYPE_INTEGER32, value.to_le_bytes().to_vec()),
            PropertyValue::Boolean(value) => (TYPE_BOOLEAN, vec![u8::from(*value)]),
            PropertyValue::Integer64(value) => (TYPE_INTEGER64, value.to_le_bytes().to_vec()),
            PropertyValue::Time(value) => (TYPE_TIME, value.to_le_bytes().to_vec()),
            PropertyValue::String8(value) => (TYPE_STRING8, value.buffer().to_vec()),
            PropertyValue::Unicode(value) => (
                TYPE_UNICODE,
                String::from_utf16_lossy(value.buffer()).into_bytes(),
            ),
            PropertyValue::Binary(value) => (TYPE_BINARY, value.buffer().to_vec()),
            _ => return None,
        };
        Some(Self { id, kind, bytes })
    }

    /// Bytes the property takes on the wire.
    pub fn wire_size(&self) -> usize {
        8 + self.bytes.len()
    }
}

/// A folder as the listing gives it.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct FolderRecord {
    pub parent: Option<u32>,
    pub depth: u32,
    pub props: Vec<Prop>,
}

/// A message as the listing gives it: its folder (an index into the
/// listing's folders), its node and its contents-table row.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct MessageRecord {
    pub folder: u32,
    pub node: u32,
    pub props: Vec<Prop>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Listing {
    pub folders: Vec<FolderRecord>,
    pub messages: Vec<MessageRecord>,
    pub truncated: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AttachmentData {
    None,
    Bytes(Vec<u8>),
    Message(Box<MessageBody>),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AttachmentRecord {
    pub props: Vec<Prop>,
    pub data: AttachmentData,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct MessageBody {
    pub props: Vec<Prop>,
    pub recipients: Vec<Vec<Prop>>,
    pub attachments: Vec<AttachmentRecord>,
    pub attachments_truncated: bool,
}

impl MessageBody {
    /// Bytes the message takes on the wire.
    pub fn wire_size(&self) -> usize {
        props_size(&self.props)
            + 4
            + self
                .recipients
                .iter()
                .map(|props| props_size(props))
                .sum::<usize>()
            + 4
            + self
                .attachments
                .iter()
                .map(AttachmentRecord::wire_size)
                .sum::<usize>()
            + 1
    }
}

impl AttachmentRecord {
    pub fn wire_size(&self) -> usize {
        props_size(&self.props)
            + 1
            + match &self.data {
                AttachmentData::None => 0,
                AttachmentData::Bytes(bytes) => 4 + bytes.len(),
                AttachmentData::Message(message) => message.wire_size(),
            }
    }
}

pub fn props_size(props: &[Prop]) -> usize {
    4 + props.iter().map(Prop::wire_size).sum::<usize>()
}

fn put_u32(out: &mut Vec<u8>, value: usize) {
    // Every count and length is bounded far below 4 GiB by the limits.
    out.extend_from_slice(&u32::try_from(value).unwrap_or(u32::MAX).to_le_bytes());
}

fn put_props(out: &mut Vec<u8>, props: &[Prop]) {
    put_u32(out, props.len());
    for prop in props {
        out.extend_from_slice(&prop.id.to_le_bytes());
        out.extend_from_slice(&prop.kind.to_le_bytes());
        put_u32(out, prop.bytes.len());
        out.extend_from_slice(&prop.bytes);
    }
}

pub fn encode_listing(listing: &Listing) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(LISTING_MAGIC);
    out.push(WIRE_VERSION);
    put_u32(&mut out, listing.folders.len());
    for folder in &listing.folders {
        out.extend_from_slice(&folder.parent.unwrap_or(u32::MAX).to_le_bytes());
        out.extend_from_slice(&folder.depth.to_le_bytes());
        put_props(&mut out, &folder.props);
    }
    put_u32(&mut out, listing.messages.len());
    for message in &listing.messages {
        out.extend_from_slice(&message.folder.to_le_bytes());
        out.extend_from_slice(&message.node.to_le_bytes());
        put_props(&mut out, &message.props);
    }
    out.push(u8::from(listing.truncated));
    out
}

fn put_body(out: &mut Vec<u8>, body: &MessageBody) {
    put_props(out, &body.props);
    put_u32(out, body.recipients.len());
    for recipient in &body.recipients {
        put_props(out, recipient);
    }
    put_u32(out, body.attachments.len());
    for attachment in &body.attachments {
        put_props(out, &attachment.props);
        match &attachment.data {
            AttachmentData::None => out.push(0),
            AttachmentData::Bytes(bytes) => {
                out.push(1);
                put_u32(out, bytes.len());
                out.extend_from_slice(bytes);
            }
            AttachmentData::Message(message) => {
                out.push(2);
                put_body(out, message);
            }
        }
    }
    out.push(u8::from(body.attachments_truncated));
}

pub fn encode_message(body: &MessageBody) -> Vec<u8> {
    let mut out = Vec::with_capacity(5 + body.wire_size());
    out.extend_from_slice(MESSAGE_MAGIC);
    out.push(WIRE_VERSION);
    put_body(&mut out, body);
    out
}
