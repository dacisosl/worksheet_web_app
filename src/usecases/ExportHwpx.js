import { writeZip } from './zipWriter.js';
import { buildEditableDoc, hex6 } from './editableDoc.js';

// ExportHwpx — 편집용 문서 모델(editableDoc)을 **HWPX**(OWPML, KS X 6101)로 직렬화한다. 순수 함수.
//
// 한글에서 바로 열어 문항을 고치는 용도다. 인쇄 조판의 복제가 아니다 — 쪽 나눔은 한글이 다시
// 계산하고, 상자는 표로, 답란은 밑줄 문단으로, 수식은 읽을 수 있는 평문 근사로 옮긴다. 그 변환
// 규칙은 editableDoc.js 에 한 번만 있고(DOCX 와 공유), 이 파일은 OWPML 만 안다.
// 정답 제거는 여기서 하지 않는다: 호출부가 BuildVariants.stripAnswersFromDocument 로 만든 학생 벌
// 트리를 넘긴다(불변식은 한 곳에서만 지킨다).
//
// 의존성 0: XML 을 직접 쓰고 zipWriter 로 담는다(저장 방식 ZIP — 한글 2022 로 열리는 것을 실측).
//
// OWPML 은 글자·문단·테두리 모양을 header.xml 의 목록(refList)에 등록하고 본문은 그 번호만 가리킨다.
// 그래서 본문을 먼저 만들며 모양을 등록기(registry)에 모으고, 마지막에 header.xml 을 쓴다.
// 패키지 구성과 각 요소의 속성 집합은 한글 2022 가 저장한 파일을 기준으로 삼았다.

const HWPUNIT_PER_PT = 100;                    // 1pt = 100 HWPUNIT(1/7200 inch)
const hu = (pt) => Math.round(pt * HWPUNIT_PER_PT);
const FONT = '함초롬돋움';
const DEFAULT_SIZE_PT = 10.5;
const DEFAULT_LINE_PERCENT = 130;
const BORDER_WIDTH = '0.12 mm';

const NS = 'xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" '
  + 'xmlns:hp10="http://www.hancom.co.kr/hwpml/2016/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" '
  + 'xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" '
  + 'xmlns:hhs="http://www.hancom.co.kr/hwpml/2011/history" xmlns:hm="http://www.hancom.co.kr/hwpml/2011/master-page" '
  + 'xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf" xmlns:dc="http://purl.org/dc/elements/1.1/" '
  + 'xmlns:opf="http://www.idpf.org/2007/opf/" xmlns:ooxmlchart="http://www.hancom.co.kr/hwpml/2016/ooxmlchart" '
  + 'xmlns:hwpunitchar="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar" xmlns:epub="http://www.idpf.org/2007/ops" '
  + 'xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"';
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

function xmlEsc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    // XML 1.0 이 허용하지 않는 제어 문자는 버린다(모델이 복사해 온 HTML 원문에 섞여 올 수 있다).
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}
const color = (c, fallback = '000000') => '#' + (hex6(c) || fallback);

// ── 등록기(모양 목록) ────────────────────────────────────────────────────────
class Registry {
  constructor() { this.items = []; this.index = new Map(); }
  /** 같은 모양은 같은 번호 — key 로 중복을 접는다. @returns {number} id */
  id(key, make) {
    if (this.index.has(key)) return this.index.get(key);
    const id = this.items.length + this.base;
    this.index.set(key, id);
    this.items.push(make(id));
    return id;
  }
}
function registry(base) { const r = new Registry(); r.base = base; return r; }

/** 테두리·채움 모양. sides: {l,r,t,b} 각각 true 면 실선, fill: hex6|null */
function borderFillXml(id, spec) {
  const side = (on) => (on
    ? `type="SOLID" width="${BORDER_WIDTH}" color="${color(spec.color, '000000')}"`
    : `type="NONE" width="0.1 mm" color="#000000"`);
  const fill = spec.fill ? `<hc:fillBrush><hc:winBrush faceColor="${color(spec.fill)}" hatchColor="#FF000000" alpha="0"/></hc:fillBrush>` : '';
  return `<hh:borderFill id="${id}" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0">`
    + '<hh:slash type="NONE" Crooked="0" isCounter="0"/><hh:backSlash type="NONE" Crooked="0" isCounter="0"/>'
    + `<hh:leftBorder ${side(spec.l)}/><hh:rightBorder ${side(spec.r)}/><hh:topBorder ${side(spec.t)}/><hh:bottomBorder ${side(spec.b)}/>`
    + '<hh:diagonal type="SOLID" width="0.1 mm" color="#000000"/>' + fill + '</hh:borderFill>';
}

function charPrXml(id, r) {
  const sizePt = r.size || DEFAULT_SIZE_PT;
  const all7 = (v) => `hangul="${v}" latin="${v}" hanja="${v}" japanese="${v}" other="${v}" symbol="${v}" user="${v}"`;
  return `<hh:charPr id="${id}" height="${hu(sizePt)}" textColor="${color(r.color, '000000')}" shadeColor="${r.shade ? color(r.shade) : 'none'}" useFontSpace="0" useKerning="0" symMark="NONE" borderFillIDRef="1">`
    + `<hh:fontRef ${all7(0)}/><hh:ratio ${all7(100)}/><hh:spacing ${all7(0)}/><hh:relSz ${all7(100)}/><hh:offset ${all7(0)}/>`
    + (r.i ? '<hh:italic/>' : '') + (r.b ? '<hh:bold/>' : '')
    + `<hh:underline type="${r.u ? 'BOTTOM' : 'NONE'}" shape="SOLID" color="${color(r.color, '000000')}"/>`
    + '<hh:strikeout shape="NONE" color="#000000"/><hh:outline type="NONE"/><hh:shadow type="NONE" color="#B2B2B2" offsetX="10" offsetY="10"/>'
    + (r.sup ? '<hh:supscript/>' : '') + (r.sub ? '<hh:subscript/>' : '')
    + '</hh:charPr>';
}

function paraPrXml(id, p) {
  const align = { left: 'LEFT', center: 'CENTER', right: 'RIGHT', both: 'JUSTIFY' }[p.align] || 'LEFT';
  const margin = `<hh:margin><hc:intent value="0" unit="HWPUNIT"/><hc:left value="${hu(p.indent || 0)}" unit="HWPUNIT"/><hc:right value="0" unit="HWPUNIT"/>`
    + `<hc:prev value="${hu(p.before || 0)}" unit="HWPUNIT"/><hc:next value="${hu(p.after || 0)}" unit="HWPUNIT"/></hh:margin>`
    + `<hh:lineSpacing type="PERCENT" value="${p.line ? Math.round(p.line * 100) : DEFAULT_LINE_PERCENT}" unit="HWPUNIT"/>`;
  return `<hh:paraPr id="${id}" tabPrIDRef="0" condense="0" fontLineHeight="0" snapToGrid="1" suppressLineNumbers="0" checked="0">`
    + `<hh:align horizontal="${align}" vertical="BASELINE"/><hh:heading type="NONE" idRef="0" level="0"/>`
    + `<hh:breakSetting breakLatinWord="KEEP_WORD" breakNonLatinWord="KEEP_WORD" widowOrphan="0" keepWithNext="${p.keepNext ? 1 : 0}" keepLines="0" pageBreakBefore="${p.pageBreakBefore ? 1 : 0}" lineWrap="BREAK"/>`
    + '<hh:autoSpacing eAsianEng="0" eAsianNum="0"/>'
    + `<hp:switch><hp:case hp:required-namespace="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar">${margin}</hp:case><hp:default>${margin}</hp:default></hp:switch>`
    + `<hh:border borderFillIDRef="${p.borderFillId}" offsetLeft="0" offsetRight="0" offsetTop="0" offsetBottom="${p.borderFillId !== 1 ? 100 : 0}" connect="0" ignoreMargin="0"/>`
    + '</hh:paraPr>';
}

// ── 본문 직렬화 ─────────────────────────────────────────────────────────────
class Writer {
  constructor() {
    this.borderFills = registry(1);
    this.charPrs = registry(0);
    this.paraPrs = registry(0);
    this.nextId = 1;
    this.zOrder = 0;
    this.plain = [];
    // id 1 은 "선 없음·채움 없음" — 글자·문단 기본이 이 번호를 가리킨다.
    this.noBorder = this.borderFill({ l: false, r: false, t: false, b: false, fill: null, color: '000000' });
    this.charPr({});
    this.paraPr({});
  }
  uid() { return String(this.nextId++); }
  borderFill(spec) {
    const key = [spec.l, spec.r, spec.t, spec.b, hex6(spec.color), hex6(spec.fill)].join('|');
    return this.borderFills.id(key, (id) => borderFillXml(id, spec));
  }
  charPr(r) {
    const spec = { b: !!r.b, i: !!r.i, u: !!r.u, sup: !!r.sup, sub: !!r.sub, color: hex6(r.color), size: r.size || 0, shade: hex6(r.shade) };
    return this.charPrs.id(JSON.stringify(spec), (id) => charPrXml(id, spec));
  }
  paraPr(p) {
    let borderFillId = this.noBorder;
    if (p.border || p.shade) {
      const sides = p.border ? (p.border.sides || ['bottom']) : [];
      borderFillId = this.borderFill({
        l: sides.includes('left'), r: sides.includes('right'), t: sides.includes('top'), b: sides.includes('bottom'),
        color: p.border ? p.border.color : '000000', fill: p.shade || null,
      });
    }
    const spec = { align: p.align || '', before: p.before || 0, after: p.after || 0, line: p.line || 0, indent: p.indent || 0, keepNext: !!p.keepNext, pageBreakBefore: !!p.pageBreakBefore, borderFillId };
    return this.paraPrs.id(JSON.stringify(spec), (id) => paraPrXml(id, spec));
  }

  /** 문단 하나 → <hp:p>. 줄바꿈(br)은 문단을 나눈다(편집용이라 의미는 같다). lead 는 첫 run 앞에 끼울 XML(구역 설정). */
  paragraph(p, lead = '') {
    const paraPrId = this.paraPr(p);
    const groups = [[]];
    for (const r of (p.runs || [])) {
      if (r.br) groups.push([]);
      else groups[groups.length - 1].push(r);
    }
    return groups.map((runs, i) => {
      const body = runs.filter((r) => r.text).map((r) => {
        this.plain.push(r.text);
        return `<hp:run charPrIDRef="${this.charPr(r)}"><hp:t>${xmlEsc(r.text)}</hp:t></hp:run>`;
      }).join('');
      const first = i === 0 ? lead : '';
      const pageBreak = p.pageBreakBefore && i === 0 ? 1 : 0;
      return `<hp:p id="${this.uid()}" paraPrIDRef="${paraPrId}" styleIDRef="0" pageBreak="${pageBreak}" columnBreak="0" merged="0">`
        + first + (body || (first ? '' : '<hp:run charPrIDRef="0"/>')) + '</hp:p>';
    }).join('');
  }

  /** 표 → 표를 담은 문단 하나. 셀 테두리·채움은 borderFill 로 등록한다. */
  table(t) {
    const rows = t.rows || [];
    const colCount = Math.max(...rows.map((r) => r.reduce((n, c) => n + (c.span || 1), 0)), 1);
    const widths = t.widths || rows[0].map((c) => c.width || 0);
    const totalW = hu(widths.reduce((a, b) => a + b, 0));
    const margin = hu(t.cellMargin != null ? t.cellMargin : 5);
    const on = !!t.borders;
    const cellFill = (shade) => this.borderFill({ l: on, r: on, t: on, b: on, color: t.borderColor || 'CBD5C0', fill: shade || null });
    const tableBorder = cellFill(null);

    const rowHeights = rows.map((cells) => hu(Math.max(13, ...cells.map((c) => c.minHeight || 0))));
    const trs = rows.map((cells, ri) => {
      let col = 0;
      const tcs = cells.map((c) => {
        const span = c.span || 1;
        const width = hu(c.width || widths.slice(col, col + span).reduce((a, b) => a + b, 0));
        const inner = (c.blocks || []).map((b) => this.block(b)).join('') || this.paragraph({ runs: [] });
        const tc = `<hp:tc name="" header="0" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="${cellFill(c.shade)}">`
          + `<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="${c.vAlign === 'center' ? 'CENTER' : 'TOP'}" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">`
          + inner + '</hp:subList>'
          + `<hp:cellAddr colAddr="${col}" rowAddr="${ri}"/><hp:cellSpan colSpan="${span}" rowSpan="1"/>`
          + `<hp:cellSz width="${width}" height="${rowHeights[ri]}"/>`
          + `<hp:cellMargin left="${margin}" right="${margin}" top="${margin}" bottom="${margin}"/></hp:tc>`;
        col += span;
        return tc;
      }).join('');
      return `<hp:tr>${tcs}</hp:tr>`;
    }).join('');

    const tbl = `<hp:tbl id="${this.uid()}" zOrder="${this.zOrder++}" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="0" rowCnt="${rows.length}" colCnt="${colCount}" cellSpacing="0" borderFillIDRef="${tableBorder}" noAdjust="0">`
      + `<hp:sz width="${totalW}" widthRelTo="ABSOLUTE" height="${rowHeights.reduce((a, b) => a + b, 0)}" heightRelTo="ABSOLUTE" protect="0"/>`
      + '<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>'
      + `<hp:outMargin left="0" right="0" top="0" bottom="0"/><hp:inMargin left="${margin}" right="${margin}" top="${margin}" bottom="${margin}"/>`
      + trs + '</hp:tbl>';
    const paraPrId = this.paraPr({ indent: t.indent || 0 });
    return `<hp:p id="${this.uid()}" paraPrIDRef="${paraPrId}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0">${tbl}</hp:run></hp:p>`;
  }

  block(b) { return b.kind === 'table' ? this.table(b) : this.paragraph(b); }
}

function secPrXml(page) {
  const m = page.margins;
  const noteDefaults = (type, len, betweenNotes, place) => `<hp:${type}><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/>`
    + `<hp:noteLine length="${len}" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="${betweenNotes}" belowLine="567" aboveLine="850"/>`
    + `<hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="${place}" beneathText="0"/></hp:${type}>`;
  const pageBorder = (type) => `<hp:pageBorderFill type="${type}" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER"><hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill>`;
  return '<hp:secPr id="" textDirection="HORIZONTAL" spaceColumns="1134" tabStop="8000" tabStopVal="4000" tabStopUnit="HWPUNIT" outlineShapeIDRef="0" memoShapeIDRef="0" textVerticalWidthHead="0" masterPageCnt="0">'
    + '<hp:grid lineGrid="0" charGrid="0" wonggojiFormat="0"/><hp:startNum pageStartsOn="BOTH" page="0" pic="0" tbl="0" equation="0"/>'
    + '<hp:visibility hideFirstHeader="0" hideFirstFooter="0" hideFirstMasterPage="0" border="SHOW_ALL" fill="SHOW_ALL" hideFirstPageNum="0" hideFirstEmptyLine="0" showLineNumber="0"/>'
    + '<hp:lineNumberShape restartType="0" countBy="0" distance="0" startNumber="0"/>'
    + `<hp:pagePr landscape="${page.landscape ? 'NARROWLY' : 'WIDELY'}" width="${hu(page.widthPt)}" height="${hu(page.heightPt)}" gutterType="LEFT_ONLY">`
    + `<hp:margin header="${hu(Math.min(m.top, 15))}" footer="${hu(Math.min(m.bottom, 15))}" gutter="0" left="${hu(m.left)}" right="${hu(m.right)}" top="${hu(m.top)}" bottom="${hu(m.bottom)}"/></hp:pagePr>`
    + noteDefaults('footNotePr', -1, 283, 'EACH_COLUMN') + noteDefaults('endNotePr', -4, 0, 'END_OF_DOCUMENT')
    + pageBorder('BOTH') + pageBorder('EVEN') + pageBorder('ODD')
    + '</hp:secPr><hp:ctrl><hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="1" sameSz="1" sameGap="0"/></hp:ctrl>';
}

export class ExportHwpx {
  /**
   * @param {object} document 개체 트리(학생 벌이면 이미 정답이 제거된 트리)
   * @param {{mode?:'student'|'teacher', themeCss?:string, standards?:Array<{code,text}>}} opts
   * @returns {{bytes:Uint8Array, notes:string[]}}
   */
  execute(document, opts = {}) {
    if (!document || typeof document !== 'object') throw new TypeError('ExportHwpx.execute 는 개체 트리 문서가 필요합니다.');
    const model = buildEditableDoc(document, opts);
    const w = new Writer();

    // 첫 문단이 구역 설정(용지·여백)을 지닌다 — 모델의 첫 블록은 항상 모드 표식 문단이다.
    const [first, ...rest] = model.blocks;
    const lead = `<hp:run charPrIDRef="0">${secPrXml(model.page)}</hp:run>`;
    const body = (first.kind === 'p' ? w.paragraph(first, lead) : w.paragraph({ runs: [] }, lead) + w.block(first))
      + rest.map((b) => w.block(b)).join('');

    const sectionXml = XML_DECL + `<hs:sec ${NS}>${body}</hs:sec>`;
    const headerXml = XML_DECL + headXml(w);
    const preview = w.plain.join(' ').replace(/\s+/g, ' ').trim().slice(0, 1000);

    // mimetype 은 첫 항목·무압축이어야 한다(컨테이너 규약).
    const bytes = writeZip([
      { name: 'mimetype', data: 'application/hwp+zip' },
      { name: 'version.xml', data: VERSION_XML },
      { name: 'META-INF/container.xml', data: CONTAINER_XML },
      { name: 'META-INF/manifest.xml', data: MANIFEST_XML },
      { name: 'META-INF/container.rdf', data: CONTAINER_RDF },
      { name: 'Contents/content.hpf', data: contentHpf(model.title) },
      { name: 'Contents/header.xml', data: headerXml },
      { name: 'Contents/section0.xml', data: sectionXml },
      { name: 'Preview/PrvText.txt', data: preview },
      { name: 'settings.xml', data: SETTINGS_XML },
    ]);
    return { bytes, notes: model.notes };
  }
}

// ── header.xml ──────────────────────────────────────────────────────────────
function headXml(w) {
  const langs = ['HANGUL', 'LATIN', 'HANJA', 'JAPANESE', 'OTHER', 'SYMBOL', 'USER'];
  const fontfaces = langs.map((lang) => `<hh:fontface lang="${lang}" fontCnt="1"><hh:font id="0" face="${FONT}" type="TTF" isEmbedded="0">`
    + '<hh:typeInfo familyType="FCAT_GOTHIC" weight="6" proportion="4" contrast="0" strokeVariation="1" armStyle="1" letterform="1" midline="1" xHeight="1"/></hh:font></hh:fontface>').join('');
  return `<hh:head ${NS} version="1.4" secCnt="1">`
    + '<hh:beginNum page="1" footnote="1" endnote="1" pic="1" tbl="1" equation="1"/>'
    + '<hh:refList>'
    + `<hh:fontfaces itemCnt="7">${fontfaces}</hh:fontfaces>`
    + `<hh:borderFills itemCnt="${w.borderFills.items.length}">${w.borderFills.items.join('')}</hh:borderFills>`
    + `<hh:charProperties itemCnt="${w.charPrs.items.length}">${w.charPrs.items.join('')}</hh:charProperties>`
    + '<hh:tabProperties itemCnt="1"><hh:tabPr id="0" autoTabLeft="0" autoTabRight="0"/></hh:tabProperties>'
    + `<hh:paraProperties itemCnt="${w.paraPrs.items.length}">${w.paraPrs.items.join('')}</hh:paraProperties>`
    + '<hh:styles itemCnt="1"><hh:style id="0" type="PARA" name="바탕글" engName="Normal" paraPrIDRef="0" charPrIDRef="0" nextStyleIDRef="0" langID="1042" lockForm="0"/></hh:styles>'
    + '</hh:refList>'
    + '<hh:compatibleDocument targetProgram="HWP201X"><hh:layoutCompatibility/></hh:compatibleDocument>'
    + '<hh:docOption><hh:linkinfo path="" pageInherit="0" footnoteInherit="0"/></hh:docOption>'
    + '<hh:trackchageConfig flags="56"/>'
    + '</hh:head>';
}

// ── 패키지 파트 ─────────────────────────────────────────────────────────────
const VERSION_XML = XML_DECL + '<hv:HCFVersion xmlns:hv="http://www.hancom.co.kr/hwpml/2011/version" tagetApplication="WORDPROCESSOR" major="5" minor="1" micro="1" buildNumber="0" os="1" xmlVersion="1.4" application="worksheet-grab" appVersion="0.6"/>';

const CONTAINER_XML = XML_DECL + '<ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf"><ocf:rootfiles>'
  + '<ocf:rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/>'
  + '<ocf:rootfile full-path="Preview/PrvText.txt" media-type="text/plain"/>'
  + '<ocf:rootfile full-path="META-INF/container.rdf" media-type="application/rdf+xml"/>'
  + '</ocf:rootfiles></ocf:container>';

const MANIFEST_XML = XML_DECL + '<odf:manifest xmlns:odf="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>';

const CONTAINER_RDF = XML_DECL + '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
  + '<rdf:Description rdf:about=""><ns0:hasPart xmlns:ns0="http://www.hancom.co.kr/hwpml/2016/meta/pkg#" rdf:resource="Contents/header.xml"/></rdf:Description>'
  + '<rdf:Description rdf:about="Contents/header.xml"><rdf:type rdf:resource="http://www.hancom.co.kr/hwpml/2016/meta/pkg#HeaderFile"/></rdf:Description>'
  + '<rdf:Description rdf:about=""><ns0:hasPart xmlns:ns0="http://www.hancom.co.kr/hwpml/2016/meta/pkg#" rdf:resource="Contents/section0.xml"/></rdf:Description>'
  + '<rdf:Description rdf:about="Contents/section0.xml"><rdf:type rdf:resource="http://www.hancom.co.kr/hwpml/2016/meta/pkg#SectionFile"/></rdf:Description>'
  + '<rdf:Description rdf:about=""><rdf:type rdf:resource="http://www.hancom.co.kr/hwpml/2016/meta/pkg#Document"/></rdf:Description>'
  + '</rdf:RDF>';

const SETTINGS_XML = XML_DECL + '<ha:HWPApplicationSetting xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"><ha:CaretPosition listIDRef="0" paraIDRef="0" pos="0"/></ha:HWPApplicationSetting>';

function contentHpf(title) {
  return XML_DECL + `<opf:package ${NS} version="" unique-identifier="" id="">`
    + `<opf:metadata><opf:title>${xmlEsc(title)}</opf:title><opf:language>ko</opf:language>`
    + '<opf:meta name="creator" content="text">worksheet-grab</opf:meta></opf:metadata>'
    + '<opf:manifest><opf:item id="header" href="Contents/header.xml" media-type="application/xml"/>'
    + '<opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/>'
    + '<opf:item id="settings" href="settings.xml" media-type="application/xml"/></opf:manifest>'
    + '<opf:spine><opf:itemref idref="header" linear="yes"/><opf:itemref idref="section0" linear="yes"/></opf:spine>'
    + '</opf:package>';
}
