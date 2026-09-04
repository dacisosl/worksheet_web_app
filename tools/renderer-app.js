/**
 * renderer-app — 단일 파일 웹앱의 앱 층(빌드 시 gem/worksheet-render.html 에 인라인).
 *
 * 왼쪽은 채팅, 오른쪽은 A4 뷰어, 나머지는 전부 설정 모달이다. 파이프라인은 그대로다:
 *   챗봇/AI JSON → 정규화(NormalizeAuthoredDoc) → 구조 검증(ValidateObjectTree)
 *   → 브라우저 실측 조판(PaginateObjectTree + iframe 측정 어댑터)
 *   → 2벌 분기(BuildVariants: 정답 트리 수준 물리 제거) → 검수 게이트(ValidateWorksheet)
 *   → 미리보기·인쇄.
 *
 * 렌더 규칙은 하나도 여기서 다시 쓰지 않는다 — 전부 src/ 의 원본 모듈을 번들로 불러 쓴다.
 * 이 파일이 담당하는 것은 (1) 화면·대화 표현, (2) Chrome 어댑터를 대신하는 iframe 측정,
 * (3) 파이프라인 배선과 인쇄 트리거뿐이다.
 */
(function () {
  'use strict';

  var RenderMod = __wsgReq('src/usecases/RenderObjectTree.js');
  var VariantsMod = __wsgReq('src/usecases/BuildVariants.js');
  var ValidateMod = __wsgReq('src/usecases/ValidateObjectTree.js');
  var PaginateMod = __wsgReq('src/usecases/PaginateObjectTree.js');
  var NormalizeMod = __wsgReq('src/usecases/NormalizeAuthoredDoc.js');
  var ReviewMod = __wsgReq('src/usecases/ValidateWorksheet.js');
  var ScanMod = __wsgReq('src/usecases/html-scan.js');

  var $ = function (id) { return document.getElementById(id); };
  var el = {
    // 채팅
    thread: $('thread'), welcome: $('welcome'), ask: $('ask'), btnAsk: $('btnAsk'), btnNew: $('btnNew'),
    // 뷰어
    frame: $('frame'), measure: $('measure'), empty: $('empty'), pageInfo: $('pageInfo'),
    tabStudent: $('tabStudent'), tabTeacher: $('tabTeacher'), btnPrint: $('btnPrint'), btnSaveHtml: $('btnSaveHtml'),
    // 설정
    settings: $('settings'), btnSettings: $('btnSettings'), btnSettingsInline: $('btnSettingsInline'),
    btnSettingsClose: $('btnSettingsClose'),
    providerSel: $('providerSel'), keyHint: $('keyHint'), apiKey: $('apiKey'),
    btnKeySave: $('btnKeySave'), btnKeyClear: $('btnKeyClear'),
    modelSel: $('modelSel'), modelFilter: $('modelFilter'), btnModelReload: $('btnModelReload'),
    src: $('src'), btnRun: $('btnRun'), btnFile: $('btnFile'), fileIn: $('fileIn'),
    btnSample: $('btnSample'), btnClear: $('btnClear'),
  };

  var state = { variants: null, mode: 'student', docTitle: '활동지', pageCount: 0, questionCount: 0 };

  // ── 대화 표현 ───────────────────────────────────────────────────────────
  var AI_AVATAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"'
    + ' stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v3M12 18v3M4.2 7.5l2.6 1.5M17.2 15l2.6 1.5'
    + 'M4.2 16.5l2.6-1.5M17.2 9l2.6-1.5"/><circle cx="12" cy="12" r="3.4"/></svg>';

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  /** 정규화기·검증기가 주는 평문 메시지의 `백틱`을 <code> 로 바꿔 보여준다. */
  function code(s) {
    return esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');
  }
  function scrollThread() {
    el.thread.scrollTop = el.thread.scrollHeight;
  }
  function hideWelcome() {
    if (el.welcome) el.welcome.hidden = true;
  }
  function append(node) {
    el.thread.appendChild(node);
    scrollThread();
    return node;
  }

  function pushUser(text) {
    hideWelcome();
    var wrap = document.createElement('div');
    wrap.className = 'msg user';
    var body = document.createElement('div');
    body.className = 'body';
    body.textContent = text;
    wrap.appendChild(body);
    return append(wrap);
  }

  function pushAI(html) {
    hideWelcome();
    var wrap = document.createElement('div');
    wrap.className = 'msg ai';
    wrap.innerHTML = '<div class="avatar">' + AI_AVATAR + '</div><div class="body">' + html + '</div>';
    return append(wrap);
  }

  /** 생각 중 표시 — 반환된 노드를 remove() 하면 사라진다. */
  function pushTyping() {
    return pushAI('<span class="typing"><i></i><i></i><i></i></span>');
  }

  // 진행 기록(정규화·검증·조판·검수)은 접히는 카드 하나에 모은다 — 대화 흐름을 어지럽히지 않으면서
  // 무엇이 왜 막혔는지는 펼쳐서 그대로 볼 수 있어야 한다.
  var activity = null;

  function beginActivity(title) {
    hideWelcome();
    var card = document.createElement('details');
    card.className = 'card';
    card.dataset.state = 'run';
    card.innerHTML = '<summary><span class="dot"></span><span class="label"></span>'
      + '<svg class="chev" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"'
      + ' stroke-width="2" stroke-linecap="round"><path d="m6 9 6 6 6-6"/></svg></summary>'
      + '<div class="lines"></div>';
    card.querySelector('.label').textContent = title || '작업 중…';
    activity = { card: card, label: card.querySelector('.label'), lines: card.querySelector('.lines') };
    return append(card);
  }
  function setActivity(stateName, label) {
    if (!activity) return;
    activity.card.dataset.state = stateName;
    if (label) activity.label.textContent = label;
    if (stateName === 'err') activity.card.open = true;
  }
  /** kind: ok | warn | err | muted */
  function say(kind, msg) {
    if (!activity) beginActivity('작업 중…');
    var p = document.createElement('p');
    p.className = 't-' + kind;
    p.innerHTML = msg;
    activity.lines.appendChild(p);
    if (kind === 'err') activity.card.open = true;
    scrollThread();
  }
  /** 이전 이름 유지(호출부가 많다) — 새 진행 카드를 여는 뜻이다. */
  function clearLog() {
    beginActivity('활동지 검사 · 조판');
  }

  function resetThread() {
    el.thread.innerHTML = '';
    if (el.welcome) {
      el.thread.appendChild(el.welcome);
      el.welcome.hidden = false;
    }
    activity = null;
  }

  // ── 교과 테마 ───────────────────────────────────────────────────────────
  var THEME_ALIAS = {
    ko: 'ko', korean: 'ko', 국어: 'ko',
    sci: 'sci', science: 'sci', 과학: 'sci', 물리: 'sci', 화학: 'sci', 생명과학: 'sci', 지구과학: 'sci',
    social: 'social', 사회: 'social', 역사: 'social', 한국사: 'social', 도덕: 'social', 지리: 'social',
    english: 'english', 영어: 'english',
    math: 'math', 수학: 'math',
  };
  function resolveTheme(doc) {
    var raw = String(doc.themeName || doc.dataSubject || doc.subject || '').trim();
    var key = THEME_ALIAS[raw] || THEME_ALIAS[raw.toLowerCase()];
    if (!key) {
      for (var alias in THEME_ALIAS) {
        if (raw.indexOf(alias) === 0) { key = THEME_ALIAS[alias]; break; }
      }
    }
    return key || 'ko';
  }

  // ── 브라우저 측정 어댑터(Chrome CDP 어댑터 대체 — 같은 measurer{measure} 포트) ──
  // 측정 규칙은 어댑터 계약 그대로다: fonts.ready(+KaTeX) 게이팅 후, 개체 높이를
  // "다음 개체 top 까지의 거리"로 잰다(마진 상쇄를 반영하는 유일한 정확한 방법).
  var browserMeasurer = {
    measure: function (args) {
      return writeIntoFrame(el.measure, args.html).then(function (win) {
        var doc = win.document;
        return (doc.fonts ? doc.fonts.ready : Promise.resolve()).then(function () {
          var hadKatex = !!doc.querySelector('script[src*="auto-render"]');
          if (!hadKatex) return { hadKatex: false, katexReady: true };
          return waitUntil(function () { return typeof win.renderMathInElement === 'function'; }, 6000)
            .then(function (ok) {
              if (!ok) say('warn', 'KaTeX(수식) 스크립트를 불러오지 못했습니다 — 인터넷이 없으면 수식이 원문 그대로 나오고 조판이 조금 어긋날 수 있습니다.');
              return { hadKatex: true, katexReady: ok };
            });
        }).then(function (gating) {
          return settle(win).then(function () {
            var nodes = [].slice.call(doc.querySelectorAll('[data-oid]'));
            var rects = nodes.map(function (node) {
              var r = node.getBoundingClientRect();
              return { id: node.getAttribute('data-oid'), top: r.top, height: r.height };
            });
            var heights = {};
            for (var i = 0; i < rects.length; i++) {
              var cur = rects[i];
              var next = rects[i + 1];
              heights[cur.id] = next ? (next.top - cur.top) : cur.height;
            }
            return { heights: heights, gating: gating };
          });
        });
      });
    },
  };

  function writeIntoFrame(frame, html) {
    return new Promise(function (resolve, reject) {
      var win = frame.contentWindow;
      if (!win) { reject(new Error('iframe 을 사용할 수 없습니다.')); return; }
      var doc = win.document;
      try {
        doc.open();
        doc.write(html);
        doc.close();
      } catch (e) { reject(e); return; }
      if (doc.readyState === 'complete') { resolve(win); return; }
      win.addEventListener('load', function () { resolve(win); }, { once: true });
      setTimeout(function () { resolve(win); }, 8000); // 자산(폰트/KaTeX CDN) 지연 시 진행
    });
  }
  function waitUntil(pred, timeoutMs) {
    return new Promise(function (resolve) {
      var start = Date.now();
      (function tick() {
        if (pred()) { resolve(true); return; }
        if (Date.now() - start > timeoutMs) { resolve(false); return; }
        setTimeout(tick, 60);
      })();
    });
  }
  // 레이아웃 정착 대기 — requestAnimationFrame 은 쓰지 않는다. 측정용 iframe 은 화면에 보이지
  // 않아(off-screen + visibility:hidden) 브라우저가 rAF 를 아예 발화하지 않는다(실측: 무한 대기).
  // getBoundingClientRect 자체가 강제 리플로우를 유발하므로 짧은 타이머 두 번이면 충분하다.
  function settle(win) {
    return new Promise(function (resolve) {
      setTimeout(function () {
        try { void win.document.body.offsetHeight; } catch (e) { /* noop */ }
        setTimeout(resolve, 16);
      }, 16);
    });
  }

  // ── 학생용 최종 확인 ────────────────────────────────────────────────────
  // 누출 판정은 프로젝트의 검수기(ValidateWorksheet)가 한다 — "정답 마크 밖으로 정답 텍스트가
  // 샜는지"가 기준이다. 여기서는 그 뒤에 남는 단 하나, **학생 벌의 정답 마크 안이 정말 비었는지**만
  // 마지막으로 확인한다(BuildVariants 가 트리에서 개체를 지우고 HTML 에서 마크 내용을 비운다 —
  // 빈 `<div class="answer"></div>` 껍데기가 남는 것은 설계상 정상이고 인쇄에도 나오지 않는다).
  function studentResidue(studentHtml) {
    return ScanMod.collectTextInside(studentHtml, VariantsMod.ANSWER_CLASSES);
  }

  // ── 파이프라인 ──────────────────────────────────────────────────────────
  /** @param {{silentUser?:boolean}} [opts] AI 경로는 이미 사용자 말풍선을 띄웠다. */
  function run(opts) {
    opts = opts || {};
    var text = el.src.value.trim();
    if (!text) {
      openSettings('json');
      return;
    }
    if (!opts.silentUser) pushUser('활동지 JSON을 붙여넣었습니다.');
    setOutputs(null);
    clearLog();

    var raw;
    try {
      raw = JSON.parse(stripFence(text));
    } catch (e) {
      say('err', 'JSON 을 읽을 수 없습니다: ' + esc(e.message));
      say('muted', '설명 문장이 섞이지 않게 <code>{</code> 로 시작해 <code>}</code> 로 끝나는 부분만 붙여넣으세요.');
      setActivity('err', 'JSON 형식 오류');
      pushAI('JSON 을 읽지 못했습니다. 위 기록을 펼쳐 확인해 주세요.');
      return;
    }

    var normalized;
    try {
      normalized = NormalizeMod.normalizeAuthoredDoc(raw);
    } catch (e) {
      say('err', '구조를 정리할 수 없습니다: ' + code(e.message));
      setActivity('err', '구조 오류');
      pushAI('활동지 구조를 알아볼 수 없습니다. 위 기록을 펼쳐 확인해 주세요.');
      return;
    }
    var doc = normalized.document;
    normalized.notes.forEach(function (n) { say('muted', '· ' + code(n)); });
    if (normalized.notes.length) say('muted', '위 ' + normalized.notes.length + '건은 앱이 자동으로 맞췄습니다.');

    // 1) 구조 검증(게이트)
    var review = new ValidateMod.ValidateObjectTree().execute(doc);
    review.findings.forEach(function (f) {
      var where = (f.objectId ? '<code>' + esc(f.objectId) + '</code> ' : '') + '[' + esc(f.rule) + '] ';
      say((f.severity || 'error') === 'error' ? 'err' : 'warn', where + esc(f.message));
    });
    if (!review.ok) {
      setActivity('err', '구조 검증에서 막힘');
      pushAI('구조 검증에서 막혔습니다. 위 기록의 빨간 줄을 그대로 복사해 “이 부분 고쳐서 다시 줘” 라고 말해 주세요.');
      return;
    }

    // 2) 실측 조판
    el.btnRun.disabled = true;
    var theme = resolveTheme(doc);
    var assets = { paperCss: WSG_ASSETS.paper, blocksCss: WSG_ASSETS.blocks, themeCss: WSG_THEMES[theme] || WSG_THEMES.ko };
    var meta = RenderMod.deriveRenderMeta(doc);
    meta.themeName = theme;
    if (!meta.dataSubject) meta.dataSubject = theme;
    setActivity('run', '쪽 나눔 측정 중…');

    var paginator = new PaginateMod.PaginateObjectTree({ measurer: browserMeasurer });
    paginator.execute(doc, assets, meta).then(function (result) {
      var paginated = result.document;
      state.pageCount = paginated.pages.length;
      var flow = paginated.pages.reduce(function (acc, p) { return acc.concat(p.flow || []); }, []);
      state.questionCount = flow.filter(function (o) { return o.type === 'question'; }).length;
      say('ok', '조판 완료 — A4 ' + state.pageCount + '쪽 (교과 테마: ' + theme + ')');

      // 3) 2벌 분기
      var variants = new VariantsMod.BuildVariants().executeObjectTree(paginated, assets, meta);

      // 4) 검수 게이트 — 구조(1층) + 렌더 실측(2층: 정답 누출·인쇄 안전·저작권 슬롯).
      //    정답이 마크 안에 온전히 있는 교사 벌을 검사해야 "밖으로 샌 정답"을 비교할 수 있다.
      var gate = new ReviewMod.ValidateWorksheet({ paper: meta.paper || null })
        .execute(paginated, variants.teacher);
      var blocking = [];
      gate.findings.forEach(function (f) {
        var where = (f.objectId ? '<code>' + esc(f.objectId) + '</code> ' : '') + '[' + esc(f.rule) + '] ';
        var detail = f.evidence ? ' — ' + esc(String(f.evidence)) : '';
        if (f.severity === 'error') { blocking.push(f); say('err', where + esc(f.message) + detail); }
        else say('warn', where + esc(f.message) + detail);
      });

      var residue = studentResidue(variants.student);
      if (residue.length) {
        blocking.push({ rule: 'student-answer-residue' });
        say('err', '학생용에 정답 텍스트가 남았습니다: ' + esc(residue[0].slice(0, 50)));
      }

      state.docTitle = (doc.docTitle || '활동지').replace(/[\\/:*?"<>|]/g, '_');

      if (blocking.length) {
        setActivity('err', '검수에서 막힘 — 교사용만 출력');
        setOutputs({ student: null, teacher: variants.teacher });
        state.mode = 'teacher';
        syncTabs();
        preview();
        pushAI('<b>학생용 출력을 막았습니다.</b> 정답이 학생 벌로 새어 나올 위험이 있어서예요 — 교사용만 인쇄할 수 있습니다.'
          + '<br>정답은 문항의 <code>answerKey</code> 로만 넣어야 학생용에서 지워집니다. “정답은 answerKey 에만 넣어서 다시 줘” 라고 말해 주세요.');
        return;
      }

      setActivity('ok', '검사 · 조판 완료 (' + state.pageCount + '쪽)');
      say('ok', '검수 통과 — 학생용 정답 제거 확인.');
      setOutputs(variants);
      preview();
      pushAI('<b>' + esc(doc.docTitle || '활동지') + '</b> 준비됐습니다. 오른쪽에서 확인하고 인쇄하세요.'
        + '<div class="meta"><span class="tag ok">A4 ' + state.pageCount + '쪽</span>'
        + '<span class="tag">문항 ' + state.questionCount + '개</span>'
        + '<span class="tag">학생용 · 교사용 2벌</span></div>');
      el.ask.placeholder = '예: 3번 문항 빼고 성찰 질문 추가해줘';
    }).catch(function (e) {
      say('err', '조판 중 오류: ' + esc(e && e.message ? e.message : String(e)));
      setActivity('err', '조판 실패');
      pushAI('조판 중 문제가 생겼습니다. 위 기록을 펼쳐 확인해 주세요.');
    }).then(function () {
      el.btnRun.disabled = false;
    });
  }

  function stripFence(text) {
    var m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    var body = m ? m[1].trim() : text;
    var first = body.search(/[[{]/);
    if (first > 0) body = body.slice(first);
    var lastBrace = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'));
    if (lastBrace !== -1 && lastBrace < body.length - 1) body = body.slice(0, lastBrace + 1);
    return body;
  }

  // ── 뷰어 ────────────────────────────────────────────────────────────────
  function setOutputs(variants) {
    state.variants = variants;
    var has = !!(variants && (variants.student || variants.teacher));
    el.btnPrint.disabled = !has;
    el.btnSaveHtml.disabled = !has;
    el.pageInfo.hidden = !has;
    el.tabStudent.disabled = !!(variants && !variants.student);
    if (has) el.pageInfo.textContent = 'A4 ' + state.pageCount + '쪽';
    el.empty.hidden = has;
  }

  function currentHtml() {
    if (!state.variants) return null;
    return state.mode === 'teacher' ? state.variants.teacher : state.variants.student;
  }

  function preview() {
    var html = currentHtml();
    if (!html) {
      writeIntoFrame(el.frame, '<!DOCTYPE html><meta charset="utf-8">'
        + '<body style="margin:0;display:grid;place-content:center;height:100vh;'
        + 'font:14px Pretendard,sans-serif;color:#c8281f;background:#eceef2">'
        + '이 벌은 출력이 막혀 있습니다.</body>');
      return;
    }
    writeIntoFrame(el.frame, html).then(fitPreview);
  }

  /**
   * A4(210mm ≈ 794px)는 미리보기 폭보다 넓어 잘려 보인다 — 화면에서만 축소해 한 장이 다 보이게 한다.
   * **`@media screen` 안에만 넣는 것이 핵심**이다: 인쇄는 같은 문서를 쓰므로 zoom 이 인쇄까지
   * 새면 조판이 어긋난다(측정·쪽 나눔은 이미 끝난 상태라 배율만 화면에 걸어야 한다).
   */
  function fitPreview() {
    var win = el.frame.contentWindow;
    var doc = win && win.document;
    if (!doc || !doc.body) return;
    var sheet = doc.querySelector('.sheet');
    if (!sheet) return;

    var style = doc.getElementById('wsg-fit');
    if (!style) {
      style = doc.createElement('style');
      style.id = 'wsg-fit';
      style.setAttribute('media', 'screen');
      doc.head.appendChild(style);
    }
    style.textContent = '';                       // 배율 없이 실제 폭을 잰다
    var paperPx = sheet.offsetWidth;
    if (!paperPx) return;
    var available = el.frame.clientWidth - 28;    // 좌우 여유
    var factor = Math.min(1, available / paperPx);
    if (factor < 0.99) style.textContent = 'body{zoom:' + factor.toFixed(4) + '}';
  }

  function syncTabs() {
    el.tabStudent.setAttribute('aria-selected', String(state.mode === 'student'));
    el.tabTeacher.setAttribute('aria-selected', String(state.mode === 'teacher'));
  }

  function printCurrent() {
    if (!currentHtml()) return;
    var win = el.frame.contentWindow; // 미리보기 프레임이 이미 이 벌을 담고 있다
    win.focus();
    setTimeout(function () { win.print(); }, 120);
  }

  function saveHtml() {
    var html = currentHtml();
    if (!html) return;
    var name = state.docTitle + '_' + (state.mode === 'teacher' ? '교사용' : '학생용') + '.html';
    var blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  // ── 설정 모달 ───────────────────────────────────────────────────────────
  function openSettings(pane) {
    el.settings.hidden = false;
    if (pane) selectPane(pane);
    var focusTarget = pane === 'json' ? el.src : el.apiKey;
    setTimeout(function () { try { focusTarget.focus(); } catch (e) { /* noop */ } }, 30);
  }
  function closeSettings() { el.settings.hidden = true; }
  function selectPane(name) {
    [].forEach.call(el.settings.querySelectorAll('.sheet-tabs button'), function (b) {
      b.setAttribute('aria-selected', String(b.dataset.pane === name));
    });
    [].forEach.call(el.settings.querySelectorAll('.pane'), function (p) {
      p.hidden = p.dataset.pane !== name;
    });
  }

  // ── 입력창 ──────────────────────────────────────────────────────────────
  var ASK_MIN_H = 34;   // 한 줄
  var ASK_MAX_H = 168;  // 그 이상은 스크롤
  function autoGrow() {
    el.ask.style.height = 'auto';
    var h = Math.max(ASK_MIN_H, Math.min(el.ask.scrollHeight, ASK_MAX_H));
    el.ask.style.height = h + 'px';
    el.btnAsk.disabled = el.ask.value.trim() === '';
  }

  // ── 이벤트 ──────────────────────────────────────────────────────────────
  el.ask.addEventListener('input', autoGrow);
  window.addEventListener('resize', function () {
    clearTimeout(fitPreview._t);
    fitPreview._t = setTimeout(fitPreview, 120);
  });
  el.btnPrint.addEventListener('click', printCurrent);
  el.btnSaveHtml.addEventListener('click', saveHtml);
  el.tabStudent.addEventListener('click', function () { state.mode = 'student'; syncTabs(); preview(); });
  el.tabTeacher.addEventListener('click', function () { state.mode = 'teacher'; syncTabs(); preview(); });

  el.btnSettings.addEventListener('click', function () { openSettings('ai'); });
  el.btnSettingsInline.addEventListener('click', function () { openSettings('ai'); });
  el.btnSettingsClose.addEventListener('click', closeSettings);
  el.settings.addEventListener('click', function (e) {
    if (e.target && e.target.hasAttribute && e.target.hasAttribute('data-close')) closeSettings();
  });
  [].forEach.call(el.settings.querySelectorAll('.sheet-tabs button'), function (b) {
    b.addEventListener('click', function () { selectPane(b.dataset.pane); });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !el.settings.hidden) closeSettings();
  });

  // 예시 요청 칩 — 그대로 보내 본다.
  [].forEach.call(document.querySelectorAll('.chip[data-ask]'), function (chip) {
    chip.addEventListener('click', function () {
      el.ask.value = chip.dataset.ask;
      autoGrow();
      ask(); // renderer-ai.js (같은 IIFE — 함수 선언은 호이스팅된다)
    });
  });

  // JSON 직접 넣기 패널
  el.btnRun.addEventListener('click', function () { closeSettings(); run(); });
  el.btnSample.addEventListener('click', function () {
    el.src.value = JSON.stringify(SAMPLE, null, 2);
    el.src.focus();
  });
  el.btnClear.addEventListener('click', function () { el.src.value = ''; el.src.focus(); });
  el.btnFile.addEventListener('click', function () { el.fileIn.click(); });
  el.fileIn.addEventListener('change', function (e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    readFileInto(file);
    e.target.value = '';
  });
  ['dragenter', 'dragover'].forEach(function (type) {
    el.src.addEventListener(type, function (e) { e.preventDefault(); el.src.classList.add('drop'); });
  });
  ['dragleave', 'drop'].forEach(function (type) {
    el.src.addEventListener(type, function () { el.src.classList.remove('drop'); });
  });
  el.src.addEventListener('drop', function (e) {
    e.preventDefault();
    var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) readFileInto(file);
  });
  function readFileInto(file) {
    var reader = new FileReader();
    reader.onload = function () {
      el.src.value = String(reader.result);
      closeSettings();
      run();
    };
    reader.readAsText(file, 'utf-8');
  }

  // 예시 활동지 — gem/knowledge/example-worksheet-science.json 을 빌드가 주입한다(같은 파일이
  // AI 프롬프트의 참고 예시로도 쓰인다 — 두 벌로 갈라지지 않게 한 곳에서만 관리).
  var SAMPLE = WSG_SAMPLE;

  /*__AI_MODULE__*/

  syncTabs();
  requestAnimationFrame(autoGrow);
})();
