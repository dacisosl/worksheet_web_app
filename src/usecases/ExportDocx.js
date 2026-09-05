import { writeZip } from './zipWriter.js';
import { buildEditableDoc, hex6 } from './editableDoc.js';

// ExportDocx — 편집용 문서 모델(editableDoc)을 **DOCX**(WordprocessingML)로 직렬화한다. 순수 함수.
//
// 목적은 "한글·워드에서 문항을 고치는 것"이다. 인쇄 조판의 복제가 아니다 — 쪽 나눔은 워드가 다시
// 계산하고, 상자는 표로, 답란은 밑줄 문단으로, 수식은 읽을 수 있는 평문 근사로 옮긴다.
// 그 변환 규칙은 editableDoc.js 에 한 번만 있고(HWPX 와 공유), 이 파일은 XML 만 안다.
// 정답 제거는 여기서 하지 않는다: 호출부가 BuildVariants.stripAnswersFromDocument 로 만든 학생 벌
// 트리를 넘긴다(불변식은 한 곳에서만 지킨다).
//
// 의존성 0: OOXML 을 직접 쓰고 zipWriter 로 담는다. 외부 라이브러리를 번들에 넣지 않는다.

// 예전 호출부 호환 — 변환기는 editableDoc 으로 옮겼다.
export { latexToRuns, inlineHtmlToRuns, blockHtmlToParagraphs } from './editableDoc.js';

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const FONT = '맑은 고딕';

// ── 단위 ────────────────────────────────────────────────────────────────────
const twips = (pt) => Math.round(pt * 20);      // 1pt = 20 twips
const halfPt = (pt) => Math.round(pt * 2);      // w:sz 는 반포인트
const eighthPt = (pt) => Math.round(pt * 8);    // 테두리 굵기는 1/8pt
const lineVal = (ratio) => Math.round(ratio * 240); // 240 = 한 줄

function xmlEsc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── 런 ──────────────────────────────────────────────────────────────────────
function runXml(r) {
  if (r.br) return '<w:r><w:br/></w:r>';
  const props = [];
  props.push(`<w:rFonts w:ascii="${FONT}" w:eastAsia="${FONT}" w:hAnsi="${FONT}"/>`);
  if (r.b) props.push('<w:b/>');
  if (r.i) props.push('<w:i/>');
  if (r.u) props.push('<w:u w:val="single"/>');
  if (r.color) props.push(`<w:color w:val="${hex6(r.color)}"/>`);
  if (r.size) props.push(`<w:sz w:val="${halfPt(r.size)}"/><w:szCs w:val="${halfPt(r.size)}"/>`);
  if (r.sup) props.push('<w:vertAlign w:val="superscript"/>');
  if (r.sub) props.push('<w:vertAlign w:val="subscript"/>');
  if (r.shade) props.push(`<w:shd w:val="clear" w:color="auto" w:fill="${hex6(r.shade)}"/>`);
  return `<w:r><w:rPr>${props.join('')}</w:rPr><w:t xml:space="preserve">${xmlEsc(r.text)}</w:t></w:r>`;
}

// ── 문단 ────────────────────────────────────────────────────────────────────
function pXml(p) {
  const pr = [];
  if (p.keepNext) pr.push('<w:keepNext/>');
  if (p.pageBreakBefore) pr.push('<w:pageBreakBefore/>');
  if (p.border) {
    const { color = 'AAAAAA', widthPt = 0.5, sides = ['bottom'] } = p.border;
    pr.push('<w:pBdr>' + sides.map((s) => `<w:${s} w:val="single" w:sz="${eighthPt(widthPt)}" w:space="1" w:color="${hex6(color)}"/>`).join('') + '</w:pBdr>');
  }
  if (p.shade) pr.push(`<w:shd w:val="clear" w:color="auto" w:fill="${hex6(p.shade)}"/>`);
  const spacing = [];
  if (p.before != null) spacing.push(`w:before="${twips(p.before)}"`);
  if (p.after != null) spacing.push(`w:after="${twips(p.after)}"`);
  if (p.line != null) spacing.push(`w:line="${lineVal(p.line)}" w:lineRule="auto"`);
  if (spacing.length) pr.push(`<w:spacing ${spacing.join(' ')}/>`);
  if (p.indent) pr.push(`<w:ind w:left="${twips(p.indent)}"/>`);
  if (p.align) pr.push(`<w:jc w:val="${p.align}"/>`);
  const body = (p.runs || []).map(runXml).join('');
  if (!pr.length && !body) return '<w:p/>';
  return `<w:p>${pr.length ? `<w:pPr>${pr.join('')}</w:pPr>` : ''}${body}</w:p>`;
}

// ── 표 ──────────────────────────────────────────────────────────────────────
function tblXml(t) {
  const { widths = null, borders = true, borderColor = 'CBD5C0', cellMargin = 5, indent = 0 } = t;
  const single = (s) => `<w:${s} w:val="single" w:sz="6" w:space="0" w:color="${hex6(borderColor)}"/>`;
  const nil = (s) => `<w:${s} w:val="nil"/>`;
  const SIDES = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'];
  const bdr = borders === 'lines'
    ? SIDES.map((s) => (s === 'bottom' || s === 'insideH' ? single(s) : nil(s))).join('') // 답란: 가로선만
    : SIDES.map(borders ? single : nil).join('');
  const grid = widths ? `<w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${twips(w)}"/>`).join('')}</w:tblGrid>` : '';
  const trs = t.rows.map((cells) => {
    const tcs = cells.map((c) => {
      const pr = [];
      if (c.width) pr.push(`<w:tcW w:w="${twips(c.width)}" w:type="dxa"/>`);
      if (c.span && c.span > 1) pr.push(`<w:gridSpan w:val="${c.span}"/>`);
      if (c.shade) pr.push(`<w:shd w:val="clear" w:color="auto" w:fill="${hex6(c.shade)}"/>`);
      if (c.vAlign) pr.push(`<w:vAlign w:val="${c.vAlign}"/>`);
      // 셀은 반드시 문단으로 끝나야 한다(중첩 표 뒤에 빈 문단을 붙인다).
      const content = (c.blocks || []).map(blockXml).join('') || '<w:p/>';
      const ending = content.endsWith('</w:tbl>') ? content + '<w:p/>' : content;
      return `<w:tc><w:tcPr>${pr.join('')}</w:tcPr>${ending}</w:tc>`;
    }).join('');
    const trPr = cells.some((c) => c.minHeight) ? `<w:trPr><w:trHeight w:val="${twips(Math.max(...cells.map((c) => c.minHeight || 0)))}"/></w:trPr>` : '';
    return `<w:tr>${trPr}${tcs}</w:tr>`;
  }).join('');
  const cm = twips(cellMargin);
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>${indent ? `<w:tblInd w:w="${twips(indent)}" w:type="dxa"/>` : ''}`
    + `<w:tblBorders>${bdr}</w:tblBorders><w:tblLayout w:type="fixed"/>`
    + `<w:tblCellMar><w:top w:w="${cm}" w:type="dxa"/><w:left w:w="${cm + 40}" w:type="dxa"/><w:bottom w:w="${cm}" w:type="dxa"/><w:right w:w="${cm + 40}" w:type="dxa"/></w:tblCellMar>`
    + `<w:tblLook w:val="0000"/></w:tblPr>${grid}${trs}</w:tbl>`;
}

function blockXml(b) {
  return b.kind === 'table' ? tblXml(b) : pXml(b);
}

export class ExportDocx {
  /**
   * @param {object} document 개체 트리(학생 벌이면 이미 정답이 제거된 트리)
   * @param {{mode?:'student'|'teacher', themeCss?:string, standards?:Array<{code,text}>}} opts
   * @returns {{bytes:Uint8Array, notes:string[]}}
   */
  execute(document, opts = {}) {
    if (!document || typeof document !== 'object') throw new TypeError('ExportDocx.execute 는 개체 트리 문서가 필요합니다.');
    const model = buildEditableDoc(document, opts);
    const { page, theme } = model;

    const body = model.blocks.map(blockXml).join('');
    const sectPr = `<w:sectPr><w:pgSz w:w="${twips(page.widthPt)}" w:h="${twips(page.heightPt)}"${page.landscape ? ' w:orient="landscape"' : ''}/>`
      + `<w:pgMar w:top="${twips(page.margins.top)}" w:right="${twips(page.margins.right)}" w:bottom="${twips(page.margins.bottom)}" w:left="${twips(page.margins.left)}" w:header="400" w:footer="400" w:gutter="0"/></w:sectPr>`;

    const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`
      + `<w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}"><w:body>${body}${sectPr}</w:body></w:document>`;

    const bytes = writeZip([
      { name: '[Content_Types].xml', data: CONTENT_TYPES },
      { name: '_rels/.rels', data: ROOT_RELS },
      { name: 'word/_rels/document.xml.rels', data: DOC_RELS },
      { name: 'word/document.xml', data: documentXml },
      { name: 'word/styles.xml', data: stylesXml(theme) },
      { name: 'docProps/core.xml', data: coreXml(model.title) },
    ]);
    return { bytes, notes: model.notes };
  }
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
