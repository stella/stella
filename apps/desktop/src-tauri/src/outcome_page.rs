//! The page a local loopback listener answers a browser with once a flow ends
//! ("ChatGPT is connected"). It is `OutcomeScreen` from
//! `@stll/ui/outcome-screen`, rendered into a self-contained template (and the
//! fragments for its facts) by `packages/ui/scripts/generate-outcome-page.ts`;
//! this module only fills their slots with escaped text, so the desktop shows
//! the same design as the web and the CLI.
//! No other module here writes an HTML document (a test below enforces it).

/// Which of the two rendered pages to answer with.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OutcomeTone {
  Success,
  Error,
}

/// The colour scheme the page draws in: the app's own when it is known, so
/// the page matches the window it came from; else the browser's.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum OutcomeScheme {
  Light,
  Dark,
  #[default]
  System,
}

impl OutcomeScheme {
  const fn attribute(self) -> &'static str {
    match self {
      Self::Light => "light",
      Self::Dark => "dark",
      Self::System => "system",
    }
  }
}

const SUCCESS_TEMPLATE: &str =
  include_str!("../../../../packages/ui/generated/outcome-page.success.gen.html");
const ERROR_TEMPLATE: &str =
  include_str!("../../../../packages/ui/generated/outcome-page.error.gen.html");
const DETAILS_FRAGMENT: &str =
  include_str!("../../../../packages/ui/generated/outcome-page.details.gen.html");
const DETAIL_ROW_FRAGMENT: &str =
  include_str!("../../../../packages/ui/generated/outcome-page.detail-row.gen.html");
const NOTE_FRAGMENT: &str =
  include_str!("../../../../packages/ui/generated/outcome-page.note.gen.html");
const CONTROL_FRAGMENT: &str =
  include_str!("../../../../packages/ui/generated/outcome-page.control.gen.html");
const BUTTON_LABEL_FRAGMENT: &str =
  include_str!("../../../../packages/ui/generated/outcome-page.button-label.gen.html");

/// One fact the page lists, e.g. Account: person@example.com.
pub struct OutcomeDetail<'a> {
  pub label: &'a str,
  pub value: &'a str,
}

/// How a `{name}` placeholder in the description is drawn.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OutcomeMarkKind {
  /// A place or control in the app ("General"), set apart as a chip.
  Control,
  /// A button's label; the sentence around it supplies the quotes.
  ButtonLabel,
}

/// The value one `{name}` placeholder in the description stands for.
pub struct OutcomeMark<'a> {
  pub name: &'a str,
  pub value: &'a str,
  pub kind: OutcomeMarkKind,
}

/// Everything one outcome page carries.
pub struct OutcomePage<'a> {
  pub tone: OutcomeTone,
  pub locale: &'a str,
  /// `ltr` or `rtl`, the active locale's direction.
  pub dir: &'static str,
  pub scheme: OutcomeScheme,
  pub title: &'a str,
  /// Text whose `{name}` placeholders the `marks` fill.
  pub description: &'a str,
  pub marks: &'a [OutcomeMark<'a>],
  /// What the flow connected; empty when there is nothing specific to say.
  pub details: &'a [OutcomeDetail<'a>],
  /// The quiet last line, only when the tab really can be closed.
  pub note: Option<&'a str>,
}

/// The page template's slots, as the generator names them.
const PAGE_SLOTS: [&str; 8] = [
  "{{lang}}",
  "{{dir}}",
  "{{theme}}",
  "{{title}}",
  "{{description}}",
  "{{details}}",
  "{{command}}",
  "{{note}}",
];

/// Fills `template` in one pass, so text put into one slot is never read as
/// another slot. Every value is escaped text or a filled fragment.
fn fill(template: &str, slots: &[&str], values: &[String]) -> String {
  let mut page = String::with_capacity(template.len() + 512);
  let mut rest = template;
  while let Some(start) = rest.find("{{") {
    page.push_str(&rest[..start]);
    let tail = &rest[start..];
    match slots.iter().position(|slot| tail.starts_with(slot)) {
      Some(index) => {
        page.push_str(&values[index]);
        rest = &tail[slots[index].len()..];
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

fn details_html(details: &[OutcomeDetail<'_>]) -> String {
  if details.is_empty() {
    return String::new();
  }
  let rows: String = details
    .iter()
    .map(|detail| {
      fill(
        DETAIL_ROW_FRAGMENT.trim_end(),
        &["{{label}}", "{{value}}"],
        &[
          ammonia::clean_text(detail.label),
          ammonia::clean_text(detail.value),
        ],
      )
    })
    .collect();
  fill(DETAILS_FRAGMENT.trim_end(), &["{{rows}}"], &[rows])
}

/// The description as escaped text, each known `{name}` placeholder drawn as
/// its mark's fragment. Text that only looks like a placeholder stays text.
fn description_html(text: &str, marks: &[OutcomeMark<'_>]) -> String {
  let mut html = String::with_capacity(text.len() + 256);
  let mut rest = text;
  while let Some(start) = rest.find('{') {
    html.push_str(&ammonia::clean_text(&rest[..start]));
    let tail = &rest[start..];
    let mark = marks.iter().find(|mark| {
      tail[1..]
        .strip_prefix(mark.name)
        .is_some_and(|after| after.starts_with('}'))
    });
    match mark {
      Some(mark) => {
        let fragment = match mark.kind {
          OutcomeMarkKind::Control => CONTROL_FRAGMENT,
          OutcomeMarkKind::ButtonLabel => BUTTON_LABEL_FRAGMENT,
        };
        html.push_str(&fill(
          fragment.trim_end(),
          &["{{text}}"],
          &[ammonia::clean_text(mark.value)],
        ));
        rest = &tail[mark.name.len() + 2..];
      }
      None => {
        html.push_str(&ammonia::clean_text("{"));
        rest = &tail[1..];
      }
    }
  }
  html.push_str(&ammonia::clean_text(rest));
  html
}

/// The outcome page, every slot filled with escaped text.
pub fn render(page: &OutcomePage<'_>) -> String {
  let template = match page.tone {
    OutcomeTone::Success => SUCCESS_TEMPLATE,
    OutcomeTone::Error => ERROR_TEMPLATE,
  };
  let values = [
    ammonia::clean_text(page.locale),
    page.dir.to_string(),
    page.scheme.attribute().to_string(),
    ammonia::clean_text(page.title),
    description_html(page.description, page.marks),
    details_html(page.details),
    // The desktop never asks for a command; its retry is a button in the app.
    String::new(),
    page.note.map_or_else(String::new, |note| {
      fill(
        NOTE_FRAGMENT.trim_end(),
        &["{{text}}"],
        &[ammonia::clean_text(note)],
      )
    }),
  ];
  fill(template, &PAGE_SLOTS, &values)
}

#[cfg(test)]
mod tests {
  use super::*;

  fn page<'a>(details: &'a [OutcomeDetail<'a>]) -> OutcomePage<'a> {
    OutcomePage {
      tone: OutcomeTone::Success,
      locale: "en",
      dir: "ltr",
      scheme: OutcomeScheme::System,
      title: "ChatGPT <b>is</b> connected",
      description: "Return to stella & {{details}}",
      marks: &[],
      details,
      note: Some("You can close this tab."),
    }
  }

  #[test]
  fn fills_every_slot_with_escaped_text() {
    let details = [OutcomeDetail {
      label: "Account",
      value: "<i>person</i>@example.com {{title}}",
    }];
    let html = render(&page(&details));
    assert!(html.starts_with("<!doctype html>"));
    let title = ammonia::clean_text("ChatGPT <b>is</b> connected");
    assert!(html.contains(&format!("<title>{title} | stella</title>")));
    assert!(html.contains(&format!(">{title}</h1>")));
    assert!(html.contains("data-tone=\"success\""));
    assert!(!html.contains("<b>") && !html.contains("<i>"));
    // Text that looks like a slot stays text: the facts are filled once,
    // where the template puts them, and a value is never read as a slot.
    assert_eq!(html.matches("data-slot=\"outcome-details\"").count(), 1);
    assert!(html.contains("&amp;&#32;{{details}}"));
    assert!(html.contains(&ammonia::clean_text("<i>person</i>@example.com {{title}}")));
    assert!(html.contains("<bdi>"));
    assert!(html.contains("data-slot=\"outcome-note\""));
    // Only the text above still reads like a slot, once each.
    assert_eq!(html.matches("{{details}}").count(), 1);
    assert_eq!(html.matches("{{title}}").count(), 1);
    for slot in [
      "{{lang}}",
      "{{dir}}",
      "{{theme}}",
      "{{description}}",
      "{{command}}",
      "{{note}}",
    ] {
      assert!(!html.contains(slot), "{slot} was left unfilled");
    }
  }

  #[test]
  fn a_page_without_facts_or_note_draws_neither() {
    let html = render(&OutcomePage {
      note: None,
      ..page(&[])
    });
    assert!(!html.contains("outcome-details") && !html.contains("outcome-note"));
    for slot in ["{{details}}", "{{command}}", "{{note}}"] {
      assert!(!html.contains(slot), "{slot} was left unfilled");
    }
  }

  #[test]
  fn arabic_pages_read_right_to_left_in_the_apps_scheme() {
    let text = OutcomePage {
      tone: OutcomeTone::Error,
      locale: "ar",
      dir: "rtl",
      scheme: OutcomeScheme::Dark,
      title: "t",
      description: "d",
      marks: &[],
      details: &[],
      note: None,
    };
    let html = render(&text);
    assert!(html.contains("data-theme=\"dark\" dir=\"rtl\" lang=\"ar\""));
    assert!(html.contains("data-tone=\"error\""));
    let light = render(&OutcomePage {
      locale: "cs",
      dir: "ltr",
      scheme: OutcomeScheme::Light,
      ..text
    });
    assert!(light.contains("data-theme=\"light\" dir=\"ltr\" lang=\"cs\""));
  }

  #[test]
  fn marks_draw_the_apps_controls_inside_escaped_text() {
    let marks = [
      OutcomeMark {
        name: "section",
        value: "General <b>",
        kind: OutcomeMarkKind::Control,
      },
      OutcomeMark {
        name: "button",
        value: "Continue",
        kind: OutcomeMarkKind::ButtonLabel,
      },
    ];
    let html = description_html(
      "Open {section} & click \u{201c}{button}\u{201d} {other}",
      &marks,
    );
    assert_eq!(html.matches("data-slot=\"outcome-control\"").count(), 1);
    assert_eq!(
      html.matches("data-slot=\"outcome-button-label\"").count(),
      1
    );
    assert!(html.contains(&format!(">{}</bdi>", ammonia::clean_text("General <b>"))));
    assert!(!html.contains("<b>"));
    assert!(html.contains("&amp;"));
    // An unknown placeholder is text, not a slot.
    assert!(html.contains("{other}"));
    assert!(!html.contains("{section}") && !html.contains("{button}"));
  }

  #[test]
  fn the_pages_load_nothing_and_style_only_inline() {
    for template in [SUCCESS_TEMPLATE, ERROR_TEMPLATE] {
      // `default-src 'none'; style-src 'unsafe-inline'; img-src data:`: no
      // script, no fetched resource, one inline stylesheet, and the favicon
      // inline as data.
      assert!(!template.contains("<script"));
      assert!(!template.contains("src="));
      assert!(!template.contains("url("));
      assert_eq!(template.matches("<link").count(), 1);
      assert!(template.contains("<link href=\"data:image/svg+xml,"));
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
