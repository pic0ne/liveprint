#import "@preview/mitex:0.2.6": mitex, mi

#set document(title: none)
#show math.equation: set text(font: "New Computer Modern Math")

#let task(done, body) = {
  box(
    width: 0.72em,
    height: 0.72em,
    baseline: 0.06em,
    stroke: 0.55pt,
    inset: 0.16em,
    if done { box(width: 100%, height: 100%, fill: black) },
  )
  h(0.5em)
  body
}

#show table: set par(justify: false, first-line-indent: 0em)
#show quote.where(block: true): set par(first-line-indent: 0em)
