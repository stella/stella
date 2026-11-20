//! A small Word document writer for what the transcription window saves on
//! this computer: a transcript with the time each paragraph starts, or the
//! cleaned-up text from its Markdown. Only the parts Word needs are written
//! (document, styles, numbering and their relationships), stored without
//! compression, so the file opens in Word, Pages and LibreOffice.
//!
//! The Markdown is the subset cleanup writes: paragraphs, `#` to `###`
//! headings, `**bold**` and `*italic*`, `- ` bullets and `1. ` numbered
//! lists one level deep. Headings and lists become Word's own heading and
//! list styles, never literal markers.

use std::io::{Cursor, Write};

use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

/// A stretch of text with its emphasis.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Span {
  pub text: String,
  pub bold: bool,
  pub italic: bool,
}

impl Span {
  fn plain(text: impl Into<String>) -> Self {
    Self {
      text: text.into(),
      bold: false,
      italic: false,
    }
  }
}

/// One paragraph of the document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Block {
  /// A heading of level 1 to 3.
  Heading {
    level: u8,
    spans: Vec<Span>,
  },
  Paragraph(Vec<Span>),
  Bullet(Vec<Span>),
  /// An item of the `list`th numbered list, which counts from 1.
  Numbered {
    list: u32,
    spans: Vec<Span>,
  },
  /// A note set apart from the text: its label, then each line.
  Note {
    label: String,
    lines: Vec<String>,
  },
}

/// `m:ss`, or `h:mm:ss` from an hour on, as the window shows it.
pub(crate) fn timestamp(ms: u64) -> String {
  let seconds = ms / 1000;
  let (hours, minutes, seconds) = (seconds / 3600, (seconds % 3600) / 60, seconds % 60);
  if hours > 0 {
    format!("{hours}:{minutes:02}:{seconds:02}")
  } else {
    format!("{minutes}:{seconds:02}")
  }
}

/// The transcript: the title, then each paragraph led by the time it starts
/// at in the recording, in bold. Paragraphs without words are left out.
pub(crate) fn transcript_blocks<'a>(
  title: &str,
  paragraphs: impl IntoIterator<Item = (u64, &'a str)>,
) -> Vec<Block> {
  std::iter::once(Block::Heading {
    level: 1,
    spans: vec![Span::plain(one_line(title))],
  })
  .chain(paragraphs.into_iter().filter_map(|(start_ms, text)| {
    let text = one_line(text);
    (!text.is_empty()).then(|| {
      Block::Paragraph(vec![
        Span {
          text: timestamp(start_ms),
          bold: true,
          italic: false,
        },
        Span::plain(format!(" {text}")),
      ])
    })
  }))
  .collect()
}

/// The cleaned-up text, with the dictation's instructions noted above it
/// when it had any.
pub(crate) fn cleaned_blocks(
  markdown: &str,
  instructions: &[String],
  instructions_label: &str,
) -> Vec<Block> {
  let lines = instructions
    .iter()
    .map(|instruction| one_line(instruction))
    .filter(|instruction| !instruction.is_empty())
    .collect::<Vec<_>>();
  let note = (!lines.is_empty()).then(|| Block::Note {
    label: one_line(instructions_label),
    lines,
  });
  note.into_iter().chain(markdown_blocks(markdown)).collect()
}

fn one_line(text: &str) -> String {
  text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn heading(line: &str) -> Option<(u8, &str)> {
  let level = line
    .chars()
    .take_while(|character| *character == '#')
    .count();
  let rest = &line[level..];
  if level == 0 || level > 6 || !rest.starts_with(' ') {
    return None;
  }
  // Deeper headings than Word's third level read as the third.
  let level = u8::try_from(level.min(3)).unwrap_or(3);
  Some((level, rest.trim()))
}

fn bullet(line: &str) -> Option<&str> {
  ["- ", "* ", "+ "]
    .iter()
    .find_map(|marker| line.strip_prefix(marker))
    .map(str::trim)
}

fn numbered(line: &str) -> Option<&str> {
  let digits = line.chars().take_while(char::is_ascii_digit).count();
  if digits == 0 || digits > 9 {
    return None;
  }
  let rest = &line[digits..];
  rest
    .strip_prefix(". ")
    .or_else(|| rest.strip_prefix(") "))
    .map(str::trim)
}

/// The blocks of the cleanup's Markdown. Lines of one paragraph are joined;
/// a numbered list keeps counting across blank lines between its items,
/// and anything else after it starts the next list from 1.
pub(crate) fn markdown_blocks(markdown: &str) -> Vec<Block> {
  let mut blocks = Vec::new();
  let mut paragraph: Vec<&str> = Vec::new();
  let mut lists = 0_u32;
  let mut in_numbered = false;
  let flush = |paragraph: &mut Vec<&str>, blocks: &mut Vec<Block>| {
    if !paragraph.is_empty() {
      blocks.push(Block::Paragraph(inline_spans(&paragraph.join(" "))));
      paragraph.clear();
    }
  };
  for line in markdown.lines() {
    let line = line.trim();
    if line.is_empty() {
      flush(&mut paragraph, &mut blocks);
      continue;
    }
    if let Some((level, text)) = heading(line) {
      flush(&mut paragraph, &mut blocks);
      in_numbered = false;
      blocks.push(Block::Heading {
        level,
        spans: inline_spans(text),
      });
    } else if let Some(text) = bullet(line) {
      flush(&mut paragraph, &mut blocks);
      in_numbered = false;
      blocks.push(Block::Bullet(inline_spans(text)));
    } else if let Some(text) = numbered(line) {
      flush(&mut paragraph, &mut blocks);
      if !in_numbered {
        lists += 1;
        in_numbered = true;
      }
      blocks.push(Block::Numbered {
        list: lists,
        spans: inline_spans(text),
      });
    } else {
      in_numbered = false;
      paragraph.push(line);
    }
  }
  flush(&mut paragraph, &mut blocks);
  blocks
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Marker {
  Bold,
  Italic,
}

enum Token {
  Text(String),
  Marker {
    marker: Marker,
    literal: &'static str,
    matched: bool,
  },
}

/// Whether `_` at `index` opens or closes emphasis rather than sitting
/// inside a word, as in `snake_case`.
fn underscore_marks(characters: &[char], index: usize, width: usize) -> bool {
  let before = index
    .checked_sub(1)
    .and_then(|before| characters.get(before));
  let after = characters.get(index + width);
  !(before.is_some_and(|character| character.is_alphanumeric())
    && after.is_some_and(|character| character.is_alphanumeric()))
}

/// `**bold**`, `__bold__`, `*italic*` and `_italic_` as spans; a marker
/// without its partner, and an escaped one, stay as written.
pub(crate) fn inline_spans(text: &str) -> Vec<Span> {
  let characters = text.chars().collect::<Vec<_>>();
  let mut tokens: Vec<Token> = Vec::new();
  let mut literal = String::new();
  let mut index = 0;
  while let Some(&character) = characters.get(index) {
    let next = characters.get(index + 1).copied();
    if character == '\\' && next.is_some_and(|next| next.is_ascii_punctuation()) {
      literal.extend(next);
      index += 2;
      continue;
    }
    // `***` closes italic and bold after text, and opens bold and italic
    // before it.
    if character == '*' && next == Some('*') && characters.get(index + 2) == Some(&'*')
    {
      if !literal.is_empty() {
        tokens.push(Token::Text(std::mem::take(&mut literal)));
      }
      let closing = index
        .checked_sub(1)
        .and_then(|before| characters.get(before))
        .is_some_and(|before| !before.is_whitespace());
      let (first, second) = if closing {
        ((Marker::Italic, "*"), (Marker::Bold, "**"))
      } else {
        ((Marker::Bold, "**"), (Marker::Italic, "*"))
      };
      for (marker, written) in [first, second] {
        tokens.push(Token::Marker {
          marker,
          literal: written,
          matched: false,
        });
      }
      index += 3;
      continue;
    }
    let token = match (character, next) {
      ('*', Some('*')) => Some((Marker::Bold, "**", 2)),
      ('_', Some('_')) if underscore_marks(&characters, index, 2) => {
        Some((Marker::Bold, "__", 2))
      }
      ('*', _) => Some((Marker::Italic, "*", 1)),
      ('_', _) if underscore_marks(&characters, index, 1) => {
        Some((Marker::Italic, "_", 1))
      }
      _ => None,
    };
    if let Some((marker, written, width)) = token {
      if !literal.is_empty() {
        tokens.push(Token::Text(std::mem::take(&mut literal)));
      }
      tokens.push(Token::Marker {
        marker,
        literal: written,
        matched: false,
      });
      index += width;
    } else {
      literal.push(character);
      index += 1;
    }
  }
  if !literal.is_empty() {
    tokens.push(Token::Text(literal));
  }

  // Pair each closing marker with the nearest open one of its kind and
  // spelling; markers left open in between stay literal.
  let mut open: Vec<usize> = Vec::new();
  for position in 0..tokens.len() {
    let Some(Token::Marker {
      marker, literal, ..
    }) = tokens.get(position)
    else {
      continue;
    };
    let (marker, literal) = (*marker, *literal);
    let partner = open.iter().rposition(|&candidate| {
      matches!(
        tokens.get(candidate),
        Some(Token::Marker { marker: open_marker, literal: open_literal, .. })
          if *open_marker == marker && *open_literal == literal
      )
    });
    if let Some(found) = partner {
      let opened = open[found];
      open.truncate(found);
      for paired in [opened, position] {
        if let Some(Token::Marker { matched, .. }) = tokens.get_mut(paired) {
          *matched = true;
        }
      }
    } else {
      open.push(position);
    }
  }

  let mut spans: Vec<Span> = Vec::new();
  let (mut bold, mut italic) = (false, false);
  let mut push = |text: &str, bold: bool, italic: bool| {
    if text.is_empty() {
      return;
    }
    match spans.last_mut() {
      Some(last) if last.bold == bold && last.italic == italic => {
        last.text.push_str(text)
      }
      _ => spans.push(Span {
        text: text.to_string(),
        bold,
        italic,
      }),
    }
  };
  for token in &tokens {
    match token {
      Token::Text(text) => push(text, bold, italic),
      Token::Marker {
        marker,
        matched: true,
        ..
      } => match marker {
        Marker::Bold => bold = !bold,
        Marker::Italic => italic = !italic,
      },
      Token::Marker { literal, .. } => push(literal, bold, italic),
    }
  }
  spans
}

/// Text as XML character data, without the characters XML 1.0 refuses.
fn xml_text(text: &str) -> String {
  let mut escaped = String::with_capacity(text.len());
  for character in text.chars() {
    match character {
      '&' => escaped.push_str("&amp;"),
      '<' => escaped.push_str("&lt;"),
      '>' => escaped.push_str("&gt;"),
      '"' => escaped.push_str("&quot;"),
      '\t' | '\n' | '\r' => escaped.push(' '),
      character if character.is_control() => {}
      '\u{FFFE}' | '\u{FFFF}' => {}
      character => escaped.push(character),
    }
  }
  escaped
}

fn run(xml: &mut String, span: &Span) {
  xml.push_str("<w:r>");
  if span.bold || span.italic {
    xml.push_str("<w:rPr>");
    if span.bold {
      xml.push_str("<w:b/>");
    }
    if span.italic {
      xml.push_str("<w:i/>");
    }
    xml.push_str("</w:rPr>");
  }
  xml.push_str("<w:t xml:space=\"preserve\">");
  xml.push_str(&xml_text(&span.text));
  xml.push_str("</w:t></w:r>");
}

fn paragraph(xml: &mut String, properties: &str, spans: &[Span]) {
  xml.push_str("<w:p>");
  if !properties.is_empty() {
    xml.push_str("<w:pPr>");
    xml.push_str(properties);
    xml.push_str("</w:pPr>");
  }
  for span in spans {
    run(xml, span);
  }
  xml.push_str("</w:p>");
}

/// The first numbering instance of a numbered list; bullets use 1.
const FIRST_NUMBERED_LIST: u32 = 2;

fn document_xml(blocks: &[Block]) -> String {
  let mut xml = String::from(
    "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
     <w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\" \
     xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><w:body>",
  );
  for block in blocks {
    match block {
      Block::Heading { level, spans } => paragraph(
        &mut xml,
        &format!("<w:pStyle w:val=\"Heading{level}\"/>"),
        spans,
      ),
      Block::Paragraph(spans) => paragraph(&mut xml, "", spans),
      Block::Bullet(spans) => paragraph(
        &mut xml,
        "<w:pStyle w:val=\"ListParagraph\"/><w:numPr><w:ilvl w:val=\"0\"/><w:numId w:val=\"1\"/></w:numPr>",
        spans,
      ),
      Block::Numbered { list, spans } => paragraph(
        &mut xml,
        &format!(
          "<w:pStyle w:val=\"ListParagraph\"/><w:numPr><w:ilvl w:val=\"0\"/><w:numId w:val=\"{}\"/></w:numPr>",
          FIRST_NUMBERED_LIST + list.saturating_sub(1)
        ),
        spans,
      ),
      Block::Note { label, lines } => {
        xml.push_str("<w:p><w:pPr><w:pStyle w:val=\"DictationNote\"/></w:pPr>");
        run(
          &mut xml,
          &Span {
            text: label.clone(),
            bold: true,
            italic: false,
          },
        );
        for line in lines {
          xml.push_str("<w:r><w:br/></w:r>");
          run(&mut xml, &Span::plain(line.clone()));
        }
        xml.push_str("</w:p>");
      }
    }
  }
  xml.push_str(
    "<w:sectPr><w:pgSz w:w=\"11906\" w:h=\"16838\"/>\
     <w:pgMar w:top=\"1418\" w:right=\"1418\" w:bottom=\"1418\" w:left=\"1418\" \
     w:header=\"709\" w:footer=\"709\" w:gutter=\"0\"/></w:sectPr></w:body></w:document>",
  );
  xml
}

fn heading_style(level: u8, size_half_points: u32) -> String {
  format!(
    "<w:style w:type=\"paragraph\" w:styleId=\"Heading{level}\">\
     <w:name w:val=\"heading {level}\"/><w:basedOn w:val=\"Normal\"/>\
     <w:next w:val=\"Normal\"/><w:qFormat/>\
     <w:pPr><w:keepNext/><w:spacing w:before=\"240\" w:after=\"120\"/>\
     <w:outlineLvl w:val=\"{}\"/></w:pPr>\
     <w:rPr><w:b/><w:sz w:val=\"{size_half_points}\"/></w:rPr></w:style>",
    level - 1
  )
}

fn styles_xml() -> String {
  format!(
    "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
     <w:styles xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">\
     <w:docDefaults><w:rPrDefault><w:rPr>\
     <w:rFonts w:ascii=\"Calibri\" w:hAnsi=\"Calibri\" w:eastAsia=\"Calibri\" w:cs=\"Calibri\"/>\
     <w:sz w:val=\"22\"/><w:szCs w:val=\"22\"/></w:rPr></w:rPrDefault>\
     <w:pPrDefault><w:pPr><w:spacing w:after=\"160\" w:line=\"276\" w:lineRule=\"auto\"/></w:pPr></w:pPrDefault>\
     </w:docDefaults>\
     <w:style w:type=\"paragraph\" w:default=\"1\" w:styleId=\"Normal\"><w:name w:val=\"Normal\"/><w:qFormat/></w:style>\
     {}{}{}\
     <w:style w:type=\"paragraph\" w:styleId=\"ListParagraph\"><w:name w:val=\"List Paragraph\"/>\
     <w:basedOn w:val=\"Normal\"/><w:qFormat/><w:pPr><w:spacing w:after=\"60\"/>\
     <w:ind w:left=\"720\"/><w:contextualSpacing/></w:pPr></w:style>\
     <w:style w:type=\"paragraph\" w:customStyle=\"1\" w:styleId=\"DictationNote\">\
     <w:name w:val=\"Dictation Note\"/><w:basedOn w:val=\"Normal\"/>\
     <w:pPr><w:spacing w:after=\"240\"/></w:pPr>\
     <w:rPr><w:i/><w:color w:val=\"737373\"/></w:rPr></w:style>\
     </w:styles>",
    heading_style(1, 32),
    heading_style(2, 26),
    heading_style(3, 24),
  )
}

fn abstract_list(id: u32, format: &str, text: &str) -> String {
  format!(
    "<w:abstractNum w:abstractNumId=\"{id}\"><w:multiLevelType w:val=\"singleLevel\"/>\
     <w:lvl w:ilvl=\"0\"><w:start w:val=\"1\"/><w:numFmt w:val=\"{format}\"/>\
     <w:lvlText w:val=\"{text}\"/><w:lvlJc w:val=\"left\"/>\
     <w:pPr><w:ind w:left=\"720\" w:hanging=\"360\"/></w:pPr></w:lvl></w:abstractNum>"
  )
}

fn numbering_xml(lists: u32) -> String {
  let mut xml = String::from(
    "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
     <w:numbering xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">",
  );
  xml.push_str(&abstract_list(0, "bullet", "\u{2022}"));
  xml.push_str(&abstract_list(1, "decimal", "%1."));
  xml.push_str("<w:num w:numId=\"1\"><w:abstractNumId w:val=\"0\"/></w:num>");
  // Each numbered list counts from 1 again.
  for list in 0..lists {
    xml.push_str(&format!(
      "<w:num w:numId=\"{}\"><w:abstractNumId w:val=\"1\"/>\
       <w:lvlOverride w:ilvl=\"0\"><w:startOverride w:val=\"1\"/></w:lvlOverride></w:num>",
      FIRST_NUMBERED_LIST + list
    ));
  }
  xml.push_str("</w:numbering>");
  xml
}

const CONTENT_TYPES: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">\
<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>\
<Default Extension=\"xml\" ContentType=\"application/xml\"/>\
<Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/>\
<Override PartName=\"/word/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml\"/>\
<Override PartName=\"/word/numbering.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml\"/>\
</Types>";

const PACKAGE_RELATIONSHIPS: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/>\
</Relationships>";

const DOCUMENT_RELATIONSHIPS: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\" Target=\"styles.xml\"/>\
<Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering\" Target=\"numbering.xml\"/>\
</Relationships>";

/// The blocks as the bytes of a `.docx` file.
pub(crate) fn docx(blocks: &[Block]) -> Result<Vec<u8>, String> {
  let lists = blocks
    .iter()
    .filter_map(|block| match block {
      Block::Numbered { list, .. } => Some(*list),
      _ => None,
    })
    .max()
    .unwrap_or(0);
  let parts = [
    ("[Content_Types].xml", CONTENT_TYPES.to_string()),
    ("_rels/.rels", PACKAGE_RELATIONSHIPS.to_string()),
    ("word/document.xml", document_xml(blocks)),
    ("word/styles.xml", styles_xml()),
    ("word/numbering.xml", numbering_xml(lists)),
    (
      "word/_rels/document.xml.rels",
      DOCUMENT_RELATIONSHIPS.to_string(),
    ),
  ];
  let options =
    SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
  let mut archive = ZipWriter::new(Cursor::new(Vec::new()));
  for (name, content) in parts {
    archive
      .start_file(name, options)
      .and_then(|()| archive.write_all(content.as_bytes()).map_err(Into::into))
      .map_err(|error| format!("the Word document could not be written: {error}"))?;
  }
  archive
    .finish()
    .map(Cursor::into_inner)
    .map_err(|error| format!("the Word document could not be written: {error}"))
}

#[cfg(test)]
mod tests {
  use std::io::Read;

  use super::*;

  fn part(bytes: &[u8], name: &str) -> String {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).expect("a valid zip");
    let mut file = archive.by_name(name).expect("the part exists");
    let mut text = String::new();
    file.read_to_string(&mut text).expect("utf-8 xml");
    text
  }

  fn span(text: &str, bold: bool, italic: bool) -> Span {
    Span {
      text: text.to_string(),
      bold,
      italic,
    }
  }

  #[test]
  fn a_docx_is_a_zip_with_the_parts_word_reads() {
    let bytes = docx(&transcript_blocks("Memo", [(0, "First.")])).unwrap();
    assert_eq!(&bytes[..2], b"PK");
    let archive = zip::ZipArchive::new(Cursor::new(bytes.as_slice())).unwrap();
    let mut names = archive
      .file_names()
      .map(|name| name.unwrap().into_owned())
      .collect::<Vec<_>>();
    names.sort_unstable();
    assert_eq!(
      names,
      [
        "[Content_Types].xml",
        "_rels/.rels",
        "word/_rels/document.xml.rels",
        "word/document.xml",
        "word/numbering.xml",
        "word/styles.xml",
      ]
    );
    let document = part(&bytes, "word/document.xml");
    assert!(document.starts_with("<?xml"));
    assert_eq!(
      document.matches("<w:p>").count(),
      document.matches("</w:p>").count()
    );
    assert!(part(&bytes, "[Content_Types].xml").contains("/word/numbering.xml"));
  }

  #[test]
  fn a_transcript_leads_each_paragraph_with_its_time() {
    assert_eq!(timestamp(0), "0:00");
    assert_eq!(timestamp(102_000), "1:42");
    assert_eq!(timestamp(3_725_000), "1:02:05");
    let blocks = transcript_blocks(
      "Memo",
      [
        (0, "First."),
        (5_000, "   "),
        (65_000, "Second <b> & *literal*."),
      ],
    );
    assert_eq!(blocks.len(), 3);
    let document = document_xml(&blocks);
    assert!(document.contains("<w:pStyle w:val=\"Heading1\"/>"));
    assert!(document.contains("<w:b/></w:rPr><w:t xml:space=\"preserve\">1:05</w:t>"));
    // Spoken words are text, never markup.
    assert!(document.contains("Second &lt;b&gt; &amp; *literal*."));
  }

  #[test]
  fn markdown_becomes_word_headings_lists_and_emphasis() {
    let blocks = markdown_blocks(
      "# Reply\n\n## Summary\n#### Deep\n\nDear **Ms Novák**, thank you\nfor *the* note.\n\n- one\n- two\n\n1. first\n\n2. second\n\nBetween.\n\n1. again",
    );
    assert_eq!(
      blocks,
      vec![
        Block::Heading {
          level: 1,
          spans: vec![span("Reply", false, false)]
        },
        Block::Heading {
          level: 2,
          spans: vec![span("Summary", false, false)]
        },
        Block::Heading {
          level: 3,
          spans: vec![span("Deep", false, false)]
        },
        Block::Paragraph(vec![
          span("Dear ", false, false),
          span("Ms Novák", true, false),
          span(", thank you for ", false, false),
          span("the", false, true),
          span(" note.", false, false),
        ]),
        Block::Bullet(vec![span("one", false, false)]),
        Block::Bullet(vec![span("two", false, false)]),
        Block::Numbered {
          list: 1,
          spans: vec![span("first", false, false)]
        },
        Block::Numbered {
          list: 1,
          spans: vec![span("second", false, false)]
        },
        Block::Paragraph(vec![span("Between.", false, false)]),
        Block::Numbered {
          list: 2,
          spans: vec![span("again", false, false)]
        },
      ]
    );
    let bytes = docx(&blocks).unwrap();
    let document = part(&bytes, "word/document.xml");
    assert!(!document.contains("**"));
    assert!(document.contains("<w:numId w:val=\"1\"/>"));
    assert!(document.contains("<w:numId w:val=\"3\"/>"));
    let numbering = part(&bytes, "word/numbering.xml");
    assert!(numbering.contains("<w:num w:numId=\"3\">"));
    assert!(part(&bytes, "word/styles.xml").contains("w:styleId=\"Heading3\""));
  }

  #[test]
  fn unpaired_and_escaped_markers_stay_as_written() {
    assert_eq!(
      inline_spans("2 * 3 = 6 and snake_case_name"),
      vec![span("2 * 3 = 6 and snake_case_name", false, false)]
    );
    assert_eq!(
      inline_spans("\\*not\\* **bold *both***"),
      vec![
        span("*not* ", false, false),
        span("bold ", true, false),
        span("both", true, true),
      ]
    );
    assert_eq!(
      inline_spans("__bold__ and _italic_"),
      vec![
        span("bold", true, false),
        span(" and ", false, false),
        span("italic", false, true),
      ]
    );
  }

  #[test]
  fn the_instructions_are_a_grey_note_above_the_text() {
    let blocks = cleaned_blocks(
      "Text.",
      &["Make it an email.".to_string(), "  ".to_string()],
      "Instructions in the dictation:",
    );
    assert_eq!(
      blocks.first(),
      Some(&Block::Note {
        label: "Instructions in the dictation:".to_string(),
        lines: vec!["Make it an email.".to_string()],
      })
    );
    let bytes = docx(&blocks).unwrap();
    let document = part(&bytes, "word/document.xml");
    assert!(document.contains("<w:pStyle w:val=\"DictationNote\"/>"));
    assert!(document.contains("<w:br/>"));
    let styles = part(&bytes, "word/styles.xml");
    assert!(styles.contains("<w:i/><w:color w:val=\"737373\"/>"));
    assert_eq!(cleaned_blocks("Text.", &[], "Label").len(), 1);
  }

  #[test]
  fn characters_xml_refuses_are_dropped() {
    assert_eq!(xml_text("a\u{0}b\u{1b}c\td"), "abc d");
  }
}
