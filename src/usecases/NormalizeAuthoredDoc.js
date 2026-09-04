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
    dropUnknownFields(obj, ctx);

    return obj;
  });
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
