//! The page a local loopback listener answers a browser with once a flow ends
//! ("ChatGPT is connected"). It is `OutcomeScreen` from
//! `@stll/ui/outcome-screen`, rendered into a self-contained template by
//! `scripts/generate-outcome-page.ts`; this module only fills its slots with
//! escaped text, so the desktop shows the same design as the web and the CLI.
//! No other module here writes an HTML document (a test below enforces it).

/// Which of the two rendered pages to answer with.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OutcomeTone {
  Success,
  Error,
}

const SUCCESS_TEMPLATE: &str =
  include_str!("../../../../packages/ui/generated/outcome-page.success.gen.html");
const ERROR_TEMPLATE: &str =
  include_str!("../../../../packages/ui/generated/outcome-page.error.gen.html");

/// The words one outcome page carries.
pub struct OutcomeText<'a> {
  pub title: &'a str,
  pub description: &'a str,
  pub note: &'a str,
}

/// The template's slots, as the generator names them.
const SLOTS: [&str; 5] = [
  "{{lang}}",
  "{{dir}}",
  "{{title}}",
  "{{description}}",
  "{{note}}",
];

/// The outcome page in `locale`, every slot filled with escaped text.
pub fn render(tone: OutcomeTone, locale: &str, text: &OutcomeText<'_>) -> String {
  let template = match tone {
    OutcomeTone::Success => SUCCESS_TEMPLATE,
    OutcomeTone::Error => ERROR_TEMPLATE,
  };
  let dir = if locale == "ar" { "rtl" } else { "ltr" };
  let values = [
    ammonia::clean_text(locale),
    dir.to_string(),
    ammonia::clean_text(text.title),
    ammonia::clean_text(text.description),
    ammonia::clean_text(text.note),
  ];
  // One pass over the template, so text put into one slot is never read as
  // another slot.
  let mut page = String::with_capacity(template.len() + 512);
  let mut rest = template;
  while let Some(start) = rest.find("{{") {
    page.push_str(&rest[..start]);
    let tail = &rest[start..];
    match SLOTS.iter().position(|slot| tail.starts_with(slot)) {
      Some(index) => {
        page.push_str(&values[index]);
        rest = &tail[SLOTS[index].len()..];
      }
      None => {
        page.push_str("{{");
        rest = &tail[2..];
      }
    }
  }
  page.push_str(rest);
  page
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn fills_every_slot_with_escaped_text() {
    let page = render(
      OutcomeTone::Success,
      "en",
      &OutcomeText {
        title: "ChatGPT <b>is</b> connected",
        description: "Return to stella & {{note}}",
        note: "You can close this tab.",
      },
    );
    assert!(page.starts_with("<!doctype html>"));
    assert!(page.contains("<title>ChatGPT&#32;&lt;b&gt;is&lt;&#47;b&gt;&#32;connected</title>"));
    assert!(page.contains("data-tone=\"success\""));
    assert!(!page.contains("<b>"));
    // Text that looks like a slot stays text: the note is filled once, where
    // the template puts it.
    let note = ammonia::clean_text("You can close this tab.");
    assert_eq!(page.matches(note.as_str()).count(), 1);
    assert!(page.contains("&amp;&#32;{{note}}"));
    for slot in ["{{lang}}", "{{dir}}", "{{title}}", "{{description}}"] {
      assert!(!page.contains(slot), "{slot} was left unfilled");
    }
  }

  #[test]
  fn arabic_pages_read_right_to_left() {
    let text = OutcomeText {
      title: "t",
      description: "d",
      note: "n",
    };
    let page = render(OutcomeTone::Error, "ar", &text);
    assert!(page.contains("dir=\"rtl\" lang=\"ar\""));
    assert!(page.contains("data-tone=\"error\""));
    assert!(render(OutcomeTone::Error, "cs", &text).contains("dir=\"ltr\" lang=\"cs\""));
  }

  #[test]
  fn the_pages_load_nothing_and_style_only_inline() {
    for template in [SUCCESS_TEMPLATE, ERROR_TEMPLATE] {
      // `default-src 'none'; style-src 'unsafe-inline'`: no script, no
      // fetched resource, one inline stylesheet.
      assert!(!template.contains("<script"));
      assert!(!template.contains("src="));
      assert!(!template.contains("<link"));
      assert!(!template.contains("url("));
      assert_eq!(template.matches("<style>").count(), 1);
    }
  }

  /// The outcome page is the only HTML document the desktop writes: any other
  /// would be a second design that drifts from `OutcomeScreen`.
  #[test]
  fn no_other_module_writes_an_html_document() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let own = std::path::Path::new(file!())
      .file_name()
      .and_then(|name| name.to_str())
      .unwrap_or_default()
      .to_string();
    let mut offenders = Vec::new();
    let mut pending = vec![root];
    while let Some(dir) = pending.pop() {
      for entry in std::fs::read_dir(&dir).expect("read src-tauri/src") {
        let path = entry.expect("read a directory entry").path();
        if path.is_dir() {
          pending.push(path);
          continue;
        }
        if path.extension().and_then(|ext| ext.to_str()) != Some("rs")
          || path.file_name().and_then(|name| name.to_str()) == Some(own.as_str())
        {
          continue;
        }
        let source = std::fs::read_to_string(&path).expect("read a source file");
        // A module's tests (its top-level `#[cfg(test)]` items) hold HTML a
        // test feeds in, such as clipboard payloads; only shipped code counts.
        let shipped = source
          .find("\n#[cfg(test)]")
          .map_or(source.as_str(), |end| &source[..end])
          .to_ascii_lowercase();
        if shipped.contains("<!doctype html") || shipped.contains("<html") {
          offenders.push(path.display().to_string());
        }
      }
    }
    assert!(
      offenders.is_empty(),
      "Only outcome_page.rs writes an HTML page; render it with \
       outcome_page::render (OutcomeScreen from @stll/ui/outcome-screen): \
       {offenders:?}"
    );
  }
}
