//! A bounded assembler of Unicode PST files, for tests and fixtures only:
//! a message store, its folders (nested), and messages with recipients,
//! plain, HTML and RTF bodies, attachments and attached messages, laid out
//! as [MS-PST] describes. The reader under test never shares code with it,
//! so a fixture checks the reader against the specification, not against
//! itself.

pub mod fixtures;
pub mod ltp;
pub mod ndb;

use ltp::{Column, Subnodes, Value};
use ndb::{Ndb, SubnodeEntry};

/// `NID_TYPE_*` ([MS-PST] 2.2.2.1).
mod node_type {
    pub const NORMAL_FOLDER: u32 = 0x02;
    pub const SEARCH_FOLDER: u32 = 0x03;
    pub const NORMAL_MESSAGE: u32 = 0x04;
    pub const ATTACHMENT: u32 = 0x05;
    pub const HIERARCHY_TABLE: u32 = 0x0D;
    pub const CONTENTS_TABLE: u32 = 0x0E;
    pub const ASSOC_CONTENTS_TABLE: u32 = 0x0F;
}

const NID_MESSAGE_STORE: u32 = 0x21;
/// The index the search folder's row names.
const SEARCH_FOLDER_INDEX: u32 = 0x3FF;
const NID_ROOT_FOLDER: u32 = 0x122;
const NID_ATTACHMENT_TABLE: u32 = 0x671;
const NID_RECIPIENT_TABLE: u32 = 0x692;

const UNICODE: u16 = 0x001F;
const INTEGER32: u16 = 0x0003;
const BOOLEAN: u16 = 0x000B;
const TIME: u16 = 0x0040;

/// 2024-03-04 09:00 UTC as a FILETIME.
pub const BASE_TIME: i64 = 133_540_164_000_000_000;
pub const HOUR: i64 = 36_000_000_000;

#[derive(Clone, Debug, Default)]
pub struct Recipient {
    pub name: String,
    pub email: String,
    /// 1 To, 2 Cc, 3 Bcc.
    pub kind: i32,
}

#[derive(Clone, Debug)]
pub enum AttachmentContent {
    Bytes(Vec<u8>),
    Message(Box<Mail>),
}

#[derive(Clone, Debug)]
pub struct Attachment {
    pub file_name: String,
    pub mime_type: Option<String>,
    pub content: AttachmentContent,
    /// What the attachment's row and properties claim its size is; by
    /// default the bytes it takes.
    pub claimed_size: Option<i32>,
}

#[derive(Clone, Debug, Default)]
pub struct Mail {
    pub subject: Option<String>,
    pub sender_name: String,
    pub sender_email: String,
    pub recipients: Vec<Recipient>,
    /// FILETIME.
    pub sent: i64,
    pub body: Option<String>,
    pub html: Option<Vec<u8>>,
    /// `PidTagRtfCompressed`, as stored.
    pub rtf_compressed: Option<Vec<u8>>,
    pub message_id: Option<String>,
    pub attachments: Vec<Attachment>,
    /// Further properties of the message, written as they are.
    pub extra: Vec<(u16, Value)>,
    /// What the contents table claims the message's size is; by default
    /// the bytes its bodies and attachments take.
    pub claimed_size: Option<i32>,
}

#[derive(Clone, Debug, Default)]
pub struct MailFolder {
    pub name: String,
    pub messages: Vec<Mail>,
    pub folders: Vec<MailFolder>,
    /// Lists the top folder again among this folder's subfolders: a
    /// damaged hierarchy that loops.
    pub loops_to_top: bool,
}

#[derive(Clone, Debug, Default)]
pub struct Mailbox {
    pub display_name: String,
    /// The folders under the top of the mailbox.
    pub folders: Vec<MailFolder>,
    /// Lists a search folder among the top folder's subfolders, as Outlook
    /// keeps its search folders: a view of messages filed elsewhere.
    pub search_folder: bool,
}

const HIERARCHY_COLUMNS: &[Column] = &[
    Column {
        id: 0x3001,
        kind: UNICODE,
    },
    Column {
        id: 0x3602,
        kind: INTEGER32,
    },
    Column {
        id: 0x3603,
        kind: INTEGER32,
    },
    Column {
        id: 0x360A,
        kind: BOOLEAN,
    },
];

const CONTENTS_COLUMNS: &[Column] = &[
    Column {
        id: 0x0017,
        kind: INTEGER32,
    },
    Column {
        id: 0x001A,
        kind: UNICODE,
    },
    Column {
        id: 0x0037,
        kind: UNICODE,
    },
    Column {
        id: 0x0039,
        kind: TIME,
    },
    Column {
        id: 0x0042,
        kind: UNICODE,
    },
    Column {
        id: 0x0C1A,
        kind: UNICODE,
    },
    Column {
        id: 0x0E03,
        kind: UNICODE,
    },
    Column {
        id: 0x0E04,
        kind: UNICODE,
    },
    Column {
        id: 0x0E06,
        kind: TIME,
    },
    Column {
        id: 0x0E07,
        kind: INTEGER32,
    },
    Column {
        id: 0x0E08,
        kind: INTEGER32,
    },
    Column {
        id: 0x3008,
        kind: TIME,
    },
];

const RECIPIENT_COLUMNS: &[Column] = &[
    Column {
        id: 0x0C15,
        kind: INTEGER32,
    },
    Column {
        id: 0x0FFE,
        kind: INTEGER32,
    },
    Column {
        id: 0x3001,
        kind: UNICODE,
    },
    Column {
        id: 0x3002,
        kind: UNICODE,
    },
    Column {
        id: 0x3003,
        kind: UNICODE,
    },
    Column {
        id: 0x3900,
        kind: INTEGER32,
    },
    Column {
        id: 0x39FE,
        kind: UNICODE,
    },
];

const ATTACHMENT_COLUMNS: &[Column] = &[
    Column {
        id: 0x0E20,
        kind: INTEGER32,
    },
    Column {
        id: 0x3704,
        kind: UNICODE,
    },
    Column {
        id: 0x3705,
        kind: INTEGER32,
    },
    Column {
        id: 0x370B,
        kind: INTEGER32,
    },
];

struct Writer {
    ndb: Ndb,
    record_key: [u8; 16],
    next_folder: u32,
    next_message: u32,
    top: u32,
}

fn text(value: &str) -> Value {
    Value::Unicode(value.to_owned())
}

fn size_i32(size: usize) -> i32 {
    i32::try_from(size).unwrap_or(i32::MAX)
}

impl Mail {
    /// The bytes its bodies and attachments take, as a writer states it.
    pub fn content_size(&self) -> usize {
        self.body.as_ref().map_or(0, |body| body.len() * 2)
            + self.html.as_ref().map_or(0, Vec::len)
            + self.rtf_compressed.as_ref().map_or(0, Vec::len)
            + self
                .attachments
                .iter()
                .map(|attachment| match &attachment.content {
                    AttachmentContent::Bytes(bytes) => bytes.len(),
                    AttachmentContent::Message(message) => message.content_size(),
                })
                .sum::<usize>()
            + 512
    }

    fn row(&self) -> Vec<(u16, Value)> {
        let mut row = vec![
            (0x0017, Value::Integer32(1)),
            (0x001A, text("IPM.Note")),
            (0x0039, Value::Time(self.sent)),
            (0x0042, text(&self.sender_name)),
            (0x0C1A, text(&self.sender_name)),
            (0x0E06, Value::Time(self.sent + HOUR / 60)),
            (0x0E07, Value::Integer32(1)),
            (
                0x0E08,
                Value::Integer32(
                    self.claimed_size
                        .unwrap_or_else(|| size_i32(self.content_size())),
                ),
            ),
            (0x3008, Value::Time(self.sent)),
        ];
        if let Some(subject) = &self.subject {
            row.push((0x0037, text(subject)));
        }
        let shown = |kind: i32| {
            self.recipients
                .iter()
                .filter(|recipient| recipient.kind == kind)
                .map(|recipient| recipient.name.as_str())
                .collect::<Vec<_>>()
                .join("; ")
        };
        for (id, kind) in [(0x0E04, 1), (0x0E03, 2)] {
            let names = shown(kind);
            if !names.is_empty() {
                row.push((id, Value::Unicode(names)));
            }
        }
        row
    }

    fn properties(&self) -> Vec<(u16, Value)> {
        let mut props = self.row();
        props.extend([
            (0x0C1E, text("SMTP")),
            (0x0C1F, text(&self.sender_email)),
            (0x5D01, text(&self.sender_email)),
            (0x0064, text("SMTP")),
            (0x0065, text(&self.sender_email)),
            (0x3007, Value::Time(self.sent)),
            (0x3FDE, Value::Integer32(65001)),
        ]);
        if let Some(body) = &self.body {
            props.push((0x1000, text(body)));
        }
        if let Some(html) = &self.html {
            props.push((0x1013, Value::Binary(html.clone())));
        }
        if let Some(rtf) = &self.rtf_compressed {
            props.push((0x1009, Value::Binary(rtf.clone())));
            props.push((0x0E1F, Value::Boolean(true)));
        }
        if let Some(message_id) = &self.message_id {
            props.push((0x1035, text(message_id)));
        }
        props.extend(self.extra.iter().cloned());
        props
    }
}

impl Writer {
    fn entry_id(&self, node: u32) -> Vec<u8> {
        let mut bytes = vec![0; 4];
        bytes.extend_from_slice(&self.record_key);
        bytes.extend_from_slice(&node.to_le_bytes());
        bytes
    }

    fn folder_node(&mut self) -> u32 {
        let index = self.next_folder;
        self.next_folder += 1;
        index
    }

    /// A folder's property context and its three tables, as top-level
    /// nodes, under `parent`.
    fn folder(
        &mut self,
        index: u32,
        parent: u32,
        name: &str,
        messages: &[Mail],
        children: &[(u32, &MailFolder)],
    ) {
        let node = (index << 5) | node_type::NORMAL_FOLDER;
        let mut subnodes = Subnodes::new();
        let props = vec![
            (0x3001, text(name)),
            (0x3602, Value::Integer32(size_i32(messages.len()))),
            (0x3603, Value::Integer32(0)),
            (0x360A, Value::Boolean(!children.is_empty())),
            (0x3613, text("IPF.Note")),
        ];
        let data = ltp::property_context(&mut self.ndb, &props, &mut subnodes);
        let sub = subnodes.write(&mut self.ndb);
        self.ndb.node(node, data, sub, parent);

        let hierarchy: Vec<(u32, Vec<(u16, Value)>)> = children
            .iter()
            .map(|(child, folder)| {
                let kind = if *child == SEARCH_FOLDER_INDEX {
                    node_type::SEARCH_FOLDER
                } else {
                    node_type::NORMAL_FOLDER
                };
                (
                    (*child << 5) | kind,
                    vec![
                        (0x3001, text(&folder.name)),
                        (0x3602, Value::Integer32(size_i32(folder.messages.len()))),
                        (0x3603, Value::Integer32(0)),
                        (0x360A, Value::Boolean(!folder.folders.is_empty())),
                    ],
                )
            })
            .collect();
        self.table(
            (index << 5) | node_type::HIERARCHY_TABLE,
            HIERARCHY_COLUMNS,
            &hierarchy,
        );

        let mut contents = Vec::with_capacity(messages.len());
        for message in messages {
            let message_node = (self.next_message << 5) | node_type::NORMAL_MESSAGE;
            self.next_message += 1;
            let (data, sub) = self.message(message);
            self.ndb.node(message_node, data, Some(sub), node);
            contents.push((message_node, message.row()));
        }
        self.table(
            (index << 5) | node_type::CONTENTS_TABLE,
            CONTENTS_COLUMNS,
            &contents,
        );
        self.table(
            (index << 5) | node_type::ASSOC_CONTENTS_TABLE,
            CONTENTS_COLUMNS,
            &[],
        );
    }

    fn table(&mut self, node: u32, columns: &[Column], rows: &[(u32, Vec<(u16, Value)>)]) {
        let mut subnodes = Subnodes::new();
        let data = ltp::table_context(&mut self.ndb, columns, rows, &mut subnodes);
        let sub = subnodes.write(&mut self.ndb);
        self.ndb.node(node, data, sub, 0);
    }

    /// A message's property context and its subnode tree (recipients,
    /// attachments, large values).
    fn message(&mut self, mail: &Mail) -> (u64, u64) {
        let mut subnodes = Subnodes::new();
        let recipients: Vec<(u32, Vec<(u16, Value)>)> = mail
            .recipients
            .iter()
            .enumerate()
            .map(|(row, recipient)| {
                #[allow(clippy::cast_possible_truncation)]
                (
                    row as u32,
                    vec![
                        (0x0C15, Value::Integer32(recipient.kind)),
                        (0x0FFE, Value::Integer32(6)),
                        (0x3001, text(&recipient.name)),
                        (0x3002, text("SMTP")),
                        (0x3003, text(&recipient.email)),
                        (0x3900, Value::Integer32(0)),
                        (0x39FE, text(&recipient.email)),
                    ],
                )
            })
            .collect();
        let (data, sub) = self.local_table(RECIPIENT_COLUMNS, &recipients);
        subnodes.add(SubnodeEntry {
            node: NID_RECIPIENT_TABLE,
            data,
            sub,
        });

        if !mail.attachments.is_empty() {
            let mut rows = Vec::with_capacity(mail.attachments.len());
            for (position, attachment) in mail.attachments.iter().enumerate() {
                let node = subnodes.id(node_type::ATTACHMENT);
                let (data, sub, size) = self.attachment(attachment, position);
                subnodes.add(SubnodeEntry { node, data, sub });
                rows.push((
                    node,
                    vec![
                        (0x0E20, Value::Integer32(size)),
                        (0x3704, text(&attachment.file_name)),
                        (
                            0x3705,
                            Value::Integer32(match attachment.content {
                                AttachmentContent::Bytes(_) => 1,
                                AttachmentContent::Message(_) => 5,
                            }),
                        ),
                        (0x370B, Value::Integer32(-1)),
                    ],
                ));
            }
            let (data, sub) = self.local_table(ATTACHMENT_COLUMNS, &rows);
            subnodes.add(SubnodeEntry {
                node: NID_ATTACHMENT_TABLE,
                data,
                sub,
            });
        }

        let data = ltp::property_context(&mut self.ndb, &mail.properties(), &mut subnodes);
        let sub = subnodes
            .write(&mut self.ndb)
            .unwrap_or_else(|| self.ndb.subnodes(Vec::new()));
        (data, sub)
    }

    /// A table local to a node (a message's recipients or attachments).
    fn local_table(&mut self, columns: &[Column], rows: &[(u32, Vec<(u16, Value)>)]) -> (u64, u64) {
        let mut subnodes = Subnodes::new();
        let data = ltp::table_context(&mut self.ndb, columns, rows, &mut subnodes);
        (data, subnodes.write(&mut self.ndb).unwrap_or(0))
    }

    fn attachment(&mut self, attachment: &Attachment, position: usize) -> (u64, u64, i32) {
        let mut subnodes = Subnodes::new();
        let mut props = vec![
            (0x3704, text(&attachment.file_name)),
            (0x3707, text(&attachment.file_name)),
            (0x3001, text(&attachment.file_name)),
            (0x370B, Value::Integer32(-1)),
            (0x7FFE, Value::Boolean(false)),
            (0x0E21, Value::Integer32(size_i32(position))),
        ];
        if let Some(mime_type) = &attachment.mime_type {
            props.push((0x370E, text(mime_type)));
        }
        let size = match &attachment.content {
            AttachmentContent::Bytes(bytes) => {
                props.push((0x3705, Value::Integer32(1)));
                props.push((0x3701, Value::Binary(bytes.clone())));
                size_i32(bytes.len())
            }
            AttachmentContent::Message(message) => {
                let node = subnodes.id(node_type::NORMAL_MESSAGE);
                let (data, sub) = self.message(message);
                subnodes.add(SubnodeEntry { node, data, sub });
                let size = size_i32(message.content_size());
                props.push((0x3705, Value::Integer32(5)));
                #[allow(clippy::cast_sign_loss)]
                props.push((
                    0x3701,
                    Value::Object {
                        node,
                        size: size as u32,
                    },
                ));
                size
            }
        };
        let size = attachment.claimed_size.unwrap_or(size);
        props.push((0x0E20, Value::Integer32(size)));
        let data = ltp::property_context(&mut self.ndb, &props, &mut subnodes);
        let sub = subnodes
            .write(&mut self.ndb)
            .unwrap_or_else(|| self.ndb.subnodes(Vec::new()));
        (data, sub, size)
    }

    fn folders(&mut self, parent_index: u32, folders: &[MailFolder]) -> Vec<(u32, u32)> {
        folders
            .iter()
            .map(|_| (self.folder_node(), parent_index))
            .collect::<Vec<_>>()
            .into_iter()
            .zip(folders)
            .map(|((index, parent), folder)| {
                let children = self.folders(index, &folder.folders);
                let looped = MailFolder::default();
                let mut child_refs: Vec<(u32, &MailFolder)> = children
                    .iter()
                    .map(|(child, _)| *child)
                    .zip(folder.folders.iter())
                    .collect();
                if folder.loops_to_top {
                    child_refs.push((self.top, &looped));
                }
                self.folder(
                    index,
                    (parent << 5) | node_type::NORMAL_FOLDER,
                    &folder.name,
                    &folder.messages,
                    &child_refs,
                );
                (index, parent)
            })
            .collect()
    }
}

/// `mailbox` as a Unicode PST file.
pub fn assemble(mailbox: &Mailbox) -> Vec<u8> {
    let mut writer = Writer {
        ndb: Ndb::new(),
        record_key: *b"stll-pst-fixture",
        next_folder: 0x400,
        next_message: 0x400,
        top: 0,
    };
    let root_index = NID_ROOT_FOLDER >> 5;
    let top_index = writer.folder_node();
    writer.top = top_index;
    let top_node = (top_index << 5) | node_type::NORMAL_FOLDER;

    let mut subnodes = Subnodes::new();
    let store = vec![
        (0x0FF9, Value::Binary(writer.record_key.to_vec())),
        (0x3001, text(&mailbox.display_name)),
        (0x35E0, Value::Binary(writer.entry_id(top_node))),
        (0x35E3, Value::Binary(writer.entry_id(top_node))),
        (0x35E7, Value::Binary(writer.entry_id(NID_ROOT_FOLDER))),
    ];
    let data = ltp::property_context(&mut writer.ndb, &store, &mut subnodes);
    let sub = subnodes.write(&mut writer.ndb);
    writer.ndb.node(NID_MESSAGE_STORE, data, sub, 0);

    let top = MailFolder {
        name: "Top of Outlook data file".to_owned(),
        messages: Vec::new(),
        folders: mailbox.folders.clone(),
        loops_to_top: false,
    };
    writer.folder(root_index, NID_ROOT_FOLDER, "", &[], &[(top_index, &top)]);
    let children = writer.folders(top_index, &mailbox.folders);
    let child_refs: Vec<(u32, &MailFolder)> = children
        .iter()
        .map(|(child, _)| *child)
        .zip(mailbox.folders.iter())
        .collect();
    let search = MailFolder {
        name: "Nepřečtená pošta".to_owned(),
        ..MailFolder::default()
    };
    let mut child_refs = child_refs;
    if mailbox.search_folder {
        // A search folder's row: a node of `NID_TYPE_SEARCH_FOLDER`, which
        // the walk never opens as a folder of its own.
        child_refs.push((SEARCH_FOLDER_INDEX, &search));
    }
    writer.folder(top_index, NID_ROOT_FOLDER, &top.name, &[], &child_refs);
    writer.ndb.finish()
}
