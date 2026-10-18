#import "@preview/mitex:0.2.6": mitex, mi

#set document(title: none)
#show math.equation: set text(font: "New Computer Modern Math")

// A formula mitex rejected, or one not closed yet, as typed.
#let typed-math(code) = text(fill: luma(115), code)

// An image the preview can link. Laid out in a box or block, the image takes its own line, so the mark before it lands
// on its top-left corner and the one after it under its left edge. Its natural size is in a context of its own: one
// that also asked where it is would measure the image again whenever the text above it moved. No mark takes space.
#let linked-image(img) = {
  context [#metadata((size: measure(img)))<liveprint-image>]
  context [#metadata((at: here().position()))<liveprint-image>]
  img
  context [#metadata((at: here().position()))<liveprint-image>]
}

// A front matter date: a datetime in `format`, or the text as written.
#let date-text(date, format) = if type(date) == datetime { date.display(format) } else { date }

// The running header's text: the front matter's title, or its date when it has no title. None without either.
#let running-head(format) = if liveprint.title != none { liveprint.title } else { date-text(liveprint.date, format) }

// The front matter's title, authors and date, at the top of the document. Each theme sets its own; this one serves a
// prelude that sets none. `date` is a datetime, or the text as written.
#let title-block(title: none, authors: (), date: none) = block(width: 100%, below: 2em, {
  set par(first-line-indent: 0em, justify: false)
  if title != none { block(below: 0.8em, text(size: 1.8em, weight: "bold", title)) }
  if authors.len() > 0 { block(below: 0.5em, authors.join(", ", last: " and ")) }
  date-text(date, "[month repr:long] [day padding:none], [year]")
})

#show outline: it => block(below: 2em, it)

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
