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
