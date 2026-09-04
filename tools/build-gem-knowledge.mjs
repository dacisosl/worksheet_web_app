#!/usr/bin/env node
/**
 * build-gem-knowledge — Gem/GPTs 등 챗봇에 올릴 "지식 파일"을 data/achievement-standards.csv 에서 굽는다.
 *
 * 왜 나누는가: 성취기준 3,285개(560KB)를 한 파일로 올리면 챗봇의 검색이 엉뚱한 학교급을 물어온다.
 * 학교급·계열로 잘라 두면 교사가 **자기가 가르치는 파일만** 올려 검색 정확도를 올릴 수 있다.
 *
 * 성취기준 원문은 절대 손대지 않는다(원칙 3) — 줄 형식만 바꿔 옮긴다.
 *
 * 사용: node tools/build-gem-knowledge.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'gem', 'knowledge');

// ── CSV 파싱(따옴표 안 콤마 보존 — 성취기준 원문에 콤마가 흔하다) ──
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; }
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const csv = readFileSync(join(ROOT, 'data', 'achievement-standards.csv'), 'utf8').replace(/^﻿/, '');
const [header, ...dataRows] = parseCsv(csv).filter((r) => r.length >= 5 && r[3]);
if (header[3] !== '성취기준 코드') throw new Error(`CSV 헤더가 예상과 다릅니다: ${header.join('|')}`);

const records = dataRows.map(([school, subject, grade, code, text]) => ({
  school: school.trim(), subject: subject.trim(), grade: grade.trim(), code: code.trim(), text: text.trim(),
}));

// ── 파일 분할 규칙 ──────────────────────────────────────────────────────────
const HIGH_GROUPS = [
  { slug: '고등-국어영어외국어', label: '고등학교 국어·영어·제2외국어·한문',
    match: (s) => /국어|화법|독서|작문|문학|매체|언어|영어|한문|독일어|프랑스어|스페인어|중국어|일본어|러시아어|아랍어|베트남어|논술/.test(s) },
  { slug: '고등-수학과학정보', label: '고등학교 수학·과학·정보',
    match: (s) => /수학|대수|미적분|확률과 통계|기하|과학|물리|화학|생명|지구|세포|유전|물질과 에너지|역학|전자기|행성|기후변화와 환경생태|정보|인공지능|데이터|소프트웨어/.test(s) },
  { slug: '고등-사회역사도덕', label: '고등학교 사회·역사·도덕·경제',
    match: (s) => /사회|지리|역사|한국사|세계사|정치|법과|경제|윤리|철학|심리|종교|국제관계|여행|도시의 미래|금융|기후변화와 지속가능한 세계|논리와 사고|교육의 이해/.test(s) },
];
const HIGH_ETC = { slug: '고등-체육예술기술교양', label: '고등학교 체육·예술·기술가정·교양(그 밖의 과목)' };

function bucketOf(rec) {
  if (rec.school === '초등학교') return { slug: '초등학교', label: '초등학교 전 교과' };
  if (rec.school === '중학교') return { slug: '중학교', label: '중학교 전 교과' };
  for (const g of HIGH_GROUPS) if (g.match(rec.subject)) return g;
  return HIGH_ETC;
}

const buckets = new Map();
for (const rec of records) {
  const b = bucketOf(rec);
  if (!buckets.has(b.slug)) buckets.set(b.slug, { ...b, items: [] });
  buckets.get(b.slug).items.push(rec);
}

mkdirSync(OUT_DIR, { recursive: true });

const written = [];
for (const bucket of buckets.values()) {
  const bySubject = new Map();
  for (const rec of bucket.items) {
    const key = `${rec.subject} (${rec.grade})`;
    if (!bySubject.has(key)) bySubject.set(key, []);
    bySubject.get(key).push(rec);
  }
  const lines = [
    `# 2022 개정 교육과정 성취기준 — ${bucket.label}`,
    '',
    '이 파일은 **조회용 원문 대장**이다. 활동지를 만들 때 성취기준 코드와 문장은 반드시 이 목록에서',
    '그대로 가져온다. 목록에 없는 코드나 문장은 **절대 지어내지 않는다** — 못 찾으면 교사에게',
    '"성취기준 코드를 알려 주세요"라고 되묻는다.',
    '',
    `총 ${bucket.items.length}개.`,
    '',
  ];
  for (const [subjectKey, items] of bySubject) {
    lines.push(`## ${subjectKey}`, '');
    for (const rec of items) lines.push(`- ${rec.code} ${rec.text}`);
    lines.push('');
  }
  const file = join(OUT_DIR, `standards-${bucket.slug}.md`);
  const body = lines.join('\n');
  writeFileSync(file, body, 'utf8');
  written.push({ file, count: bucket.items.length, bytes: Buffer.byteLength(body, 'utf8') });
}

// ── 예시 활동지는 손으로 관리한다(생성하지 않는다) ──────────────────────────
// 파이프라인 산출물을 그대로 예시로 쓰면 안 된다: 실제 산출물에는 문항·강조상자·정답을 richtext
// 원시 HTML 로 써 넣은 레거시 문서가 섞여 있고(실측: 마이그레이션 문서의 qbox·class='answer'),
// 그것을 few-shot 으로 주면 모델이 **개체 카탈로그를 우회하도록** 배운다. 예시는
// worksheet-json-spec.md 를 그대로 따르는 것만 두고, 바꿀 때마다 아래로 검증한다.
//   node tools/check-authored-json.mjs gem/knowledge/example-worksheet-<과목>.json
const EXAMPLES = ['example-worksheet-science.json', 'example-worksheet-social.json'];
for (const name of EXAMPLES) {
  const file = join(OUT_DIR, name);
  if (!existsSync(file)) {
    console.warn(`! 예시 파일이 없습니다(직접 저작해야 합니다): ${relative(ROOT, file)}`);
    continue;
  }
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  const flow = doc.pages.reduce((n, p) => n + (p.flow || []).length, 0);
  console.log(`· 예시 유지: ${name} (개체 ${flow}개 — 손으로 관리)`);
}

for (const w of written) {
  console.log(`✔ ${relative(ROOT, w.file)}  (${w.count}건 · ${(w.bytes / 1024).toFixed(0)} KB)`);
}
console.log(`\n총 ${records.length}개 성취기준을 ${buckets.size}개 파일로 나눴습니다.`);
