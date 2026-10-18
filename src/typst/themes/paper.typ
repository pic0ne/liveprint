// Paper: the LaTeX article look. New Computer Modern, numbered sections, centred title.
#set text(font: "New Computer Modern", size: 11pt, lang: "en")
#set par(justify: true, leading: 0.55em, spacing: 0.55em, first-line-indent: 1.5em)
#set page(numbering: "1", number-align: center)
#set page(header: context if here().page() > 1 { align(center, text(size: 0.9em, smallcaps(running-head("[month repr:long] [day padding:none], [year]")))) })

#set heading(numbering: (..n) => numbering("1.1", ..n.pos().slice(1)))
#show heading.where(level: 1): set heading(numbering: none)
#show heading: set text(size: 1.2em, weight: "bold")
#show heading: set block(above: 1.5em, below: 0.9em)
#show heading.where(level: 1): it => align(center, block(above: 0.4em, below: 1.8em, text(size: 1.45em, weight: "regular", it.body)))
#show heading.where(level: 3): set text(size: 1.05em)
#show heading.where(level: 4): set text(size: 1em)

#show quote.where(block: true): set pad(x: 2.5em)
#show raw: set text(font: "DejaVu Sans Mono", size: 0.82em)
#show raw.where(block: true): set block(inset: (left: 1.5em, y: 2pt))
#show raw.where(block: true): set par(justify: false)
#show link: set text(fill: rgb("#7a1f1f"))

#set table(stroke: none, inset: (x: 6pt, y: 3pt))
#set table.hline(stroke: 0.5pt)
#show table.cell.where(y: 0): set text(weight: "bold")
#set list(indent: 1em)
#set enum(indent: 1em)

#let title-block(title: none, authors: (), date: none) = align(center, block(below: 2.2em, {
  set par(first-line-indent: 0em, justify: false)
  if title != none { block(above: 0.4em, below: 1.5em, text(size: 1.75em, title)) }
  if authors.len() > 0 { block(below: 0.9em, text(size: 1.2em, authors.join(h(2.5em)))) }
  if date != none { text(size: 1.2em, date-text(date, "[month repr:long] [day padding:none], [year]")) }
}))
