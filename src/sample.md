# A field guide to the printed page

Most writing now lives on screens that reflow, scroll and resize. The printed page does none of that. It has edges, a fixed width, a known number of lines, and once it leaves the printer it never changes again. That permanence is why a page rewards care: every decision about measure, leading and rhythm is visible, and it stays visible.

This guide collects the working rules a typesetter keeps in their head. None of them are new. Most are older than electricity. They are written down here because Markdown hides them, and a tool that turns Markdown into real pages has to make them again on the writer's behalf.

## The measure

The *measure* is the length of a line of text. It is the single most important number on a page, more important than the typeface and more important than the size.

A line that is too long tires the eye. When the reader reaches the end of a long line and sweeps back to the left, the eye has to find the start of the next line, and on a wide block it often lands on the wrong one. A line that is too short breaks phrases apart and fills the right edge with ragged gaps or, when justified, with loose word spacing.

The classic advice is 45 to 75 characters per line, with 66 as the ideal for a single column of running text. For two columns, 40 to 50 characters per column reads well. These numbers are not laws, but they are a good place to start, and a page that ignores them usually looks wrong before anyone can say why.

> A line of 66 characters is the widely accepted ideal for a single-column page set in a serifed text face in a text size.
>
> Robert Bringhurst, paraphrased from *The Elements of Typographic Style*

There is a quick test. Set a paragraph, then count the characters in a typical line, spaces included. If the count is over 80, widen the margins or raise the type size. If it is under 40, do the reverse.

## Leading

*Leading* (rhymes with *heading*) is the vertical distance from one baseline to the next. The word comes from the strips of lead that compositors placed between lines of metal type.

Leading depends on the measure. Longer lines need more leading, because the eye travels further before it returns and needs a wider channel to follow. A reasonable default for body text is 1.2 to 1.45 times the type size. Headings, which are short, can be set much tighter, often at 1.0 to 1.1.

| Body size | Tight leading | Comfortable leading | Loose leading |
|-----------|---------------|---------------------|---------------|
| 9 pt      | 10.8 pt       | 12.6 pt             | 14.4 pt       |
| 10 pt     | 12 pt         | 14 pt               | 16 pt         |
| 11 pt     | 13.2 pt       | 15.4 pt             | 17.6 pt       |
| 12 pt     | 14.4 pt       | 16.8 pt             | 19.2 pt       |

Too little leading makes the page dark and dense. Ascenders of one line start to touch the descenders of the line above. Too much leading breaks the paragraph into separate stripes, and the reader stops seeing a block of text.

### Vertical rhythm

A page has rhythm when every line of body text sits on a shared grid. Headings, quotations and lists then take up whole multiples of the base line height, so lines on facing pages align and text on the back of a sheet does not show through between lines on the front.

Strict rhythm is hard to keep once a page has images, tables and equations of arbitrary height. Most modern systems settle for consistent spacing *around* those elements instead of snapping them to the grid. That is a reasonable compromise, and it is the one this guide recommends.

## Choosing a typeface

A text face has one job: to disappear. The reader should notice the meaning, not the letters. Display faces, used for titles and headings at large sizes, can carry more personality.

Things to check before choosing a text face:

1. **x-height.** Faces with a large x-height read well at small sizes but can look crowded with tight leading.
2. **Range of weights and styles.** Running text needs at least a regular, an italic and a bold. Small caps and old-style figures are a bonus.
3. **Language coverage.** Accented letters, Greek and Cyrillic, and the symbols a document will need, such as arrows, the multiplication sign and proper quotation marks.
4. **Figures.** Old-style figures sit well in running text; lining figures suit tables. Tabular figures, where each digit has the same width, keep columns of numbers aligned.
5. **Licence.** A font that cannot be embedded in a PDF is a font that cannot be used for print.

Pairing faces is easier than it looks. One serif for text and one sans for headings is a safe default. Two faces from the same designer or foundry usually share proportions and pair well. More than two faces on a page is almost always one too many.

### Size

For printed body text, 9 to 12 point covers nearly every case. Books are often set at 10 or 11 point. Reports and letters tend to use 11 or 12. Footnotes and captions drop one or two points below the body.

A *point* in modern digital type is exactly 1/72 of an inch. That makes the conversions simple:

$$1\,\text{pt} = \frac{1}{72}\,\text{in} = \frac{25.4}{72}\,\text{mm} \approx 0.3528\,\text{mm}$$

## Justification and line breaking

Justified text has both edges straight. It looks orderly, and it is the default in most books. The cost is that the space between words has to stretch or shrink to fill each line exactly, and when it stretches too far the page grows *rivers*: white channels that run down through several lines.

Ragged-right text keeps word spacing constant and lets the right edge vary. It is easier to set well, especially on short measures, and it is the better choice for narrow columns.

Good justification depends on the line-breaking algorithm. A naive breaker fills each line greedily, one at a time, which can leave a terrible line late in a paragraph because an earlier line took one word too many. The Knuth–Plass algorithm, introduced with TeX, considers the whole paragraph at once and chooses the set of breaks that minimises the total *badness*.

For a line whose natural width is $w$, with total stretchability $y$ and target width $W$, the adjustment ratio is

$$r = \frac{W - w}{y}$$

and the badness of the line is approximately

$$b = 100\,|r|^3$$

so a line stretched to twice its comfortable amount is eight times as bad. The algorithm then adds penalties for hyphens, for consecutive hyphenated lines, and for adjacent lines with very different tightness, and finds the cheapest path through all the possible breakpoints with dynamic programming.

Typst uses an optimised version of this approach for justified paragraphs, which is one reason its output looks close to TeX at a fraction of the compile time.

### Hyphenation

Hyphenation is what makes justified text on a narrow measure possible. Without it, a long word that does not fit must move entirely to the next line, leaving a gap. Most systems use Liang's pattern-based hyphenation, also from the TeX project, with pattern files for each language.

Rules worth keeping:

- No more than two consecutive lines ending in a hyphen.
- Do not hyphenate the last word of a paragraph.
- Do not hyphenate proper names if it can be avoided.
- Leave at least two letters before the break and three after it.

## Widows and orphans

An *orphan* is the first line of a paragraph left alone at the bottom of a page. A *widow* is the last line of a paragraph pushed alone to the top of the next page. Both make the page look broken, because the reader sees a fragment where they expect a block.

Typesetting systems fix them by moving a line forward or back, which makes one page a line shorter than the others. A good system adjusts the spacing on the facing page too, so the spread still balances. In Typst, the paragraph rule controls this through the `costs` parameter of `text`, and a document can make widows and orphans more or less expensive than a short page.

## Margins

Margins frame the text block and give the reader's thumbs somewhere to hold the page. They are not wasted space.

The classical proportions for a book page, worked out by medieval scribes and later rediscovered by Jan Tschichold and others, give the inner margin the smallest share and the bottom margin the largest. One well-known set of ratios is 2 : 3 : 4 : 6 for inner, top, outer and bottom.

For a single-sided document such as a report, which is printed on one side and read flat, equal left and right margins are fine. A useful default for A4 is about 25 mm on every side, which leaves a measure of 160 mm. At 11 point, that is close to 90 characters per line: slightly long, which is why many reports set body text at 12 point or widen the margins to 30 mm.

| Paper  | Size (mm)  | Size (in)      | Common in                       |
|--------|------------|----------------|---------------------------------|
| A4     | 210 × 297  | 8.27 × 11.69   | Nearly everywhere outside North America |
| Letter | 216 × 279  | 8.5 × 11       | United States, Canada           |
| A5     | 148 × 210  | 5.83 × 8.27    | Notebooks, booklets             |
| Legal  | 216 × 356  | 8.5 × 14       | US legal documents              |

The A series has a neat property: every size has the ratio $1 : \sqrt{2}$, so folding a sheet in half gives the next size down with the same proportions. A0 has an area of exactly one square metre, which fixes every other size:

$$\text{width}(A_n) = \frac{1000}{2^{(2n+1)/4}}\,\text{mm}, \qquad \text{height}(A_n) = \frac{1000}{2^{(2n-1)/4}}\,\text{mm}$$

## Headings

Headings tell the reader where they are. A document needs only as many levels as its structure demands, and readers struggle to tell apart more than three.

Each level should differ from its neighbours in more than one way: size, weight, space above, or style. Space *above* a heading should be larger than space *below* it, so the heading clearly belongs to the text it introduces and not to the text before it. A heading must never be the last line on a page; the system should carry it over with at least two lines of its paragraph.

Numbered headings help in long technical documents and legal texts, where readers refer to sections by number. In shorter documents they add noise.

## Lists

Lists work when their items are parallel: all phrases, or all sentences, starting the same way. Mixed lists, where one item is a word and the next a paragraph, look careless however they are set.

A short checklist for any document before it is printed:

- [x] Body text between 45 and 75 characters per line
- [x] Leading at least 1.2 times the type size
- [x] No more than two typefaces
- [ ] No widows or orphans
- [ ] Every table and figure referenced in the text
- [ ] Page numbers on every page except the first

Indentation of a list should line up with something: either the text block's edge, with the bullets hanging into the margin, or a consistent indent used everywhere else on the page.

## Tables

A table is for comparison. Readers scan down columns and across rows, so the layout must make both easy.

Most tables need far fewer rules than they get. Horizontal rules above and below the header, and one at the bottom of the table, are usually enough. Vertical rules are rarely needed: alignment and space separate the columns. Numbers align on the decimal point, text aligns left, and headings align with their column's content.

| Element        | Typical rule                     | Why                                     |
|----------------|----------------------------------|-----------------------------------------|
| Header row     | Bold or a rule below             | Separates labels from data              |
| Numeric column | Right or decimal aligned         | Makes magnitudes comparable at a glance |
| Text column    | Left aligned                     | Matches the reading direction           |
| Totals         | A rule above, bold figures       | Signals a summary, not another row      |
| Units          | In the header, not in every cell | Removes repetition from the data        |

## Code

Code in a printed document must be exact: a reader may type it back in. Set it in a monospaced face, keep the original line breaks, and never hyphenate or justify it. If a line is too long for the measure, shrink the code size slightly or let it overflow into the margin rather than wrapping it in a way that changes its meaning.

A short example in Rust, the language Typst is written in:

```rust
/// Returns the badness of a line, following Knuth and Plass.
fn badness(natural: f64, target: f64, stretch: f64, shrink: f64) -> f64 {
    let delta = target - natural;
    let ratio = if delta >= 0.0 {
        if stretch == 0.0 { return f64::INFINITY; }
        delta / stretch
    } else {
        if shrink == 0.0 { return f64::INFINITY; }
        delta / shrink
    };
    if ratio < -1.0 {
        return f64::INFINITY;
    }
    100.0 * ratio.abs().powi(3)
}
```

And the same idea in TypeScript, as a browser-based tool might use it to check a preview:

```typescript
export function charactersPerLine(text: string, lines: number): number {
  return Math.round(text.length / Math.max(lines, 1));
}

export function measureVerdict(cpl: number): "short" | "good" | "long" {
  if (cpl < 45) return "short";
  if (cpl > 75) return "long";
  return "good";
}
```

Syntax highlighting helps on screen. In print, keep it subtle: weight and italics survive photocopying better than colour.

## Mathematics

Mathematics has its own typography, and it is unforgiving. Variables are italic, functions such as $\sin$ and $\log$ are upright, and spacing around operators and relations follows fixed rules that a reader notices when they are broken.

Inline formulas should not disturb the leading. A fraction like $\frac{a}{b}$ in running text is acceptable; a tall one should be displayed instead. Displayed equations are centred, numbered on the right when the text refers to them, and punctuated as part of the sentence they belong to.

The normal distribution, for example, has the density

$$f(x) = \frac{1}{\sigma\sqrt{2\pi}} \exp\left(-\frac{(x-\mu)^2}{2\sigma^2}\right),$$

and its mean and variance are $\mu$ and $\sigma^2$. A matrix is displayed with its brackets scaled to the content:

$$A = \begin{pmatrix} a_{11} & a_{12} & a_{13} \\ a_{21} & a_{22} & a_{23} \\ a_{31} & a_{32} & a_{33} \end{pmatrix}, \qquad \det(A) = \sum_{\sigma \in S_3} \operatorname{sgn}(\sigma) \prod_{i=1}^{3} a_{i,\sigma(i)}.$$

Long derivations break at relation signs, with the relation starting the new line and aligned with the one above:

$$\begin{aligned} (a + b)^2 &= (a + b)(a + b) \\ &= a^2 + ab + ba + b^2 \\ &= a^2 + 2ab + b^2. \end{aligned}$$

## Images and figures

A figure should be as wide as the text block or a clear fraction of it: full, two thirds, half. Arbitrary widths look accidental. Captions go below figures and above tables, by long convention, and are set a size smaller than the body.

Raster images need enough resolution for print. At 300 pixels per inch, a figure the full width of a 160 mm text block needs about 1900 pixels across. Screenshots taken on ordinary displays are often too small and print blurred. Vector formats such as SVG and PDF scale to any size and are the better choice for charts and diagrams.

## Proofing

Every page should be read on paper, or at least as a real page, before it is sent anywhere. Errors that hide on a scrolling screen jump out of a fixed page: a heading stranded at the bottom, a table split across a break, a figure pushed two pages away from its reference.

That is the argument for previewing the real page while writing, instead of an approximation that reflows differently from the final output. When the preview is the document, there is nothing left to discover at the end.

### A proofing order

1. Read once for sense, ignoring layout entirely.
2. Read again for typography: quotation marks, dashes, spacing around units and numbers.
3. Look at every spread as a picture, without reading, to catch rivers, widows, orphans and uneven page lengths.
4. Check every cross-reference, page number and link.
5. Print one copy and read it away from the desk.

## A short glossary

**Ascender.** The part of a lowercase letter that rises above the x-height, as in *b*, *d* and *h*.

**Baseline.** The line on which most letters sit.

**Descender.** The part of a letter that falls below the baseline, as in *g*, *p* and *y*.

**Em.** A unit equal to the current type size. In 11 point type, one em is 11 points.

**Kerning.** Adjusting the space between specific pairs of letters, such as *AV* or *To*, so their spacing looks even.

**Ligature.** Two or more letters joined into one glyph, such as *fi* and *fl*, to avoid collisions.

**Measure.** The length of a line of text.

**River.** A channel of white space running down through several lines of justified text.

**Tracking.** Uniform adjustment of spacing across a range of text. Positive tracking on body text almost always hurts readability; small capitals and all-caps headings benefit from a little.

**x-height.** The height of the lowercase *x*, and so of the main body of most lowercase letters.

---

The rules above are defaults, and good typography sometimes breaks them on purpose. But it breaks them knowingly, one at a time, for a reason the reader can feel. The first step is to see the real page.
