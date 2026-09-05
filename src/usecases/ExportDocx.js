import { writeZip } from './zipWriter.js';
import { resolvePaper, paperDims, paperMargins } from './paper.js';

// ExportDocx — 개체 트리 문서를 **편집용 DOCX**(WordprocessingML)로 다시 그린다. 순수 함수.
//
// 목적은 "한글·워드에서 문항을 고치는 것"이다. 인쇄 조판의 복제가 아니다 — 쪽 나눔은 워드가 다시
// 계산하고, 상자는 표로, 답란은 밑줄 문단으로, 수식은 읽을 수 있는 평문 근사(위·아래 첨자 런)로
// 옮긴다. 정답 제거는 여기서 하지 않는다: 호출부가 BuildVariants.stripAnswersFromDocument 로 만든
// 학생 벌 트리를 넘긴다(불변식은 한 곳에서만 지킨다).
//
// 의존성 0: OOXML 을 직접 쓰고 zipWriter 로 담는다. 외부 라이브러리를 번들에 넣지 않는다.
//
// 못 옮기는 것(정직하게 문서 맨 위 안내로 남긴다): 조직자 SVG(자리 표시), 절대배치(float) 개체,
// 변환하지 못한 LaTeX 명령(원문 그대로 남김).

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const FONT = '맑은 고딕';
const TWIPS_PER_MM = 1440 / 25.4;

// ── XML 유틸 ────────────────────────────────────────────────────────────────
function xmlEsc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
const twips = (mm) => Math.round(mm * TWIPS_PER_MM);
const hex = (c) => String(c || '').replace('#', '').toUpperCase();

// ── 런(글자 묶음) ──────────────────────────────────────────────────────────
/** @typedef {{text:string, b?:boolean, i?:boolean, u?:boolean, sup?:boolean, sub?:boolean, color?:string, size?:number}} Run */

function runXml(r) {
  if (r.br) return '<w:r><w:br/></w:r>';
  const props = [];
  props.push(`<w:rFonts w:ascii="${FONT}" w:eastAsia="${FONT}" w:hAnsi="${FONT}"/>`);
  if (r.b) props.push('<w:b/>');
  if (r.i) props.push('<w:i/>');
  if (r.u) props.push('<w:u w:val="single"/>');
  if (r.color) props.push(`<w:color w:val="${hex(r.color)}"/>`);
  if (r.size) props.push(`<w:sz w:val="${r.size}"/><w:szCs w:val="${r.size}"/>`);
  if (r.sup) props.push('<w:vertAlign w:val="superscript"/>');
  if (r.sub) props.push('<w:vertAlign w:val="subscript"/>');
  if (r.shade) props.push(`<w:shd w:val="clear" w:color="auto" w:fill="${hex(r.shade)}"/>`);
  return `<w:r><w:rPr>${props.join('')}</w:rPr><w:t xml:space="preserve">${xmlEsc(r.text)}</w:t></w:r>`;
}

/**
 * 문단. opts: align(left|center|right), before/after(twips), line(줄간격 240=1줄), border({color,sz}),
 * shade(hex), indent(twips), keepNext, pageBreakBefore
 */
function pXml(runs, opts = {}) {
  const pr = [];
  if (opts.keepNext) pr.push('<w:keepNext/>');
  if (opts.pageBreakBefore) pr.push('<w:pageBreakBefore/>');
  if (opts.border) {
    const { color = 'AAAAAA', sz = 4, sides = ['bottom'] } = opts.border;
    pr.push('<w:pBdr>' + sides.map((s) => `<w:${s} w:val="single" w:sz="${sz}" w:space="1" w:color="${hex(color)}"/>`).join('') + '</w:pBdr>');
  }
  if (opts.shade) pr.push(`<w:shd w:val="clear" w:color="auto" w:fill="${hex(opts.shade)}"/>`);
  const spacing = [];
  if (opts.before != null) spacing.push(`w:before="${opts.before}"`);
  if (opts.after != null) spacing.push(`w:after="${opts.after}"`);
  if (opts.line != null) spacing.push(`w:line="${opts.line}" w:lineRule="auto"`);
  if (spacing.length) pr.push(`<w:spacing ${spacing.join(' ')}/>`);
  if (opts.indent) pr.push(`<w:ind w:left="${opts.indent}"/>`);
  if (opts.align) pr.push(`<w:jc w:val="${opts.align}"/>`);
  const body = (runs || []).map(runXml).join('');
  return `<w:p>${pr.length ? `<w:pPr>${pr.join('')}</w:pPr>` : ''}${body}</w:p>`;
}

/** 표. rows: Array<Array<{content:string(XML 블록들), shade?:hex, width?:twips, span?:number}>> */
function tblXml(rows, opts = {}) {
  const { widths = null, borders = true, borderColor = 'CBD5C0', cellMargin = 100, indent = 0 } = opts;
  const bdr = borders
    ? ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((s) => `<w:${s} w:val="single" w:sz="6" w:space="0" w:color="${hex(borderColor)}"/>`).join('')
    : ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((s) => `<w:${s} w:val="nil"/>`).join('');
  const grid = widths ? `<w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>` : '';
  const trs = rows.map((cells) => {
    const tcs = cells.map((c) => {
      const pr = [];
      if (c.width) pr.push(`<w:tcW w:w="${c.width}" w:type="dxa"/>`);
      if (c.span && c.span > 1) pr.push(`<w:gridSpan w:val="${c.span}"/>`);
      if (c.shade) pr.push(`<w:shd w:val="clear" w:color="auto" w:fill="${hex(c.shade)}"/>`);
      if (c.vAlign) pr.push(`<w:vAlign w:val="${c.vAlign}"/>`);
      // 셀은 반드시 문단으로 끝나야 한다(중첩 표 뒤에 빈 문단을 붙인다).
      const content = c.content && c.content.trim() ? c.content : '<w:p/>';
      const ending = content.endsWith('</w:tbl>') ? content + '<w:p/>' : content;
      return `<w:tc><w:tcPr>${pr.join('')}</w:tcPr>${ending}</w:tc>`;
    }).join('');
    const trPr = cells.some((c) => c.minHeight) ? `<w:trPr><w:trHeight w:val="${Math.max(...cells.map((c) => c.minHeight || 0))}"/></w:trPr>` : '';
    return `<w:tr>${trPr}${tcs}</w:tr>`;
  }).join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>${indent ? `<w:tblInd w:w="${indent}" w:type="dxa"/>` : ''}`
    + `<w:tblBorders>${bdr}</w:tblBorders><w:tblLayout w:type="fixed"/>`
    + `<w:tblCellMar><w:top w:w="${cellMargin}" w:type="dxa"/><w:left w:w="${cellMargin + 40}" w:type="dxa"/><w:bottom w:w="${cellMargin}" w:type="dxa"/><w:right w:w="${cellMargin + 40}" w:type="dxa"/></w:tblCellMar>`
    + `<w:tblLook w:val="0000"/></w:tblPr>${grid}${trs}</w:tbl>`;
}

// ── LaTeX → 읽을 수 있는 평문 런(근사) ──────────────────────────────────────
// 워드의 OMML 로 완전 변환하는 대신, 중·고교 수식의 대부분(첨자·분수·근호·기호)을 사람이 읽고
// 고칠 수 있는 형태로 옮긴다. 모르는 명령은 원문을 남기고 count 로 보고한다.
const SYMBOLS = {
  pm: '±', mp: '∓', times: '×', cdot: '·', div: '÷', le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠',
  lt: '<', gt: '>', iff: '⟺', Leftrightarrow: '⟺', Rightarrow: '⇒', rightarrow: '→', to: '→', leftarrow: '←',
  infty: '∞', pi: 'π', alpha: 'α', beta: 'β', gamma: 'γ', theta: 'θ', lambda: 'λ', mu: 'μ', sigma: 'σ', omega: 'ω',
  Delta: 'Δ', angle: '∠', triangle: '△', circ: '°', degree: '°', ldots: '…', cdots: '⋯', dots: '…', approx: '≈',
  equiv: '≡', in: '∈', notin: '∉', subset: '⊂', cup: '∪', cap: '∩', emptyset: '∅', varnothing: '∅', perp: '⊥',
  parallel: '∥', propto: '∝', therefore: '∴', because: '∵', prime: '′', overline: '‾', bar: '‾',
  sum: 'Σ', prod: 'Π', int: '∫', partial: '∂', nabla: '∇', forall: '∀', exists: '∃', neg: '¬', land: '∧', lor: '∨',
  quad: '  ', qquad: '    ', ',': ' ', ';': ' ', ' ': ' ', '!': '', '{': '{', '}': '}', '%': '%', '&': '&', '#': '#', '_': '_', '\\': '\n',
  left: '', right: '', big: '', Big: '', bigl: '', bigr: '', displaystyle: '', textstyle: '', mathrm: '', mathbf: '', text: '', operatorname: '',
};

/**
 * @param {string} src `$` 없는 LaTeX 본문
 * @param {{unknown:number}} stats 변환 못한 명령 수 누적
 * @returns {Run[]}
 */
export function latexToRuns(src, stats = { unknown: 0 }, base = {}) {
  const runs = [];
  let i = 0;
  const s = String(src);
  const push = (text, extra) => { if (text) runs.push({ text, ...base, ...(extra || {}) }); };

  function readGroup() {
    // 현재 위치가 '{' 면 짝 맞는 '}' 까지, 아니면 한 토큰(명령 하나 또는 글자 하나).
    if (s[i] === '{') {
      let depth = 0; const start = i + 1;
      for (; i < s.length; i++) {
        if (s[i] === '{') depth++;
        else if (s[i] === '}') { depth--; if (depth === 0) { const g = s.slice(start, i); i++; return g; } }
      }
      return s.slice(start);
    }
    if (s[i] === '\\') {
      const m = /^\\[a-zA-Z]+/.exec(s.slice(i));
      if (m) { i += m[0].length; return m[0]; }
      const t = s.slice(i, i + 2); i += 2; return t;
    }
    const ch = s[i]; i++; return ch;
  }

  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\') {
      const m = /^\\([a-zA-Z]+|.)/.exec(s.slice(i));
      const name = m ? m[1] : '';
      i += m ? m[0].length : 1;
      if (name === 'frac' || name === 'dfrac' || name === 'tfrac') {
        const a = readGroup(); const b = readGroup();
        const ar = latexToRuns(a, stats, base); const br = latexToRuns(b, stats, base);
        const wrap = (r, raw) => (raw.trim().length > 1 ? [{ text: '(', ...base }, ...r, { text: ')', ...base }] : r);
        runs.push(...wrap(ar, a), { text: '/', ...base }, ...wrap(br, b));
      } else if (name === 'sqrt') {
        let idx = null;
        if (s[i] === '[') { const end = s.indexOf(']', i); idx = s.slice(i + 1, end); i = end + 1; }
        const g = readGroup();
        if (idx) push(idx, { sup: true });
        push('√(');
        runs.push(...latexToRuns(g, stats, base));
        push(')');
      } else if (name === 'text' || name === 'mathrm' || name === 'mathbf' || name === 'operatorname' || name === 'textbf') {
        push(readGroup(), name === 'mathbf' || name === 'textbf' ? { b: true } : {});
      } else if (name === 'overline' || name === 'bar' || name === 'vec' || name === 'hat') {
        const g = readGroup(); runs.push(...latexToRuns(g, stats, base)); push(name === 'vec' ? '⃗' : '‾');
      } else if (Object.prototype.hasOwnProperty.call(SYMBOLS, name)) {
        push(SYMBOLS[name]);
      } else {
        stats.unknown++;
        // 모르는 명령은 인자 중괄호까지 원문 그대로 남긴다 — 교사가 보고 고칠 수 있게.
        push('\\' + name);
        while (s[i] === '{') { const g = readGroup(); push('{' + g + '}'); }
      }
    } else if (ch === '^' || ch === '_') {
      i++;
      const g = readGroup();
      const sub = latexToRuns(g, stats, {});
      const flag = ch === '^' ? { sup: true } : { sub: true };
      for (const r of sub) runs.push({ ...r, ...base, ...flag });
    } else if (ch === '{' || ch === '}') {
      i++;
    } else if (ch === '~') {
      i++; push(' ');
    } else {
      // 연속 평문을 한 런으로
      let j = i;
      while (j < s.length && !'\\^_{}~'.includes(s[j])) j++;
      push(s.slice(i, j));
      i = j;
    }
  }
  return runs;
}

// ── 살균 HTML → 문단(런 배열) 목록 ─────────────────────────────────────────
const ENTITIES = { nbsp: ' ', lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", '#39': "'" };
function decodeEntities(s) {
  return s.replace(/&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+|#39);/g, (m, e) => {
    if (e[0] === '#') return e[1] === 'x' ? String.fromCodePoint(parseInt(e.slice(2), 16)) : String.fromCodePoint(parseInt(e.slice(1), 10));
    return Object.prototype.hasOwnProperty.call(ENTITIES, e) ? ENTITIES[e] : m;
  });
}

/**
 * 인라인 HTML(b/strong/i/em/u/sup/sub/br, `$…$` 수식)을 런 배열로. 다른 태그는 벗긴다.
 * @returns {Run[]}
 */
export function inlineHtmlToRuns(html, stats, base = {}) {
  const runs = [];
  const stack = [{ ...base }];
  const cur = () => stack[stack.length - 1];
  const text = (t) => {
    if (!t) return;
    // `$…$` 수식 분리
    const parts = String(t).split(/(\$[^$\n]{1,300}?\$)/);
    for (const part of parts) {
      if (!part) continue;
      if (part.length > 2 && part[0] === '$' && part[part.length - 1] === '$') {
        runs.push(...latexToRuns(part.slice(1, -1), stats, cur()));
      } else {
        runs.push({ ...cur(), text: decodeEntities(part) });
      }
    }
  };
  const re = /<\/?([a-zA-Z][a-zA-Z0-9]*)[^>]*>/g;
  let last = 0; let m;
  while ((m = re.exec(html)) !== null) {
    text(html.slice(last, m.index));
    last = re.lastIndex;
    const tag = m[1].toLowerCase();
    const closing = m[0][1] === '/';
    if (tag === 'br') { runs.push({ br: true }); continue; }
    const flag = { b: 'b', strong: 'b', i: 'i', em: 'i', u: 'u', sup: 'sup', sub: 'sub', mark: 'u' }[tag];
    if (!flag) continue;
    if (closing) { if (stack.length > 1) stack.pop(); }
    else stack.push({ ...cur(), [flag]: true });
  }
  text(html.slice(last));
  return runs;
}

/** 블록 HTML(p/ul/ol/li/div/h3/h4/table 등)을 문단 단위로 쪼갠다. 표는 행을 문단으로 펼친다. */
export function blockHtmlToParagraphs(html, stats) {
  const out = [];
  // 블록 경계에서 나눈다 — 태그는 남겨 인라인 처리기에 넘긴다.
  const chunks = String(html)
    .replace(/<\s*(p|div|li|h[1-6]|tr|dt|dd|blockquote|pre)\b[^>]*>/gi, ' $&')
    .replace(/<\/\s*(p|div|li|h[1-6]|tr|dt|dd|blockquote|pre|ul|ol|table|thead|tbody)\s*>/gi, '$& ')
    .split(' ');
  for (const raw of chunks) {
    const isLi = /^<\s*li\b/i.test(raw);
    const isCell = /<\s*t[dh]\b/i.test(raw);
    let body = raw;
    if (isCell) body = raw.replace(/<\/\s*t[dh]\s*>\s*<\s*t[dh]\b[^>]*>/gi, ' | ');
    const runs = inlineHtmlToRuns(body, stats);
    const plain = runs.map((r) => r.text || '').join('').trim();
    if (!plain) continue;
    if (isLi) runs.unshift({ text: '• ' });
    out.push(runs);
  }
  return out;
}

// ── 개체 → OOXML 블록 ───────────────────────────────────────────────────────
const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];
const CALLOUT_LABELS = { tip: '도움말', warning: '주의', note: '참고', summary: '핵심 정리' };

function cellText(x) {
  if (x == null) return '';
  if (typeof x === 'string' || typeof x === 'number') return String(x);
  return typeof x.text === 'string' ? x.text : (typeof x.label === 'string' ? x.label : '');
}

export class ExportDocx {
  /**
   * @param {object} document 개체 트리(학생 벌이면 이미 정답이 제거된 트리)
   * @param {{mode?:'student'|'teacher', themeCss?:string, standards?:Array<{code,text}>}} opts
   * @returns {{bytes:Uint8Array, notes:string[]}}
   */
  execute(document, opts = {}) {
    if (!document || typeof document !== 'object') throw new TypeError('ExportDocx.execute 는 개체 트리 문서가 필요합니다.');
    const mode = opts.mode === 'teacher' ? 'teacher' : 'student';
    const theme = parseTheme(opts.themeCss || '');
    const stats = { unknown: 0, organizers: 0, floats: 0 };
    const ctx = { theme, mode, stats, section: 0, contentWidth: 0, standards: new Map((opts.standards || document.standards || []).map((s) => [String(s.code).replace(/^\[|\]$/g, ''), s.text])) };

    const paper = resolvePaper(document.paper ?? null);
    const dims = paperDims(paper);
    const margins = paperMargins(paper);
    ctx.contentWidth = twips(dims.w - margins.left - margins.right);

    const blocks = [];
    // 모드 표식 + 머리글 한 줄(워드 머리글 파트 대신 본문 첫 줄 — 편집용이라 충분하다)
    blocks.push(pXml([
      { text: mode === 'teacher' ? '교사용 (정답 포함)' : '학생용', b: true, color: theme.c, size: 18 },
      { text: document.runHead ? '    ' + document.runHead : '', color: '888888', size: 16 },
    ], { after: 60 }));

    const pages = Array.isArray(document.pages) ? document.pages : [];
    for (const page of pages) {
      for (const obj of (page.flow || [])) blocks.push(...renderObject(obj, ctx));
      if ((page.float || []).length) stats.floats += page.float.length;
    }

    const notes = [];
    if (stats.unknown) notes.push(`수식 명령 ${stats.unknown}개는 변환하지 못해 LaTeX 원문 그대로 남겼습니다.`);
    if (stats.organizers) notes.push(`그림형 조직자 ${stats.organizers}개는 워드에서 자리 표시로만 나옵니다.`);
    if (stats.floats) notes.push(`자유 배치(float) 개체 ${stats.floats}개는 편집용 문서에 넣지 않았습니다.`);

    const sectPr = `<w:sectPr><w:pgSz w:w="${twips(dims.w)}" w:h="${twips(dims.h)}"${paper.orientation === 'landscape' ? ' w:orient="landscape"' : ''}/>`
      + `<w:pgMar w:top="${twips(margins.top)}" w:right="${twips(margins.right)}" w:bottom="${twips(margins.bottom)}" w:left="${twips(margins.left)}" w:header="400" w:footer="400" w:gutter="0"/></w:sectPr>`;

    const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`
      + `<w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}"><w:body>${blocks.join('')}${sectPr}</w:body></w:document>`;

    const bytes = writeZip([
      { name: '[Content_Types].xml', data: CONTENT_TYPES },
      { name: '_rels/.rels', data: ROOT_RELS },
      { name: 'word/_rels/document.xml.rels', data: DOC_RELS },
      { name: 'word/document.xml', data: documentXml },
      { name: 'word/styles.xml', data: stylesXml(theme) },
      { name: 'docProps/core.xml', data: coreXml(document.docTitle || '활동지') },
    ]);
    return { bytes, notes };
  }
}

function parseTheme(css) {
  const pick = (name, fallback) => {
    const m = new RegExp(`--${name}:\\s*#([0-9a-fA-F]{6})`).exec(css);
    return m ? m[1].toUpperCase() : fallback;
  };
  return { c: pick('c', '1565C0'), c2: pick('c2', '1E88E5'), clite: pick('clite', 'E8F1FB'), cink: pick('cink', '0D47A1'), clabel: pick('clabel', 'BBDEFB') };
}

function renderObject(obj, ctx) {
  if (!obj || typeof obj !== 'object') return [];
  switch (obj.type) {
    case 'title': return renderTitle(obj, ctx);
    case 'richtext': return renderRichtext(obj, ctx);
    case 'std-box': return renderStdBox(obj, ctx);
    case 'callout': return renderCallout(obj, ctx);
    case 'question': return renderQuestion(obj, ctx);
    case 'table': return renderTable(obj, ctx);
    case 'answer-area': return renderAnswerArea(obj, ctx);
    case 'divider': return [pXml([], { border: { color: 'BBBBBB', sz: 6 }, before: 80, after: 120 })];
    case 'image-slot': return [boxTable(ctx, [pXml([{ text: '[그림 자리] ' + (obj.alt || obj.caption || ''), color: '888888', size: 18 }], { align: 'center', before: 200, after: 200 })], { border: 'BBBBBB' })];
    case 'passage-slot': return renderPassage(obj, ctx);
    case 'organizer': ctx.stats.organizers++; return [boxTable(ctx, [pXml([{ text: `[${organizerName(obj.kind)} 자리 — 인쇄판(PDF)에서 그림으로 나옵니다]`, color: '888888', size: 18 }], { align: 'center', before: 300, after: 300 })], { border: 'BBBBBB' })];
    case 'columns': return renderColumns(obj, ctx);
    case 'spacer': return [pXml([], { before: twips(Number(obj.heightMm) || 5) })];
    case 'page-break': return [pXml([], { pageBreakBefore: true })];
    case 'shape': return [];
    default: return [pXml([{ text: `[${obj.type}]`, color: '888888' }])];
  }
}

function organizerName(kind) {
  return { venn: '벤다이어그램', conceptmap: '개념 지도', fishbone: '피시본', flowchart: '순서 흐름도', hierarchy: '위계 트리', hexagon: '헥사곤' }[kind] || '조직자';
}

/** 1×1 표로 상자를 만든다(.qbox/.callout/.std-box 의 워드 대응 — 편집이 자연스럽다). */
function boxTable(ctx, contentBlocks, { shade, border = 'CBD5C0', header } = {}) {
  const rows = [];
  if (header) rows.push([{ content: header.content, shade: header.shade, width: ctx.contentWidth }]);
  rows.push([{ content: contentBlocks.join(''), shade, width: ctx.contentWidth }]);
  return tblXml(rows, { widths: [ctx.contentWidth], borderColor: border }) + pXml([], { after: 40 });
}

function renderTitle(obj, ctx) {
  const stats = ctx.stats;
  const inner = typeof obj.textHtml === 'string' && obj.textHtml ? inlineHtmlToRuns(obj.textHtml, stats) : [{ text: String(obj.text ?? '') }];
  if (obj.level === 2) {
    ctx.section += 1;
    return [pXml([{ text: `${ctx.section}. `, b: true, color: ctx.theme.c, size: 24 }, ...inner.map((r) => ({ ...r, b: true, size: 24 }))], { before: 240, after: 80, keepNext: true })];
  }
  const out = [];
  const meta = obj.meta || {};
  const metaRuns = [];
  if (meta.pill) metaRuns.push({ text: ` ${meta.pill} `, b: true, color: 'FFFFFF', size: 18, shade: ctx.theme.c });
  if (meta.page) metaRuns.push({ text: (metaRuns.length ? '    ' : '') + meta.page, color: '555555', size: 17 });
  if (metaRuns.length) out.push(pXml(metaRuns, { after: 60 }));
  out.push(tblXml([[{ content: pXml(inner.map((r) => ({ ...r, b: true, size: 40, color: ctx.theme.cink })), { align: 'center', before: 120, after: 120 }), shade: ctx.theme.clite, width: ctx.contentWidth }]], { widths: [ctx.contentWidth], borderColor: ctx.theme.c2 }));
  if (meta.source) out.push(pXml([{ text: meta.source, color: '666666', size: 17 }], { align: 'right', after: 60 }));
  out.push(pXml([], { after: 80 }));
  return out;
}

function renderRichtext(obj, ctx) {
  const html = String(obj.html || '');
  // 이름칸 관용구 — 표 2열로
  if (/class=['"]unit-line['"]/.test(html)) {
    const unit = (/<div class=['"]unit['"]>([\s\S]*?)<\/div>/.exec(html) || [])[1] || '';
    return [tblXml([[
      { content: pXml(inlineHtmlToRuns(unit, ctx.stats, { size: 19 })), width: Math.round(ctx.contentWidth * 0.6) },
      { content: pXml([{ text: '학년 ______  반 ______  이름 ____________', size: 19, color: '444444' }], { align: 'right' }), width: Math.round(ctx.contentWidth * 0.4) },
    ]], { widths: [Math.round(ctx.contentWidth * 0.6), Math.round(ctx.contentWidth * 0.4)], borders: false }), pXml([], { after: 40 })];
  }
  if (/class=['"]direct['"]/.test(html)) {
    const runs = inlineHtmlToRuns(html, ctx.stats, { b: true, size: 22 });
    return [pXml([{ text: '◐ ', color: ctx.theme.c, b: true, size: 22 }, ...runs], { before: 200, after: 120 })];
  }
  const paras = blockHtmlToParagraphs(html, ctx.stats);
  return paras.map((runs) => pXml(runs, { after: 60 }));
}

function renderStdBox(obj, ctx) {
  const heading = obj.heading || '학습 목표';
  const body = [];
  for (const o of (obj.objectives || [])) body.push(pXml([{ text: '• ' }, ...inlineHtmlToRuns(String(o), ctx.stats)], { after: 40 }));
  if (obj.showStandards && Array.isArray(obj.codes) && obj.codes.length) {
    for (const code of obj.codes) {
      const text = ctx.standards.get(String(code).replace(/^\[|\]$/g, ''));
      body.push(pXml([{ text: `${code} `, b: true, color: '666666', size: 17 }, { text: text || '', color: '666666', size: 17 }], { after: 30 }));
    }
  }
  if (!body.length) body.push(pXml([]));
  return [boxTable(ctx, body, { header: { content: pXml([{ text: '▣ ' + heading, b: true, color: ctx.theme.cink, size: 19 }]), shade: ctx.theme.clite } })];
}

function renderCallout(obj, ctx) {
  const label = obj.titleHtml ? inlineHtmlToRuns(obj.titleHtml, ctx.stats, { b: true, color: ctx.theme.cink, size: 19 })
    : [{ text: obj.title || CALLOUT_LABELS[obj.variant] || '참고', b: true, color: ctx.theme.cink, size: 19 }];
  const body = blockHtmlToParagraphs(String(obj.body || ''), ctx.stats).map((runs) => pXml(runs, { after: 50 }));
  if (!body.length) body.push(pXml([]));
  return [boxTable(ctx, body, { header: { content: pXml(label), shade: ctx.theme.clite }, border: ctx.theme.c2 })];
}

function answerLines(n, ctx) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(pXml([{ text: ' ' }], { border: { color: 'BBBBBB', sz: 4 }, line: 360, after: 60 }));
  return out;
}

function renderQuestion(obj, ctx) {
  const stats = ctx.stats;
  const qnum = obj.qnum != null ? [{ text: `${CIRCLED[Number(obj.qnum) - 1] || obj.qnum} `, b: true, color: ctx.theme.c, size: 22 }] : [];
  const prompt = typeof obj.promptHtml === 'string' && obj.promptHtml ? inlineHtmlToRuns(obj.promptHtml, stats, { b: true }) : [{ text: String(obj.prompt ?? ''), b: true }];
  const blocks = [pXml([...qnum, ...prompt], { after: 80 })];

  switch (obj.qtype) {
    case 'multiple-choice': {
      (obj.choices || []).forEach((c, i) => blocks.push(pXml([{ text: `${CIRCLED[i] || (i + 1) + '.'} ` }, ...inlineHtmlToRuns(cellText(c), stats)], { indent: 300, after: 30 })));
      break;
    }
    case 'true-false': {
      const stmts = obj.choices || [];
      if (!stmts.length) blocks.push(pXml([{ text: '☐ 참(O)      ☐ 거짓(X)' }], { indent: 300 }));
      else stmts.forEach((s, i) => blocks.push(pXml([{ text: `${CIRCLED[i] || (i + 1) + '.'} ` }, ...inlineHtmlToRuns(cellText(s), stats), { text: '   ( O / X )' }], { indent: 300, after: 30 })));
      break;
    }
    case 'matching': {
      const left = obj.left || []; const right = obj.right || [];
      const n = Math.max(left.length, right.length);
      const rows = [];
      for (let i = 0; i < n; i++) {
        rows.push([
          { content: pXml(inlineHtmlToRuns(cellText(left[i]), stats)), width: Math.round(ctx.contentWidth * 0.45) },
          { content: pXml([{ text: '•          •' }], { align: 'center' }), width: Math.round(ctx.contentWidth * 0.1) },
          { content: pXml(inlineHtmlToRuns(cellText(right[i]), stats)), width: Math.round(ctx.contentWidth * 0.45) },
        ]);
      }
      if (rows.length) blocks.push(tblXml(rows, { widths: [Math.round(ctx.contentWidth * 0.45), Math.round(ctx.contentWidth * 0.1), Math.round(ctx.contentWidth * 0.45)], borders: false }), pXml([]));
      break;
    }
    case 'ordering': {
      (obj.items || []).forEach((it) => blocks.push(pXml([{ text: '☐  ' }, ...inlineHtmlToRuns(cellText(it), stats)], { indent: 300, after: 30 })));
      break;
    }
    case 'fill-blank': {
      const bank = obj.choices || [];
      if (bank.length) blocks.push(pXml([{ text: '낱말 상자: ', b: true, size: 19 }, { text: bank.map(cellText).join('   '), size: 19 }], { indent: 300 }));
      break;
    }
    case 'short-answer':
      blocks.push(...answerLines(1, ctx));
      break;
    case 'essay':
    default: {
      if (obj.lines === 0) break;
      blocks.push(...answerLines(Math.max(1, Number(obj.lines) || 4), ctx));
    }
  }

  if (ctx.mode === 'teacher' && obj.answerKey) {
    const ak = obj.answerKey;
    const runs = typeof ak.html === 'string' ? inlineHtmlToRuns(ak.html, stats) : [{ text: String(ak.text ?? '') }];
    blocks.push(pXml([{ text: '정답  ', b: true, color: ctx.theme.cink, size: 19 }, ...runs.map((r) => ({ ...r, color: r.color || ctx.theme.cink, size: 19 }))], { shade: ctx.theme.clite, before: 80, after: 40 }));
  }
  return [boxTable(ctx, blocks, { border: 'CBD5C0' })];
}

function renderTable(obj, ctx) {
  const rows = Array.isArray(obj.rows) ? obj.rows : [];
  if (!rows.length) return [];
  const colCount = Math.max(...rows.map((r) => (Array.isArray(r) ? r.length : 0)));
  const first = Array.isArray(rows[0]) ? rows[0] : [];
  const hasW = first.some((c) => typeof c?.w === 'number');
  const widths = [];
  for (let c = 0; c < colCount; c++) {
    const w = hasW && typeof first[c]?.w === 'number' ? first[c].w : 100 / colCount;
    widths.push(Math.round(ctx.contentWidth * (w / 100)));
  }
  const out = [];
  if (obj.caption) out.push(pXml([{ text: String(obj.caption), color: '555555', size: 18 }], { align: 'center', after: 40 }));
  const trs = rows.map((row) => (Array.isArray(row) ? row : []).map((cell, c) => ({
    content: pXml(inlineHtmlToRuns(cellText(cell), ctx.stats, cell?.header ? { b: true, color: ctx.theme.cink } : {}), { align: cell?.align === 'center' || cell?.align === 'right' ? cell.align : undefined }),
    shade: cell?.header ? ctx.theme.clite : undefined,
    width: widths[c],
    minHeight: typeof cell?.h === 'number' ? twips(cell.h) : undefined,
  })));
  out.push(tblXml(trs, { widths }), pXml([], { after: 60 }));
  return out;
}

function renderAnswerArea(obj, ctx) {
  const out = [];
  if (obj.label) out.push(pXml([{ text: String(obj.label), b: true, size: 19 }], { after: 40 }));
  if (obj.style === 'box') out.push(boxTable(ctx, [pXml([], { before: 600, after: 600 })], { border: 'BBBBBB' }));
  else out.push(...answerLines(Math.max(1, Number(obj.lines) || 3), ctx));
  return out;
}

function renderPassage(obj, ctx) {
  const header = pXml([{ text: String(obj.slotLabel || '제시문'), b: true, color: ctx.theme.cink, size: 19 }, { text: obj.title ? '  ' + obj.title : '', b: true, size: 19 }]);
  const body = obj.bodyHtml ? blockHtmlToParagraphs(String(obj.bodyHtml), ctx.stats).map((r) => pXml(r, { after: 50 })) : [pXml([{ text: '(지문을 여기에 넣으세요)', color: '999999' }], { before: 200, after: 200 })];
  if (obj.source) body.push(pXml([{ text: '출처: ' + obj.source, color: '666666', size: 17 }], { align: 'right' }));
  return [boxTable(ctx, body, { header: { content: header, shade: ctx.theme.clite } })];
}

function renderColumns(obj, ctx) {
  const cols = Array.isArray(obj.children) ? obj.children : [];
  if (!cols.length) return [];
  const ratio = Array.isArray(obj.ratio) && obj.ratio.length === cols.length ? obj.ratio : cols.map(() => 1);
  const sum = ratio.reduce((a, b) => a + Number(b), 0);
  const widths = ratio.map((r) => Math.round(ctx.contentWidth * (Number(r) / sum)));
  const subCtx = { ...ctx };
  const cells = cols.map((col, i) => {
    subCtx.contentWidth = widths[i] - 120;
    const content = (Array.isArray(col) ? col : []).flatMap((child) => renderObject(child, subCtx)).join('');
    return { content, width: widths[i], vAlign: 'top' };
  });
  ctx.section = subCtx.section;
  return [tblXml([cells], { widths, borders: false, cellMargin: 40 }), pXml([], { after: 40 })];
}

// ── 패키지 파트 ─────────────────────────────────────────────────────────────
const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`;

const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

function stylesXml(theme) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W_NS}">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${FONT}" w:eastAsia="${FONT}" w:hAnsi="${FONT}" w:cs="${FONT}"/><w:sz w:val="21"/><w:szCs w:val="21"/><w:lang w:val="ko-KR" w:eastAsia="ko-KR"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="80" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:qFormat/><w:rPr><w:b/><w:sz w:val="40"/><w:color w:val="${theme.cink}"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:qFormat/><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>
<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblCellMar><w:left w:w="108" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
</w:styles>`;
}

function coreXml(title) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${xmlEsc(title)}</dc:title><dc:creator>worksheet-grab</dc:creator>
</cp:coreProperties>`;
}
