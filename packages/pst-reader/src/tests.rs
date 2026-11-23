use std::panic::{AssertUnwindSafe, catch_unwind};

use crate::{
    Limits, Mailbox, Refusal,
    assemble::{self, Attachment, AttachmentContent, Mail, MailFolder, fixtures},
    prop,
    source::Source,
    wire::{self, AttachmentData, Listing, MessageBody, Prop},
};

/// The limits the service reads with ([`crate::Limits`] fields).
const LIMITS: Limits = Limits {
    max_messages: 10_000,
    max_message_bytes: 32 * 1024 * 1024,
    max_walk_bytes: 256 * 1024 * 1024,
    max_message_read_bytes: 80 * 1024 * 1024,
    max_reads: 1_000_000,
    max_folders: 2_000,
    max_folder_depth: 32,
    max_recipients: 500,
    max_attachments: 250,
};

fn text(props: &[Prop], id: u16) -> Option<String> {
    let found = props.iter().find(|prop| prop.id == id)?;
    match found.kind {
        wire::TYPE_UNICODE => String::from_utf8(found.bytes.clone()).ok(),
        _ => None,
    }
}

fn integer(props: &[Prop], id: u16) -> Option<i32> {
    let found = props.iter().find(|prop| prop.id == id)?;
    Some(i32::from_le_bytes(found.bytes.clone().try_into().ok()?))
}

fn open(bytes: Vec<u8>, limits: Limits) -> Result<Mailbox, Refusal> {
    Mailbox::open(bytes, limits)
}

fn law_firm() -> Vec<u8> {
    assemble::assemble(&fixtures::law_firm())
}

fn listing(bytes: Vec<u8>, limits: Limits) -> Result<Listing, Refusal> {
    let mut mailbox = open(bytes, limits)?;
    mailbox.list().cloned()
}

fn folder_path(listing: &Listing, folder: u32) -> String {
    let mut names = Vec::new();
    let mut at = Some(folder);
    while let Some(index) = at {
        let record = &listing.folders[index as usize];
        if record.depth > 0 {
            names.push(text(&record.props, prop::DISPLAY_NAME).unwrap_or_default());
        }
        at = record.parent;
    }
    names.reverse();
    names.join("/")
}

#[test]
fn lists_folders_depth_first_and_messages_in_table_order() -> Result<(), Refusal> {
    let listing = listing(law_firm(), LIMITS)?;
    let rows: Vec<(String, Option<String>)> = listing
        .messages
        .iter()
        .map(|message| {
            (
                folder_path(&listing, message.folder),
                text(&message.props, prop::SUBJECT),
            )
        })
        .collect();
    let expected: Vec<(&str, Option<&str>)> = vec![
        (
            "Doručená pošta",
            Some("Smlouva o převodu podílu: návrh k připomínkám"),
        ),
        ("Doručená pošta", Some("Re: Termín jednání")),
        ("Doručená pošta", None),
        ("Doručená pošta", Some("Zápis z porady")),
        ("Doručená pošta", Some("Plná moc")),
        (
            "Doručená pošta/Klienti/Fiktivní stavby",
            Some("Fwd: Výzva k úhradě"),
        ),
        (
            "Doručená pošta/Klienti/Fiktivní stavby",
            Some("Spis ve skenech"),
        ),
        ("Odeslaná pošta", Some("Ελληνικά, العربية, 日本語")),
        ("Archiv/2023", Some("Uzavření věci")),
    ];
    let expected: Vec<(String, Option<String>)> = expected
        .into_iter()
        .map(|(folder, subject)| (folder.to_owned(), subject.map(str::to_owned)))
        .collect();
    assert_eq!(rows, expected);
    assert!(!listing.truncated);
    let first = &listing.messages[0].props;
    assert_eq!(
        text(first, prop::SENDER_NAME).as_deref(),
        Some("Petra Vlková")
    );
    assert!(
        first
            .iter()
            .any(|prop| prop.id == prop::MESSAGE_DELIVERY_TIME)
    );
    assert_eq!(
        integer(&listing.messages[6].props, prop::MESSAGE_SIZE),
        Some(48 * 1024 * 1024)
    );
    Ok(())
}

#[test]
fn reads_a_message_with_bodies_recipients_and_attachments() -> Result<(), Refusal> {
    let mut mailbox = open(law_firm(), LIMITS)?;
    let message = mailbox.message(0)?;
    assert_eq!(
        text(&message.props, prop::SUBJECT).as_deref(),
        Some("Smlouva o převodu podílu: návrh k připomínkám")
    );
    assert!(text(&message.props, prop::BODY).is_some_and(|body| body.contains("Připomínky")));
    let html = message.props.iter().find(|prop| prop.id == prop::HTML);
    assert!(
        html.is_some_and(
            |html| String::from_utf8_lossy(&html.bytes).contains("<b>návrh smlouvy</b>")
        )
    );
    assert_eq!(
        text(&message.props, prop::SENDER_SMTP_ADDRESS).as_deref(),
        Some("petra.vlkova@vlkova-lisy.example")
    );
    let recipients: Vec<(Option<String>, Option<i32>)> = message
        .recipients
        .iter()
        .map(|props| {
            (
                text(props, prop::SMTP_ADDRESS),
                integer(props, prop::RECIPIENT_TYPE),
            )
        })
        .collect();
    assert_eq!(
        recipients,
        vec![
            (Some("ondrej.lisy@vlkova-lisy.example".to_owned()), Some(1)),
            (Some("jitka@fiktivni-stavby.example".to_owned()), Some(2)),
        ]
    );
    let names: Vec<Option<String>> = message
        .attachments
        .iter()
        .map(|attachment| text(&attachment.props, prop::ATTACH_LONG_FILENAME))
        .collect();
    assert_eq!(
        names,
        vec![
            Some("navrh-smlouvy.pdf".to_owned()),
            Some("poznámky k návrhu.txt".to_owned())
        ]
    );
    assert_eq!(
        message.attachments[0].data,
        AttachmentData::Bytes(fixtures::small_pdf("Návrh smlouvy"))
    );
    assert!(!message.attachments_truncated);
    Ok(())
}

/// An attached message's `PidTagAttachDataObject` is a `PtypObject`, a type
/// the library's property reader does not list; it stops reading the
/// attachment's properties there, so the attachment is given by its row in
/// the attachment table (its name, method and size), without content.
#[test]
fn an_attached_message_is_given_by_its_row() -> Result<(), Refusal> {
    let mut mailbox = open(law_firm(), LIMITS)?;
    let message = mailbox.message(5)?;
    let [attachment] = message.attachments.as_slice() else {
        panic!("one attachment expected");
    };
    assert_eq!(integer(&attachment.props, prop::ATTACH_METHOD), Some(5));
    assert_eq!(
        text(&attachment.props, prop::ATTACH_FILENAME).as_deref(),
        Some("Výzva k úhradě.msg")
    );
    assert!(integer(&attachment.props, prop::ATTACH_SIZE).is_some_and(|size| size > 0));
    assert_eq!(attachment.data, AttachmentData::None);
    assert!(text(&message.props, prop::BODY).is_some_and(|body| body.contains("Přeposílám")));
    Ok(())
}

#[test]
fn reads_rtf_bodies_as_stored() -> Result<(), Refusal> {
    let mut mailbox = open(law_firm(), LIMITS)?;
    let message = mailbox.message(3)?;
    let rtf = message
        .props
        .iter()
        .find(|prop| prop.id == prop::RTF_COMPRESSED)
        .map(|prop| prop.bytes.clone());
    assert!(rtf.is_some_and(|rtf| rtf[8..12] == *b"MELA"));
    assert!(message.props.iter().all(|prop| prop.id != prop::BODY));
    Ok(())
}

#[test]
fn a_message_without_a_subject_has_none() -> Result<(), Refusal> {
    let mut mailbox = open(law_firm(), LIMITS)?;
    let message = mailbox.message(2)?;
    assert_eq!(text(&message.props, prop::SUBJECT), None);
    assert!(text(&message.props, prop::BODY).is_some());
    Ok(())
}

#[test]
fn a_message_reads_the_same_with_or_without_the_list_first() -> Result<(), Refusal> {
    let mut listed = open(law_firm(), LIMITS)?;
    listed.list()?;
    let mut direct = open(law_firm(), LIMITS)?;
    for index in 0..9 {
        if index == 6 {
            continue;
        }
        assert_eq!(listed.message(index)?, direct.message(index)?);
    }
    assert_eq!(direct.message(9), Err(Refusal::NoMessage));
    assert_eq!(listed.message(9), Err(Refusal::NoMessage));
    Ok(())
}

#[test]
fn a_message_claiming_more_than_a_message_may_be_is_not_read() -> Result<(), Refusal> {
    let mut mailbox = open(law_firm(), LIMITS)?;
    assert_eq!(mailbox.message(6), Err(Refusal::TooLarge));
    Ok(())
}

#[test]
fn a_message_larger_than_it_claims_is_stopped_at_the_bound() -> Result<(), Refusal> {
    let big = Mail {
        subject: Some("Velká příloha".to_owned()),
        sender_name: "A".to_owned(),
        sender_email: "a@example.example".to_owned(),
        attachments: vec![Attachment {
            file_name: "sken.bin".to_owned(),
            mime_type: None,
            content: AttachmentContent::Bytes(vec![7; 600_000]),
            claimed_size: None,
        }],
        claimed_size: Some(1000),
        ..Mail::default()
    };
    let bytes = assemble::assemble(&assemble::Mailbox {
        display_name: "x".to_owned(),
        search_folder: false,
        folders: vec![MailFolder {
            name: "Inbox".to_owned(),
            messages: vec![big],
            ..MailFolder::default()
        }],
    });
    let mut small = open(
        bytes.clone(),
        Limits {
            max_message_bytes: 500_000,
            ..LIMITS
        },
    )?;
    assert_eq!(small.message(0), Err(Refusal::TooLarge));
    let mut budget = open(
        bytes.clone(),
        Limits {
            max_message_read_bytes: 300_000,
            ..LIMITS
        },
    )?;
    assert_eq!(budget.message(0), Err(Refusal::TooLarge));
    let mut fits = open(bytes, LIMITS)?;
    let read = fits.message(0)?;
    assert_eq!(
        read.attachments[0].data,
        AttachmentData::Bytes(vec![7; 600_000])
    );
    Ok(())
}

/// A mailbox of one message with one attachment of `bytes` bytes, whose
/// row and properties claim `claimed` bytes.
fn one_attachment(bytes: usize, claimed: Option<i32>) -> Vec<u8> {
    assemble::assemble(&assemble::Mailbox {
        display_name: "x".to_owned(),
        search_folder: false,
        folders: vec![MailFolder {
            name: "Inbox".to_owned(),
            messages: vec![Mail {
                subject: Some("Příloha".to_owned()),
                sender_name: "A".to_owned(),
                sender_email: "a@example.example".to_owned(),
                attachments: vec![Attachment {
                    file_name: "sken.bin".to_owned(),
                    mime_type: None,
                    content: AttachmentContent::Bytes(vec![7; bytes]),
                    claimed_size: claimed,
                }],
                claimed_size: Some(1000),
                ..Mail::default()
            }],
            ..MailFolder::default()
        }],
    })
}

#[test]
fn an_attachment_larger_than_it_claims_is_stopped_at_the_bound() -> Result<(), Refusal> {
    let limits = Limits {
        max_message_bytes: 500_000,
        ..LIMITS
    };
    // Its row says 1,000 bytes; what is read is over the bound.
    let mut lying = open(one_attachment(600_000, Some(1000)), limits)?;
    assert_eq!(lying.message(0), Err(Refusal::TooLarge));
    let mut honest = open(one_attachment(400_000, None), limits)?;
    assert!(honest.message(0).is_ok());
    Ok(())
}

#[test]
fn an_attachment_claiming_more_than_a_message_may_be_is_not_read() -> Result<(), Refusal> {
    let limits = Limits {
        max_message_bytes: 500_000,
        ..LIMITS
    };
    let mut claiming = open(one_attachment(100, Some(600_000)), limits)?;
    assert_eq!(claiming.message(0), Err(Refusal::TooLarge));
    Ok(())
}

#[test]
fn a_search_folder_is_not_walked_as_a_folder() -> Result<(), Refusal> {
    let mut plain = fixtures::law_firm();
    plain.search_folder = false;
    let with = listing(law_firm(), LIMITS)?;
    let without = listing(assemble::assemble(&plain), LIMITS)?;
    assert_eq!(with, without);
    assert!(!with.truncated);
    Ok(())
}

#[test]
fn the_list_stops_at_its_message_bound() -> Result<(), Refusal> {
    let limits = Limits {
        max_messages: 4,
        ..LIMITS
    };
    let listing = listing(law_firm(), limits)?;
    assert_eq!(listing.messages.len(), 4);
    assert!(listing.truncated);
    let exact = listing_of(9);
    assert!(!exact.truncated);
    assert_eq!(exact.messages.len(), 9);
    let mut mailbox = open(law_firm(), limits)?;
    assert_eq!(mailbox.message(4), Err(Refusal::NoMessage));
    Ok(())
}

fn listing_of(max_messages: usize) -> Listing {
    listing(
        law_firm(),
        Limits {
            max_messages,
            ..LIMITS
        },
    )
    .unwrap_or_default()
}

#[test]
fn the_walk_stops_at_its_folder_and_depth_bounds() -> Result<(), Refusal> {
    let shallow = listing(
        law_firm(),
        Limits {
            max_folder_depth: 1,
            ..LIMITS
        },
    )?;
    assert!(shallow.truncated);
    assert!(shallow.folders.iter().all(|folder| folder.depth <= 1));
    assert_eq!(shallow.messages.len(), 6);
    let few = listing(
        law_firm(),
        Limits {
            max_folders: 3,
            ..LIMITS
        },
    )?;
    assert!(few.truncated);
    assert_eq!(few.folders.len(), 3);
    Ok(())
}

#[test]
fn a_hierarchy_that_loops_is_walked_once() -> Result<(), Refusal> {
    let mut mailbox = fixtures::law_firm();
    mailbox.folders[2].folders[0].loops_to_top = true;
    let listing = listing(assemble::assemble(&mailbox), LIMITS)?;
    assert_eq!(listing.messages.len(), 9);
    assert_eq!(listing.folders.len(), 7);
    Ok(())
}

#[test]
fn a_large_folder_lists_every_message() -> Result<(), Refusal> {
    let bytes = assemble::assemble(&fixtures::large(1_500, 1, 0));
    let listing = listing(bytes.clone(), LIMITS)?;
    assert_eq!(listing.messages.len(), 1_500);
    let mut mailbox = open(bytes, LIMITS)?;
    let last = mailbox.message(1_499)?;
    assert_eq!(
        text(&last.props, prop::SUBJECT).as_deref(),
        Some("Věc č. 2499: stanovisko")
    );
    Ok(())
}

#[test]
fn budgets_end_an_operation() {
    let tiny_walk = open(
        law_firm(),
        Limits {
            max_walk_bytes: 2_000,
            ..LIMITS
        },
    );
    assert!(matches!(tiny_walk, Err(Refusal::Exhausted)));
    let few_reads = open(
        law_firm(),
        Limits {
            max_reads: 3,
            ..LIMITS
        },
    );
    assert!(matches!(few_reads, Err(Refusal::Exhausted)));
}

/// A host that stops answering after `left` reads, as one past its
/// deadline does.
struct Stopping {
    bytes: Vec<u8>,
    left: std::cell::Cell<usize>,
}

impl Source for Stopping {
    fn size(&self) -> u64 {
        self.bytes.len() as u64
    }

    fn read_at(&mut self, offset: u64, buffer: &mut [u8]) -> std::io::Result<usize> {
        let left = self.left.get();
        if left == 0 {
            return Err(std::io::Error::other("deadline"));
        }
        self.left.set(left - 1);
        self.bytes.read_at(offset, buffer)
    }
}

#[test]
fn a_host_that_stops_ends_the_operation() -> Result<(), Refusal> {
    let opening = Mailbox::open(
        Stopping {
            bytes: law_firm(),
            left: std::cell::Cell::new(2),
        },
        LIMITS,
    );
    assert!(matches!(opening, Err(Refusal::Exhausted)));
    // The fewest reads that open the mailbox, then one more: the list
    // starts and is stopped.
    let opens = (1..100)
        .find(|reads| {
            Mailbox::open(
                Stopping {
                    bytes: law_firm(),
                    left: std::cell::Cell::new(*reads),
                },
                LIMITS,
            )
            .is_ok()
        })
        .unwrap_or(0);
    // With more reads, the list ends early (and says so) or not at all.
    let mut partial = 0;
    for reads in opens..opens + 200 {
        let mut mailbox = Mailbox::open(
            Stopping {
                bytes: law_firm(),
                left: std::cell::Cell::new(reads),
            },
            LIMITS,
        )?;
        match mailbox.list() {
            Ok(listing) if listing.messages.len() == 9 && !listing.truncated => break,
            Ok(listing) => {
                assert!(listing.truncated);
                partial += 1;
            }
            Err(refusal) => assert_eq!(refusal, Refusal::Exhausted),
        }
    }
    assert!(partial > 0);
    Ok(())
}

#[test]
fn files_that_are_not_mailboxes_are_unreadable() {
    for bytes in [
        Vec::new(),
        b"!BDN".to_vec(),
        vec![0; 4096],
        b"From someone@example.example Mon Jan  1 00:00:00 2024\n\nhello\n".to_vec(),
    ] {
        assert!(matches!(open(bytes, LIMITS), Err(Refusal::Unreadable)));
    }
}

#[test]
fn the_libraries_empty_mailbox_lists_nothing() -> Result<(), Refusal> {
    let bytes = include_bytes!("../fixtures/outlook-pst-rs/Empty.pst").to_vec();
    let listing = listing(bytes, LIMITS)?;
    assert!(listing.messages.is_empty());
    assert!(!listing.truncated);
    Ok(())
}

/// Runs every operation on `bytes`; a damaged file is refused or read in
/// part, and every operation ends. A panic inside the library (which in
/// WebAssembly traps and is handled by the host) is counted, not raised.
fn read_everything(bytes: Vec<u8>) -> bool {
    catch_unwind(AssertUnwindSafe(|| {
        let Ok(mut mailbox) = open(bytes, LIMITS) else {
            return;
        };
        let count = mailbox.list().map_or(0, |listing| listing.messages.len());
        for index in 0..count {
            let _ = mailbox.message(index);
        }
    }))
    .is_ok()
}

#[test]
fn every_truncation_of_a_mailbox_ends() {
    let bytes = law_firm();
    let mut cut = 0;
    while cut < bytes.len() {
        read_everything(bytes[..cut].to_vec());
        cut += 997;
    }
}

#[test]
fn damaged_bytes_never_spin() {
    let bytes = law_firm();
    let mut seed = 0x2545_F491_4F6C_DD1D_u64;
    for _ in 0..300 {
        let mut damaged = bytes.clone();
        for _ in 0..8 {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            let at = usize::try_from(seed % damaged.len() as u64).unwrap_or(0);
            damaged[at] ^= u8::try_from(seed >> 56).unwrap_or(1) | 1;
        }
        read_everything(damaged);
    }
}

#[test]
fn the_committed_fixture_is_the_assemblers_output() {
    let committed = include_bytes!("../fixtures/law-firm.pst");
    assert!(
        committed.as_slice() == law_firm().as_slice(),
        "fixtures/law-firm.pst is stale: run `cargo run --example write-fixtures --features assemble`"
    );
}

#[test]
fn the_wire_layout_round_trips_sizes() -> Result<(), Refusal> {
    let mut mailbox = open(law_firm(), LIMITS)?;
    let body: MessageBody = mailbox.message(5)?;
    assert_eq!(wire::encode_message(&body).len(), 5 + body.wire_size());
    let listing = mailbox.list()?;
    let encoded = wire::encode_listing(listing);
    assert_eq!(&encoded[..4], wire::LISTING_MAGIC);
    assert_eq!(encoded.last(), Some(&0));
    Ok(())
}
