import { OBJECT_TYPES, QUESTION_TYPES, TYPE_SPECS } from '../domain/schema/ObjectCatalog.js';

// NormalizeAuthoredDoc — 챗봇(Gem/GPTs/Claude 프로젝트)이 저작한 활동지 JSON 을 개체 트리 스키마에
// 맞게 정돈한다. 순수 함수(FS/DOM/Chrome 무접촉).
//
// 왜 필요한가: 구독 챗봇은 CLI 를 실행하지 못해 compose 스캐폴드를 받지 못한다 — 스키마를 프롬프트로만
// 알고 저작하므로 (a) 엔진 소관 필드(id/placement/pagination)를 빠뜨리거나 지어내고, (b) 렌더가 읽는
// 정확한 모양(표 셀 {text}, answerKey {text})을 문자열로 낸다. 이 계층이 그 간극을 흡수한다.
//
// 원칙:
//  1) 조용히 고치지 않는다 — 손댄 것은 전부 notes 로 보고한다(호출부가 사용자에게 보인다).
//  2) 뜻을 지어내지 않는다 — 값을 새로 만들지 않고 **모양만** 맞춘다. 판단이 필요한 결함(알 수 없는
//     타입·필수 필드 누락 등)은 그대로 남겨 ValidateObjectTree 가 게이트로 잡게 한다.
//  3) 조판은 늘 다시 한다 — pagination 은 항상 'scaffold' 로 되돌린다(챗봇이 잰 쪽 경계는 근거가 없다).
//
// notes 는 평문이다(`백틱`으로 식별자를 감싼다). 표시 형식은 호출부(UI) 소관.

/** 챗봇이 흔히 쓰는 오타·유사 이름 → 카탈로그 타입. 소문자·구분기호 제거 후 비교한다. */
const TYPE_ALIASES = Object.freeze({
  heading: 'title', header: 'title',
  text: 'richtext', paragraph: 'richtext', html: 'richtext', body: 'richtext',
  image: 'image-slot', img: 'image-slot', figure: 'image-slot',
  passage: 'passage-slot', reading: 'passage-slot',
  answerarea: 'answer-area', answerspace: 'answer-area', answersheet: 'answer-area',
  std: 'std-box', stdbox: 'std-box', standard: 'std-box', standards: 'std-box', objectives: 'std-box',
  pagebreak: 'page-break', hr: 'divider', separator: 'divider', rule: 'divider',
  box: 'callout', tip: 'callout', warning: 'callout', summary: 'callout',
  graphicorganizer: 'organizer', diagram: 'organizer',
  row: 'columns', twocol: 'columns', twocolumns: 'columns', grid: 'columns', sidebyside: 'columns', cols: 'columns',
});

const ALWAYS_ALLOWED = ['id', 'type', 'placement', 'rect', 'opacity', 'angle'];

/**
 * @param {unknown} raw 챗봇이 낸 JSON(파싱된 값). 개체 배열·{flow}·{objects}·정식 문서 모두 받는다.
 * @returns {{document:object, notes:string[]}}
 * @throws {Error} 개체 목록을 찾을 수 없을 때(=고칠 대상이 없음)
 */
export function normalizeAuthoredDoc(raw) {
  const notes = [];
  let doc = raw;

  if (Array.isArray(doc)) {
    doc = { pages: [{ flow: doc }] };
    notes.push('최상위가 개체 배열이라 `pages[0].flow` 로 감쌌습니다.');
  }
  if (!doc || typeof doc !== 'object') {
    throw new Error('JSON 최상위가 객체가 아닙니다.');
  }
  if (!Array.isArray(doc.pages)) {
    if (Array.isArray(doc.flow)) {
      const { flow, float, ...rest } = doc;
      doc = { ...rest, pages: [{ flow, float: Array.isArray(float) ? float : [] }] };
      notes.push('최상위 `flow` 를 `pages[0].flow` 로 옮겼습니다.');
    } else if (Array.isArray(doc.objects)) {
      const { objects, ...rest } = doc;
      doc = { ...rest, pages: [{ flow: objects }] };
      notes.push('최상위 `objects` 를 `pages[0].flow` 로 옮겼습니다.');
    } else {
      throw new Error('`pages` 배열이 없습니다. 챗봇에게 "pages[].flow 형식으로 다시" 라고 요청하세요.');
    }
  }

  const ctx = { notes, counter: 0, seenIds: new Set() };
  const pages = doc.pages.map((page, pageIndex) => {
    const p = { ...(page && typeof page === 'object' ? page : {}) };
    if (typeof p.id !== 'string' || p.id.trim() === '' || ctx.seenIds.has(`page:${p.id}`)) {
      p.id = `page-${pageIndex + 1}`;
    }
    ctx.seenIds.add(`page:${p.id}`);
    p.flow = normalizeBucket(Array.isArray(p.flow) ? p.flow : [], 'flow', ctx);
    p.float = normalizeBucket(Array.isArray(p.float) ? p.float : [], 'float', ctx);
    return p;
  });

  // 조판 상태는 늘 되돌린다 — 쪽 경계는 실측 패스만이 정한다(D-A).
  return { document: { ...doc, pagination: 'scaffold', pages }, notes };
}

function normalizeBucket(list, bucket, ctx) {
  return list.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const obj = { ...item };

    normalizeType(obj, ctx);
    normalizeIdentity(obj, bucket, ctx);
    normalizeTable(obj, ctx);
    normalizeQuestion(obj, ctx);
    normalizeAnswerFlag(obj);
    normalizeMathInHtml(obj, ctx);
    normalizeColumns(obj, ctx);
    dropUnknownFields(obj, ctx);

    return obj;
  });
}

/** HTML 을 담는 필드 — 이 안의 `$…$` 수식에 든 `<`/`>` 는 브라우저가 태그로 읽어 수식과 뒤 문장을
 *  통째로 삼킨다(실측: `$d<r$ 서로 다른…$d>r$` 이 "$dr$" 로 무너졌다). */
const HTML_FIELDS = ['html', 'body', 'promptHtml', 'textHtml', 'titleHtml', 'bodyHtml'];

function normalizeMathInHtml(obj, ctx) {
  let touched = false;
  for (const field of HTML_FIELDS) {
    const v = obj[field];
    if (typeof v !== 'string' || v.indexOf('$') === -1) continue;
    const fixed = v.replace(/\$([^$\n]{1,200}?)\$/g, (m, inner) => {
      if (!/[<>]/.test(inner)) return m;
      touched = true;
      return '$' + inner.replace(/</g, '\\lt ').replace(/>/g, '\\gt ') + '$';
    });
    if (fixed !== v) obj[field] = fixed;
  }
  if (touched) ctx.notes.push(`\`${obj.id}\` 의 수식 안 \`<\`/\`>\` 를 \`\\lt\`/\`\\gt\` 로 바꿨습니다(HTML 태그로 읽히는 것을 막기 위해).`);
  normalizeMathText(obj, ctx);
}

// 수식 표기의 흔한 이탈 두 가지를 개체의 모든 글 필드(선택지·표 셀·정답 포함)에서 고친다.
//  1) `$$…$$` 표시 수식 → `$…$`. 렌더러의 KaTeX 는 인라인 `$…$` 만 등록되어 있어 `$$` 는 인쇄에도 원문이
//     그대로 나오고, 편집용 문서 변환기도 잡지 못했다(실측: "$I = V/R … [\Omega]$" 가 그대로 남음).
//  2) 수식 밖의 낱 기호 명령(`\Omega`, `\mu`, `\times` …) → 유니코드 글자. 모델이 "5 \Omega" 처럼 `$` 없이
//     쓰는 일이 흔한데, `$` 가 없으면 어디서도 변환되지 않아 인쇄물에 백슬래시가 찍힌다.
const BARE_SYMBOLS = {
  Omega: 'Ω', ohm: 'Ω', mu: 'μ', pi: 'π', theta: 'θ', alpha: 'α', beta: 'β', gamma: 'γ', lambda: 'λ', sigma: 'σ',
  omega: 'ω', Delta: 'Δ', rho: 'ρ', tau: 'τ', phi: 'φ', epsilon: 'ε', times: '×', div: '÷', pm: '±', cdot: '·',
  le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠', degree: '°', circ: '°', infty: '∞', rightarrow: '→', to: '→',
  approx: '≈', propto: '∝', angle: '∠', perp: '⊥', parallel: '∥', therefore: '∴', because: '∵', celsius: '℃',
};
const BARE_SYMBOL_RE = new RegExp('\\\\(' + Object.keys(BARE_SYMBOLS).join('|') + ')(?![A-Za-z])', 'g');
/** 값이 아니라 표식인 문자열 필드 — 여기의 `$`·백슬래시는 건드리지 않는다. */
const NON_TEXT_KEYS = new Set(['id', 'type', 'placement', 'qtype', 'variant', 'kind', 'style', 'align', 'themeName',
  'dataSubject', 'heading', 'slotLabel', 'codes', 'children', 'rect']);

function fixMathText(s, hits) {
  let out = s;
  if (out.indexOf('$$') !== -1) {
    const fixed = out.replace(/\$\$([^$]{1,400}?)\$\$/g, (m, inner) => '$' + inner.trim() + '$');
    if (fixed !== out) { hits.display++; out = fixed; }
  }
  if (out.indexOf('\\') !== -1) {
    // `$…$` 안은 그대로 두고(변환기가 처리한다) 밖만 바꾼다.
    const parts = out.split(/(\$[^$\n]{1,400}?\$)/);
    const fixed = parts.map((p, i) => (i % 2 === 1 ? p : p.replace(BARE_SYMBOL_RE, (m, name) => { hits.bare++; return BARE_SYMBOLS[name]; }))).join('');
    out = fixed;
  }
  return out;
}
function walkStrings(node, hits, depth = 0) {
  if (depth > 6 || node == null) return;
  if (Array.isArray(node)) {
    node.forEach((v, i) => {
      if (typeof v === 'string') node[i] = fixMathText(v, hits);
      else walkStrings(v, hits, depth + 1);
    });
    return;
  }
  if (typeof node !== 'object') return;
  for (const key of Object.keys(node)) {
    if (NON_TEXT_KEYS.has(key)) continue;
    const v = node[key];
    if (typeof v === 'string') node[key] = fixMathText(v, hits);
    else if (v && typeof v === 'object') walkStrings(v, hits, depth + 1);
  }
}
function normalizeMathText(obj, ctx) {
  const hits = { display: 0, bare: 0 };
  walkStrings(obj, hits);
  if (hits.display) ctx.notes.push(`\`${obj.id}\` 의 표시 수식 \`$$…$$\` ${hits.display}곳을 인라인 \`$…$\` 로 바꿨습니다(렌더러는 인라인만 지원).`);
  if (hits.bare) ctx.notes.push(`\`${obj.id}\` 의 수식 밖 기호 명령 ${hits.bare}개(\`\\Omega\` 등)를 유니코드 기호로 바꿨습니다.`);
}

/** columns 자식도 같은 정규화를 받는다(id·answerKey 모양·표 셀…). 챗봇이 `children:[q1,q2]` 처럼
 *  열 배열을 빼먹고 평평하게 내면 개체마다 한 열로 감싼다(뜻은 그대로 — "나란히"). */
function normalizeColumns(obj, ctx) {
  if (obj.type !== 'columns' || !Array.isArray(obj.children)) return;
  const cols = obj.children;
  const flat = cols.length > 0 && cols.every((c) => c && typeof c === 'object' && !Array.isArray(c));
  if (flat) {
    obj.children = cols.map((c) => [c]);
    ctx.notes.push(`\`${obj.id}\` 의 children 이 개체 목록이라 개체마다 한 열로 감쌌습니다(${cols.length}열).`);
  }
  obj.children = obj.children.map((col) => normalizeBucket(Array.isArray(col) ? col : [col], 'flow', ctx));
}

function normalizeType(obj, ctx) {
  if (typeof obj.type !== 'string' || OBJECT_TYPES.includes(obj.type)) return;
  const key = obj.type.toLowerCase().replace(/[\s_-]/g, '');
  const mapped = TYPE_ALIASES[key];
  if (!mapped) return; // 알 수 없는 타입은 남긴다 — 검증이 unknown-type 으로 막는다.
  ctx.notes.push(`개체 타입 \`${obj.type}\` → \`${mapped}\` 로 바꿨습니다.`);
  obj.type = mapped;
}

function normalizeIdentity(obj, bucket, ctx) {
  if (typeof obj.id !== 'string' || obj.id.trim() === '' || ctx.seenIds.has(obj.id)) {
    obj.id = `o${++ctx.counter}`;
  }
  ctx.seenIds.add(obj.id);

  if (obj.placement !== bucket) {
    if (obj.placement !== undefined) {
      ctx.notes.push(`\`${obj.id}\` 의 placement 를 \`${bucket}\` 로 맞췄습니다(담긴 버킷 기준).`);
    }
    obj.placement = bucket;
  }
  // flow 개체의 좌표는 애초에 허용되지 않는다(원칙 3) — 지어낸 값이므로 버린다.
  if (bucket === 'flow' && obj.rect !== undefined) {
    delete obj.rect;
    ctx.notes.push(`\`${obj.id}\` 의 좌표(rect)를 제거했습니다 — 본문 개체는 좌표를 갖지 않습니다.`);
  }
}

function normalizeTable(obj, ctx) {
  if (obj.type !== 'table') return;
  if (obj.splittable !== false) obj.splittable = false; // 표는 언제나 분할 불가(불변식)
  if (!Array.isArray(obj.rows)) return;

  let wrapped = false;
  obj.rows = obj.rows.map((row) => {
    if (!Array.isArray(row)) return row;
    return row.map((cell) => {
      // 렌더는 cell.text 만 읽는다 — 문자열 셀을 그대로 두면 빈 칸으로 인쇄된다.
      if (typeof cell === 'string' || typeof cell === 'number') {
        wrapped = true;
        return { text: String(cell) };
      }
      return cell;
    });
  });
  if (wrapped) ctx.notes.push(`\`${obj.id}\` 표의 문자열 셀을 \`{"text": …}\` 로 감쌌습니다.`);

  // headerRows 는 렌더가 읽지 않는다(머리글 기준은 셀의 header:true) — 뜻을 셀로 옮긴다.
  const headerRows = Number(obj.headerRows) || 0;
  if (headerRows <= 0) return;
  let marked = 0;
  for (let r = 0; r < headerRows && r < obj.rows.length; r++) {
    if (!Array.isArray(obj.rows[r])) continue;
    obj.rows[r] = obj.rows[r].map((cell) => {
      if (cell && typeof cell === 'object' && cell.header !== true) { marked++; return { ...cell, header: true }; }
      return cell;
    });
  }
  if (marked > 0) ctx.notes.push(`\`${obj.id}\` 표의 머리글 ${headerRows}행에 \`header:true\` 를 넣었습니다.`);
}

function normalizeQuestion(obj, ctx) {
  if (obj.type !== 'question') return;

  if (typeof obj.qtype === 'string' && !QUESTION_TYPES.includes(obj.qtype)) {
    const q = obj.qtype.toLowerCase().replace(/[\s_]/g, '-');
    if (QUESTION_TYPES.includes(q)) {
      ctx.notes.push(`\`${obj.id}\` 의 qtype \`${obj.qtype}\` → \`${q}\``);
      obj.qtype = q;
    }
  }

  // 렌더는 answerKey.text / answerKey.html 만 읽는다 — 문자열이면 교사용에 아무것도 찍히지 않는다.
  if (obj.answerKey !== undefined && obj.answerKey !== null && typeof obj.answerKey !== 'object') {
    obj.answerKey = { text: String(obj.answerKey) };
    ctx.notes.push(`\`${obj.id}\` 의 answerKey 를 \`{"text": …}\` 로 감쌌습니다.`);
  }
}

function normalizeAnswerFlag(obj) {
  if (obj.answer !== undefined && typeof obj.answer !== 'boolean') {
    obj.answer = obj.answer === 'true' || obj.answer === 1;
  }
  if (obj.answer === false) delete obj.answer; // 카탈로그가 허용하지 않는 타입에서 불필요한 반려를 막는다
}

function dropUnknownFields(obj, ctx) {
  const spec = TYPE_SPECS[obj.type];
  if (!spec) return; // 타입 미상 — 검증이 판정한다
  const allowed = new Set([...ALWAYS_ALLOWED, ...spec.required, ...spec.optional]);
  for (const key of Object.keys(obj)) {
    if (allowed.has(key)) continue;
    delete obj[key];
    ctx.notes.push(`\`${obj.id}\`(${obj.type}) 의 필드 \`${key}\` 는 카탈로그 밖이라 제거했습니다.`);
  }
}
