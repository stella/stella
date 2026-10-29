// Default invoice template. All data arrives as one JSON document in
// `sys.inputs.invoice` (see InvoiceTemplateData in data.ts); the template has
// no file system or network access.
#let data = json(bytes(sys.inputs.invoice))

#let accent = rgb("#1f4fd1")
#let muted = rgb("#5b6472")
#let rule = rgb("#d9dde3")
#let tint = rgb("#f3f5f9")

#set document(title: data.title)
#set page(
  paper: "a4",
  margin: (x: 18mm, top: 18mm, bottom: 22mm),
  footer: context {
    set text(size: 7.5pt, fill: muted)
    grid(
      columns: (1fr, auto),
      gutter: 12pt,
      if data.footerNotes != none { data.footerNotes },
      counter(page).display("1 / 1", both: true),
    )
  },
)
#set text(
  font: ("Inter", "DejaVu Sans"),
  size: 9pt,
  lang: data.lang,
  dir: if data.dir == "rtl" { rtl } else { ltr },
  fill: rgb("#14171c"),
)
#set par(leading: 0.55em, spacing: 0.9em)

#let label-text(body) = text(size: 7pt, weight: "semibold", fill: muted, tracking: 0.04em, body)
#let field-list(items) = for item in items [
  #item.label: #item.value \
]
#let party-block(p) = if p != none {
  label-text(p.heading)
  v(3pt)
  if p.name != none { text(weight: "semibold", size: 10pt, p.name); linebreak() }
  for line in p.address [#line \ ]
  if p.ids.len() > 0 { v(2pt); text(fill: muted, field-list(p.ids)) }
}

// Header: seller on the start side, document title and number on the end side.
#grid(
  columns: (1fr, auto),
  align: (start + top, end + top),
  if data.seller != none { text(size: 11pt, weight: "bold", data.seller.name) },
  {
    text(size: 18pt, weight: "bold", data.title)
    if data.isDraft {
      linebreak()
      box(fill: rgb("#fff4d6"), inset: (x: 6pt, y: 3pt), radius: 3pt,
        text(size: 8pt, weight: "semibold", fill: rgb("#7a5600"), data.draftLabel))
    }
  },
)
#v(14pt)

// Parties.
#grid(
  columns: (1fr, 1fr),
  gutter: 24pt,
  party-block(data.seller),
  party-block(data.buyer),
)
#v(12pt)

// Meta row.
#if data.meta.len() > 0 {
  block(fill: tint, inset: 9pt, radius: 4pt, width: 100%,
    grid(
      columns: (1fr,) * calc.min(data.meta.len(), 5),
      row-gutter: 8pt,
      column-gutter: 10pt,
      ..data.meta.map(m => [#label-text(m.label) \ #text(weight: "medium", m.value)]),
    ))
}
#v(14pt)

// Lines: the header row repeats on every page the table breaks onto.
#show table: set text(size: 8.5pt, number-width: "tabular")
#table(
  columns: (1fr, auto, auto, auto, auto, auto),
  stroke: (x, y) => if y == 0 { (bottom: 0.8pt + accent) } else { (bottom: 0.4pt + rule) },
  inset: (x: 5pt, y: 7pt),
  align: (x, y) => if x == 0 { start + top } else { end + top },
  table.header(
    repeat: true,
    ..(
      data.labels.description,
      data.labels.quantity,
      data.labels.unitPrice,
      data.labels.net,
      data.labels.vat,
      data.labels.total,
    ).map(h => text(size: 7pt, weight: "semibold", fill: muted, upper(h))),
  ),
  // Lines grouped by matter; one row per line, the description wrapping in its
  // own column beside the figures.
  ..data.groups.map(group => (
    table.cell(colspan: 6, fill: tint, text(weight: "semibold", group.workspaceName)),
    ..group.lines.map(line => (
      line.description,
      if line.quantity != none { line.quantity } else { [] },
      if line.unitPrice != none { line.unitPrice } else { [] },
      line.net,
      [#line.vat \ #text(size: 7pt, fill: muted, line.vatLabel)],
      text(weight: "medium", line.total),
    )).flatten(),
    table.cell(colspan: 3, text(weight: "semibold", data.labels.total + ": " + group.workspaceName)),
    text(weight: "semibold", group.net),
    text(weight: "semibold", group.vat),
    text(weight: "semibold", group.total),
  )).flatten(),
)
#v(10pt)

// Totals, VAT breakdown and the amount due, which is the most prominent figure.
#align(end, block(width: 62%, breakable: false, {
  set text(number-width: "tabular")
  // VAT breakdown per rate, then the summed net and VAT.
  grid(
    columns: (1fr, auto, auto),
    column-gutter: 14pt,
    row-gutter: 6pt,
    align: (start, end, end),
    [], label-text(data.labels.net), label-text(data.labels.vat),
    ..data.totals.breakdown.map(b => (
      text(fill: muted, b.label), text(fill: muted, b.net), text(fill: muted, b.vat),
    )).flatten(),
    // A single rate is its own sum; with none or several, the summed row carries the totals.
    ..if data.totals.breakdown.len() != 1 {
      (
        grid.hline(stroke: 0.4pt + rule),
        text(weight: "semibold", data.labels.total),
        text(weight: "semibold", data.totals.net),
        text(weight: "semibold", data.totals.vat),
      )
    } else { () },
  )
  if data.totals.homeVat != none {
    v(8pt)
    grid(
      columns: (1fr, auto),
      row-gutter: 5pt,
      align: (start, end),
      ..data.totals.homeVat.breakdown.map(b => (
        text(fill: muted, size: 8pt, [#data.labels.vatHome — #b.label]),
        text(fill: muted, size: 8pt, b.vat),
      )).flatten(),
      text(weight: "semibold", data.labels.vatHomeTotal),
      text(weight: "semibold", data.totals.homeVat.total),
    )
    v(5pt)
    text(fill: muted, size: 8pt, [
      #data.labels.exchangeRate: #data.totals.homeVat.rate; \
      #data.labels.rateSource: #data.totals.homeVat.source; \
      #data.labels.rateDate: #data.totals.homeVat.date
    ])
  }
  v(8pt)
  block(fill: accent, inset: (x: 12pt, y: 10pt), radius: 5pt, width: 100%,
    grid(
      columns: (1fr, auto),
      align: (start + horizon, end + horizon),
      text(fill: white, weight: "semibold", size: 10pt, data.labels.total),
      text(fill: white, weight: "bold", size: 17pt, data.totals.gross),
    ))
}))
#if data.legalNotes.len() > 0 {
  block(fill: tint, inset: 9pt, radius: 4pt, width: 100%,
    data.legalNotes.map(note => [#note \ ]).join())
  v(12pt)
}

#v(16pt)

// Payment block with the payment QR code (SPAYD, PAY by square or ZBP).
#if data.payment != none {
  block(breakable: false, grid(
    columns: if data.payment.qrSvg != none { (1fr, data.payment.qrWidthMm * 1mm) } else { (1fr,) },
    gutter: 16pt,
    {
      label-text(data.labels.payment)
      v(3pt)
      field-list(data.payment.fields)
      if data.payment.accountNumber != none [#data.payment.accountNumber]
    },
    ..if data.payment.qrSvg != none {
      (image(bytes(data.payment.qrSvg), format: "svg", width: data.payment.qrWidthMm * 1mm),)
    } else { () },
  ))
}

#if data.notes != none {
  v(12pt)
  label-text(data.labels.notes)
  v(3pt)
  data.notes
}
