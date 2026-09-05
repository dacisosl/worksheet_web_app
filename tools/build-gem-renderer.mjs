#!/usr/bin/env node
/**
 * build-gem-renderer — 순수 렌더 코어(src/domain, src/usecases 중 FS/Chrome 무접촉 모듈)를
 * 브라우저 단일 HTML 파일(gem/worksheet-render.html)로 굽는다.
 *
 * 왜 번들러를 쓰는가: 렌더 규칙(정답 물리 제거·페이지 귀속·개체→HTML)의 **단일 출처를 유지**하려면
 * 브라우저용으로 코드를 다시 쓰면 안 된다. 이 스크립트는 원본 ESM 을 손대지 않고 import/export 만
 * 작은 모듈 레지스트리(__wsgDef/__wsgReq) 호출로 치환해 하나의 클래식 스크립트로 잇는다.
 * (클래식 스크립트로 굽는 이유: file:// 로 더블클릭해 열어도 동작해야 한다 — 로컬 파일 문서에서
 *  ESM/blob import 는 브라우저가 막는다.)
 *
 * 규칙:
 *  - node 내장 모듈·spawn 을 쓰는 어댑터(ChromeRenderer, PaginationMeasurer)는 그래프에 들어오지 않는다.
 *    측정은 브라우저 iframe 어댑터(tools/renderer-app.js)가 같은 measurer{measure} 포트로 주입한다.
 *  - 실패는 조용히 넘기지 않는다: 미지의 import 형태·순환·중복 export 는 즉시 예외.
 *
 * 사용: node tools/build-gem-renderer.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve, relative, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 브라우저 렌더러가 필요한 진입 모듈 — 여기서 DFS 로 그래프를 닫는다. */
const ENTRIES = [
  'src/usecases/RenderObjectTree.js',
  'src/usecases/BuildVariants.js',
  'src/usecases/ValidateObjectTree.js',
  'src/usecases/PaginateObjectTree.js',
  'src/usecases/NormalizeAuthoredDoc.js',
  'src/usecases/ValidateWorksheet.js',
  'src/usecases/ExportDocx.js',
  'src/domain/schema/exportGate.js',
];

/** 렌더 문서에 주입할 CSS 자산(호출부 hoist 계약 — RenderObjectTree.execute assets). */
const CSS_ASSETS = {
  paper: 'assets/paper.css',
  blocks: 'assets/blocks.css',
};
const THEME_FILES = ['ko', 'sci', 'social', 'english', 'math'];

// ── 모듈 그래프 ─────────────────────────────────────────────────────────────
const IMPORT_RE = /^[ \t]*import[ \t]*\{([\s\S]*?)\}[ \t]*from[ \t]*['"]([^'"]+)['"][ \t]*;?[ \t]*$/gm;
const REEXPORT_RE = /^[ \t]*export[ \t]*\{([\s\S]*?)\}[ \t]*from[ \t]*['"]([^'"]+)['"][ \t]*;?[ \t]*$/gm;
const DECL_RE = /^[ \t]*export[ \t]+(const|let|var|function|class|async[ \t]+function)[ \t]+([A-Za-z_$][\w$]*)/gm;

/** `A, B as C` → 구조분해 문자열 + 노출 이름(로컬 이름) 목록. */
function parseBindings(raw) {
  const items = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const parts = [];
  const locals = [];
  for (const item of items) {
    const m = item.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
    if (!m) throw new Error(`알 수 없는 import/export 바인딩 형태: ${JSON.stringify(item)}`);
    const [, source, alias] = m;
    parts.push(alias ? `${source}: ${alias}` : source);
    locals.push(alias || source);
  }
  return { destructure: `{ ${parts.join(', ')} }`, locals };
}

function modKey(absPath) {
  return posix.normalize(relative(ROOT, absPath).split('\\').join('/'));
}

const modules = new Map(); // key → {key, code, exports:[], deps:[]}
const visiting = new Set();

function loadModule(absPath) {
  const key = modKey(absPath);
  if (modules.has(key)) return key;
  if (visiting.has(key)) throw new Error(`순환 의존성: ${key}`);
  visiting.add(key);

  let src = readFileSync(absPath, 'utf8');
  const deps = [];
  const exports = new Set();

  const resolveDep = (spec) => {
    if (!spec.startsWith('.')) throw new Error(`${key}: 상대경로 아닌 import 는 지원하지 않습니다 — ${spec}`);
    const depAbs = resolve(dirname(absPath), spec);
    const depKey = loadModule(depAbs);
    if (!deps.includes(depKey)) deps.push(depKey);
    return depKey;
  };

  // 1) re-export 배럴: export { A, B } from './x.js'
  src = src.replace(REEXPORT_RE, (_all, bindings, spec) => {
    const depKey = resolveDep(spec);
    const { destructure, locals } = parseBindings(bindings);
    for (const name of locals) exports.add(name);
    return `const ${destructure} = __wsgReq(${JSON.stringify(depKey)});`;
  });

  // 2) 일반 import: import { a, b as c } from './x.js'
  src = src.replace(IMPORT_RE, (_all, bindings, spec) => {
    const depKey = resolveDep(spec);
    const { destructure } = parseBindings(bindings);
    return `const ${destructure} = __wsgReq(${JSON.stringify(depKey)});`;
  });

  // 남은 모듈 구문 감시 — export 선언(아래 3단계에서 강등) 외의 import/export 가 남아 있으면
  // 조용히 잘못된 번들을 굽지 않고 즉시 실패한다.
  const unhandled = src.split('\n').filter((line) => (
    /^[ \t]*(import|export)\b/.test(line)
    && !/^[ \t]*export[ \t]+(const|let|var|function|class|async[ \t]+function)[ \t]+/.test(line)
  ));
  if (unhandled.length) throw new Error(`${key}: 처리하지 못한 모듈 구문\n  ${unhandled.join('\n  ')}`);

  // 3) export 선언 → 선언으로 강등 + 이름 수집
  DECL_RE.lastIndex = 0;
  for (const m of src.matchAll(DECL_RE)) exports.add(m[2]);
  src = src.replace(DECL_RE, (_all, kind, name) => _all.replace(/^([ \t]*)export[ \t]+/, '$1'));

  visiting.delete(key);
  modules.set(key, { key, code: src, exports: [...exports], deps });
  return key;
}

for (const entry of ENTRIES) loadModule(join(ROOT, entry));

// 위상 정렬(의존 먼저)
const ordered = [];
const done = new Set();
function emit(key) {
  if (done.has(key)) return;
  done.add(key);
  for (const dep of modules.get(key).deps) emit(dep);
  ordered.push(key);
}
for (const entry of ENTRIES) emit(modKey(join(ROOT, entry)));

// ── 번들 생성 ───────────────────────────────────────────────────────────────
/** 인라인 <script> 안에서 문서를 조기 종료시키지 않도록 — 문자열 안 `</script` 만 나온다(KATEX_HEAD). */
const guardScript = (s) => s.replaceAll('</script', '<\\/script');

const moduleChunks = ordered.map((key) => {
  const mod = modules.get(key);
  const returns = mod.exports.length ? `{ ${mod.exports.join(', ')} }` : '{}';
  return `__wsgDef(${JSON.stringify(key)}, function (__wsgReq) {\n${mod.code}\nreturn ${returns};\n});`;
});

const registryPrelude = `
// ── 모듈 레지스트리(빌드 산출 — tools/build-gem-renderer.mjs) ──
var __wsgFactories = {};
var __wsgCache = {};
function __wsgDef(key, factory) { __wsgFactories[key] = factory; }
function __wsgReq(key) {
  if (Object.prototype.hasOwnProperty.call(__wsgCache, key)) return __wsgCache[key];
  var factory = __wsgFactories[key];
  if (!factory) throw new Error('모듈을 찾을 수 없습니다: ' + key);
  var exportsObj = factory(__wsgReq);
  __wsgCache[key] = exportsObj;
  return exportsObj;
}
`.trim();

const bundle = guardScript([registryPrelude, ...moduleChunks].join('\n\n'));

// CSS 자산
const assets = {};
for (const [name, rel] of Object.entries(CSS_ASSETS)) assets[name] = readFileSync(join(ROOT, rel), 'utf8');
const themes = {};
for (const t of THEME_FILES) themes[t] = readFileSync(join(ROOT, 'themes', `${t}.css`), 'utf8');

// ── AI 패널용 자산: 시스템 프롬프트 · 저작 규격 · 예시 · 성취기준 대장 ──────────
// 프롬프트 문서는 사람이 고치는 정본을 그대로 싣는다(앱 코드에 복제하지 않는다 — 규격이 갈리면
// 챗봇 경로와 API 경로가 서로 다른 활동지를 만든다).
const promptSystem = readFileSync(join(ROOT, 'tools', 'ai-system-prompt.md'), 'utf8');
const promptSpec = readFileSync(join(ROOT, 'gem', 'knowledge', 'worksheet-json-spec.md'), 'utf8');
const exampleText = readFileSync(join(ROOT, 'gem', 'knowledge', 'example-worksheet-science.json'), 'utf8');
const exampleDoc = JSON.parse(exampleText);
// 교과별 참고 예시 — 요청의 교과가 수학 계열이면 수학 예시(2단 문항·공식 callout·자기점검표)를,
// 그 밖엔 과학 예시를 시스템 프롬프트에 싣는다. 모델은 예시의 조판 패턴을 그대로 흉내 내므로
// 예시가 곧 결과물의 밀도를 정한다(실측: 예시 없는 수학 요청은 문항마다 한 줄씩 세로로 늘어졌다).
const exampleMathText = readFileSync(join(ROOT, 'gem', 'knowledge', 'example-worksheet-math.json'), 'utf8');
JSON.parse(exampleMathText); // 깨진 예시가 프롬프트에 실리는 일을 빌드에서 막는다

/** 성취기준 대장 — 학교급/과목/학년을 인덱스로 접어 크기를 줄인다(원문은 손대지 않는다). */
function buildStandardsIndex() {
  const text = readFileSync(join(ROOT, 'data', 'achievement-standards.csv'), 'utf8').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }

  const [head, ...body] = rows.filter((r) => r.length >= 5 && r[3]);
  if (head[3] !== '성취기준 코드') throw new Error(`성취기준 CSV 헤더가 예상과 다릅니다: ${head.join('|')}`);

  const schools = [];
  const subjects = [];
  const grades = [];
  const intern = (list, value) => {
    const idx = list.indexOf(value);
    return idx === -1 ? (list.push(value) - 1) : idx;
  };
  const items = body.map(([school, subject, grade, code, stdText]) => [
    intern(schools, school.trim()),
    intern(subjects, subject.trim()),
    intern(grades, grade.trim()),
    code.trim(),
    stdText.trim(),
  ]);
  return { schools, subjects, grades, items };
}
const standards = buildStandardsIndex();

const assetsJs = [
  `var WSG_ASSETS = ${JSON.stringify(assets)};`,
  `var WSG_THEMES = ${JSON.stringify(themes)};`,
  `var WSG_SAMPLE = ${JSON.stringify(exampleDoc)};`,
  `var WSG_PROMPT = ${JSON.stringify({ system: promptSystem, spec: promptSpec, examples: { general: exampleText, math: exampleMathText } })};`,
  `var WSG_STANDARDS = ${JSON.stringify(standards)};`,
].join('\n');

// 셸 + 앱
const shell = readFileSync(join(ROOT, 'tools', 'renderer-shell.html'), 'utf8');
// AI 패널은 별도 파일이지만 앱과 같은 IIFE 안에 들어가야 한다(el/say/run/stripFence 공유).
const appSrc = readFileSync(join(ROOT, 'tools', 'renderer-app.js'), 'utf8');
const aiSrc = readFileSync(join(ROOT, 'tools', 'renderer-ai.js'), 'utf8')
  .split('\n').map((line) => (line ? `  ${line}` : line)).join('\n');
if (!appSrc.includes('/*__AI_MODULE__*/')) throw new Error('renderer-app.js 에 /*__AI_MODULE__*/ 자리표시가 없습니다.');
const app = guardScript(appSrc.replace('/*__AI_MODULE__*/', () => aiSrc));
const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

const out = shell
  .replace('/*__WSG_BUNDLE__*/', () => bundle)
  .replace('/*__WSG_ASSETS__*/', () => assetsJs)
  .replace('/*__WSG_APP__*/', () => app)
  .replaceAll('__WSG_VERSION__', version);

if (out.includes('__WSG_BUNDLE__') || out.includes('__WSG_APP__') || out.includes('__WSG_ASSETS__')) {
  throw new Error('셸 템플릿 치환이 완료되지 않았습니다(플레이스홀더 잔존).');
}

mkdirSync(join(ROOT, 'gem'), { recursive: true });
const outPath = join(ROOT, 'gem', 'worksheet-render.html');
writeFileSync(outPath, out, 'utf8');

console.log(`✔ ${relative(ROOT, outPath)}  (${(Buffer.byteLength(out, 'utf8') / 1024).toFixed(0)} KB)`);
console.log(`  모듈 ${ordered.length}개 · 테마 ${THEME_FILES.length}종 · 성취기준 ${standards.items.length}건 · v${version}`);
for (const key of ordered) console.log(`   - ${key} → ${modules.get(key).exports.length} exports`);
