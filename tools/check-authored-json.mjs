#!/usr/bin/env node
/**
 * check-authored-json — 챗봇이 저작한 활동지 JSON 을 브라우저 없이 점검한다.
 * 브라우저 렌더러(gem/worksheet-render.html)와 **같은 모듈**로 정규화·검증·2벌 분기를 수행하고,
 * 학생용 정답 누출을 최종 확인한다. 다른 점은 Chrome 실측 조판을 하지 않는 것뿐이다
 * (쪽 나눔은 브라우저에서만 확인 가능 — 여기서는 구조·정답·렌더 성공 여부만 본다).
 *
 * 사용: node tools/check-authored-json.mjs <file.json> [--html <out-prefix>]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeAuthoredDoc } from '../src/usecases/NormalizeAuthoredDoc.js';
import { ValidateObjectTree } from '../src/usecases/ValidateObjectTree.js';
import { ValidateWorksheet } from '../src/usecases/ValidateWorksheet.js';
import { BuildVariants, ANSWER_CLASSES } from '../src/usecases/BuildVariants.js';
import { collectTextInside } from '../src/usecases/html-scan.js';
import { deriveRenderMeta } from '../src/usecases/RenderObjectTree.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('사용: node tools/check-authored-json.mjs <file.json> [--html <out-prefix>]');
  process.exit(2);
}
const htmlIdx = args.indexOf('--html');
const htmlPrefix = htmlIdx !== -1 ? args[htmlIdx + 1] : null;

const THEME_ALIAS = {
  ko: 'ko', korean: 'ko', 국어: 'ko',
  sci: 'sci', science: 'sci', 과학: 'sci',
  social: 'social', 사회: 'social', 역사: 'social', 도덕: 'social',
  english: 'english', 영어: 'english',
  math: 'math', 수학: 'math',
};

const raw = JSON.parse(readFileSync(file, 'utf8'));

let normalized;
try {
  normalized = normalizeAuthoredDoc(raw);
} catch (e) {
  console.error(`✗ 구조를 정리할 수 없습니다: ${e.message}`);
  process.exit(1);
}
for (const note of normalized.notes) console.log(`· ${note}`);

const review = new ValidateObjectTree().execute(normalized.document);
for (const f of review.findings) {
  const sev = (f.severity || 'error') === 'error' ? '✗' : '△';
  console.log(`${sev} [${f.rule}] ${f.objectId ? `${f.objectId} — ` : ''}${f.message}`);
}
if (!review.ok) {
  console.error('\n✗ 구조 검증 실패.');
  process.exit(1);
}

const meta = deriveRenderMeta(normalized.document);
const theme = THEME_ALIAS[meta.themeName] || THEME_ALIAS[meta.dataSubject] || 'ko';
meta.themeName = theme;
if (!meta.dataSubject) meta.dataSubject = theme;
const assets = {
  paperCss: readFileSync(join(ROOT, 'assets', 'paper.css'), 'utf8'),
  blocksCss: readFileSync(join(ROOT, 'assets', 'blocks.css'), 'utf8'),
  themeCss: readFileSync(join(ROOT, 'themes', `${theme}.css`), 'utf8'),
};

const variants = new BuildVariants().executeObjectTree(normalized.document, assets, meta);

// 검수 게이트 — 브라우저 렌더러와 같은 판정기(1층 구조 + 2층 렌더 실측: 정답 누출·인쇄 안전).
// 정답이 마크 안에 온전히 있는 교사 벌을 검사해야 "밖으로 샌 정답"을 비교할 수 있다.
const gate = new ValidateWorksheet({ paper: meta.paper || null }).execute(normalized.document, variants.teacher);
let blocking = 0;
for (const f of gate.findings) {
  const mark = f.severity === 'error' ? '✗' : '△';
  if (f.severity === 'error') blocking++;
  console.log(`${mark} [${f.rule}] ${f.objectId ? `${f.objectId} — ` : ''}${f.message}${f.evidence ? ` — ${f.evidence}` : ''}`);
}
const residue = collectTextInside(variants.student, ANSWER_CLASSES);
if (residue.length) {
  blocking++;
  console.log(`✗ [student-answer-residue] 학생용에 정답 텍스트가 남았습니다 — ${residue[0].slice(0, 50)}`);
}
if (blocking) {
  console.error('\n✗ 검수 게이트에서 막혔습니다(학생용 출력 불가).');
  process.exit(1);
}

// columns 자식까지 펼쳐 센다(2단 문항도 문항이다).
const flatten = (list) => list.flatMap((o) => (
  o?.type === 'columns' && Array.isArray(o.children) ? o.children.flatMap((c) => flatten(Array.isArray(c) ? c : [])) : [o]
));
const flow = flatten(normalized.document.pages.flatMap((p) => p.flow));
const questions = flow.filter((o) => o.type === 'question');
const withKey = questions.filter((o) => o.answerKey);
console.log(`\n✔ 통과 — 개체 ${flow.length}개 · 문항 ${questions.length}개(정답 있는 문항 ${withKey.length}개) · 테마 ${theme}`);
console.log(`  교사용 ${(variants.teacher.length / 1024).toFixed(0)}KB · 학생용 ${(variants.student.length / 1024).toFixed(0)}KB · 정답 제거 확인`);
console.log('  쪽 나눔은 브라우저 렌더러(gem/worksheet-render.html)에서 확인하세요.');

if (htmlPrefix) {
  writeFileSync(`${htmlPrefix}-student.html`, variants.student, 'utf8');
  writeFileSync(`${htmlPrefix}-teacher.html`, variants.teacher, 'utf8');
  console.log(`  → ${htmlPrefix}-student.html / ${htmlPrefix}-teacher.html`);
}

// --pdf <prefix>: 웹앱과 같은 **쪽 나눔 경로**로 A4 PDF 2벌을 만든다(Chrome 필요).
// 위의 --html 은 쪽 나눔 없이 한 장짜리 sheet 를 그대로 쓴 것이라 머리글·꼬리글이 첫/끝에만 붙는다 —
// 인쇄물 비교는 반드시 이 경로로 한다(PaginateObjectTree + Chrome 측정 어댑터 → BuildVariants → PDF).
const pdfIdx = args.indexOf('--pdf');
if (pdfIdx !== -1) {
  const prefix = args[pdfIdx + 1];
  const [{ PaginateObjectTree }, { ChromePaginationMeasurer }, { ChromeRenderer }, { RenderPdf }] = await Promise.all([
    import('../src/usecases/PaginateObjectTree.js'),
    import('../src/adapters/PaginationMeasurer.js'),
    import('../src/adapters/ChromeRenderer.js'),
    import('../src/usecases/RenderPdf.js'),
  ]);
  const paginator = new PaginateObjectTree({ measurer: new ChromePaginationMeasurer() });
  const { document: paginated } = await paginator.execute(normalized.document, assets, meta);
  const pagedVariants = new BuildVariants().executeObjectTree(paginated, assets, meta);
  const renderPdf = new RenderPdf({ renderer: new ChromeRenderer() });
  for (const [mode, html] of [['student', pagedVariants.student], ['teacher', pagedVariants.teacher]]) {
    const inputPath = `${prefix}-${mode}.paged.html`;
    writeFileSync(inputPath, html, 'utf8');
    await renderPdf.execute({ inputPath, outputPath: `${prefix}-${mode}.pdf` });
  }
  console.log(`  쪽 나눔 ${paginated.pages.length}쪽 → ${prefix}-student.pdf / ${prefix}-teacher.pdf`);
}
