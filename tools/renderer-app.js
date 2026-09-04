/**
 * renderer-app — 브라우저 단일 파일 렌더러의 앱 층(빌드 시 gem/worksheet-render.html 에 인라인).
 *
 * 역할: 챗봇(Gem/GPT/Claude)이 낸 활동지 JSON → 정규화 → 구조 검증(ValidateObjectTree)
 *       → 브라우저 실측 조판(PaginateObjectTree + iframe 측정 어댑터)
 *       → 학생용/교사용 2벌(BuildVariants: 정답 개체 트리 수준 물리 제거) → 미리보기·인쇄.
 *
 * 렌더 규칙은 하나도 여기서 다시 쓰지 않는다 — 전부 src/ 의 원본 모듈을 번들로 불러 쓴다.
 * 이 파일이 담당하는 것은 (1) LLM 출력 정규화, (2) Chrome 어댑터를 대신하는 iframe 측정,
 * (3) UI 와 인쇄 트리거뿐이다.
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
    src: $('src'), log: $('log'), frame: $('frame'), measure: $('measure'),
    btnRun: $('btnRun'), btnPrint: $('btnPrint'), btnSaveHtml: $('btnSaveHtml'),
    btnSample: $('btnSample'), btnClear: $('btnClear'), fileIn: $('fileIn'),
    tabStudent: $('tabStudent'), tabTeacher: $('tabTeacher'),
    pageInfo: $('pageInfo'), empty: $('empty'),
    // AI 패널(renderer-ai.js)
    ask: $('ask'), btnAsk: $('btnAsk'), btnNew: $('btnNew'), btnKeyToggle: $('btnKeyToggle'),
    keyPanel: $('keyPanel'), providerSel: $('providerSel'), keyHint: $('keyHint'),
    apiKey: $('apiKey'), btnKeySave: $('btnKeySave'), btnKeyClear: $('btnKeyClear'),
    modelSel: $('modelSel'), modelFilter: $('modelFilter'), btnModelReload: $('btnModelReload'),
  };

  var state = { variants: null, mode: 'student', docTitle: '활동지', pageCount: 0 };

  // ── 로그 ────────────────────────────────────────────────────────────────
  function clearLog() { el.log.innerHTML = ''; }
  function say(kind, msg) {
    var p = document.createElement('p');
    p.className = 't-' + kind;
    p.innerHTML = msg;
    el.log.appendChild(p);
    el.log.scrollTop = el.log.scrollHeight;
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  /** 정규화기·검증기가 주는 평문 메시지의 `백틱`을 <code> 로 바꿔 보여준다. */
  function code(s) {
    return esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');
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
              if (!ok) say('warn', 'KaTeX(수식) 스크립트를 불러오지 못했습니다 — 인터넷 연결이 없으면 수식이 원문 그대로 나오고 조판이 조금 어긋날 수 있습니다.');
              return { hadKatex: true, katexReady: ok };
            });
        }).then(function (gating) {
          return settle(win).then(function () {
            var els = [].slice.call(doc.querySelectorAll('[data-oid]'));
            var rects = els.map(function (node) {
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
  function run() {
    clearLog();
    setOutputs(null);
    var text = el.src.value.trim();
    if (!text) { say('err', '활동지 JSON을 먼저 붙여넣으세요.'); return; }

    var raw;
    try {
      raw = JSON.parse(stripFence(text));
    } catch (e) {
      say('err', 'JSON 을 읽을 수 없습니다: ' + esc(e.message));
      say('muted', '챗봇 답변에서 <code>{</code> 로 시작해 <code>}</code> 로 끝나는 부분만 복사했는지 확인하세요. 설명 문장이 섞이면 안 됩니다.');
      return;
    }

    var normalized;
    try {
      normalized = NormalizeMod.normalizeAuthoredDoc(raw);
    } catch (e) {
      say('err', '구조를 정리할 수 없습니다: ' + code(e.message));
      return;
    }
    var doc = normalized.document;
    normalized.notes.forEach(function (n) { say('muted', '· ' + code(n)); });

    // 1) 구조 검증(게이트)
    var review = new ValidateMod.ValidateObjectTree().execute(doc);
    review.findings.forEach(function (f) {
      var where = (f.objectId ? '<code>' + esc(f.objectId) + '</code> ' : '') + '[' + esc(f.rule) + '] ';
      say((f.severity || 'error') === 'error' ? 'err' : 'warn', where + esc(f.message));
    });
    if (!review.ok) {
      say('err', '구조 검증에서 막혔습니다 — 위 항목을 챗봇에 그대로 붙여 "이 부분을 고쳐서 JSON 다시 줘" 라고 요청하세요.');
      return;
    }

    // 2) 실측 조판 → 3) 2벌 분기
    el.btnRun.disabled = true;
    el.btnRun.textContent = '조판 중…';
    var theme = resolveTheme(doc);
    var assets = { paperCss: WSG_ASSETS.paper, blocksCss: WSG_ASSETS.blocks, themeCss: WSG_THEMES[theme] || WSG_THEMES.ko };
    var meta = RenderMod.deriveRenderMeta(doc);
    meta.themeName = theme;
    if (!meta.dataSubject) meta.dataSubject = theme;

    var paginator = new PaginateMod.PaginateObjectTree({ measurer: browserMeasurer });
    paginator.execute(doc, assets, meta).then(function (result) {
      var paginated = result.document;
      state.pageCount = paginated.pages.length;
      say('ok', '조판 완료 — A4 <b>' + state.pageCount + '쪽</b> (교과 테마: ' + theme + ')');

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

      if (blocking.length) {
        say('err', '학생용 출력을 막았습니다 — 교사용만 인쇄할 수 있습니다.');
        say('muted', '정답은 <code>question.answerKey</code> 또는 개체의 <code>answer:true</code> 로만 표시해야 학생용에서 제거됩니다. 위 항목을 그대로 AI/챗봇에 붙여 고쳐 달라고 하세요.');
        state.docTitle = (doc.docTitle || '활동지').replace(/[\\/:*?"<>|]/g, '_');
        setOutputs({ student: null, teacher: variants.teacher });
        state.mode = 'teacher';
        syncTabs();
        preview();
        return;
      }
      say('ok', '검수 통과 — 학생용 정답 제거 확인. 학생용/교사용 2벌 준비 완료.');
      state.docTitle = (doc.docTitle || '활동지').replace(/[\\/:*?"<>|]/g, '_');
      setOutputs(variants);
      preview();
    }).catch(function (e) {
      say('err', '조판 중 오류: ' + esc(e && e.message ? e.message : String(e)));
    }).then(function () {
      el.btnRun.disabled = false;
      el.btnRun.textContent = '검사 · 조판';
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

  function setOutputs(variants) {
    state.variants = variants;
    var has = !!(variants && (variants.student || variants.teacher));
    el.btnPrint.disabled = !has;
    el.btnSaveHtml.disabled = !has;
    el.pageInfo.hidden = !has;
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
      writeIntoFrame(el.frame, '<!DOCTYPE html><meta charset="utf-8"><body style="font:14px sans-serif;padding:24px;color:#cf222e">이 벌은 출력이 막혀 있습니다.</body>');
      return;
    }
    writeIntoFrame(el.frame, html);
  }

  function syncTabs() {
    el.tabStudent.setAttribute('aria-selected', String(state.mode === 'student'));
    el.tabTeacher.setAttribute('aria-selected', String(state.mode === 'teacher'));
  }

  function printCurrent() {
    var html = currentHtml();
    if (!html) return;
    var win = el.frame.contentWindow;
    // 미리보기 프레임이 이미 같은 벌을 담고 있다 — 그 문서를 그대로 인쇄한다.
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

  // ── 이벤트 ──────────────────────────────────────────────────────────────
  el.btnRun.addEventListener('click', run);
  el.btnPrint.addEventListener('click', printCurrent);
  el.btnSaveHtml.addEventListener('click', saveHtml);
  el.btnClear.addEventListener('click', function () {
    el.src.value = ''; clearLog(); setOutputs(null); el.src.focus();
  });
  el.btnSample.addEventListener('click', function () {
    el.src.value = JSON.stringify(SAMPLE, null, 2);
    clearLog();
    say('muted', '예시를 넣었습니다. <b>검사 · 조판</b> 을 눌러 보세요.');
  });
  el.tabStudent.addEventListener('click', function () { state.mode = 'student'; syncTabs(); preview(); });
  el.tabTeacher.addEventListener('click', function () { state.mode = 'teacher'; syncTabs(); preview(); });

  el.fileIn.addEventListener('change', function (e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () { el.src.value = String(reader.result); run(); };
    reader.readAsText(file, 'utf-8');
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
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () { el.src.value = String(reader.result); run(); };
    reader.readAsText(file, 'utf-8');
  });
  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); }
  });

  // ── 예시 활동지 ─────────────────────────────────────────────────────────
  // gem/knowledge/example-worksheet-science.json 을 빌드가 주입한다(같은 파일이 AI 프롬프트의
  // 참고 예시로도 쓰인다 — 두 벌로 갈라지지 않게 한 곳에서만 관리).
  var SAMPLE = WSG_SAMPLE;

  /*__AI_MODULE__*/

  syncTabs();
  say('muted', '준비됐습니다. 위에 요청을 적어 <b>AI로 만들기</b>, 또는 챗봇이 준 JSON을 붙여넣고 <b>검사 · 조판</b>(Ctrl+Enter).');
})();
