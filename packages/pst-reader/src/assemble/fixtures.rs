//! The committed fixtures and the generated measurement mailbox: invented
//! correspondence of an invented law firm. Every name, firm, address and
//! number here is made up; addresses use the reserved `.example` domain.

use super::{Attachment, AttachmentContent, BASE_TIME, HOUR, Mail, MailFolder, Mailbox, Recipient};

pub const FIRM_DOMAIN: &str = "vlkova-lisy.example";

fn recipient(name: &str, email: &str, kind: i32) -> Recipient {
    Recipient {
        name: name.to_owned(),
        email: email.to_owned(),
        kind,
    }
}

/// An RTF body as `PidTagRtfCompressed` stores it uncompressed (`MELA`,
/// [MS-OXRTFCP] 2.1.3.1): the size, the raw size, the magic and a zero CRC.
pub fn uncompressed_rtf(rtf: &str) -> Vec<u8> {
    let raw = rtf.as_bytes();
    let mut bytes = Vec::with_capacity(raw.len() + 16);
    let size = u32::try_from(raw.len() + 12).unwrap_or(u32::MAX);
    bytes.extend_from_slice(&size.to_le_bytes());
    bytes.extend_from_slice(&u32::try_from(raw.len()).unwrap_or(u32::MAX).to_le_bytes());
    bytes.extend_from_slice(&0x414C_454D_u32.to_le_bytes());
    bytes.extend_from_slice(&0_u32.to_le_bytes());
    bytes.extend_from_slice(raw);
    bytes
}

/// A tiny PDF that opens (one empty page).
pub fn small_pdf(title: &str) -> Vec<u8> {
    format!(
        "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n4 0 obj<</Title({title})>>endobj\ntrailer<</Root 1 0 R/Info 4 0 R>>\n%%EOF\n"
    )
    .into_bytes()
}

fn partner() -> (String, String) {
    (
        "Petra Vlková".to_owned(),
        format!("petra.vlkova@{FIRM_DOMAIN}"),
    )
}

fn associate() -> (String, String) {
    (
        "Ondřej Lisý".to_owned(),
        format!("ondrej.lisy@{FIRM_DOMAIN}"),
    )
}

fn client() -> (String, String) {
    (
        "Jitka Fiktivní".to_owned(),
        "jitka@fiktivni-stavby.example".to_owned(),
    )
}

/// The law firm mailbox the tests read: nested folders (and a search
/// folder, which is a view, not a folder of its own); plain, HTML and RTF
/// bodies; attachments; an attached message with an attachment of its own;
/// Unicode text; a message without a subject; and one whose list row claims
/// more than a message may be.
pub fn law_firm() -> Mailbox {
    let (partner_name, partner_email) = partner();
    let (associate_name, associate_email) = associate();
    let (client_name, client_email) = client();

    let draft = Mail {
        subject: Some("Smlouva o převodu podílu: návrh k připomínkám".to_owned()),
        sender_name: partner_name.clone(),
        sender_email: partner_email.clone(),
        recipients: vec![
            recipient(&associate_name, &associate_email, 1),
            recipient(&client_name, &client_email, 2),
        ],
        sent: BASE_TIME,
        body: Some(
            "Dobrý den,\r\n\r\nv příloze posílám návrh smlouvy o převodu podílu. \
             Připomínky prosím do pátku.\r\n\r\nPetra Vlková"
                .to_owned(),
        ),
        html: Some(
            "<html><body><p>Dobrý den,</p><p>v příloze posílám <b>návrh smlouvy</b> \
             o převodu podílu. Připomínky prosím do pátku.</p><p>Petra Vlková</p></body></html>"
                .as_bytes()
                .to_vec(),
        ),
        message_id: Some(format!("<navrh-1@{FIRM_DOMAIN}>")),
        attachments: vec![
            Attachment {
                file_name: "navrh-smlouvy.pdf".to_owned(),
                mime_type: Some("application/pdf".to_owned()),
                content: AttachmentContent::Bytes(small_pdf("Návrh smlouvy")),
                claimed_size: None,
            },
            Attachment {
                file_name: "poznámky k návrhu.txt".to_owned(),
                mime_type: None,
                content: AttachmentContent::Bytes(
                    "1. Kupní cena ve dvou splátkách.\n2. Konkurenční doložka na dva roky.\n"
                        .as_bytes()
                        .to_vec(),
                ),
                claimed_size: None,
            },
        ],
        ..Mail::default()
    };

    let reply = Mail {
        subject: Some("Re: Termín jednání".to_owned()),
        sender_name: client_name.clone(),
        sender_email: client_email.clone(),
        recipients: vec![recipient(&partner_name, &partner_email, 1)],
        sent: BASE_TIME + 3 * HOUR,
        body: Some("Dobrý den, čtvrtek v 10:00 nám vyhovuje. J. Fiktivní".to_owned()),
        ..Mail::default()
    };

    let no_subject = Mail {
        subject: None,
        sender_name: associate_name.clone(),
        sender_email: associate_email.clone(),
        recipients: vec![recipient(&partner_name, &partner_email, 1)],
        sent: BASE_TIME + 4 * HOUR,
        body: Some("Posílám bez předmětu, omlouvám se.".to_owned()),
        ..Mail::default()
    };

    let rtf_html = Mail {
        subject: Some("Zápis z porady".to_owned()),
        sender_name: partner_name.clone(),
        sender_email: partner_email.clone(),
        recipients: vec![recipient(&associate_name, &associate_email, 1)],
        sent: BASE_TIME + 5 * HOUR,
        rtf_compressed: Some(uncompressed_rtf(
            "{\\rtf1\\ansi\\fromhtml1 \\deff0{\\fonttbl{\\f0 Arial;}}\
             {\\*\\htmltag19 <html>}{\\*\\htmltag34 <body>}\
             {\\*\\htmltag64 <p>}Z\\'e1pis z porady: \\htmlrtf {\\b \\htmlrtf0 \
             {\\*\\htmltag84 <b>}ukoly\\htmlrtf }\\htmlrtf0 {\\*\\htmltag92 </b>} do konce m\\u283?s\\'edce.\
             {\\*\\htmltag72 </p>}{\\*\\htmltag42 </body>}{\\*\\htmltag27 </html>}}",
        )),
        ..Mail::default()
    };

    let rtf_plain = Mail {
        subject: Some("Plná moc".to_owned()),
        sender_name: associate_name.clone(),
        sender_email: associate_email.clone(),
        recipients: vec![recipient(&partner_name, &partner_email, 1)],
        sent: BASE_TIME + 6 * HOUR,
        rtf_compressed: Some(uncompressed_rtf(
            "{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Arial;}}\
             \\f0 Plnou moc jsem nechal podepsat u klientky.\\par}",
        )),
        ..Mail::default()
    };

    let forwarded = Mail {
        subject: Some("Fwd: Výzva k úhradě".to_owned()),
        sender_name: partner_name.clone(),
        sender_email: partner_email.clone(),
        recipients: vec![recipient(&associate_name, &associate_email, 1)],
        sent: BASE_TIME + 24 * HOUR,
        body: Some("Přeposílám výzvu, prosím o návrh odpovědi.".to_owned()),
        attachments: vec![Attachment {
            file_name: "Výzva k úhradě.msg".to_owned(),
            mime_type: None,
            content: AttachmentContent::Message(Box::new(Mail {
                subject: Some("Výzva k úhradě".to_owned()),
                sender_name: "Advokátní kancelář Modrý dub".to_owned(),
                sender_email: "podatelna@modry-dub.example".to_owned(),
                recipients: vec![recipient(&client_name, &client_email, 1)],
                sent: BASE_TIME + 20 * HOUR,
                body: Some("Vyzýváme Vás k úhradě částky 120 000 Kč do 15 dnů.".to_owned()),
                attachments: vec![Attachment {
                    file_name: "faktura-2024-118.pdf".to_owned(),
                    mime_type: Some("application/pdf".to_owned()),
                    content: AttachmentContent::Bytes(small_pdf("Faktura")),
                    claimed_size: None,
                }],
                ..Mail::default()
            })),
            claimed_size: None,
        }],
        ..Mail::default()
    };

    let foreign = Mail {
        subject: Some("Ελληνικά, العربية, 日本語".to_owned()),
        sender_name: associate_name.clone(),
        sender_email: associate_email.clone(),
        recipients: vec![recipient(&partner_name, &partner_email, 1)],
        sent: BASE_TIME + 30 * HOUR,
        body: Some("Překlady pro zahraničního klienta: Ελληνικά, العربية, 日本語.".to_owned()),
        ..Mail::default()
    };

    let oversize = Mail {
        subject: Some("Spis ve skenech".to_owned()),
        sender_name: client_name.clone(),
        sender_email: client_email.clone(),
        recipients: vec![recipient(&partner_name, &partner_email, 1)],
        sent: BASE_TIME + 48 * HOUR,
        body: Some("Skeny celého spisu.".to_owned()),
        claimed_size: Some(48 * 1024 * 1024),
        ..Mail::default()
    };

    let archived = Mail {
        subject: Some("Uzavření věci".to_owned()),
        sender_name: partner_name.clone(),
        sender_email: partner_email.clone(),
        recipients: vec![recipient(&client_name, &client_email, 1)],
        sent: BASE_TIME - 2000 * HOUR,
        body: Some("Věc je uzavřena, spis archivujeme.".to_owned()),
        ..Mail::default()
    };

    Mailbox {
        display_name: "Petra Vlková".to_owned(),
        search_folder: true,
        folders: vec![
            MailFolder {
                name: "Doručená pošta".to_owned(),
                messages: vec![draft, reply, no_subject, rtf_html, rtf_plain],
                folders: vec![MailFolder {
                    name: "Klienti".to_owned(),
                    messages: Vec::new(),
                    folders: vec![MailFolder {
                        name: "Fiktivní stavby".to_owned(),
                        messages: vec![forwarded, oversize],
                        ..MailFolder::default()
                    }],
                    ..MailFolder::default()
                }],
                ..MailFolder::default()
            },
            MailFolder {
                name: "Odeslaná pošta".to_owned(),
                messages: vec![foreign],
                ..MailFolder::default()
            },
            MailFolder {
                name: "Archiv".to_owned(),
                folders: vec![MailFolder {
                    name: "2023".to_owned(),
                    messages: vec![archived],
                    ..MailFolder::default()
                }],
                ..MailFolder::default()
            },
        ],
    }
}

/// A generated mailbox of `count` messages over `folders` folders, every
/// third with an attachment of `attachment_bytes`, for measurements.
pub fn large(count: usize, folders: usize, attachment_bytes: usize) -> Mailbox {
    let (partner_name, partner_email) = partner();
    let (client_name, client_email) = client();
    let paragraph = "Zasíláme stanovisko k bodům, které jsme probrali na jednání. \
                     Smluvní pokuta se uplatní jen při podstatném porušení. ";
    let attachment: Vec<u8> = (0..attachment_bytes)
        .map(|index| u8::try_from((index * 31 + index / 7) % 251).unwrap_or(0))
        .collect();
    let mut buckets: Vec<Vec<Mail>> = vec![Vec::new(); folders.max(1)];
    for index in 0..count {
        let sent = BASE_TIME + i64::try_from(index).unwrap_or(0) * HOUR / 4;
        let mail = Mail {
            subject: Some(format!("Věc č. {}: stanovisko", 1000 + index)),
            sender_name: partner_name.clone(),
            sender_email: partner_email.clone(),
            recipients: vec![recipient(&client_name, &client_email, 1)],
            sent,
            body: Some(paragraph.repeat(1 + index % 12)),
            attachments: if index % 3 == 0 && attachment_bytes > 0 {
                vec![Attachment {
                    file_name: format!("stanovisko-{index}.bin"),
                    mime_type: Some("application/octet-stream".to_owned()),
                    content: AttachmentContent::Bytes(attachment.clone()),
                    claimed_size: None,
                }]
            } else {
                Vec::new()
            },
            ..Mail::default()
        };
        let bucket = index % buckets.len();
        buckets[bucket].push(mail);
    }
    Mailbox {
        display_name: "Generated mailbox".to_owned(),
        search_folder: false,
        folders: buckets
            .into_iter()
            .enumerate()
            .map(|(index, messages)| MailFolder {
                name: format!("Spisy {index}"),
                messages,
                ..MailFolder::default()
            })
            .collect(),
    }
}
