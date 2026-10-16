#import "@preview/mitex:0.2.6": mitex, mi

#set document(title: none)
#set page(paper: "a4", margin: 2.2cm)
#set text(font: "Libertinus Serif", size: 11pt, lang: "en")
#set par(justify: true)
#show math.equation: set text(font: "New Computer Modern Math")
#show raw: set text(font: "DejaVu Sans Mono", size: 9pt)
#show raw.where(block: true): set block(fill: luma(245), inset: 8pt, width: 100%)
#show link: set text(fill: rgb("#1f4e8c"))

#set table(stroke: none, inset: (x: 6pt, y: 4pt))
#set table.hline(stroke: 0.6pt)
#show table.cell.where(y: 0): set text(weight: "bold")

#let task(done, body) = {
  box(
    width: 0.75em,
    height: 0.75em,
    baseline: 0.05em,
    stroke: 0.6pt,
    inset: 0.18em,
    if done { box(width: 100%, height: 100%, fill: black) },
  )
  h(0.5em)
  body
}
