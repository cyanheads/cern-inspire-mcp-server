/**
 * @fileoverview Unit tests for `markupToText`, the converter that turns the
 * publisher HTML, JATS, and MathML in INSPIRE titles and abstracts into text:
 * real INSPIRE strings, the conversion rules, input built to confuse the
 * scanner (CDATA, comments, processing instructions, namespaces, case, tags
 * reassembled from fragments, prototype-named and out-of-range entities),
 * MathML nested past the first level, prose that carries `<` and `>` and must
 * come back byte-for-byte, and linear running time on unclosed and nested input
 * (thread CPU time, so a loaded suite run does not skew the growth ratio).
 * @module tests/shared/markup-to-text.test
 */

import { describe, expect, it } from 'vitest';
import { containsMarkup, markupToText } from '@/services/inspire/markup-to-text.js';
import { MARKUP_AS_TEXT, MARKUP_FREE, PUBLISHER_MARKUP } from '../fixtures/inspire-markup.js';
import { measureGrowth, threadCpuMs } from '../fixtures/measure-growth.js';

describe('real INSPIRE strings', () => {
  it.each(Object.entries(PUBLISHER_MARKUP))('converts the %s to text', (name, raw) => {
    expect(markupToText(raw)).toBe(MARKUP_AS_TEXT[name as keyof typeof PUBLISHER_MARKUP]);
  });

  it.each(Object.entries(MARKUP_FREE))('returns the markup-free %s unchanged', (_name, text) => {
    expect(markupToText(text)).toBe(text);
  });
});

describe('conversion rules', () => {
  it.each([
    ['a one-character subscript', 'u<sub>1</sub>', 'u_1'],
    ['a one-character superscript', 'u<sup>3</sup>', 'u^3'],
    ['a longer script, braced', 'E<sub>T</sub><sup>miss</sup>', 'E_T^{miss}'],
    ['a script around an inline element', '𝔽<sub><i>q</i></sub>', '𝔽_q'],
    ['an empty script, dropped', 'x<sub></sub>y<sup> </sup>', 'xy'],
    ['msub', '<msub><mi>σ</mi><mi>γ</mi></msub>', 'σ_γ'],
    ['msup', '<msup><mi>fb</mi><mrow><mo>-</mo><mn>1</mn></mrow></msup>', 'fb^{-1}'],
    ['msubsup', '<msubsup><mi>B</mi><mi>c</mi><mo>±</mo></msubsup>', 'B_c^±'],
    [
      'mmultiscripts with a prescript',
      '<mmultiscripts><mi>Tb</mi><mprescripts/><none/><mn>144</mn></mmultiscripts>',
      '^{144}Tb',
    ],
    ['a one-character mfrac', '<mfrac><mi>a</mi><mi>b</mi></mfrac>', 'a/b'],
    [
      'an mfrac with a multi-character operand',
      '<mfrac><mrow><mi>a</mi><mo>+</mo><mi>b</mi></mrow><mi>c</mi></mfrac>',
      '(a+b)/c',
    ],
    ['msqrt', '<msqrt><mi>s</mi></msqrt>', '√s'],
    ['mroot', '<mroot><mi>x</mi><mn>3</mn></mroot>', '√[3]x'],
    ['mfenced with its defaults', '<mfenced><mi>a</mi><mi>b</mi></mfenced>', '(a,b)'],
    [
      'mfenced with its attributes',
      '<mfenced open="〈" close="〉" separators="|"><mi>a</mi><mi>b</mi></mfenced>',
      '〈a|b〉',
    ],
    [
      'an mtable',
      '<mtable><mtr><mtd><mi>a</mi></mtd><mtd><mi>b</mi></mtd></mtr><mtr><mtd><mi>c</mi></mtd></mtr></mtable>',
      'a b; c',
    ],
    [
      'an accent over one character',
      '<mover accent="true"><mi>s</mi><mo>¯</mo></mover>',
      's\u{304}',
    ],
    ['an arrow over one character', '<mover><mi>p</mi><mo>→</mo></mover>', 'p\u{20D7}'],
    ['a dot written as its spacing form', '<mover><mi>q</mi><mo>˙</mo></mover>', 'q\u{307}'],
    ['a hat written as its spacing form', '<mover><mi>β</mi><mo>ˆ</mo></mover>', 'β\u{302}'],
    ['a diaeresis written as its spacing form', '<mover><mi>x</mi><mo>¨</mo></mover>', 'x\u{308}'],
    ['a bare combining dot (U+0307)', '<mover><mi>q</mi><mo>\u{307}</mo></mover>', 'q\u{307}'],
    [
      'a bare combining circumflex (U+0302)',
      '<mover accent="true"><mi>β</mi><mo>\u{302}</mo></mover>',
      'β\u{302}',
    ],
    [
      'a bare combining diaeresis (U+0308)',
      '<mover><mi>x</mi><mo>&#x308;</mo></mover>',
      'x\u{308}',
    ],
    ['a bare combining overline (U+0305)', '<mover><mi>u</mi><mo>\u{305}</mo></mover>', 'u\u{305}'],
    ['a bare combining arrow (U+20D7)', '<mover><mi>A</mi><mo>\u{20D7}</mo></mover>', 'A\u{20D7}'],
    [
      'a bare combining mark over a prefixed base',
      '<mml:mover><mml:mi>s</mml:mi><mml:mo>\u{307}</mml:mo></mml:mover><mml:mo>+</mml:mo><mml:mn>3</mml:mn>',
      's\u{307}+3',
    ],
    [
      'an accent over several characters, as a superscript',
      '<mover><mrow><mi>a</mi><mi>b</mi></mrow><mo>¯</mo></mover>',
      'ab^¯',
    ],
  ])('renders %s', (_name, raw, text) => {
    expect(markupToText(raw)).toBe(text);
  });

  it('separates paragraphs with a blank line', () => {
    expect(markupToText('<p>A</p><p>B</p>')).toBe('A\n\nB');
    expect(markupToText('<p>A</p>\n<p>B</p>')).toBe('A\n\nB');
    expect(markupToText('<sec><title>Intro</title><p>Body.</p></sec>')).toBe('Intro\n\nBody.');
  });

  it('turns a line break element into a newline', () => {
    expect(markupToText('x<br>y')).toBe('x\ny');
    expect(markupToText('x<br/>y')).toBe('x\ny');
    expect(markupToText('x<br></br>y')).toBe('x\ny');
  });

  it('never lets an end tag close a void element, so the text after the start tag survives', () => {
    expect(markupToText('A<br>B</br>C')).toBe('A\nB\nC');
    expect(markupToText('Line one<br>Line two<br>Line three</br>')).toBe(
      'Line one\nLine two\nLine three',
    );
    expect(markupToText('a</br>b')).toBe('a\nb');
    expect(markupToText('a<none>b</none>c')).toBe('abc');
    expect(markupToText('x</none>y')).toBe('xy');
    expect(markupToText('<p>x</p><graphic><caption>Figure 1: important</caption></graphic>')).toBe(
      'x\n\n<caption>Figure 1: important</caption>',
    );
    expect(markupToText('a<mspace width="1em"></mspace>b')).toBe('a b');
  });

  it('reads et al. from an etal element whether it is empty, holds the words, or is left open', () => {
    expect(markupToText('Smith <etal/>')).toBe('Smith et al.');
    expect(markupToText('Smith <etal>et al.</etal>, 2020')).toBe('Smith et al., 2020');
    expect(markupToText('Smith <etal> 2020')).toBe('Smith et al. 2020');
  });

  it('collapses the whitespace runs pretty-printed MathML leaves to one space', () => {
    expect(
      markupToText(
        'Let <mml:math>\n  <mml:mrow>\n    <mml:mi>x</mml:mi>\n    <mml:mo>=</mml:mo>\n    <mml:mn>1</mml:mn>\n  </mml:mrow>\n</mml:math> hold',
      ),
    ).toBe('Let x=1 hold');
    expect(markupToText('pre <i>  x  </i> post')).toBe('pre x post');
  });

  it('binds a script to its neighbours across whitespace that pretty-printing broke onto new lines', () => {
    expect(markupToText('Nb\n    <sub>3</sub>\n    Sn')).toBe('Nb_3Sn');
    expect(markupToText('H\n<sub>2</sub>O and E\r\n  <sup>2</sup>')).toBe('H_2O and E^2');
  });

  it('keeps one space beside a script where a space was written on one line', () => {
    expect(markupToText('of <sup>12</sup>C and <sup>40</sup>Ca nuclei')).toBe(
      'of ^{12}C and ^{40}Ca nuclei',
    );
    expect(markupToText('3000 fb<sup>−1</sup>   luminosity')).toBe('3000 fb^{−1} luminosity');
    expect(markupToText('x  <sup>2</sup> y')).toBe('x ^2 y');
  });

  it('collapses the whitespace around a removed element to one space', () => {
    expect(markupToText('a <!-- c --> b')).toBe('a b');
    expect(markupToText('a <?A3B2 tvs=1.6pt?> b')).toBe('a b');
    expect(markupToText('see <pub-id>10.1/x</pub-id> now')).toBe('see now');
    expect(markupToText('a <annotation>s</annotation> b')).toBe('a b');
    expect(markupToText('a <none>b</none> c')).toBe('a b c');
    expect(markupToText('(<?A3B2 tvs?><math><mi>χ</mi></math><?A3B2 tvs?>EFT)')).toBe('(χEFT)');
  });

  it('keeps the whitespace inside text that no removed tag touches', () => {
    expect(markupToText('<p>two  spaces\tand a tab</p>')).toBe('two  spaces\tand a tab');
  });

  it('drops annotation content, which repeats the formula', () => {
    expect(
      markupToText(
        '<semantics><msub><mi>D</mi><mn>1</mn></msub><annotation encoding="application/x-tex">D_{1}</annotation></semantics>',
      ),
    ).toBe('D_1');
    expect(
      markupToText(
        '<semantics><mi>σ</mi><annotation-xml encoding="MathML-Content"><ci>σ</ci></annotation-xml></semantics>',
      ),
    ).toBe('σ');
    expect(markupToText('<mml:annotation encoding="x">D_{k}</mml:annotation>x')).toBe('x');
  });

  it('keeps tex-math content as written, trimming the whitespace inside the formula beside punctuation', () => {
    expect(markupToText('<tex-math notation="LaTeX">$\\frac{a}{b} < c$</tex-math>')).toBe(
      '$\\frac{a}{b} < c$',
    );
    expect(
      markupToText(
        '~10-<inline-formula> <tex-math notation="LaTeX">$\\mu $ </tex-math></inline-formula>V',
      ),
    ).toBe('~10-$\\mu $ V');
    expect(
      markupToText(
        'a <inline-formula> <tex-math notation="LaTeX">$k$ </tex-math></inline-formula>-uniform state',
      ),
    ).toBe('a $k$-uniform state');
    expect(
      markupToText(
        'the bound (<inline-formula> <tex-math notation="LaTeX">$n$ </tex-math></inline-formula>), then',
      ),
    ).toBe('the bound ($n$), then');
  });

  it('keeps a formula apart from a word when the only space between them sat inside the formula', () => {
    expect(
      markupToText(
        'of <inline-formula> <tex-math notation="LaTeX">$n$ </tex-math></inline-formula>parties',
      ),
    ).toBe('of $n$ parties');
    expect(
      markupToText(
        'Conf<inline-formula> <tex-math notation="LaTeX">$\\cdot $ </tex-math></inline-formula>Rel',
      ),
    ).toBe('Conf $\\cdot $ Rel');
    expect(
      markupToText('order <inline-formula> <tex-math>$p^{e}$ </tex-math></inline-formula>2'),
    ).toBe('order $p^{e}$ 2');
    expect(
      markupToText(
        'of <inline-formula>\n  <mml:math><mml:mi>n</mml:mi></mml:math>\n</inline-formula>parties',
      ),
    ).toBe('of n parties');
  });

  it('keeps a formula joined to a word when no space was written on either side', () => {
    expect(markupToText('the <math><mi>γ</mi></math>ray and <math><mi>x</mi></math>-axis')).toBe(
      'the γray and x-axis',
    );
  });

  it('sets a display formula on its own line', () => {
    expect(
      markupToText(
        'we prove<disp-formula> <tex-math notation="LaTeX">\\begin{equation*} E=mc^2 \\end{equation*}</tex-math> </disp-formula>where E',
      ),
    ).toBe('we prove\n\\begin{equation*} E=mc^2 \\end{equation*}\nwhere E');
    expect(
      markupToText('we prove<disp-formula><tex-math>E=mc^2</tex-math></disp-formula>where E'),
    ).toBe('we prove\nE=mc^2\nwhere E');
    expect(
      markupToText(
        '<p>We prove</p><disp-formula><tex-math>E</tex-math></disp-formula><p>where</p>',
      ),
    ).toBe('We prove\n\nE\n\nwhere');
  });

  it('drops processing instructions and comments', () => {
    expect(markupToText('<?A3B2 tvs=1.6pt?>x<!-- c -->y')).toBe('xy');
    expect(markupToText('<?xml version="1.0"?><p>x</p>')).toBe('x');
  });

  it('drops publisher identifiers and phantoms with their content, and renders et al.', () => {
    expect(
      markupToText('Ref.<pub-id pub-id-type="doi">10.1/x</pub-id> ISSN<issn>1234</issn>'),
    ).toBe('Ref. ISSN');
    expect(markupToText('<mi>a</mi><mphantom><mi>b</mi></mphantom>')).toBe('a');
    expect(markupToText('Smith <etal/>')).toBe('Smith et al.');
  });

  it('drops a zero-width mspace and turns a positive one into a space', () => {
    expect(markupToText('a<mspace width="0pt"/>b')).toBe('ab');
    expect(markupToText('a<mspace width="negativethinmathspace"/>b')).toBe('ab');
    expect(markupToText('a<mspace width="0.16em"/>b')).toBe('a b');
    expect(markupToText('a<mspace width="thinmathspace"/>b')).toBe('a b');
  });
});

describe('input built to confuse the scanner', () => {
  it('keeps CDATA content as text, never tags or entities', () => {
    expect(markupToText('<![CDATA[a<b>c</b>]]>')).toBe('a<b>c</b>');
    expect(markupToText('<p><![CDATA[&lt;i&gt;]]></p>')).toBe('&lt;i&gt;');
    expect(markupToText('<tex-math><![CDATA[$a<b$]]></tex-math>')).toBe('$a<b$');
  });

  it('leaves an unterminated CDATA section as written', () => {
    expect(markupToText('<![CDATA[x <p>')).toBe('<![CDATA[x <p>');
  });

  it('ends a comment at the first -->, hiding any markup inside it', () => {
    expect(markupToText('a<!-- c -- d -->b')).toBe('ab');
    expect(markupToText('<p>a</p><!-- <p>b</p> -->c')).toBe('a\n\nc');
    expect(markupToText('<i>a<!-- </i> -->b</i>')).toBe('ab');
    expect(markupToText('a<!-- x -->b<!-- y -->c')).toBe('abc');
  });

  it('leaves an unterminated comment opener as written', () => {
    expect(markupToText('a <!-- never closed')).toBe('a <!-- never closed');
  });

  it('drops a processing instruction only when it names a target and closes', () => {
    expect(markupToText('<?pi data?>x')).toBe('x');
    expect(markupToText('<? no target ?>x')).toBe('<? no target ?>x');
    expect(markupToText('x <?pi unclosed')).toBe('x <?pi unclosed');
  });

  it('allows whitespace before the > of a tag, but a stray end tag stays prose', () => {
    expect(markupToText('<p >x</p >')).toBe('x');
    expect(markupToText('</p >x')).toBe('</p >x');
    expect(markupToText('x</i>')).toBe('x</i>');
  });

  it('reads vocabulary names case-sensitively, so uppercase tags stay text', () => {
    expect(markupToText('<P>x</P>')).toBe('<P>x</P>');
    expect(markupToText('<MI>x</MI>')).toBe('<MI>x</MI>');
    expect(markupToText('<p>x</P>')).toBe('<p>x</P>');
    expect(markupToText('<P>x</P><p>y</p>')).toBe('<P>x</P>\n\ny');
  });

  it('reads the local name after any namespace prefix', () => {
    expect(markupToText('<mml:msub><mml:mi>x</mml:mi><mml:mn>2</mml:mn></mml:msub>')).toBe('x_2');
    expect(markupToText('<a:p>A</a:p><a:p>B</a:p>')).toBe('A\n\nB');
    expect(markupToText('H<c:sub>2</c:sub>O')).toBe('H_2O');
  });

  it('pairs a start tag only with an end tag under the same prefix', () => {
    expect(markupToText('<mml:mi>x</mi>')).toBe('<mml:mi>x</mi>');
    expect(markupToText('<mi>x</mml:mi>')).toBe('<mi>x</mml:mi>');
    expect(markupToText('<a:p>x</b:p>')).toBe('<a:p>x</b:p>');
  });

  it('leaves tags outside the vocabulary as text', () => {
    for (const text of [
      '<script>alert(1)</script>',
      '<img src="x" onerror="y">',
      '<a href="https://evil.example">y</a>',
      '<iframe src="x"></iframe>',
    ]) {
      expect(markupToText(text)).toBe(text);
    }
  });

  it('never reads a tag that removing markup reassembles from fragments', () => {
    expect(markupToText('<scr<b>ipt>')).toBe('<scr<b>ipt>');
    expect(markupToText('<scr<b></b>ipt>alert(1)</script>')).toBe('<script>alert(1)</script>');
    expect(markupToText('<su<b></b>p>2</sup>')).toBe('<sup>2</sup>');
  });

  it('leaves an unclosed vocabulary tag before a real one as text', () => {
    expect(markupToText('<p<p>x</p>')).toBe('<p\n\nx');
    expect(markupToText('<<p>x</p>')).toBe('<\n\nx');
  });

  it.each([
    '&constructor;',
    '&__proto__;',
    '&hasOwnProperty;',
    '&toString;',
    '&valueOf;',
    '&l;',
    '&g;',
    '&lt',
    '&#65',
    '&#;',
    '&#x;',
  ])('leaves the unknown or malformed reference %s as written', (text) => {
    expect(markupToText(text)).toBe(text);
    expect(markupToText(`<p>${text}</p>`)).toBe(text);
  });

  it('decodes entities once, so a double-escaped entity decodes to its escaped form', () => {
    expect(markupToText('&amp;lt;')).toBe('&lt;');
    expect(markupToText('&amp;amp;')).toBe('&amp;');
    expect(markupToText('<p>&amp;lt;</p>')).toBe('&lt;');
  });

  it('decodes an escaped tag to text, never to markup', () => {
    expect(markupToText('&lt;p&gt;')).toBe('<p>');
    expect(markupToText('&lt;p&gt;x&lt;/p&gt;')).toBe('<p>x</p>');
    expect(markupToText('<i>&lt;script&gt;</i>')).toBe('<script>');
    expect(markupToText('<p>&lt;p&gt;x</p>')).toBe('<p>x');
  });

  it('never decodes an entity split by a removed tag', () => {
    expect(markupToText('&l<i>t;</i>')).toBe('&lt;');
  });

  it('decodes the named entities in its table', () => {
    expect(
      markupToText('&nbsp;&thinsp;&hyphen;&ndash;&mdash;&minus;&plusmn;&times;&quot;&apos;&amp;'),
    ).toBe('\u{A0}\u{2009}\u{2010}–—−±×"\'&');
  });

  it.each([
    ['NUL', '&#0;'],
    ['NUL in hex', '&#x0;'],
    ['a tab', '&#9;'],
    ['a line feed', '&#10;'],
    ['the last C0 control', '&#x1F;'],
    ['DEL', '&#127;'],
    ['a C1 control', '&#x80;'],
    ['the last C1 control', '&#x9F;'],
    ['a high surrogate', '&#xD800;'],
    ['a high surrogate in decimal', '&#55296;'],
    ['a low surrogate', '&#xDFFF;'],
    ['the first code point past U+10FFFF', '&#x110000;'],
    ['an out-of-range decimal reference', '&#9999999;'],
    ['a seven-digit hex reference', '&#x1234567;'],
    ['the first Unicode tag character', '&#xE0000;'],
    ['TAG LATIN CAPITAL LETTER A', '&#xE0041;'],
    ['TAG LATIN CAPITAL LETTER A in decimal', '&#917569;'],
    ['CANCEL TAG', '&#xE007F;'],
  ])('leaves a numeric reference to %s as written', (_name, text) => {
    expect(markupToText(text)).toBe(text);
    expect(markupToText(`<i>${text}</i>`)).toBe(text);
  });

  it.each([
    ['&#65;', 'A'],
    ['&#x41;', 'A'],
    ['&#X41;', 'A'],
    ['&#00065;', 'A'],
    ['&#xA0;', '\u{A0}'],
    ['&#x1D53D;', '𝔽'],
    ['&#x10FFFF;', '\u{10FFFF}'],
    ['&#xE0080;', '\u{E0080}'],
  ])('decodes the valid numeric reference %s', (text, decoded) => {
    expect(markupToText(text)).toBe(decoded);
  });

  it('passes a lone surrogate in the text through untouched', () => {
    expect(markupToText('x\u{D800}y')).toBe('x\u{D800}y');
    expect(markupToText('<i>\u{DC00}</i>')).toBe('\u{DC00}');
  });
});

describe('depth', () => {
  it('renders an mrow in an msub in an mfrac in an msup', () => {
    expect(
      markupToText(
        '<msup><mfrac><msub><mrow><mi>a</mi><mi>b</mi></mrow><mrow><mn>1</mn><mn>2</mn></mrow></msub><mrow><mi>c</mi><mo>+</mo><mi>d</mi></mrow></mfrac><mrow><mn>2</mn><mi>n</mi></mrow></msup>',
      ),
    ).toBe('(ab_{12})/(c+d)^{2n}');
    expect(
      markupToText(
        '<msup><mfrac><msub><mrow><mi>a</mi></mrow><mn>1</mn></msub><mi>b</mi></mfrac><mn>2</mn></msup>',
      ),
    ).toBe('(a_1)/b^2');
  });

  it('writes a spin-parity fraction the way physics writes it', () => {
    expect(
      markupToText(
        '<mml:msup><mml:mfrac><mml:mn>3</mml:mn><mml:mn>2</mml:mn></mml:mfrac><mml:mo>+</mml:mo></mml:msup>',
      ),
    ).toBe('3/2^+');
  });

  it('nests scripts inside scripts, braced at every level', () => {
    expect(
      markupToText(
        '<msub><mi>t</mi><msub><mi>x</mi><mrow><mi>i</mi><mi>j</mi></mrow></msub></msub>',
      ),
    ).toBe('t_{x_{ij}}');
  });

  it('puts both mmultiscripts prescripts before the base and the postscripts after it', () => {
    expect(
      markupToText(
        '<mmultiscripts><mi>U</mi><mn>2</mn><mo>+</mo><mprescripts/><mn>92</mn><mn>238</mn></mmultiscripts>',
      ),
    ).toBe('_{92}^{238}U_2^+');
    expect(
      markupToText(
        '<mmultiscripts><mi>C</mi><none/><none/><mprescripts/><mn>6</mn><mn>14</mn></mmultiscripts>',
      ),
    ).toBe('_6^{14}C');
  });

  it('braces each multi-character msubsup script', () => {
    expect(
      markupToText(
        '<msubsup><mi>x</mi><mrow><mi>i</mi><mi>j</mi></mrow><mrow><mn>2</mn><mi>k</mi></mrow></msubsup>',
      ),
    ).toBe('x_{ij}^{2k}');
  });

  it('parenthesizes each multi-character mfrac operand', () => {
    expect(markupToText('<mfrac><mn>12</mn><mi>b</mi></mfrac>')).toBe('(12)/b');
    expect(
      markupToText(
        '<mfrac><mrow><mi>a</mi><mo>+</mo><mi>b</mi></mrow><mrow><mi>c</mi><mo>−</mo><mi>d</mi></mrow></mfrac>',
      ),
    ).toBe('(a+b)/(c−d)');
    expect(
      markupToText('<msqrt><msub><mi>s</mi><mrow><mi>N</mi><mi>N</mi></mrow></msub></msqrt>'),
    ).toBe('√(s_{NN})');
  });

  it('renders list items as paragraphs, each label before its text', () => {
    expect(
      markupToText(
        '<list list-type="bullet"><list-item><p>One</p></list-item><list-item><p>Two</p></list-item></list>',
      ),
    ).toBe('One\n\nTwo');
    expect(
      markupToText(
        'see <list><list-item><label>•</label><p>First.</p></list-item><list-item><label>•</label><p>Second.</p></list-item></list> end',
      ),
    ).toBe('see\n\n• First.\n\n• Second.\n\nend');
  });

  it.each([
    ['<italic> closed by </i>', '<italic>x</i>'],
    ['<bold> closed by </b>', '<bold>x</b>'],
    ['<sc> closed by </small>', '<sc>x</small>'],
    ['a prefixed <italic> closed by </i>', '<mml:italic>x</mml:i>'],
  ])('pairs %s', (_name, raw) => {
    expect(markupToText(raw)).toBe('x');
  });

  it('pairs an alias closer with the nearest open tag it can close', () => {
    expect(markupToText('<italic>a <i>b</i> c</i>')).toBe('a b c');
    expect(markupToText('CR–RC<italic>x<sup>2</sup></i> filter')).toBe('CR–RCx^2 filter');
  });

  it('leaves an alias opener whose closer never comes as text', () => {
    expect(markupToText('<italic>never closed')).toBe('<italic>never closed');
    expect(markupToText('a <italic>b <i>c</i> d')).toBe('a <italic>b c d');
  });

  it('does not let </italic> close an <i>, since aliases run one way', () => {
    expect(markupToText('<i>x</italic>')).toBe('<i>x</italic>');
  });

  it('unwraps inline elements nested several levels deep', () => {
    expect(markupToText('<i><b><i><sc>x</sc></i></b></i>')).toBe('x');
  });
});

describe('prose survives', () => {
  it.each([
    [
      'Z/A < 1, while the model without the <math><mi>s</mi></math> asymmetry',
      'Z/A < 1, while the model without the s asymmetry',
    ],
    ['on a <100-mK stage', 'on a <100-mK stage'],
    ['$<Q^2> ~ 1.9$', '$<Q^2> ~ 1.9$'],
    ['\\left< E_{\\nu} \\right>', '\\left< E_{\\nu} \\right>'],
    ['$0.75<|y|<2.3$', '$0.75<|y|<2.3$'],
    ['an unclosed <p> stays', 'an unclosed <p> stays'],
    [
      'The mean <p> rises while <p_T> and <N_ch> stay flat',
      'The mean <p> rises while <p_T> and <N_ch> stay flat',
    ],
    ['if a<b and c>d', 'if a<b and c>d'],
    ['a <b and c> d', 'a <b and c> d'],
    ['the <sub> shell', 'the <sub> shell'],
    ['R&D at AT&T & co.', 'R&D at AT&T & co.'],
    ['$m_{\\ell\\ell} < 80$ GeV with <i>no</i> veto', '$m_{\\ell\\ell} < 80$ GeV with no veto'],
  ])('keeps %j', (raw, text) => {
    expect(markupToText(raw)).toBe(text);
  });

  it('returns a LaTeX abstract that holds < and > but no recognized tag byte for byte', () => {
    const latex = MARKUP_FREE.arxiv1768644Abstract;
    expect(latex).toMatch(/</);
    expect(latex).toMatch(/>/);
    expect(markupToText(latex)).toBe(latex);
    expect(markupToText(`${latex}\n  ${latex}`)).toBe(`${latex}\n  ${latex}`);
  });
});

describe('containsMarkup', () => {
  it.each([
    ['a paired tag', '<p>x</p>'],
    ['a void tag', 'a<br>b'],
    ['a self-closing tag', '<etal/>'],
    ['a comment', 'a <!-- c --> b'],
    ['a processing instruction', '<?A3B2 tvs?>x'],
    ['a CDATA section', '<![CDATA[x]]>'],
    ['the text an entity-escaped CDS abstract converts to', markupToText('&lt;p&gt;x&lt;/p&gt;')],
  ])('finds %s', (_name, text) => {
    expect(containsMarkup(text)).toBe(true);
  });

  it.each([
    ['empty text', ''],
    ['plain text', 'Dark matter search.'],
    ['a comparison', 'Z/A < 1 and c > d'],
    ['an unclosed vocabulary tag', 'an unclosed <p> stays'],
    ['a stray end tag', 'x</i>'],
    ['tags outside the vocabulary', '<P>x</P><script>y</script>'],
    ['converted text', markupToText(PUBLISHER_MARKUP.aps1316657Abstract)],
  ])('finds none in %s', (_name, text) => {
    expect(containsMarkup(text)).toBe(false);
  });
});

describe('running time', () => {
  /**
   * From 40,000 to 320,000 characters, linear growth is 8x and quadratic 64x.
   * The converter measures 7–11x on every shape; wrapped in a naive
   * closer-search scan, which is quadratic, it measures 50–64x on every shape,
   * so the ratio limit alone fails it. A quadratic term shows in the ratio only
   * once it outweighs the linear work at the small size, which is why the span
   * starts at 40,000 characters rather than 5,000.
   */
  const SPAN = { small: 40_000, large: 320_000 };
  const LIMITS = { maxRatio: 20, maxLargeMs: 500 };

  const repeatTo = (unit: string, chars: number) => unit.repeat(Math.floor(chars / unit.length));
  const nest = (open: string, inner: string, close: string, chars: number) => {
    const depth = Math.floor(chars / (open.length + close.length));
    return { depth, text: `${open.repeat(depth)}${inner}${close.repeat(depth)}` };
  };
  const PREFIXES = '<m<ms<msu<msub<msubs<msubsu<msubsup';

  it.for([
    { shape: '<p repeated', make: (n: number) => repeatTo('<p', n), out: (s: string) => s },
    {
      shape: 'unclosed <p> repeated',
      make: (n: number) => repeatTo('<p>', n),
      out: (s: string) => s,
    },
    {
      shape: 'nested <mrow>',
      make: (n: number) => nest('<mrow>', 'x', '</mrow>', n).text,
      out: () => 'x',
    },
    {
      shape: '<a<a<a…>>>',
      make: (n: number) => `${repeatTo('<a', (n * 2) / 3)}${repeatTo('>', n / 3)}`,
      out: (s: string) => s,
    },
    {
      shape: 'overlapping name prefixes',
      make: (n: number) => repeatTo(PREFIXES, n),
      out: (s: string) => s,
    },
    {
      shape: 'unterminated <!-- repeated',
      make: (n: number) => repeatTo('<!--', n),
      out: (s: string) => s,
    },
    {
      shape: 'scripts, void end tags, comments',
      make: (n: number) => repeatTo('x\n<sub>2</sub>\n</br></none><!---->', n),
      out: (s: string) =>
        Array((s.match(/x/g) ?? []).length)
          .fill('x_2')
          .join('\n'),
    },
    {
      shape: 'nested <msub>',
      make: (n: number) => nest('<msub><mi>x</mi>', '<mi>y</mi>', '</msub>', n).text,
      out: (s: string) => {
        const depth = (s.match(/<msub>/g) ?? []).length;
        return `${'x_{'.repeat(depth - 1)}x_y${'}'.repeat(depth - 1)}`;
      },
    },
  ])(
    'converts $shape in linear time from 40,000 to 320,000 characters',
    async ({ make, out }, { annotate }) => {
      const small = make(SPAN.small);
      const large = make(SPAN.large);
      expect(markupToText(small)).toBe(out(small));
      expect(markupToText(large)).toBe(out(large));

      const growth = measureGrowth(markupToText, { small, large }, LIMITS);
      await annotate(growth.summary, 'cpu-time');

      expect(growth.ratio, growth.summary).toBeLessThan(LIMITS.maxRatio);
      expect(growth.largeMs, growth.summary).toBeLessThan(LIMITS.maxLargeMs);
    },
  );

  it('converts 100,000 unclosed <p> and 10,000 nested <mrow> quickly', () => {
    const unclosed = '<p>'.repeat(100_000);
    const nested = `${'<mrow>'.repeat(10_000)}<mi>x</mi>${'</mrow>'.repeat(10_000)}`;

    const start = threadCpuMs();
    expect(markupToText(unclosed)).toBe(unclosed);
    expect(markupToText(`<math>${nested}</math>`)).toBe('x');
    expect(threadCpuMs() - start).toBeLessThan(1_000);
  });
});
