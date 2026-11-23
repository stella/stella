//! Bounded reading of Outlook mailbox files (`.pst`, and `.ost` files kept
//! in the same layout), on Microsoft's `outlook-pst` reader.
//!
//! A mailbox is read as a list and as one message at a time. The list walks
//! the folder hierarchy from the top of the mailbox (the store's IPM
//! subtree), depth first in each hierarchy table's order, and gives each
//! message's contents-table row; a message's position in that walk is its
//! address. A message is read as its MAPI properties, recipients and
//! attachments (an attached message with its own properties and recipients),
//! which the host writes as an email.
//!
//! Every operation is bounded: the bytes and host reads it may take, the
//! folders and their depth, the messages, recipients and attachments, and
//! the size of what it returns. The file is read through the host at an
//! offset (`source`), so nothing here holds it whole.

use std::{collections::HashSet, io, rc::Rc};

use outlook_pst::{
    AnsiPstFile, PstReader, UnicodePstFile,
    ltp::{prop_context::PropertyValue, table_context::TableContext},
    messaging::{
        attachment::{AnsiAttachment, Attachment, AttachmentData, UnicodeAttachment},
        message::{AnsiMessage, Message, UnicodeMessage},
        store::{AnsiStore, EntryId, Store, UnicodeStore},
    },
    ndb::node_id::{NID_ROOT_FOLDER, NodeId, NodeIdType},
};

pub mod source;
pub mod wire;

#[cfg(any(test, feature = "assemble"))]
pub mod assemble;
#[cfg(test)]
mod tests;
#[cfg(target_arch = "wasm32")]
mod wasm;

use source::{Exhaustion, Meter, Metered, Source};
use wire::{
    AttachmentData as WireData, AttachmentRecord, FolderRecord, Listing, MessageBody,
    MessageRecord, Prop,
};

/// What one mailbox may make the reader do. Each operation (opening, the
/// list, one message) starts with its own budget of bytes and host reads.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Limits {
    /// Messages the list gives; a mailbox with more is `truncated`.
    pub max_messages: usize,
    /// The largest message read, as returned (properties, bodies and
    /// attachments); a larger one is refused as too large.
    pub max_message_bytes: usize,
    /// Bytes opening the mailbox and walking its folders may read.
    pub max_walk_bytes: u64,
    /// Bytes reading one message may read, its walk aside.
    pub max_message_read_bytes: u64,
    /// Reads from the host one operation may make.
    pub max_reads: u64,
    /// Folders the walk opens; past them the list is `truncated`.
    pub max_folders: usize,
    /// How deep below the top folder the walk goes.
    pub max_folder_depth: u32,
    /// Recipients a message gives.
    pub max_recipients: usize,
    /// Attachments a message gives; it says when it has more.
    pub max_attachments: usize,
}

/// Why a mailbox, or one of its messages, is not read.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Refusal {
    /// Not a PST file this reader reads, or a damaged one.
    Unreadable,
    /// The list has no message at that position.
    NoMessage,
    /// The message is larger than `max_message_bytes`, or reading it would
    /// take more than its budget.
    TooLarge,
    /// The operation made as many host reads as it may, or the host
    /// stopped it.
    Exhausted,
}

impl Refusal {
    pub const fn code(self) -> &'static str {
        match self {
            Self::Unreadable => "unreadable",
            Self::NoMessage => "no-message",
            Self::TooLarge => "too-large",
            Self::Exhausted => "exhausted",
        }
    }
}

/// `PidTagSubject`, `PidTagSenderName`, … : the MAPI property ids read.
pub mod prop {
    pub const MESSAGE_CLASS: u16 = 0x001A;
    pub const IMPORTANCE: u16 = 0x0017;
    pub const SUBJECT: u16 = 0x0037;
    pub const CLIENT_SUBMIT_TIME: u16 = 0x0039;
    pub const SUBJECT_PREFIX: u16 = 0x003D;
    pub const SENT_REPRESENTING_NAME: u16 = 0x0042;
    pub const SENT_REPRESENTING_ADDRESS_TYPE: u16 = 0x0064;
    pub const SENT_REPRESENTING_EMAIL: u16 = 0x0065;
    pub const TRANSPORT_MESSAGE_HEADERS: u16 = 0x007D;
    pub const RECIPIENT_TYPE: u16 = 0x0C15;
    pub const SENDER_NAME: u16 = 0x0C1A;
    pub const SENDER_ADDRESS_TYPE: u16 = 0x0C1E;
    pub const SENDER_EMAIL: u16 = 0x0C1F;
    pub const DISPLAY_BCC: u16 = 0x0E02;
    pub const DISPLAY_CC: u16 = 0x0E03;
    pub const DISPLAY_TO: u16 = 0x0E04;
    pub const MESSAGE_DELIVERY_TIME: u16 = 0x0E06;
    pub const MESSAGE_FLAGS: u16 = 0x0E07;
    pub const MESSAGE_SIZE: u16 = 0x0E08;
    pub const NORMALIZED_SUBJECT: u16 = 0x0E1D;
    pub const RTF_IN_SYNC: u16 = 0x0E1F;
    pub const ATTACH_SIZE: u16 = 0x0E20;
    pub const BODY: u16 = 0x1000;
    pub const RTF_COMPRESSED: u16 = 0x1009;
    pub const HTML: u16 = 0x1013;
    pub const INTERNET_MESSAGE_ID: u16 = 0x1035;
    pub const INTERNET_REFERENCES: u16 = 0x1039;
    pub const IN_REPLY_TO_ID: u16 = 0x1042;
    pub const DISPLAY_NAME: u16 = 0x3001;
    pub const ADDRESS_TYPE: u16 = 0x3002;
    pub const EMAIL_ADDRESS: u16 = 0x3003;
    pub const CREATION_TIME: u16 = 0x3007;
    pub const LAST_MODIFICATION_TIME: u16 = 0x3008;
    pub const CONTAINER_CLASS: u16 = 0x3613;
    pub const ATTACH_DATA: u16 = 0x3701;
    pub const ATTACH_FILENAME: u16 = 0x3704;
    pub const ATTACH_METHOD: u16 = 0x3705;
    pub const ATTACH_LONG_FILENAME: u16 = 0x3707;
    pub const RENDERING_POSITION: u16 = 0x370B;
    pub const ATTACH_MIME_TAG: u16 = 0x370E;
    pub const ATTACH_CONTENT_ID: u16 = 0x3712;
    pub const ATTACH_FLAGS: u16 = 0x3714;
    pub const SMTP_ADDRESS: u16 = 0x39FE;
    pub const INTERNET_CODEPAGE: u16 = 0x3FDE;
    pub const MESSAGE_CODEPAGE: u16 = 0x3FFD;
    pub const SENDER_SMTP_ADDRESS: u16 = 0x5D01;
    pub const SENT_REPRESENTING_SMTP_ADDRESS: u16 = 0x5D02;
    pub const RECIPIENT_DISPLAY_NAME: u16 = 0x5FF6;
    pub const ATTACHMENT_HIDDEN: u16 = 0x7FFE;
}

const FOLDER_PROPS: &[u16] = &[prop::DISPLAY_NAME, prop::CONTAINER_CLASS];

/// A message's row in its folder's list.
const ROW_PROPS: &[u16] = &[
    prop::MESSAGE_CLASS,
    prop::SUBJECT,
    prop::NORMALIZED_SUBJECT,
    prop::SENDER_NAME,
    prop::SENDER_EMAIL,
    prop::SENDER_SMTP_ADDRESS,
    prop::SENT_REPRESENTING_NAME,
    prop::CLIENT_SUBMIT_TIME,
    prop::MESSAGE_DELIVERY_TIME,
    prop::MESSAGE_SIZE,
    prop::MESSAGE_CODEPAGE,
];

/// What a message's email is written from.
const MESSAGE_PROPS: &[u16] = &[
    prop::MESSAGE_CLASS,
    prop::IMPORTANCE,
    prop::SUBJECT,
    prop::SUBJECT_PREFIX,
    prop::NORMALIZED_SUBJECT,
    prop::CLIENT_SUBMIT_TIME,
    prop::MESSAGE_DELIVERY_TIME,
    prop::SENT_REPRESENTING_NAME,
    prop::SENT_REPRESENTING_ADDRESS_TYPE,
    prop::SENT_REPRESENTING_EMAIL,
    prop::SENT_REPRESENTING_SMTP_ADDRESS,
    prop::TRANSPORT_MESSAGE_HEADERS,
    prop::SENDER_NAME,
    prop::SENDER_ADDRESS_TYPE,
    prop::SENDER_EMAIL,
    prop::SENDER_SMTP_ADDRESS,
    prop::DISPLAY_BCC,
    prop::DISPLAY_CC,
    prop::DISPLAY_TO,
    prop::MESSAGE_FLAGS,
    prop::MESSAGE_SIZE,
    prop::RTF_IN_SYNC,
    prop::BODY,
    prop::RTF_COMPRESSED,
    prop::HTML,
    prop::INTERNET_MESSAGE_ID,
    prop::INTERNET_REFERENCES,
    prop::IN_REPLY_TO_ID,
    prop::CREATION_TIME,
    prop::LAST_MODIFICATION_TIME,
    prop::INTERNET_CODEPAGE,
    prop::MESSAGE_CODEPAGE,
];

const RECIPIENT_PROPS: &[u16] = &[
    prop::RECIPIENT_TYPE,
    prop::DISPLAY_NAME,
    prop::ADDRESS_TYPE,
    prop::EMAIL_ADDRESS,
    prop::SMTP_ADDRESS,
    prop::RECIPIENT_DISPLAY_NAME,
];

const ATTACHMENT_PROPS: &[u16] = &[
    prop::ATTACH_SIZE,
    prop::DISPLAY_NAME,
    prop::ATTACH_FILENAME,
    prop::ATTACH_METHOD,
    prop::ATTACH_LONG_FILENAME,
    prop::RENDERING_POSITION,
    prop::ATTACH_MIME_TAG,
    prop::ATTACH_CONTENT_ID,
    prop::ATTACH_FLAGS,
    prop::ATTACHMENT_HIDDEN,
];

/// `afByValue`, `afEmbeddedMessage`, `afStorage` ([MS-OXCMSG]).
const ATTACH_EMBEDDED_MESSAGE: i32 = 5;

/// A store as the library opens it: both layouts have the same reading,
/// but an attachment is read through its message's own type.
enum PstStore {
    Unicode(Rc<UnicodeStore>),
    Ansi(Rc<AnsiStore>),
}

enum OpenedMessage {
    Unicode(Rc<UnicodeMessage>),
    Ansi(Rc<AnsiMessage>),
}

impl PstStore {
    fn store(&self) -> Rc<dyn Store> {
        match self {
            Self::Unicode(store) => store.clone(),
            Self::Ansi(store) => store.clone(),
        }
    }

    fn open_message(&self, entry_id: &EntryId) -> io::Result<OpenedMessage> {
        Ok(match self {
            Self::Unicode(store) => OpenedMessage::Unicode(UnicodeMessage::read(
                store.clone(),
                entry_id,
                Some(MESSAGE_PROPS),
            )?),
            Self::Ansi(store) => OpenedMessage::Ansi(AnsiMessage::read(
                store.clone(),
                entry_id,
                Some(MESSAGE_PROPS),
            )?),
        })
    }
}

impl OpenedMessage {
    fn message(&self) -> &dyn Message {
        match self {
            Self::Unicode(message) => message.as_ref(),
            Self::Ansi(message) => message.as_ref(),
        }
    }

    fn attachment(&self, node: NodeId) -> io::Result<Rc<dyn Attachment>> {
        Ok(match self {
            Self::Unicode(message) => {
                UnicodeAttachment::read(message.clone(), node, Some(MESSAGE_PROPS))?
            }
            Self::Ansi(message) => {
                AnsiAttachment::read(message.clone(), node, Some(MESSAGE_PROPS))?
            }
        })
    }
}

fn props_of<'a>(
    values: impl Iterator<Item = (&'a u16, &'a PropertyValue)>,
    wanted: &[u16],
) -> Vec<Prop> {
    values
        .filter(|(id, _)| wanted.contains(id))
        .filter_map(|(id, value)| Prop::from_value(*id, value))
        .collect()
}

fn integer(props: &[Prop], id: u16) -> Option<i64> {
    let found = props.iter().find(|prop| prop.id == id)?;
    match found.bytes.as_slice() {
        [a, b, c, d] => Some(i64::from(i32::from_le_bytes([*a, *b, *c, *d]))),
        _ => None,
    }
}

/// How reading a table's rows ended.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RowsEnd {
    /// Every row was read.
    Complete,
    /// The table has more rows than were asked for.
    More,
    /// A row could not be read; the rows before it are kept.
    Failed,
}

/// Rows by their row id, each with its wanted columns.
type Rows = Vec<(u32, Vec<Prop>)>;

/// A table's rows and how reading them ended.
type TableRows = (Rows, RowsEnd);

/// A table's rows as their row ids and wanted columns, at most `max_rows` of
/// those whose row id `keep` accepts. A row is checked by its id before any
/// of its columns is read, and reading stops at the bound.
fn table_rows_where(
    table: &dyn TableContext,
    wanted: &[u16],
    max_rows: usize,
    keep: impl Fn(u32) -> bool,
) -> TableRows {
    let context = table.context();
    let columns: Vec<_> = context
        .columns()
        .iter()
        .enumerate()
        .filter(|(_, column)| wanted.contains(&column.prop_id()))
        .map(|(index, column)| (index, column.prop_id(), column.prop_type()))
        .collect();
    let mut rows = Vec::new();
    for row in table.rows_matrix() {
        let id = u32::from(row.id());
        if !keep(id) {
            continue;
        }
        if rows.len() == max_rows {
            return (rows, RowsEnd::More);
        }
        let Ok(values) = row.columns(context) else {
            return (rows, RowsEnd::Failed);
        };
        let mut props = Vec::with_capacity(columns.len());
        for (index, id, prop_type) in &columns {
            if let Some(Some(value)) = values.get(*index) {
                let Ok(value) = table.read_column(value, *prop_type) else {
                    return (rows, RowsEnd::Failed);
                };
                props.extend(Prop::from_value(*id, &value));
            }
        }
        rows.push((id, props));
    }
    (rows, RowsEnd::Complete)
}

/// Every row (at most `max_rows`) of a table read whole: a row that cannot
/// be read fails the table.
fn table_rows(
    table: &dyn TableContext,
    wanted: &[u16],
    max_rows: usize,
) -> io::Result<(Rows, bool)> {
    match table_rows_where(table, wanted, max_rows, |_| true) {
        (_, RowsEnd::Failed) => Err(io::Error::other("a table row could not be read")),
        (rows, end) => Ok((rows, end == RowsEnd::More)),
    }
}

fn node_type(node: u32) -> Option<NodeIdType> {
    NodeId::from(node).id_type().ok()
}

/// An opened mailbox. Operations run one after another; each starts with
/// its own budget.
pub struct Mailbox {
    store: PstStore,
    meter: Rc<Meter>,
    limits: Limits,
    /// The complete list, once walked.
    listing: Option<Listing>,
}

impl Mailbox {
    /// Opens the mailbox in `source`: its header, its node and block
    /// B-trees' roots and its store's properties.
    ///
    /// # Errors
    ///
    /// [`Refusal::Unreadable`] for a file that is not a PST file this reader
    /// reads; [`Refusal::Exhausted`] when opening would take more than the
    /// walk's budget.
    pub fn open<S: Source + 'static>(mut source: S, limits: Limits) -> Result<Self, Refusal> {
        // `wVer`: 14 and 15 are the 32-bit (ANSI) layout, 23 the 64-bit
        // (Unicode) one ([MS-PST] 2.2.2.6).
        let mut version = [0_u8; 2];
        match source.read_at(10, &mut version) {
            Ok(2) => {}
            Ok(_) => return Err(Refusal::Unreadable),
            // The host stopped (its deadline), as it may at any read.
            Err(_) => return Err(Refusal::Exhausted),
        }
        let meter = Rc::new(Meter::default());
        meter.start(limits.max_walk_bytes, limits.max_reads);
        let reader: Box<dyn PstReader> = Box::new(Metered::new(source, meter.clone()));
        let opened = match u16::from_le_bytes(version) {
            14 | 15 => AnsiPstFile::read_from(reader)
                .and_then(|file| AnsiStore::read(Rc::new(file)))
                .map(PstStore::Ansi),
            23 => UnicodePstFile::read_from(reader)
                .and_then(|file| UnicodeStore::read(Rc::new(file)))
                .map(PstStore::Unicode),
            _ => return Err(Refusal::Unreadable),
        };
        match opened {
            Ok(store) => Ok(Self {
                store,
                meter,
                limits,
                listing: None,
            }),
            Err(_) => Err(match meter.exhausted() {
                Some(_) => Refusal::Exhausted,
                None => Refusal::Unreadable,
            }),
        }
    }

    /// The mailbox's folders and messages, in walk order, at most
    /// `max_messages` of them.
    ///
    /// # Errors
    ///
    /// [`Refusal::Unreadable`] when not even the top folder can be read.
    pub fn list(&mut self) -> Result<&Listing, Refusal> {
        if self.listing.is_none() {
            self.meter
                .start(self.limits.max_walk_bytes, self.limits.max_reads);
            let listing = self.walk(None)?;
            self.listing = Some(listing);
        }
        self.listing.as_ref().ok_or(Refusal::Unreadable)
    }

    /// The message at `index` in the list.
    ///
    /// # Errors
    ///
    /// [`Refusal::NoMessage`] past the list's end, [`Refusal::TooLarge`]
    /// for a message over its bounds, [`Refusal::Unreadable`] for one that
    /// cannot be read, [`Refusal::Exhausted`] past the host-read budget.
    pub fn message(&mut self, index: usize) -> Result<MessageBody, Refusal> {
        let row = match &self.listing {
            Some(listing) => listing.messages.get(index).cloned(),
            None => {
                self.meter
                    .start(self.limits.max_walk_bytes, self.limits.max_reads);
                self.walk(Some(index))?.messages.get(index).cloned()
            }
        };
        let row = row.ok_or(Refusal::NoMessage)?;
        if integer(&row.props, prop::MESSAGE_SIZE)
            .is_some_and(|size| size > self.limits.max_message_bytes as i64)
        {
            return Err(Refusal::TooLarge);
        }
        self.meter
            .start(self.limits.max_message_read_bytes, self.limits.max_reads);
        let read = self.read_message(row.node);
        match (read, self.meter.exhausted()) {
            (Ok(body), _) => Ok(body),
            (Err(_), Some(Exhaustion::Bytes)) => Err(Refusal::TooLarge),
            (Err(_), Some(Exhaustion::Reads | Exhaustion::Stopped)) => Err(Refusal::Exhausted),
            (Err(refusal), None) => Err(refusal),
        }
    }

    fn entry_id(&self, store: &dyn Store, node: u32) -> io::Result<EntryId> {
        store.properties().make_entry_id(NodeId::from(node))
    }

    /// The folder the walk starts from: the top of the mailbox's folders
    /// (its IPM subtree), else the store's root folder.
    fn top_folder(store: &dyn Store) -> u32 {
        let properties = store.properties();
        properties
            .ipm_sub_tree_entry_id()
            .ok()
            .filter(|entry_id| properties.matches_record_key(entry_id).unwrap_or(false))
            .map_or(u32::from(NID_ROOT_FOLDER), |entry_id| {
                u32::from(entry_id.node_id())
            })
    }

    /// The walk: depth first from the top folder, each folder's messages
    /// in its contents table's order, then its subfolders in its hierarchy
    /// table's order. With `stop`, it ends at that message.
    fn walk(&self, stop: Option<usize>) -> Result<Listing, Refusal> {
        let store = self.store.store();
        let limits = &self.limits;
        let mut listing = Listing::default();
        let mut visited = HashSet::new();
        let mut pending: Vec<(u32, Option<u32>, u32)> = vec![(Self::top_folder(&*store), None, 0)];
        while let Some((node, parent, depth)) = pending.pop() {
            if !visited.insert(node) {
                continue;
            }
            if listing.folders.len() == limits.max_folders || self.meter.exhausted().is_some() {
                listing.truncated = true;
                break;
            }
            let folder = self
                .entry_id(&*store, node)
                .and_then(|entry_id| store.open_folder(&entry_id));
            let folder = match folder {
                Ok(folder) => folder,
                // Without its top folder there is no mailbox to list; a
                // subfolder that cannot be read is left out.
                Err(_) if listing.folders.is_empty() => {
                    return Err(match self.meter.exhausted() {
                        Some(_) => Refusal::Exhausted,
                        None => Refusal::Unreadable,
                    });
                }
                Err(_) => {
                    listing.truncated = true;
                    continue;
                }
            };
            let index = u32::try_from(listing.folders.len()).map_err(|_| Refusal::Unreadable)?;
            listing.folders.push(FolderRecord {
                parent,
                depth,
                props: props_of(folder.properties().iter(), FOLDER_PROPS),
            });
            if let Some(contents) = folder.contents_table() {
                let left = limits.max_messages - listing.messages.len();
                // Read no further than the message asked for, or the bound.
                let needed = stop.map_or(left, |stop| {
                    (stop + 1).saturating_sub(listing.messages.len()).min(left)
                });
                let (rows, end) = table_rows_where(contents.as_ref(), ROW_PROPS, needed, |node| {
                    node_type(node) == Some(NodeIdType::NormalMessage)
                });
                for (node, props) in rows {
                    listing.messages.push(MessageRecord {
                        folder: index,
                        node,
                        props,
                    });
                    if stop == Some(listing.messages.len() - 1) {
                        return Ok(listing);
                    }
                }
                match end {
                    RowsEnd::Complete => {}
                    // More messages than the list's bound.
                    RowsEnd::More => {
                        listing.truncated = true;
                        return Ok(listing);
                    }
                    // The rows before the one that failed are listed.
                    RowsEnd::Failed => {
                        listing.truncated = true;
                        continue;
                    }
                }
            } else if self.meter.exhausted().is_some() {
                listing.truncated = true;
                break;
            }
            let Some(hierarchy) = folder.hierarchy_table() else {
                // The library reads a hierarchy it could not read as none:
                // one the budget stopped means subfolders were left out.
                if self.meter.exhausted().is_some() {
                    listing.truncated = true;
                    break;
                }
                continue;
            };
            let Ok((children, _)) = table_rows(hierarchy.as_ref(), &[], limits.max_folders) else {
                listing.truncated = true;
                continue;
            };
            let children: Vec<u32> = children
                .into_iter()
                .map(|(node, _)| node)
                .filter(|node| node_type(*node) == Some(NodeIdType::NormalFolder))
                .collect();
            if children.is_empty() {
                continue;
            }
            if depth >= limits.max_folder_depth {
                listing.truncated = true;
                continue;
            }
            pending.extend(
                children
                    .into_iter()
                    .rev()
                    .map(|child| (child, Some(index), depth + 1)),
            );
        }
        Ok(listing)
    }

    fn read_message(&self, node: u32) -> Result<MessageBody, Refusal> {
        let store = self.store.store();
        let entry_id = self
            .entry_id(&*store, node)
            .map_err(|_| Refusal::Unreadable)?;
        let opened = self
            .store
            .open_message(&entry_id)
            .map_err(|_| Refusal::Unreadable)?;
        let message = opened.message();
        let mut body = MessageBody {
            props: props_of(message.properties().iter(), MESSAGE_PROPS),
            recipients: self.recipients(message)?,
            ..MessageBody::default()
        };
        self.fits(&body)?;
        let Some(table) = message.attachment_table() else {
            return Ok(body);
        };
        let (rows, truncated) = table_rows(
            table.as_ref(),
            ATTACHMENT_PROPS,
            self.limits.max_attachments,
        )
        .map_err(|_| Refusal::Unreadable)?;
        body.attachments_truncated = truncated;
        for (node, row) in rows {
            let claimed = integer(&row, prop::ATTACH_SIZE).unwrap_or(0);
            if claimed > self.limits.max_message_bytes as i64 {
                return Err(Refusal::TooLarge);
            }
            let attachment = match opened.attachment(NodeId::from(node)) {
                Ok(attachment) => self.attachment(attachment.as_ref())?,
                // An attachment that cannot be read is given by its row:
                // its name and size, without its content.
                Err(_) if self.meter.exhausted().is_none() => AttachmentRecord {
                    props: row,
                    data: WireData::None,
                },
                Err(_) => return Err(Refusal::TooLarge),
            };
            body.attachments.push(attachment);
            self.fits(&body)?;
        }
        Ok(body)
    }

    fn fits(&self, body: &MessageBody) -> Result<(), Refusal> {
        if body.wire_size() > self.limits.max_message_bytes {
            Err(Refusal::TooLarge)
        } else {
            Ok(())
        }
    }

    fn recipients(&self, message: &dyn Message) -> Result<Vec<Vec<Prop>>, Refusal> {
        let Some(table) = message.recipient_table() else {
            return Ok(Vec::new());
        };
        table_rows(table.as_ref(), RECIPIENT_PROPS, self.limits.max_recipients)
            .map(|(rows, _)| rows.into_iter().map(|(_, props)| props).collect())
            .map_err(|_| Refusal::Unreadable)
    }

    fn attachment(&self, attachment: &dyn Attachment) -> Result<AttachmentRecord, Refusal> {
        let props = props_of(attachment.properties().iter(), ATTACHMENT_PROPS);
        let embedded = integer(&props, prop::ATTACH_METHOD) == Some(ATTACH_EMBEDDED_MESSAGE.into());
        let data = match attachment.data() {
            Some(AttachmentData::Binary(value)) if !embedded => {
                WireData::Bytes(value.buffer().to_vec())
            }
            Some(AttachmentData::Message(message)) => {
                WireData::Message(Box::new(self.attached_message(message.as_ref())?))
            }
            _ => WireData::None,
        };
        Ok(AttachmentRecord { props, data })
    }

    /// An attached message: its properties and recipients, and its own
    /// attachments by their rows (name and size). The library reads an
    /// attached message's attachments only by their table.
    fn attached_message(&self, message: &dyn Message) -> Result<MessageBody, Refusal> {
        let mut body = MessageBody {
            props: props_of(message.properties().iter(), MESSAGE_PROPS),
            recipients: self.recipients(message)?,
            ..MessageBody::default()
        };
        if let Some(table) = message.attachment_table() {
            let (rows, truncated) = table_rows(
                table.as_ref(),
                ATTACHMENT_PROPS,
                self.limits.max_attachments,
            )
            .map_err(|_| Refusal::Unreadable)?;
            body.attachments_truncated = truncated;
            body.attachments = rows
                .into_iter()
                .map(|(_, props)| AttachmentRecord {
                    props,
                    data: WireData::None,
                })
                .collect();
        }
        Ok(body)
    }
}
