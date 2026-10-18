// Book: Libertinus Serif, justified, indented paragraphs, old-style figures, quiet rules.
#set text(font: "Libertinus Serif", size: 11.5pt, lang: "en", number-type: "old-style")
#set par(justify: true, leading: 0.62em, spacing: 0.62em, first-line-indent: 1.2em)
#set page(footer: context {
  let n = counter(page).get().first()
  if n > 1 { align(center, text(size: 0.9em, str(n))) }
})

#show heading: set text(weight: "regular")
#show heading: set block(above: 1.6em, below: 0.8em)
#show heading.where(level: 1): set text(size: 2em)
#show heading.where(level: 1): set block(above: 0em, below: 1.2em)
#show heading.where(level: 2): set text(size: 1.35em)
#show heading.where(level: 3): it => block(above: 1.3em, below: 0.7em, smallcaps(it.body))
#show heading.where(level: 4): it => block(above: 1.2em, below: 0.6em, emph(it.body))

#show quote.where(block: true): set text(size: 0.95em)
#show quote.where(block: true): set pad(x: 1.5em)
#show raw: set text(font: "DejaVu Sans Mono", size: 0.8em)
#show raw.where(block: true): set block(fill: luma(246), inset: (x: 8pt, y: 7pt), width: 100%)
#show raw.where(block: true): set par(justify: false)
#show link: underline.with(stroke: 0.4pt, offset: 1.5pt)

#set table(stroke: none, inset: (x: 6pt, y: 3.5pt))
#set table.hline(stroke: 0.55pt)
#show table.cell.where(y: 0): set text(style: "italic")
#show table: set text(number-type: "lining")
#set list(indent: 0.6em, marker: [–])
#set enum(indent: 0.6em)

#let title-block(title: none, authors: (), date: none) = align(center, block(below: 2.6em, {
  set par(first-line-indent: 0em, justify: false)
  if title != none { block(below: 1em, text(size: 2.3em, title)) }
  if authors.len() > 0 { block(below: 0.6em, text(size: 1.15em, authors.join(", ", last: " and "))) }
  if date != none { emph(if type(date) == datetime { date.display("[day padding:none] [month repr:long] [year]") } else { date }) }
}))
