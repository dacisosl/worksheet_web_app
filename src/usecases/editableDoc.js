import { resolvePaper, paperDims, paperMargins } from './paper.js';

// editableDoc — 개체 트리를 **편집용 문서 모델**(문단·표·런)로 옮기는 단일 지점. 순수 함수.
//
// DOCX(OOXML)와 HWPX(OWPML)는 서로 다른 XML 이지만 "활동지를 어떤 문단·표로 옮기느냐"는 같아야
// 한다 — 상자는 표로, 답란은 밑줄 문단으로, 수식은 읽을 수 있는 평문 근사로. 그 결정을 형식마다
// 따로 쓰면 두 문서가 다른 활동지가 된다. 그래서 개체 → 모델 변환은 여기 한 번만 있고,
// ExportDocx / ExportHwpx 는 모델을 각자의 XML 로 직렬화만 한다.
//
// 단위는 **포인트(pt)** 하나로 통일한다(DOCX 는 twips=pt×20, HWPX 는 HWPUNIT=pt×100 으로 환산).
//
// 정답 제거는 여기서 하지 않는다: 호출부가 BuildVariants.stripAnswersFromDocument 로 만든 학생 벌
// 트리를 넘긴다(불변식은 한 곳에서만 지킨다).
//
// 모델:
//   Run        {text, b?, i?, u?, sup?, sub?, color?(hex6), size?(pt), shade?(hex6)} | {br:true}
//   Paragraph  {kind:'p', runs:Run[], align?, before?, after?(pt), line?(배수 1=한 줄), border?{color,widthPt,sides},
//               shade?(hex6), indent?(pt), keepNext?, pageBreakBefore?}
//   Table      {kind:'table', rows:Cell[][], widths:number[](pt), borders:boolean, borderColor, cellMargin(pt), indent?(pt)}
//   Cell       {blocks:Block[], width(pt), shade?, span?, vAlign?('top'|'center'), minHeight?(pt)}

const PT_PER_MM = 72 / 25.4;
export const ptFromMm = (mm) => mm * PT_PER_MM;
export const hex6 = (c) => String(c || '').replace('#', '').toUpperCase();

// ── LaTeX → 읽을 수 있는 평문 런(근사) ──────────────────────────────────────
// 완전한 수식 객체로 변환하는 대신, 중·고교 수식의 대부분(첨자·분수·근호·기호)을 사람이 읽고
// 고칠 수 있는 형태로 옮긴다. 모르는 명령은 원문을 남기고 count 로 보고한다.
const SYMBOLS = {
  pm: '±', mp: '∓', times: '×', cdot: '·', div: '÷', le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠',
  lt: '<', gt: '>', iff: '⟺', Leftrightarrow: '⟺', Rightarrow: '⇒', rightarrow: '→', to: '→', leftarrow: '←',
  infty: '∞', pi: 'π', alpha: 'α', beta: 'β', gamma: 'γ', theta: 'θ', lambda: 'λ', mu: 'μ', sigma: 'σ', omega: 'ω',
  Delta: 'Δ', Gamma: 'Γ', Theta: 'Θ', Lambda: 'Λ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω', Xi: 'Ξ',
  delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η', kappa: 'κ', nu: 'ν', xi: 'ξ', rho: 'ρ', tau: 'τ',
  upsilon: 'υ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', ohm: 'Ω', celsius: '℃',
  angle: '∠', triangle: '△', circ: '°', degree: '°', ldots: '…', cdots: '⋯', dots: '…', approx: '≈',
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
        // 안쪽도 다시 변환한다 — `\text{(단위: [\Omega])}` 처럼 글 안에 기호 명령이 섞여 오는 일이 흔하다(실측).
        const g = readGroup();
        runs.push(...latexToRuns(g, stats, name === 'mathbf' || name === 'textbf' ? { ...base, b: true } : base));
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
    .replace(/<\s*(p|div|li|h[1-6]|tr|dt|dd|blockquote|pre)\b[^>]*>/gi, '\u0000$&')
    .replace(/<\/\s*(p|div|li|h[1-6]|tr|dt|dd|blockquote|pre|ul|ol|table|thead|tbody)\s*>/gi, '$&\u0000')
    .split('\u0000'); // 본문에 나올 수 없는 구분자 — 공백으로 자르면 낱말이 문단으로 쪼개진다
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

// ── 모델 생성자 ─────────────────────────────────────────────────────────────
/** 문단. 단위 pt: before/after/indent, line 은 배수(1=한 줄), border.widthPt. */
export function P(runs, opts = {}) {
  return { kind: 'p', runs: runs || [], ...opts };
}
/** 표. rows: Cell[][], widths(pt). borders: true(전부) | false(없음) | 'lines'(칸 아래 가로선만 — 답란). */
export function T(rows, opts = {}) {
  const { widths = null, borders = true, borderColor = 'CBD5C0', cellMargin = 5, indent = 0 } = opts;
  return { kind: 'table', rows, widths, borders, borderColor, cellMargin, indent };
}

/** 표 셀 내용은 반드시 블록으로 끝나야 한다 — 비면 빈 문단 하나. */
export function ensureBlocks(blocks) {
  return blocks && blocks.length ? blocks : [P([])];
}

// ── 개체 → 모델 ───────────────────────────────────────────────────────────
const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];
const CALLOUT_LABELS = { tip: '도움말', warning: '주의', note: '참고', summary: '핵심 정리' };

function cellText(x) {
  if (x == null) return '';
  if (typeof x === 'string' || typeof x === 'number') return String(x);
  return typeof x.text === 'string' ? x.text : (typeof x.label === 'string' ? x.label : '');
}

/** 테마 CSS(--c, --c2, --clite, --cink, --clabel)에서 교과색을 읽는다. 없으면 파란 계열 기본값. */
export function parseTheme(css) {
  const pick = (name, fallback) => {
    const m = new RegExp(`--${name}:\\s*#([0-9a-fA-F]{6})`).exec(css || '');
    return m ? m[1].toUpperCase() : fallback;
  };
  return { c: pick('c', '1565C0'), c2: pick('c2', '1E88E5'), clite: pick('clite', 'E8F1FB'), cink: pick('cink', '0D47A1'), clabel: pick('clabel', 'BBDEFB') };
}

/**
 * @param {object} document 개체 트리(학생 벌이면 이미 정답이 제거된 트리)
 * @param {{mode?:'student'|'teacher', themeCss?:string, standards?:Array<{code,text}>}} opts
 * @returns {{blocks:Block[], notes:string[], theme:object, mode:string, title:string,
 *   page:{widthPt:number, heightPt:number, landscape:boolean, margins:{top,right,bottom,left}(pt), contentWidthPt:number}}}
 */
export function buildEditableDoc(document, opts = {}) {
  if (!document || typeof document !== 'object') throw new TypeError('buildEditableDoc 은 개체 트리 문서가 필요합니다.');
  const mode = opts.mode === 'teacher' ? 'teacher' : 'student';
  const theme = parseTheme(opts.themeCss || '');
  const stats = { unknown: 0, organizers: 0, floats: 0 };

  // paper 미지정은 A4 세로 기본과 같다(resolvePaper(null) 은 "주입 0" 을 뜻하는 null 을 준다).
  const paper = resolvePaper(document.paper ?? null) || resolvePaper({});
  const dims = paperDims(paper);
  const margins = paperMargins(paper);
  const page = {
    widthPt: ptFromMm(dims.w), heightPt: ptFromMm(dims.h), landscape: paper.orientation === 'landscape',
    margins: { top: ptFromMm(margins.top), right: ptFromMm(margins.right), bottom: ptFromMm(margins.bottom), left: ptFromMm(margins.left) },
    contentWidthPt: ptFromMm(dims.w - margins.left - margins.right),
  };

  const ctx = {
    theme, mode, stats, section: 0, contentWidth: page.contentWidthPt,
    standards: new Map((opts.standards || document.standards || []).map((s) => [String(s.code).replace(/^\[|\]$/g, ''), s.text])),
  };

  const blocks = [];
  // 모드 표식 + 머리글 한 줄(머리글 파트 대신 본문 첫 줄 — 편집용이라 충분하다)
  blocks.push(P([
    { text: mode === 'teacher' ? '교사용 (정답 포함)' : '학생용', b: true, color: theme.c, size: 9 },
    { text: document.runHead ? '    ' + document.runHead : '', color: '888888', size: 8 },
  ], { after: 3 }));

  const pages = Array.isArray(document.pages) ? document.pages : [];
  for (const pg of pages) {
    for (const obj of (pg.flow || [])) blocks.push(...renderObject(obj, ctx));
    if ((pg.float || []).length) stats.floats += pg.float.length;
  }

  const notes = [];
  if (stats.unknown) notes.push(`수식 명령 ${stats.unknown}개는 변환하지 못해 LaTeX 원문 그대로 남겼습니다.`);
  if (stats.organizers) notes.push(`그림형 조직자 ${stats.organizers}개는 편집용 문서에서 자리 표시로만 나옵니다.`);
  if (stats.floats) notes.push(`자유 배치(float) 개체 ${stats.floats}개는 편집용 문서에 넣지 않았습니다.`);

  return { blocks, notes, theme, mode, page, title: String(document.docTitle || '활동지') };
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
    case 'divider': return [P([], { border: { color: 'BBBBBB', widthPt: 0.75 }, before: 4, after: 6 })];
    case 'image-slot': return [...boxTable(ctx, [P([{ text: '[그림 자리] ' + (obj.alt || obj.caption || ''), color: '888888', size: 9 }], { align: 'center', before: 10, after: 10 })], { border: 'BBBBBB' })];
    case 'passage-slot': return renderPassage(obj, ctx);
    case 'organizer': ctx.stats.organizers++; return [...boxTable(ctx, [P([{ text: `[${organizerName(obj.kind)} 자리 — 인쇄판(PDF)에서 그림으로 나옵니다]`, color: '888888', size: 9 }], { align: 'center', before: 15, after: 15 })], { border: 'BBBBBB' })];
    case 'columns': return renderColumns(obj, ctx);
    case 'spacer': return [P([], { before: ptFromMm(Number(obj.heightMm) || 5) })];
    case 'page-break': return [P([], { pageBreakBefore: true })];
    case 'shape': return [];
    default: return [P([{ text: `[${obj.type}]`, color: '888888' }])];
  }
}

function organizerName(kind) {
  return { venn: '벤다이어그램', conceptmap: '개념 지도', fishbone: '피시본', flowchart: '순서 흐름도', hierarchy: '위계 트리', hexagon: '헥사곤' }[kind] || '조직자';
}

/** 1×1 표로 상자를 만든다(.qbox/.callout/.std-box 의 대응 — 편집이 자연스럽다). 뒤에 여백 문단 하나. */
function boxTable(ctx, contentBlocks, { shade, border = 'CBD5C0', header } = {}) {
  const rows = [];
  if (header) rows.push([{ blocks: ensureBlocks(header.blocks), shade: header.shade, width: ctx.contentWidth }]);
  rows.push([{ blocks: ensureBlocks(contentBlocks), shade, width: ctx.contentWidth }]);
  return [T(rows, { widths: [ctx.contentWidth], borderColor: border }), P([], { after: 2 })];
}

function renderTitle(obj, ctx) {
  const stats = ctx.stats;
  const inner = typeof obj.textHtml === 'string' && obj.textHtml ? inlineHtmlToRuns(obj.textHtml, stats) : [{ text: String(obj.text ?? '') }];
  if (obj.level === 2) {
    ctx.section += 1;
    return [P([{ text: `${ctx.section}. `, b: true, color: ctx.theme.c, size: 12 }, ...inner.map((r) => ({ ...r, b: true, size: 12 }))], { before: 12, after: 4, keepNext: true })];
  }
  const out = [];
  const meta = obj.meta || {};
  const metaRuns = [];
  if (meta.pill) metaRuns.push({ text: ` ${meta.pill} `, b: true, color: 'FFFFFF', size: 9, shade: ctx.theme.c });
  if (meta.page) metaRuns.push({ text: (metaRuns.length ? '    ' : '') + meta.page, color: '555555', size: 8.5 });
  if (metaRuns.length) out.push(P(metaRuns, { after: 3 }));
  out.push(T([[{ blocks: [P(inner.map((r) => ({ ...r, b: true, size: 20, color: ctx.theme.cink })), { align: 'center', before: 6, after: 6 })], shade: ctx.theme.clite, width: ctx.contentWidth }]], { widths: [ctx.contentWidth], borderColor: ctx.theme.c2 }));
  if (meta.source) out.push(P([{ text: meta.source, color: '666666', size: 8.5 }], { align: 'right', after: 3 }));
  out.push(P([], { after: 4 }));
  return out;
}

function renderRichtext(obj, ctx) {
  const html = String(obj.html || '');
  // 이름칸 관용구 — 표 2열로
  if (/class=['"]unit-line['"]/.test(html)) {
    const unit = (/<div class=['"]unit['"]>([\s\S]*?)<\/div>/.exec(html) || [])[1] || '';
    const w1 = Math.round(ctx.contentWidth * 0.6 * 20) / 20; // twips 정수와 같은 눈금
    const w2 = Math.round(ctx.contentWidth * 0.4 * 20) / 20;
    return [T([[
      { blocks: [P(inlineHtmlToRuns(unit, ctx.stats, { size: 9.5 }))], width: w1 },
      { blocks: [P([{ text: '학년 ______  반 ______  이름 ____________', size: 9.5, color: '444444' }], { align: 'right' })], width: w2 },
    ]], { widths: [w1, w2], borders: false }), P([], { after: 2 })];
  }
  if (/class=['"]direct['"]/.test(html)) {
    const runs = inlineHtmlToRuns(html, ctx.stats, { b: true, size: 11 });
    return [P([{ text: '◐ ', color: ctx.theme.c, b: true, size: 11 }, ...runs], { before: 10, after: 6 })];
  }
  const paras = blockHtmlToParagraphs(html, ctx.stats);
  return paras.map((runs) => P(runs, { after: 3 }));
}

function renderStdBox(obj, ctx) {
  const heading = obj.heading || '학습 목표';
  const body = [];
  for (const o of (obj.objectives || [])) body.push(P([{ text: '• ' }, ...inlineHtmlToRuns(String(o), ctx.stats)], { after: 2 }));
  if (obj.showStandards && Array.isArray(obj.codes) && obj.codes.length) {
    for (const code of obj.codes) {
      const text = ctx.standards.get(String(code).replace(/^\[|\]$/g, ''));
      body.push(P([{ text: `${code} `, b: true, color: '666666', size: 8.5 }, { text: text || '', color: '666666', size: 8.5 }], { after: 1.5 }));
    }
  }
  return boxTable(ctx, body, { header: { blocks: [P([{ text: '▣ ' + heading, b: true, color: ctx.theme.cink, size: 9.5 }])], shade: ctx.theme.clite } });
}

function renderCallout(obj, ctx) {
  const label = obj.titleHtml ? inlineHtmlToRuns(obj.titleHtml, ctx.stats, { b: true, color: ctx.theme.cink, size: 9.5 })
    : [{ text: obj.title || CALLOUT_LABELS[obj.variant] || '참고', b: true, color: ctx.theme.cink, size: 9.5 }];
  const body = blockHtmlToParagraphs(String(obj.body || ''), ctx.stats).map((runs) => P(runs, { after: 2.5 }));
  return boxTable(ctx, body, { header: { blocks: [P(label)], shade: ctx.theme.clite }, border: ctx.theme.c2 });
}

/** 답란 — 가로선만 있는 1열 표(줄 하나 = 칸 하나, 9mm). 한글·워드 학습지의 관용 답란이라 칸에 바로 써넣을 수
 *  있고, 줄을 늘리거나 줄이는 것도 표 행 추가·삭제로 자연스럽다(문단 테두리 밑줄은 글을 치면 선이 밀려 어색했다). */
export const ANSWER_LINE_MM = 9;
function answerLines(n, ctx) {
  const rows = [];
  for (let i = 0; i < n; i++) rows.push([{ blocks: [P([])], width: ctx.contentWidth, minHeight: ptFromMm(ANSWER_LINE_MM) }]);
  return [T(rows, { widths: [ctx.contentWidth], borders: 'lines', borderColor: 'BBBBBB', cellMargin: 2 })];
}

function renderQuestion(obj, ctx) {
  const stats = ctx.stats;
  const qnum = obj.qnum != null ? [{ text: `${CIRCLED[Number(obj.qnum) - 1] || obj.qnum} `, b: true, color: ctx.theme.c, size: 11 }] : [];
  // 평문 필드(prompt·answerKey.text)도 인라인 처리기를 거친다 — `$…$` 수식이 평문에도 흔히 들어온다(실측).
  const prompt = inlineHtmlToRuns(typeof obj.promptHtml === 'string' && obj.promptHtml ? obj.promptHtml : String(obj.prompt ?? ''), stats, { b: true });
  // 문항은 상자(표)로 감싸지 않는다 — 한글·워드에서 문항을 지우고 붙이고 번호를 고치는 일이 표 안에서는
  // 번거롭다(실측 피드백). 인쇄판의 상자는 PDF 쪽 일이고, 편집용은 "번호 문단 + 선택지 + 답란 표"가 자연스럽다.
  const blocks = [P([...qnum, ...prompt], { before: 4, after: 4, keepNext: true })];

  switch (obj.qtype) {
    case 'multiple-choice': {
      (obj.choices || []).forEach((c, i) => blocks.push(P([{ text: `${CIRCLED[i] || (i + 1) + '.'} ` }, ...inlineHtmlToRuns(cellText(c), stats)], { indent: 15, after: 1.5 })));
      break;
    }
    case 'true-false': {
      const stmts = obj.choices || [];
      if (!stmts.length) blocks.push(P([{ text: '☐ 참(O)      ☐ 거짓(X)' }], { indent: 15 }));
      else stmts.forEach((s, i) => blocks.push(P([{ text: `${CIRCLED[i] || (i + 1) + '.'} ` }, ...inlineHtmlToRuns(cellText(s), stats), { text: '   ( O / X )' }], { indent: 15, after: 1.5 })));
      break;
    }
    case 'matching': {
      const left = obj.left || []; const right = obj.right || [];
      const n = Math.max(left.length, right.length);
      const wSide = Math.round(ctx.contentWidth * 0.45 * 20) / 20;
      const wMid = Math.round(ctx.contentWidth * 0.1 * 20) / 20;
      const rows = [];
      for (let i = 0; i < n; i++) {
        rows.push([
          { blocks: [P(inlineHtmlToRuns(cellText(left[i]), stats))], width: wSide },
          { blocks: [P([{ text: '•          •' }], { align: 'center' })], width: wMid },
          { blocks: [P(inlineHtmlToRuns(cellText(right[i]), stats))], width: wSide },
        ]);
      }
      if (rows.length) blocks.push(T(rows, { widths: [wSide, wMid, wSide], borders: false }), P([]));
      break;
    }
    case 'ordering': {
      (obj.items || []).forEach((it) => blocks.push(P([{ text: '☐  ' }, ...inlineHtmlToRuns(cellText(it), stats)], { indent: 15, after: 1.5 })));
      break;
    }
    case 'fill-blank': {
      const bank = obj.choices || [];
      if (bank.length) blocks.push(P([{ text: '낱말 상자: ', b: true, size: 9.5 }, { text: bank.map(cellText).join('   '), size: 9.5 }], { indent: 15 }));
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
    const runs = inlineHtmlToRuns(typeof ak.html === 'string' ? ak.html : String(ak.text ?? ''), stats);
    blocks.push(P([{ text: '정답  ', b: true, color: ctx.theme.cink, size: 9.5 }, ...runs.map((r) => ({ ...r, color: r.color || ctx.theme.cink, size: 9.5 }))], { shade: ctx.theme.clite, before: 4, after: 2 }));
  }
  blocks.push(P([], { after: 6 })); // 문항 사이 숨 고르기
  return blocks;
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
    widths.push(Math.round(ctx.contentWidth * (w / 100) * 20) / 20);
  }
  const out = [];
  if (obj.caption) out.push(P([{ text: String(obj.caption), color: '555555', size: 9 }], { align: 'center', after: 2 }));
  const trs = rows.map((row) => (Array.isArray(row) ? row : []).map((cell, c) => ({
    blocks: [P(inlineHtmlToRuns(cellText(cell), ctx.stats, cell?.header ? { b: true, color: ctx.theme.cink } : {}), { align: cell?.align === 'center' || cell?.align === 'right' ? cell.align : undefined })],
    shade: cell?.header ? ctx.theme.clite : undefined,
    width: widths[c],
    minHeight: typeof cell?.h === 'number' ? ptFromMm(cell.h) : undefined,
  })));
  out.push(T(trs, { widths }), P([], { after: 3 }));
  return out;
}

function renderAnswerArea(obj, ctx) {
  const out = [];
  if (obj.label) out.push(P([{ text: String(obj.label), b: true, size: 9.5 }], { after: 2 }));
  if (obj.style === 'box') out.push(...boxTable(ctx, [P([], { before: 30, after: 30 })], { border: 'BBBBBB' }));
  else out.push(...answerLines(Math.max(1, Number(obj.lines) || 3), ctx));
  return out;
}

function renderPassage(obj, ctx) {
  const header = P([{ text: String(obj.slotLabel || '제시문'), b: true, color: ctx.theme.cink, size: 9.5 }, { text: obj.title ? '  ' + obj.title : '', b: true, size: 9.5 }]);
  const body = obj.bodyHtml ? blockHtmlToParagraphs(String(obj.bodyHtml), ctx.stats).map((r) => P(r, { after: 2.5 })) : [P([{ text: '(지문을 여기에 넣으세요)', color: '999999' }], { before: 10, after: 10 })];
  if (obj.source) body.push(P([{ text: '출처: ' + obj.source, color: '666666', size: 8.5 }], { align: 'right' }));
  return boxTable(ctx, body, { header: { blocks: [header], shade: ctx.theme.clite } });
}

function renderColumns(obj, ctx) {
  const cols = Array.isArray(obj.children) ? obj.children : [];
  if (!cols.length) return [];
  const ratio = Array.isArray(obj.ratio) && obj.ratio.length === cols.length ? obj.ratio : cols.map(() => 1);
  const sum = ratio.reduce((a, b) => a + Number(b), 0);
  const widths = ratio.map((r) => Math.round(ctx.contentWidth * (Number(r) / sum) * 20) / 20);
  const subCtx = { ...ctx };
  const cells = cols.map((col, i) => {
    subCtx.contentWidth = widths[i] - 6;
    const blocks = (Array.isArray(col) ? col : []).flatMap((child) => renderObject(child, subCtx));
    return { blocks: ensureBlocks(blocks), width: widths[i], vAlign: 'top' };
  });
  ctx.section = subCtx.section;
  return [T([cells], { widths, borders: false, cellMargin: 2 }), P([], { after: 2 })];
}
