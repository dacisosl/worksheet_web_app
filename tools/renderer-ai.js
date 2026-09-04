// ══ AI 패널 — 활동지 초안을 브라우저에서 직접 생성한다 ══════════════════════
//
// 빌드가 renderer-app.js 의 /*__AI_MODULE__*/ 자리에 이 파일을 끼워 넣는다(같은 IIFE 안 —
// el/say/esc/run/stripFence 를 그대로 쓴다).
//
// 챗봇 복붙 경로와 **같은 규격·같은 프롬프트 문서**를 쓴다(WSG_PROMPT = tools/ai-system-prompt.md
// + gem/knowledge/worksheet-json-spec.md + 예시). 규격이 두 벌로 갈라지면 두 경로가 서로 다른
// 활동지를 만들기 때문이다.
//
// 성취기준은 내장 대장(WSG_STANDARDS)에서 후보를 추려 프롬프트에 동봉한다 — 모델이 코드를
// 지어내지 못하게 하는 유일한 실효 수단이다(원칙 3: 성취기준은 조회만).
//
// 공급자 2종(Gemini API · OpenRouter)을 같은 포트로 감싼다: listModels(key) / generate(...).
// 키는 이 브라우저 localStorage 에만 저장하고, 서버를 거치지 않고 각 API 로 직접 보낸다.

var LS_PROVIDER = 'wsg.ai.provider';
var chat = { history: [], busy: false }; // history: [{role:'user'|'model', text}]

function lsGet(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 사생활 보호 모드 */ } }
function lsDel(k) { try { localStorage.removeItem(k); } catch (e) { /* noop */ } }

// ── 성취기준 후보 검색(오프라인, 내장 대장) ────────────────────────────────
var STD_STOP = ['활동지', '학습지', '워크시트', '만들어줘', '만들어', '만들기', '제작', '수업', '차시',
  '학년', '단원', '주제', '관련', '대한', '대해', '문항', '학생', '해줘', '주세요', '부탁'];

function detectSchool(q) {
  if (/초등|초\s*[1-6]|초[1-6]/.test(q)) return '초등학교';
  if (/중등|중학|중\s*[1-3]|중[1-3]/.test(q)) return '중학교';
  if (/고등|고교|고\s*[1-3]|고[1-3]/.test(q)) return '고등학교';
  return '';
}
function queryTokens(q) {
  return q.replace(/[^가-힣A-Za-z0-9]+/g, ' ').split(' ').filter(function (t) {
    return t.length >= 2 && STD_STOP.indexOf(t) === -1;
  });
}
function detectGrade(q) {
  var m = q.match(/(?:초|중|고)\s*([1-6])/);
  if (m) return Number(m[1]);
  m = q.match(/([1-6])\s*학년/);
  return m ? Number(m[1]) : 0;
}
/** 학년군 표기('3~4', '1~3학년', '공통과목')가 해당 학년을 담는지. 범위로 안 읽히면 통과시킨다. */
function gradeAllows(band, grade) {
  if (!grade) return true;
  var m = String(band).match(/([1-9])\s*~\s*([1-9])/);
  if (!m) return true;
  return grade >= Number(m[1]) && grade <= Number(m[2]);
}

/** 학교급별로 존재하는 과목 인덱스 — 과목 감지를 그 학교급 안으로 제한하는 데 쓴다. */
var SUBJECTS_IN_SCHOOL = (function () {
  var map = {};
  WSG_STANDARDS.items.forEach(function (it) {
    if (!map[it[0]]) map[it[0]] = {};
    map[it[0]][it[1]] = true;
  });
  return map;
})();

/**
 * 질문에 등장한 과목(대장의 공식 과목명 기준). 점수 우선순위가 중요하다 —
 * 예전엔 '중2 과학' 의 '과학' 이 '통합과학1'·'스포츠 과학' 까지 같은 점수로 물어와 과목 필터가
 * 무력해졌고, '아시아' 가 '동아시아 역사 기행' 에 걸려 엉뚱한 학교급으로 튀었다(실측).
 *  1) 과목명이 질문에 그대로 있거나 토큰과 완전히 같으면 → 이름 길이 + 10 (정확 일치가 늘 이긴다)
 *  2) 과목명이 토큰을 부분 포함하면 → 토큰 길이
 * 최고점만 채택한다.
 */
function detectSubjects(q, tokens, schoolIdx) {
  var allowed = schoolIdx !== -1 ? SUBJECTS_IN_SCHOOL[schoolIdx] : null;
  var hits = [];
  WSG_STANDARDS.subjects.forEach(function (name, idx) {
    if (allowed && !allowed[idx]) return;
    var score = 0;
    if (q.indexOf(name) !== -1) score = name.length + 10;
    if (!score && tokens.indexOf(name) !== -1) score = name.length + 10;
    if (!score) {
      for (var i = 0; i < tokens.length; i++) {
        if (name.indexOf(tokens[i]) !== -1 && tokens[i].length > score) score = tokens[i].length;
      }
    }
    if (score) hits.push({ idx: idx, score: score });
  });
  if (!hits.length) return [];
  var best = 0;
  hits.forEach(function (h) { if (h.score > best) best = h.score; });
  return hits.filter(function (h) { return h.score === best; }).map(function (h) { return h.idx; });
}

/** 교과 하나를 통째로 보낼 수 있는 상한(건수). 이 아래면 추리지 않고 전부 보낸다. */
var WHOLE_SUBJECT_LIMIT = 150;

/** 교과를 못 좁혔을 때 주제어 점수로 보낼 최대 건수. */
var STD_SEARCH_LIMIT = 40;

/**
 * 성취기준 후보 추리기. **주제어 검색만으로는 부족하다** — 교과서 단원명(예: "옴의 법칙")은
 * 성취기준 문장에 아예 안 나오는 일이 흔하다(실측: [9과14-02] 원문에 '옴' 이 없다).
 * 그래서 학교급·교과가 확정되고 그 교과의 성취기준이 150건 이하면 **교과 전체를 보낸다**
 * (중학교 과학 87건 ≈ 8KB — 모델이 직접 고르게 하는 것이 가장 정확하다).
 * 교과를 못 좁혔을 때만 주제어 점수로 상위 몇 건을 추린다.
 */
function searchStandards(query, limit) {
  var schools = WSG_STANDARDS.schools;
  var subjects = WSG_STANDARDS.subjects;
  var grades = WSG_STANDARDS.grades;
  var items = WSG_STANDARDS.items; // [schoolIdx, subjectIdx, gradeIdx, code, text]
  var school = detectSchool(query);
  var schoolIdx = school ? schools.indexOf(school) : -1;
  var grade = detectGrade(query);
  var tokens = queryTokens(query);
  var subjectHits = detectSubjects(query, tokens, schoolIdx);

  function collect(useSubject, useSchool, useGrade) {
    var rows = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (useSchool && schoolIdx !== -1 && it[0] !== schoolIdx) continue;
      if (useSubject && subjectHits.length && subjectHits.indexOf(it[1]) === -1) continue;
      if (useGrade && !gradeAllows(grades[it[2]], grade)) continue;
      rows.push({ order: i, code: it[3], text: it[4],
        school: schools[it[0]], subject: subjects[it[1]], grade: grades[it[2]] });
    }
    return rows;
  }

  // 필터를 단계적으로 풀며 비지 않는 집합을 찾는다(과목 감지가 틀렸을 때 0건으로 끝나지 않게).
  var rows = collect(true, true, true);
  if (!rows.length) rows = collect(true, true, false);
  if (!rows.length) rows = collect(false, true, true);
  if (!rows.length) rows = collect(false, true, false);
  if (!rows.length) rows = collect(false, false, false);

  var narrowed = subjectHits.length > 0 || (schoolIdx !== -1 && rows.length <= WHOLE_SUBJECT_LIMIT);
  if (narrowed && rows.length <= WHOLE_SUBJECT_LIMIT) {
    return {
      school: school, grade: grade, mode: 'whole',
      subjects: unique(rows.map(function (r) { return r.subject; })),
      hits: rows,
    };
  }

  // 교과를 못 좁혔다 — 주제어 점수로 추린다(차선책).
  var scored = rows.map(function (r) {
    var score = 0;
    for (var t = 0; t < tokens.length; t++) {
      if (r.text.indexOf(tokens[t]) !== -1) score += 3;
      else if (r.subject.indexOf(tokens[t]) !== -1) score += 1;
    }
    return { row: r, score: score };
  }).filter(function (x) { return x.score > 0; });
  scored.sort(function (a, b) { return b.score - a.score || a.row.order - b.row.order; });
  var hits = scored.slice(0, limit).map(function (x) { return x.row; });

  return {
    school: school, grade: grade, mode: 'search',
    subjects: unique(hits.map(function (r) { return r.subject; })).slice(0, 6),
    hits: hits,
  };
}

function unique(list) {
  var out = [];
  list.forEach(function (v) { if (out.indexOf(v) === -1) out.push(v); });
  return out;
}

// ── 프롬프트 조립 ──────────────────────────────────────────────────────────
function systemInstruction() {
  return WSG_PROMPT.system
    + '\n\n---\n\n# 활동지 JSON 저작 규격\n\n' + WSG_PROMPT.spec
    + '\n\n---\n\n# 참고 예시 (형식만 참고하고 내용을 베끼지 않는다)\n\n' + WSG_PROMPT.example;
}
function firstUserMessage(request, found) {
  var where = [found.school, found.subjects.join(' / ')].filter(Boolean).join(' ');
  var head = '교사 요청: ' + request + '\n\n# 조회된 성취기준'
    + (found.mode === 'whole' ? ' (해당 교과 전체)' : ' (주제어로 추린 후보)')
    + (where ? ' — ' + where : '');

  if (!found.hits.length) {
    return head + '\n(찾지 못했습니다. `standards` 를 빈 배열로 두고 std-box 에서 `codes` 를 빼세요.)';
  }

  // 과목별로 묶어 보낸다 — 여러 과목이 섞였을 때 모델이 학교급·과목을 헷갈리지 않게.
  var groups = [];
  found.hits.forEach(function (h) {
    var key = h.school + ' ' + h.subject + ' · ' + h.grade;
    var g = groups.filter(function (x) { return x.key === key; })[0];
    if (!g) { g = { key: key, lines: [] }; groups.push(g); }
    g.lines.push('- ' + h.code + ' ' + h.text);
  });
  var body = groups.map(function (g) { return '## ' + g.key + '\n' + g.lines.join('\n'); }).join('\n\n');

  return head + '\n\n' + body
    + '\n\n위 목록에서 주제에 맞는 1~3개만 고르고, 코드와 문장을 글자 그대로 옮기세요. 목록에 없는 것은 쓰지 마세요.';
}

// ── 공급자 ────────────────────────────────────────────────────────────────
function httpText(url, opts) {
  return fetch(url, opts).then(function (res) {
    return res.text().then(function (text) { return { ok: res.ok, status: res.status, text: text }; });
  });
}
function errDetail(text) {
  try {
    var data = JSON.parse(text);
    return (data.error && (data.error.message || data.error.metadata)) || data.message || '';
  } catch (e) { return ''; }
}
function commonError(status, text, provider) {
  var detail = String(errDetail(text) || '').slice(0, 200);
  if (status === 401) return 'API 키가 인증되지 않았습니다 — ⚙ 에서 키를 다시 저장하세요.';
  if (status === 400 && /API[_ ]?key|api key/i.test(detail)) return 'API 키가 올바르지 않습니다 — ⚙ 에서 확인하세요.';
  if (status === 400) return '요청이 거부되었습니다: ' + (detail || '400');
  if (status === 402) return '크레딧이 부족합니다(OpenRouter 잔액을 확인하세요).';
  if (status === 403) return provider === 'gemini'
    ? '키에 권한이 없습니다(Generative Language API 사용 설정·지역 제한을 확인하세요).'
    : '접근이 거부되었습니다: ' + (detail || '403');
  if (status === 404) return '선택한 모델을 쓸 수 없습니다 — ⚙ 에서 [목록 새로고침] 후 다른 모델을 고르세요.';
  if (status === 429) return '사용 한도를 넘었습니다. 잠시 뒤 다시 시도하거나 다른 모델을 고르세요.';
  if (status >= 500) return '공급자 서버 오류입니다(' + status + '). 잠시 뒤 다시 시도하세요.';
  return '요청 실패(' + status + ') ' + detail;
}

var PROVIDERS = {
  gemini: {
    label: 'Google Gemini API',
    keyHint: 'AIza… 형식. 발급: <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer noopener">Google AI Studio</a>',
    base: 'https://generativelanguage.googleapis.com/v1beta',

    listModels: function (key) {
      return httpText(this.base + '/models?key=' + encodeURIComponent(key)).then(function (r) {
        if (!r.ok) throw new Error(commonError(r.status, r.text, 'gemini'));
        var models = (JSON.parse(r.text).models || []).filter(function (m) {
          return (m.supportedGenerationMethods || []).indexOf('generateContent') !== -1 && /gemini/i.test(m.name || '');
        }).map(function (m) {
          return { id: String(m.name).replace(/^models\//, ''), label: m.displayName || m.name, free: false };
        });
        // 빠르고 싼 모델을 먼저 — 활동지 한 장에는 충분하다.
        models.sort(function (a, b) {
          var fa = /flash/i.test(a.id) ? 0 : 1;
          var fb = /flash/i.test(b.id) ? 0 : 1;
          return fa - fb || a.id.localeCompare(b.id);
        });
        return models;
      });
    },

    generate: function (key, model, system, history, jsonMode) {
      var self = this;
      var body = {
        systemInstruction: { parts: [{ text: system }] },
        contents: history.map(function (t) { return { role: t.role, parts: [{ text: t.text }] }; }),
        generationConfig: { temperature: 0.7 },
      };
      if (jsonMode) body.generationConfig.responseMimeType = 'application/json';
      var url = this.base + '/models/' + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(key);
      return httpText(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }).then(function (r) {
        if (!r.ok) {
          // 일부 모델은 responseMimeType 을 거부한다 — 한 번은 빼고 재시도한다.
          if (r.status === 400 && jsonMode && /responseMimeType|response_mime_type/i.test(r.text)) {
            return self.generate(key, model, system, history, false);
          }
          throw new Error(commonError(r.status, r.text, 'gemini'));
        }
        var data = JSON.parse(r.text);
        var cand = (data.candidates || [])[0];
        if (!cand) {
          var blocked = (data.promptFeedback || {}).blockReason;
          throw new Error(blocked ? '요청이 안전 필터에 걸렸습니다(' + blocked + ').' : '응답이 비어 있습니다.');
        }
        var out = ((cand.content || {}).parts || []).map(function (p) { return p.text || ''; }).join('');
        return { text: out, truncated: cand.finishReason === 'MAX_TOKENS', reason: cand.finishReason || '' };
      });
    },
  },

  openrouter: {
    label: 'OpenRouter',
    keyHint: 'sk-or-… 형식. 발급: <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer noopener">openrouter.ai/keys</a>',
    base: 'https://openrouter.ai/api/v1',

    listModels: function () {
      // 모델 목록은 키 없이도 공개된다 — 키를 저장하기 전에 골라 볼 수 있다.
      return httpText(this.base + '/models').then(function (r) {
        if (!r.ok) throw new Error(commonError(r.status, r.text, 'openrouter'));
        var models = (JSON.parse(r.text).data || []).map(function (m) {
          var prompt = parseFloat((m.pricing || {}).prompt || '0');
          var params = m.supported_parameters || [];
          return {
            id: m.id,
            label: m.name || m.id,
            free: !(prompt > 0),
            price: prompt,
            json: params.indexOf('response_format') !== -1 || params.indexOf('structured_outputs') !== -1,
          };
        });
        // 구조화 출력을 지원하는 모델을 먼저(활동지는 JSON 이므로), 그 다음 무료·저가 순.
        models.sort(function (a, b) {
          if (a.json !== b.json) return a.json ? -1 : 1;
          if (a.free !== b.free) return a.free ? -1 : 1;
          return a.price - b.price || a.id.localeCompare(b.id);
        });
        return models;
      });
    },

    generate: function (key, model, system, history, jsonMode) {
      var self = this;
      var messages = [{ role: 'system', content: system }].concat(history.map(function (t) {
        return { role: t.role === 'model' ? 'assistant' : 'user', content: t.text };
      }));
      var body = { model: model, messages: messages, temperature: 0.7 };
      if (jsonMode) body.response_format = { type: 'json_object' };
      var headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key, 'X-Title': 'worksheet-grab' };
      // file:// 로 열면 origin 이 "null" 이라 보내지 않는다(OpenRouter 랭킹용 선택 헤더).
      if (location.protocol === 'http:' || location.protocol === 'https:') headers['HTTP-Referer'] = location.origin;
      return httpText(this.base + '/chat/completions', {
        method: 'POST', headers: headers, body: JSON.stringify(body),
      }).then(function (r) {
        if (!r.ok) {
          if (r.status === 400 && jsonMode && /response_format|json/i.test(r.text)) {
            return self.generate(key, model, system, history, false);
          }
          throw new Error(commonError(r.status, r.text, 'openrouter'));
        }
        var data = JSON.parse(r.text);
        if (data.error) throw new Error('요청이 거부되었습니다: ' + (data.error.message || '').slice(0, 200));
        var choice = (data.choices || [])[0];
        if (!choice) throw new Error('응답이 비어 있습니다.');
        var msg = choice.message || {};
        return {
          text: typeof msg.content === 'string' ? msg.content : '',
          truncated: choice.finish_reason === 'length',
          reason: choice.finish_reason || '',
        };
      });
    },
  },
};

function providerId() {
  var id = lsGet(LS_PROVIDER) || 'gemini';
  return PROVIDERS[id] ? id : 'gemini';
}
function provider() { return PROVIDERS[providerId()]; }
function keySlot() { return 'wsg.' + providerId() + '.key'; }
function modelSlot() { return 'wsg.' + providerId() + '.model'; }

// ── 모델 목록 UI ───────────────────────────────────────────────────────────
var modelCache = [];

/** 드롭다운에 한 번에 보일 모델 수 상한(OpenRouter 는 수백 개다 — 나머지는 검색칸으로 찾는다). */
var MODEL_SHOW_LIMIT = 200;

function priceLabel(m) {
  if (m.free) return '무료';
  if (!m.price) return '';
  return '$' + (m.price * 1000000).toFixed(2) + '/1M';
}
function fillModelSelect(filter) {
  var selected = lsGet(modelSlot());
  var needle = String(filter || '').trim().toLowerCase();
  var list = modelCache.filter(function (m) {
    if (!needle) return true;
    return (m.id + ' ' + m.label).toLowerCase().indexOf(needle) !== -1;
  }).slice(0, MODEL_SHOW_LIMIT);

  el.modelSel.innerHTML = '';
  if (!list.length) {
    var none = document.createElement('option');
    none.value = '';
    none.textContent = modelCache.length ? '검색 결과가 없습니다' : '[목록 새로고침] 을 누르세요';
    el.modelSel.appendChild(none);
    return;
  }
  list.forEach(function (m) {
    var opt = document.createElement('option');
    opt.value = m.id;
    var tags = [priceLabel(m), m.json === false ? 'JSON 미지원' : ''].filter(Boolean).join(' · ');
    opt.textContent = m.label + (tags ? '  [' + tags + ']' : '');
    if (m.id === selected) opt.selected = true;
    el.modelSel.appendChild(opt);
  });
  if (list.every(function (m) { return m.id !== selected; })) {
    el.modelSel.value = list[0].id;
    lsSet(modelSlot(), list[0].id);
  }
}

function refreshModels(quiet) {
  var key = lsGet(keySlot());
  var prov = provider();
  if (prov === PROVIDERS.gemini && !key) {
    if (!quiet) say('err', '먼저 Gemini API 키를 저장하세요(모델 목록도 키로 조회합니다).');
    return;
  }
  el.btnModelReload.disabled = true;
  prov.listModels(key).then(function (list) {
    modelCache = list;
    fillModelSelect(el.modelFilter.value);
    if (!quiet) {
      say('ok', '모델 ' + list.length + '개를 불러왔습니다.'
        + (list.length > MODEL_SHOW_LIMIT ? ' 목록에는 ' + MODEL_SHOW_LIMIT + '개까지 보입니다 — 검색칸으로 좁히세요.' : ''));
      if (list.some(function (m) { return m.free; })) {
        say('muted', '무료 모델은 품질과 한도가 들쭉날쭉합니다. 활동지가 자꾸 실패하면 `flash` 처럼 값싼 유료 모델을 고르세요.');
      }
    }
  }).catch(function (e) {
    if (!quiet) say('err', esc(e.message));
  }).then(function () {
    el.btnModelReload.disabled = false;
  });
}

function syncProviderUi() {
  var id = providerId();
  el.providerSel.value = id;
  el.keyHint.innerHTML = PROVIDERS[id].keyHint;
  el.apiKey.value = '';
  el.apiKey.placeholder = lsGet(keySlot()) ? '저장됨 (다시 입력하면 교체)' : (id === 'gemini' ? 'AIza…' : 'sk-or-…');
  modelCache = [];
  fillModelSelect('');
}

// ── 실행 ──────────────────────────────────────────────────────────────────
function ask() {
  var request = el.ask.value.trim();
  if (!request || chat.busy) return;

  var key = lsGet(keySlot());
  if (!key) {
    pushUser(request);
    pushAI('먼저 <b>AI 서비스와 키</b>를 등록해 주세요. 설정 창을 열어 두었습니다.'
      + '<br>키 없이 쓰려면 설정의 <b>JSON 직접 넣기</b> 탭에서 챗봇이 만든 활동지를 붙여넣으세요.');
    openSettings('ai');
    return;
  }
  var model = el.modelSel.value || lsGet(modelSlot());
  if (!model) {
    pushUser(request);
    pushAI('사용할 <b>모델</b>을 골라 주세요. 설정에서 [목록 새로고침] 을 누르면 목록이 채워집니다.');
    openSettings('ai');
    return;
  }

  pushUser(request);
  el.ask.value = '';
  autoGrow();

  var isFollowUp = chat.history.length > 0;
  var userText = request;
  beginActivity(isFollowUp ? '수정 요청 전송' : '성취기준 조회 · 초안 요청');

  if (isFollowUp) {
    say('muted', '앞서 만든 활동지를 함께 보내 고쳐 달라고 요청합니다(처음부터 새로 만들려면 ＋ 버튼).');
  } else {
    var found = searchStandards(request, STD_SEARCH_LIMIT);
    userText = firstUserMessage(request, found);
    var where = [found.school, found.subjects.slice(0, 3).join('/')].filter(Boolean).join(' ');
    say('muted', '성취기준 ' + found.hits.length + '건을 함께 보냅니다'
      + (where ? ' (' + esc(where) + ')' : '')
      + (found.mode === 'whole' ? ' — 해당 교과 전체' : ' — 주제어로 추린 후보') + '.');
    if (!found.hits.length) {
      say('warn', '성취기준을 찾지 못했습니다 — 학교급·교과를 넣어 다시 말하거나(예: "중2 과학 …") 코드를 직접 알려주세요.');
    } else if (found.mode === 'search') {
      say('warn', '교과를 좁히지 못했습니다 — "중2 과학 …"처럼 학교급·교과를 넣으면 성취기준이 더 정확해집니다.');
    }
  }
  say('muted', esc(model) + ' 에 요청했습니다.');

  var history = chat.history.concat([{ role: 'user', text: userText }]);
  chat.busy = true;
  el.btnAsk.disabled = true;
  var typing = pushTyping();

  provider().generate(key, model, systemInstruction(), history, true).then(function (out) {
    if (!out.text || !out.text.trim()) {
      throw new Error(out.truncated
        ? '응답이 길이 제한에 걸려 끊겼습니다 — "문항을 5개로 줄여줘"처럼 좁혀 요청하세요.'
        : '응답에 본문이 없습니다(' + (out.reason || '알 수 없음') + ').');
    }
    if (out.truncated) {
      say('warn', '응답이 길이 제한에 걸려 끊겼을 수 있습니다 — 조판이 실패하면 분량을 줄여 다시 요청하세요.');
    }
    var json = stripFence(out.text);
    el.src.value = json;
    chat.history = trimHistory(history.concat([{ role: 'model', text: json }]));
    say('ok', '초안을 받았습니다(' + Math.round(json.length / 1024) + 'KB).');
    typing.remove();
    run({ silentUser: true });
  }).catch(function (e) {
    var msg = e && e.message ? e.message : String(e);
    typing.remove();
    say('err', esc(msg));
    if (/Failed to fetch|NetworkError|network/i.test(msg)) {
      say('muted', '인터넷 연결이나 학교 방화벽을 확인하세요. 오프라인에서는 설정의 JSON 직접 넣기를 쓰세요.');
    }
    setActivity('err', '요청 실패');
    pushAI('요청이 실패했습니다: ' + esc(msg));
  }).then(function () {
    chat.busy = false;
    autoGrow();
  });
}

/** 대화 맥락은 최근 것만 남긴다 — 첫 요청(성취기준 후보 포함)과 마지막 2턴이면 수정에 충분하다. */
function trimHistory(list) {
  if (list.length <= 5) return list;
  return [list[0]].concat(list.slice(-4));
}

// ── 이벤트 ────────────────────────────────────────────────────────────────
el.btnAsk.addEventListener('click', ask);
el.ask.addEventListener('keydown', function (e) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask(); }
});
el.btnNew.addEventListener('click', function () {
  chat.history = [];
  el.ask.value = '';
  el.ask.placeholder = '중2 과학 옴의 법칙 활동지 만들어줘';
  el.src.value = '';
  autoGrow();
  resetThread();
  setOutputs(null);
  el.ask.focus();
});
el.providerSel.addEventListener('change', function () {
  lsSet(LS_PROVIDER, el.providerSel.value);
  chat.history = [];
  syncProviderUi();
  refreshModels(true);
});
el.btnKeySave.addEventListener('click', function () {
  var key = el.apiKey.value.trim();
  if (!key) { el.apiKey.focus(); return; }
  lsSet(keySlot(), key);
  el.apiKey.value = '';
  el.apiKey.placeholder = '저장됨 (다시 입력하면 교체)';
  beginActivity(PROVIDERS[providerId()].label + ' 키 저장');
  say('ok', '키를 이 브라우저에 저장했습니다. 모델 목록을 불러옵니다…');
  refreshModels(false);
});
el.btnKeyClear.addEventListener('click', function () {
  lsDel(keySlot());
  lsDel(modelSlot());
  el.apiKey.value = '';
  el.apiKey.placeholder = providerId() === 'gemini' ? 'AIza…' : 'sk-or-…';
});
el.btnModelReload.addEventListener('click', function () { refreshModels(false); });
el.modelFilter.addEventListener('input', function () { fillModelSelect(el.modelFilter.value); });
el.modelSel.addEventListener('change', function () { lsSet(modelSlot(), el.modelSel.value); });

syncProviderUi();
if (lsGet(keySlot()) || providerId() === 'openrouter') refreshModels(true);

// 진단용 창구 — "왜 이 성취기준이 후보에 안 나오나"를 콘솔에서 바로 확인할 수 있게 열어 둔다.
// 읽기 전용 조회 함수만 노출한다(키·대화 맥락은 노출하지 않는다).
window.WSG_DEBUG = {
  searchStandards: searchStandards,
  buildPrompt: function (request) {
    var found = searchStandards(request, STD_SEARCH_LIMIT);
    return { system: systemInstruction(), user: firstUserMessage(request, found), found: found };
  },
};
