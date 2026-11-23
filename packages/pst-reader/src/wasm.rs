use std::io;

use wasm_bindgen::prelude::*;

use crate::{Limits, Mailbox, source::Source, wire};

#[wasm_bindgen]
extern "C" {
    /// The host's file: `readAt(offset, buffer)` fills `buffer` from
    /// `offset` and returns how many bytes it read (fewer only at the end of
    /// the file), or -1 when it cannot or will not read (its deadline).
    pub type PstHostFile;

    #[wasm_bindgen(method, js_name = readAt)]
    fn read_at(this: &PstHostFile, offset: f64, buffer: &mut [u8]) -> i32;
}

struct HostSource {
    file: PstHostFile,
    size: u64,
}

impl Source for HostSource {
    fn size(&self) -> u64 {
        self.size
    }

    fn read_at(&mut self, offset: u64, buffer: &mut [u8]) -> io::Result<usize> {
        #[allow(clippy::cast_precision_loss)]
        let read = self.file.read_at(offset as f64, buffer);
        usize::try_from(read)
            .ok()
            .filter(|read| *read <= buffer.len())
            .ok_or_else(|| io::Error::other("the host did not read"))
    }
}

/// The outcome of one operation: `read`, or the refusal's code.
#[wasm_bindgen]
pub struct WasmPstOutcome {
    status: &'static str,
    bytes: Vec<u8>,
}

#[wasm_bindgen]
impl WasmPstOutcome {
    #[wasm_bindgen(getter)]
    pub fn status(&self) -> String {
        self.status.to_owned()
    }

    /// The listing or the message (`wire`), moved out: a second call
    /// returns none.
    pub fn take_bytes(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.bytes)
    }
}

fn outcome(result: Result<Vec<u8>, crate::Refusal>) -> WasmPstOutcome {
    match result {
        Ok(bytes) => WasmPstOutcome {
            status: "read",
            bytes,
        },
        Err(refusal) => WasmPstOutcome {
            status: refusal.code(),
            bytes: Vec::new(),
        },
    }
}

#[wasm_bindgen]
pub struct WasmPstMailbox {
    mailbox: Option<Mailbox>,
    refusal: &'static str,
}

#[wasm_bindgen]
impl WasmPstMailbox {
    /// `opened`, or the refusal's code.
    #[wasm_bindgen(getter)]
    pub fn status(&self) -> String {
        if self.mailbox.is_some() {
            "opened".to_owned()
        } else {
            self.refusal.to_owned()
        }
    }

    pub fn list(&mut self) -> WasmPstOutcome {
        outcome(match &mut self.mailbox {
            Some(mailbox) => mailbox.list().map(wire::encode_listing),
            None => Err(crate::Refusal::Unreadable),
        })
    }

    pub fn message(&mut self, index: u32) -> WasmPstOutcome {
        outcome(match &mut self.mailbox {
            Some(mailbox) => mailbox
                .message(index as usize)
                .map(|body| wire::encode_message(&body)),
            None => Err(crate::Refusal::Unreadable),
        })
    }
}

/// Limits are passed as JavaScript numbers, in [`Limits`] field order, and
/// must be whole and positive; anything else is a caller defect.
#[wasm_bindgen]
pub fn open_pst_mailbox(
    file: PstHostFile,
    size: f64,
    limits: &[f64],
) -> Result<WasmPstMailbox, JsValue> {
    let whole = |value: f64| {
        if value.is_finite() && value >= 1.0 && value.fract() == 0.0 && value <= 9.0e15 {
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            Ok(value as u64)
        } else {
            Err(JsValue::from_str("limits must be positive integers"))
        }
    };
    let [
        max_messages,
        max_message_bytes,
        max_walk_bytes,
        max_message_read_bytes,
        max_reads,
        max_folders,
        max_folder_depth,
        max_recipients,
        max_attachments,
    ] = limits
    else {
        return Err(JsValue::from_str("nine limits are required"));
    };
    let index = |value: f64| {
        whole(value).and_then(|value| {
            usize::try_from(value).map_err(|_| JsValue::from_str("a limit is too large"))
        })
    };
    let limits = Limits {
        max_messages: index(*max_messages)?,
        max_message_bytes: index(*max_message_bytes)?,
        max_walk_bytes: whole(*max_walk_bytes)?,
        max_message_read_bytes: whole(*max_message_read_bytes)?,
        max_reads: whole(*max_reads)?,
        max_folders: index(*max_folders)?,
        max_folder_depth: u32::try_from(whole(*max_folder_depth)?)
            .map_err(|_| JsValue::from_str("a limit is too large"))?,
        max_recipients: index(*max_recipients)?,
        max_attachments: index(*max_attachments)?,
    };
    let size = if size.is_finite() && size >= 0.0 && size.fract() == 0.0 {
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        Ok(size as u64)
    } else {
        Err(JsValue::from_str("the size must be a whole number"))
    }?;
    Ok(match Mailbox::open(HostSource { file, size }, limits) {
        Ok(mailbox) => WasmPstMailbox {
            mailbox: Some(mailbox),
            refusal: "",
        },
        Err(refusal) => WasmPstMailbox {
            mailbox: None,
            refusal: refusal.code(),
        },
    })
}
