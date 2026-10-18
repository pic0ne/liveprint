import type { TextPiece } from './toTypst';

// The parts of a formula's LaTeX that print as letters or digits, so that linking can pair the glyphs of a formula
// with the LaTeX that made them, instead of spreading the formula's LaTeX evenly over its glyphs.

const GREEK: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ϵ', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ',
  vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', varpi: 'ϖ', rho: 'ρ',
  varrho: 'ϱ', sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ', phi: 'ϕ', varphi: 'φ', chi: 'χ', psi: 'ψ',
  omega: 'ω', Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ',
  Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
};

/** Commands that print their own name upright. */
const OPERATORS = new Set([
  'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh', 'coth', 'log',
  'ln', 'lg', 'exp', 'lim', 'liminf', 'limsup', 'max', 'min', 'sup', 'inf', 'det', 'dim', 'ker', 'deg', 'gcd',
  'arg', 'hom', 'Pr',
]);

/** Commands whose braced argument names something and prints nothing. */
const NAMING = new Set(['begin', 'end']);

const LETTER = /[\p{L}\p{N}]/u;

/**
 * The pieces of `tex`, which starts at `from` in the Markdown, that print as letters or digits: letters and digits
 * outside command names, the names of operators such as `\sin`, and Greek letters such as `\alpha`, which print a
 * symbol in place of the command.
 */
export function mathPieces(tex: string, from: number): TextPiece[] {
  const pieces: TextPiece[] = [];
  let i = 0;
  while (i < tex.length) {
    if (tex[i] === '\\') {
      let end = i + 1;
      while (end < tex.length && /[a-zA-Z]/.test(tex[end]!)) end++;
      const name = tex.slice(i + 1, end);
      if (name === '') end++;
      else if (OPERATORS.has(name)) pieces.push({ from: from + i + 1, text: name });
      else if (GREEK[name]) pieces.push({ from: from + i, text: GREEK[name]!, symbol: true });
      else if (NAMING.has(name) && tex[end] === '{') end = tex.indexOf('}', end) + 1 || tex.length;
      i = end;
      continue;
    }
    if (!LETTER.test(tex[i]!)) {
      i++;
      continue;
    }
    let end = i;
    while (end < tex.length && LETTER.test(tex[end]!)) end++;
    pieces.push({ from: from + i, text: tex.slice(i, end) });
    i = end;
  }
  return pieces;
}
