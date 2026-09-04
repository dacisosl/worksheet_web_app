# 활동지 JSON 저작 규격 (worksheet-grab 개체 트리 · 챗봇 저작판)

이 문서가 유일한 출력 규격이다. HTML 을 직접 쓰지 않고, 아래 **개체(object)** 를 순서대로 나열한
JSON 하나만 낸다. 렌더러(`worksheet-render.html`)가 이 JSON 을 A4 조판·학생용/교사용 2벌로 만든다.

## 0. 문서 골격

```json
{
  "docTitle": "옴의 법칙 — 전압·전류·저항의 관계 찾기",
  "subject": "과학",
  "themeName": "sci",
  "lang": "ko",
  "runHead": "2022 개정 교육과정 · 중학교 과학 · 전기와 자기",
  "runFoot": { "left": "중학교 과학 활동지", "rightPrefix": "옴의 법칙" },
  "paper": { "size": "a4", "orientation": "portrait" },
  "head": { "katex": true },
  "standards": [
    { "code": "[9과14-02]", "text": "성취기준 원문 그대로" }
  ],
  "pages": [ { "flow": [ /* 개체들 */ ] } ]
}
```

- `themeName` — 교과 색 테마. `ko`(국어) · `sci`(과학) · `social`(사회·역사·도덕) · `english`(영어) ·
  `math`(수학) 다섯 중 하나. 색을 직접 쓰지 말고 이 이름만 고른다.
- `runHead` / `runFoot` — 모든 쪽 위·아래에 반복되는 머리글/꼬리글. `rightPrefix` 뒤에 쪽번호가 자동으로 붙는다.
- `head.katex` — 수식이 있을 때만 `true`. 그때 `$V = IR$`, `$$\int f(x)dx$$` 처럼 `$` 구분자를 쓸 수 있다.
- `standards` — 성취기준 **원문 대장에서 조회한 것만**. 지어내지 않는다. 못 찾으면 이 배열을 비우고
  교사에게 코드를 물어본다.
- `pages` — **항상 `[{ "flow": [ … ] }]` 한 개만 낸다.** 쪽 나눔은 렌더러가 실제 높이를 재서 정한다.
  쪽 수를 예상해 직접 나누지 않는다.
- 쓰지 않는 필드: `pagination`, 개체의 `id`, `placement`, `rect`(좌표), `widthPct`/`minHeightMm`/`align`.
  좌표와 조판은 사람과 엔진의 몫이다.

## 1. 개체 11종 (이 목록 밖의 `type` 은 렌더되지 않는다)

### title — 제목
```json
{ "type": "title", "level": 1, "text": "옴의 법칙 — 전압·전류·저항의 관계 찾기",
  "meta": { "pill": "전기와 자기", "page": "중학교 과학" } }
```
`level` 1 = 활동지 대제목(문서에 한 번), 2 = 중간 소제목(섹션 머리). `meta` 는 `level:1` 에서만 쓴다.

### std-box — 학습 목표 상자
```json
{ "type": "std-box", "codes": ["[9과14-02]"],
  "objectives": ["전압을 바꾸며 전류를 측정해 두 양의 관계를 그래프로 나타낼 수 있다."] }
```
`objectives` 는 성취기준을 이 차시에 맞게 구체화한 **저작 문장**("~할 수 있다", 2~4개).
`codes` 는 조회한 코드만. `heading`(기본 "학습 목표")으로 이름을 바꿀 수 있다.
`showStandards: true` 를 주면 교사용에 성취기준 원문 박스가 함께 나온다(기본은 안 나옴).

### question — 문항 (활동지의 중심)
```json
{ "type": "question", "qnum": 2, "qtype": "multiple-choice",
  "prompt": "표의 결과에서 알 수 있는 저항의 특징으로 알맞은 것은?",
  "choices": [{ "text": "전압이 커지면 저항도 커진다." }, { "text": "저항은 거의 일정하다." }],
  "answerKey": { "text": "② 전압과 전류가 정비례하므로 저항은 일정하다." } }
```
- `qtype` 7종만: `multiple-choice`(→`choices`) · `short-answer`(한 줄 답란 자동) ·
  `essay`(→`lines`, 기본 4줄) · `fill-blank`(발문 안에 `_____`, 보기는 `choices`) ·
  `true-false`(판별 문장을 `choices` 에) · `matching`(→`left`, `right`) · `ordering`(→`items`).
- `qnum` 은 사람이 읽는 문항 번호. 활동지 전체에서 1부터 이어 붙인다.
- **정답은 `answerKey` 에만 쓴다. 반드시 `{ "text": "…" }` 객체다**(문자열로 쓰면 교사용에 아무것도 안 찍힌다).
  수식이 필요하면 `{ "text": "y=3x-1", "html": "<b>$y=3x-1$</b>" }` 처럼 둘 다 준다.
- 답란은 qtype 이 자동으로 만든다. 더 넓은 공간이 필요할 때만 뒤에 `answer-area` 를 덧붙인다.

### table — 표
```json
{ "type": "table", "splittable": false, "headerRows": 1, "caption": "측정 결과",
  "rows": [
    [{ "text": "전압 (V)", "header": true }, { "text": "전류 (A)", "header": true }],
    [{ "text": "1.5" }, { "text": "" }]
  ] }
```
- 셀은 **반드시 `{ "text": "…" }` 객체**(문자열 셀은 빈 칸으로 나온다). 머리글 셀에 `"header": true`.
- 셀 옵션: `colspan` · `rowspan` · `w`(첫 행에만, 열 너비 %) · `h`(mm, 필기 공간) · `align`(`center`|`right`).
- `splittable` 은 항상 `false`. 표는 쪽 경계에서 쪼개지지 않는다 — 표가 크면 앞뒤 개체를 줄인다.

### callout — 강조 상자
```json
{ "type": "callout", "variant": "tip", "title": "실험 준비",
  "body": "<p>전압계는 <b>병렬</b>, 전류계는 <b>직렬</b>로 연결한다.</p>" }
```
`variant`: `tip`(도움말) · `warning`(주의) · `note`(참고) · `summary`(핵심 정리).
`body` 는 간단한 HTML(`p` `ul` `ol` `li` `b` `strong` `em` `br` `table` 등, `class`/`style` 금지).
**정답을 여기에 쓰지 않는다** — callout 은 학생용에도 그대로 나온다.

### answer-area — 답 쓰는 공간
```json
{ "type": "answer-area", "style": "line", "lines": 5, "label": "우리 조의 결론" }
```
`style`: `line`(밑줄, `lines` 개수) · `box`(빈 상자) · `dots`(점선 원고).

### richtext — 그 밖의 본문 (허용 관용구만)
```json
{ "type": "richtext", "html": "<div class='direct'>전압을 바꾸며 전류를 재어 관계를 찾아보자.</div>" }
```
쓸 수 있는 관용구는 아래 4개뿐이다(다른 class 는 스타일이 없어 맨 글자로 나온다).

| 용도 | 마크업 |
|---|---|
| 지시문(활동 안내 한 문장) | `<div class='direct'>…</div>` |
| 단원·이름칸 (제목 바로 아래 한 번) | `<div class='unit-line'><div class='unit'><b>단원</b>　…</div><div class='namefield'>학년<span></span> 반<span></span> 이름<span></span></div></div>` |
| 필기 밑줄 몇 줄 | `<div class='note-under'></div>` (필요한 만큼 반복) |
| 점선 강조 상자 | `<div class='dash-box'><div class='dh'>제목</div><div class='db'>내용</div></div>` |

정답을 `richtext` 안에 쓰면 **학생용 출력이 차단된다**(정답 누출 검사에 걸린다).

### organizer — 그림형 사고 조직자
```json
{ "type": "organizer", "kind": "venn", "params": { "circles": 2 },
  "labels": { "left": "직렬연결", "right": "병렬연결", "common": "공통점" } }
```
도형·좌표는 엔진이 그린다. 개수(`params`)와 슬롯 글자(`labels`, **이름→글자 맵**)만 준다.
슬롯 이름을 틀리면 그 칸은 기본값(빈칸)으로 나온다.

| kind | params (범위) | labels 슬롯 이름 |
|---|---|---|
| `venn` | `circles`: 2 또는 3 | 2원: `left` `right` `common` / 3원: `a` `b` `c` `common` |
| `conceptmap` | `nodes`: 3~6 | `center`, `node1`…`nodeN` |
| `fishbone` | `branches`: 2~6 | `result`, `cause1`…`causeN` |
| `flowchart` | `steps`: 2~6 | `step1`…`stepN` |
| `hierarchy` | `children`: 2~5 | `top`, `child1`…`childN` |
| `hexagon` | `count`: 3~7 | `hex1`…`hexN` |

학생이 채울 칸은 `labels` 에서 빼면 빈칸으로 인쇄된다.

### image-slot — 그림 자리
```json
{ "type": "image-slot", "alt": "전기 회로 연결 사진(교사 준비)", "caption": "회로 연결" }
```
`src` 는 비워 둔다(교사가 나중에 채운다). `alt` 에 "무엇이 들어갈 자리"인지 적는다.

### passage-slot — 저작권 지문 자리
```json
{ "type": "passage-slot", "slotLabel": "제시문 ①",
  "title": "지문 제목", "source": "출처(교사 기입)" }
```
실존 작품의 원문은 **옮기지 않는다.** 자리와 라벨만 만들고 `bodyHtml` 은 비워 둔다
(교사가 직접 채우거나, 교사가 명시적으로 요청할 때만 요약·재구성해서 넣는다).

### divider — 구분선
```json
{ "type": "divider" }
```

## 2. 정답 처리 (가장 중요)

정답을 표시하는 방법은 **두 가지뿐**이다.

1. `question.answerKey = { "text": "…" }` — 문항의 정답·예시 답안.
2. 개체 전체가 정답·해설일 때 `"answer": true` — 그 개체는 학생용에서 통째로 사라진다.
   (`title` · `question` · `table` · `richtext` 에만 붙일 수 있다.)

렌더러는 학생용을 만들 때 이 두 가지를 **물리적으로 제거**한 다음, 남은 흔적이 있으면 학생용
출력 자체를 막는다. 그러니 정답은 절대 발문·callout·표 셀·richtext 본문에 섞어 쓰지 않는다.

## 3. 활동지 한 장의 기본 흐름

1. `title`(level 1) → 2. `richtext`(unit-line 이름칸) → 3. `std-box`(학습 목표) →
4. `richtext`(direct 지시문) → 5. 활동별로 `title`(level 2) + `callout`/`table`/`organizer` +
`question` 묶음 → 6. 마지막에 성찰 문항(`question`, `essay`) 1개.

A4 한 장 기준 분량: 문항 4~7개. 표·조직자가 크면 문항을 줄인다.

## 4. 스스로 점검할 것 (JSON 을 내기 전에)

- [ ] `type` 이 위 11종 안에 있는가? `qtype` 이 7종 안에 있는가?
- [ ] 표 셀이 모두 `{ "text": … }` 인가? `splittable: false` 인가?
- [ ] `answerKey` 가 `{ "text": … }` 객체인가? 정답이 발문·callout·표에 새지 않았는가?
- [ ] 성취기준 코드·원문이 대장에 있는 것과 **글자 그대로** 같은가?
- [ ] `pages` 가 `[{ "flow": [ … ] }]` 하나인가? `id`·`placement`·좌표를 쓰지 않았는가?
- [ ] 학생이 읽을 문장인가? (지시문은 학생에게 말하듯, 목표는 교사 언어로)
