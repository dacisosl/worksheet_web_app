# worksheet-grab — 한국 초·중·고 교사용 활동지 제작

교사의 한 문장 요청("중2 과학 옴의 법칙 활동지")을 **학생용·교사용 A4 활동지 2벌**로 만듭니다.
2022 개정 교육과정 성취기준 3,285건을 내장하고, 학생용에서는 정답을 **물리적으로 제거**합니다.

## 지금 바로 쓰기

### → <https://dacisosl.github.io/worksheet_web_app/>

설치·서버·계정이 필요 없습니다. 파일로 쓰려면 **[`gem/worksheet-render.html`](gem/worksheet-render.html)**
하나만 내려받아 더블클릭하세요(인터넷 없이도 열립니다). 자세한 사용법은 **[gem/README.md](gem/README.md)**.

활동지 내용을 만드는 방법은 두 가지이고, **조판·정답 제거·인쇄는 두 경로 모두 같은 코드**가 합니다.

| | (A) 앱에서 바로 | (B) 챗봇에서 복붙 |
|---|---|---|
| 방법 | 앱에 요청을 입력 → Gemini API 또는 OpenRouter 호출 | Gemini Gem·ChatGPT·Claude 프로젝트가 만든 JSON을 붙여넣기 |
| 준비물 | API 키 1개(브라우저에만 저장) | 이미 쓰는 챗봇 구독 |
| 성취기준 | 앱이 교과 성취기준을 프롬프트에 자동 첨부 | `gem/knowledge/standards-*.md` 를 챗봇 지식으로 업로드 |

명령줄로도 씁니다(Node 24+, Chrome 필요): `node bin/worksheet-grab.js help`

## 무엇이 기계적으로 보장되는가

AI 가 쓰는 것은 **내용뿐**이고, 아래는 코드가 보장합니다.

- **학생용에 정답이 남지 않는다** — 정답 개체를 트리 수준에서 제거하고, 마크 밖으로 정답 텍스트가
  샌 흔적이 있으면 학생용 출력 자체를 막습니다([`BuildVariants`](src/usecases/BuildVariants.js),
  [`ValidateWorksheet`](src/usecases/ValidateWorksheet.js)).
- **A4 쪽 넘침이 없다** — 브라우저에서 실제 높이를 재서 쪽을 나눕니다. 표·조직자는 쪼개지지 않습니다
  ([`PaginateObjectTree`](src/usecases/PaginateObjectTree.js)).
- **성취기준을 창작하지 않는다** — 코드·원문은 [`data/achievement-standards.csv`](data/achievement-standards.csv)
  에서 조회한 것만 씁니다.
- **교과 색·서식이 매번 같다** — AI 는 CSS·좌표를 만들지 않습니다. 개체 트리만 저작합니다
  ([`schema/worksheet-object.schema.json`](schema/worksheet-object.schema.json)).
- **실존 작품 원문을 옮기지 않는다** — 저작권 지문은 교사가 채우는 슬롯입니다.

최종 수업 배포 전 사실성·난이도·저작권·정답 표시는 교사가 확인합니다.

## 저장소 구조

| 경로 | 내용 |
|---|---|
| `src/domain`, `src/usecases` | 렌더 코어 — 개체 트리 → HTML, 2벌 분기, 쪽 나눔, 검수. 의존성 0 |
| `src/adapters` | Chrome(PDF·측정)·파일시스템·에디터 HTTP 어댑터 |
| `src/editor` | 브라우저 편집기(`edit-ui`) |
| `assets`, `themes`, `blocks` | 인쇄 CSS·교과 색 토큰·블록 템플릿 |
| `data`, `manifests`, `templates` | 성취기준 대장·예시 매니페스트·교과 프리셋 |
| `tools` | 웹앱 빌드(`build-gem-renderer.mjs`)·지식파일 빌드·JSON 점검 |
| `gem` | **웹앱 산출물**과 챗봇용 지식 파일·사용 설명 |
| `.claude` | 스킬·에이전트 정의(Claude Code 파이프라인) |

## 개발

```bash
npm run build:gem
```

`gem/worksheet-render.html` 은 **빌드 산출물**입니다. 직접 고치지 말고 원본을 고쳐 다시 빌드하세요.

| 고칠 곳 | 무엇 |
|---|---|
| `src/**` | 렌더·검증·조판 규칙(웹앱과 CLI가 공유) |
| `tools/renderer-shell.html`, `tools/renderer-app.js` | 웹앱 UI·파이프라인 배선 |
| `tools/renderer-ai.js` | AI 패널(공급자·성취기준 검색·프롬프트 조립) |
| `src/usecases/editableDoc.js` | 편집용 문서 모델(개체 → 문단·표·런) — DOCX·HWPX 가 공유하는 단일 변환 지점 |
| `src/usecases/ExportDocx.js`, `ExportHwpx.js`, `zipWriter.js` | 편집용 DOCX(OOXML)·HWPX(OWPML) 내보내기 — XML 직접 작성, 의존성 0 |
| `tools/ai-system-prompt.md` | AI 시스템 프롬프트 |
| `gem/knowledge/worksheet-json-spec.md` | 활동지 JSON 저작 규격(정본 — 두 경로가 공유) |
| `gem/GEM_INSTRUCTIONS.md` | 챗봇(Gem/GPTs) 지시문 |

챗봇이 만든 JSON 을 브라우저 없이 점검:

```bash
node tools/check-authored-json.mjs 활동지.json --html out
```

## 라이선스

[MIT](LICENSE). 성취기준 원문은 2022 개정 교육과정(교육부) 자료입니다.
