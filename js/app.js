// app.js: interface do TranscrevAI.
import {
  buildSegments, buildParagraphs, speakerName, tc, shortTc,
  toPlainText, toTimecodeText, toSRT, toVTT, toJSON, toDocxFiles, safeFileName,
} from './format.js';
import { pingExtension, needsExtension, fetchAudioViaExtension } from './bridge.js';
import { saveDoc, listDocs, getDoc, deleteDoc } from './store.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const COLORS = ['#E8341C', '#3EA6FF', '#3ECF8E', '#F2B33D', '#B57BFF', '#FF7AB6', '#2DD4BF', '#A3A3A3'];
const colorOf = (spk) => COLORS[spk % COLORS.length];

const MODEL_UI = {
  turbo: { label: 'Máxima', name: 'Whisper Large v3 Turbo', gpuOnly: true, desktopOnly: true, size: { webgpu: '1,6 GB', webgpu_nof16: '760 MB' } },
  small: { label: 'Equilibrada', name: 'Whisper Small', size: { webgpu: '410 MB', webgpu_nof16: '590 MB', wasm: '250 MB' } },
  base: { label: 'Rápida', name: 'Whisper Base', size: { webgpu: '150 MB', webgpu_nof16: '150 MB', wasm: '80 MB' } },
};

// Celular e tablet derrubam a aba quando o modelo não cabe na memória (por volta
// de 1 GB no iPhone). Por isso a qualidade Máxima só aparece no computador.
const IS_MOBILE = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
  || (navigator.maxTouchPoints > 1 && Math.min(screen.width, screen.height) < 820);

// iPhone, iPad e Safari usam o WebKit, e a versão do ONNX Runtime que vem com o
// transformers.js não traz o motor WebGPU para o WebKit (dá "webgpuInit is not a
// function"). Nesses navegadores o processamento vai pelo processador.
const IS_WEBKIT = /iP(hone|ad|od)/.test(navigator.userAgent)
  || (/^((?!chrome|android|crios|fxios|edg).)*safari/i.test(navigator.userAgent));

const state = {
  tab: 'file',
  file: null,
  caps: { webgpu: false, f16: false },
  ext: null,
  worker: null,
  busy: false,
  flag: null,
  doc: null,
  mediaUrl: null,
  run: null,
};

// ---------------------------------------------------------------------
// utilidades de UI
// ---------------------------------------------------------------------
let toastTimer;
function toast(msg, { error = false, ms = 3500 } = {}) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('err', error);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function show(view) {
  for (const v of ['viewInput', 'viewWork', 'viewResult']) $('#' + v).hidden = v !== view;
  window.scrollTo({ top: 0 });
}

const fmtBytes = (n) => (n >= 1e9 ? (n / 1e9).toFixed(2).replace('.', ',') + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(0) + ' MB' : Math.max(1, Math.round(n / 1e3)) + ' KB');
const fmtEta = (s) => {
  if (s == null || !isFinite(s)) return '';
  s = Math.round(s);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, '0')} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
};
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Google Analytics: só eventos de uso (qualidade, origem, duração). Nunca vai
// nome de arquivo, link completo nem uma palavra do texto transcrito.
function track(name, params = {}) {
  try { if (typeof window.gtag === 'function') window.gtag('event', name, params); } catch { /* ok */ }
}
const linkHost = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'outro'; } };

function lsGet(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* ok */ } }

// ---------------------------------------------------------------------
// capacidades (WebGPU) e extensão
// ---------------------------------------------------------------------
async function detectCaps() {
  try {
    if (IS_WEBKIT || !navigator.gpu) return { webgpu: false, f16: false };
    const ad = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!ad) return { webgpu: false, f16: false };
    return { webgpu: true, f16: ad.features.has('shader-f16') };
  } catch {
    return { webgpu: false, f16: false };
  }
}

function deviceKey() {
  if (!state.caps.webgpu) return 'wasm';
  return state.caps.f16 ? 'webgpu' : 'webgpu_nof16';
}

function fillModels() {
  const sel = $('#optModel');
  const dk = deviceKey();
  sel.innerHTML = '';
  for (const [key, m] of Object.entries(MODEL_UI)) {
    if (m.gpuOnly && !state.caps.webgpu) continue;
    if (m.desktopOnly && IS_MOBILE) continue;
    const o = document.createElement('option');
    o.value = key;
    o.textContent = m.label;
    sel.appendChild(o);
  }
  const saved = lsGet('tv_model', IS_MOBILE ? 'base' : state.caps.webgpu ? 'turbo' : 'small');
  sel.value = [...sel.options].some((o) => o.value === saved) ? saved : sel.options[0].value;
  updateModelHint();
}

function updateModelHint() {
  const key = $('#optModel').value;
  const dk = deviceKey();
  const size = MODEL_UI[key].size[dk] || MODEL_UI[key].size.wasm;
  const eng = state.caps.webgpu ? 'na placa de vídeo (WebGPU)' : 'no processador (sem WebGPU, mais lento)';
  const mobileNote = IS_MOBILE ? ' No celular a qualidade Máxima não cabe na memória, por isso ela só aparece no computador.' : '';
  $('#modelHint').textContent = `${MODEL_UI[key].name}: download único de ~${size} na primeira vez. Processamento ${eng}.` + mobileNote;
}

async function refreshExt() {
  const chip = $('#chipExt');
  state.ext = await pingExtension();
  chip.classList.remove('ok', 'warn', 'off');
  // sem extensão (ou com o ajudante fora do ar) aparece o atalho para a
  // página de instalação, que é o que outras pessoas precisam ver
  $('#btnInstallExt').hidden = IS_MOBILE || !!(state.ext && state.ext.host === 'ok');
  if (state.ext && state.ext.host === 'ok') {
    chip.textContent = 'BaixaAI conectado';
    chip.classList.add('ok');
  } else if (state.ext) {
    chip.textContent = 'BaixaAI: atualize o ajudante';
    chip.classList.add('warn');
    chip.title = state.ext.hostError || 'Rode o install.sh (Mac) ou install.ps1 (Windows) de novo.';
  } else {
    chip.textContent = 'BaixaAI não detectado';
    chip.classList.add('off');
  }
  // a resposta do ping chega depois da tela montar: revalida o campo de link
  // para liberar (ou travar) o botão Transcrever com o estado real da extensão
  validate();
}

// ---------------------------------------------------------------------
// entrada
// ---------------------------------------------------------------------
function setTab(tab) {
  state.tab = tab;
  $$('.tab').forEach((t) => {
    const on = t.dataset.tab === tab;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', on);
  });
  $$('.tabpane').forEach((p) => { p.hidden = p.dataset.pane !== tab; });
  validate();
}

function setFile(file) {
  state.file = file || null;
  const el = $('#dropFile');
  if (file) {
    el.textContent = `${file.name} · ${fmtBytes(file.size)}`;
    el.hidden = false;
  } else el.hidden = true;
  validate();
}

function validate() {
  let ok = false;
  if (state.tab === 'file') ok = !!state.file;
  else {
    const v = $('#linkInput').value.trim();
    ok = /^https?:\/\/\S+\.\S+/.test(v);
    const hint = $('#linkHint');
    hint.classList.remove('warn');
    if (ok && needsExtension(v) && !(state.ext && state.ext.host === 'ok')) {
      ok = false;
      hint.innerHTML = (state.ext
        ? 'Esse link precisa do BaixaAI, mas o ajudante local não respondeu. '
        : 'Esse link precisa da extensão BaixaAI instalada e ativa neste Chrome. Sem ela, baixe o vídeo e envie pela aba Arquivo. ')
        + '<a href="baixaai.html">Ver como instalar</a>';
      hint.classList.add('warn');
    } else {
      hint.textContent = 'YouTube, Instagram, TikTok, Facebook e Globo usam a extensão BaixaAI. Links diretos de arquivo (.mp3, .mp4) funcionam sem ela.';
    }
  }
  $('#btnStart').disabled = !ok || state.busy;
}

// ---------------------------------------------------------------------
// processamento
// ---------------------------------------------------------------------
function resetSteps(withFetch) {
  $$('#steps li').forEach((li) => {
    li.classList.remove('active', 'done', 'skip');
    $('.val', li).textContent = '';
  });
  $('#steps li[data-step="fetch"]').hidden = !withFetch;
  $('#barFill').style.width = '0%';
  $('#barText').textContent = 'Preparando…';
  $('#live').innerHTML = '';
}

const STEP_ORDER = ['fetch', 'decode', 'models', 'vad', 'speakers', 'asr'];
const STEP_WEIGHT = { fetch: 0, decode: 0.04, models: 0.06, vad: 0.05, speakers: 0.1, asr: 0.75 };

function setStep(step, { skip = false } = {}) {
  const idx = STEP_ORDER.indexOf(step);
  $$('#steps li').forEach((li) => {
    const i = STEP_ORDER.indexOf(li.dataset.step);
    if (i < idx && !li.classList.contains('skip')) { li.classList.remove('active'); li.classList.add('done'); }
    if (i === idx) {
      li.classList.toggle('active', !skip);
      li.classList.toggle('skip', skip);
    }
  });
  state.run.step = step;
  setOverall(0);
}

function stepVal(step, text) {
  const li = $(`#steps li[data-step="${step}"]`);
  if (li) $('.val', li).textContent = text;
}

function setOverall(frac, text) {
  const step = state.run.step;
  let base = 0;
  for (const s of STEP_ORDER) {
    if (s === step) break;
    base += STEP_WEIGHT[s];
  }
  const pct = Math.min(100, (base + STEP_WEIGHT[step] * Math.min(1, Math.max(0, frac))) * 100);
  $('#barFill').style.width = pct.toFixed(1) + '%';
  if (text != null) $('#barText').textContent = text;
}

function ensureWorker() {
  if (state.worker) return state.worker;
  const w = new Worker(new URL('./worker.js?v=9', import.meta.url), { type: 'module' });
  w.onmessage = (e) => onWorkerMessage(e.data);
  w.onerror = (e) => {
    console.error(e);
    fail('O processamento parou inesperadamente (' + (e.message || 'erro no worker') + ').');
    try { w.terminate(); } catch { /* ok */ }
    state.worker = null;
  };
  state.worker = w;
  return w;
}

async function start() {
  if (state.busy) return;
  const model = $('#optModel').value;
  const opts = {
    language: $('#optLang').value,
    model,
    speakers: $('#optSpk').value,
    device: state.caps.webgpu ? 'webgpu' : 'wasm',
    f16: state.caps.f16,
  };
  lsSet('tv_model', model);
  lsSet('tv_lang', opts.language);
  lsSet('tv_spk', opts.speakers);

  const isLink = state.tab === 'link';
  const url = $('#linkInput').value.trim();
  state.busy = true;
  document.body.classList.add('busy');
  state.flag = { cancelled: false };
  state.run = { step: 'decode', opts, words: [], duration: 0, title: '', startedAt: Date.now(), source: isLink ? url : state.file.name };
  resetSteps(isLink);
  show('viewWork');
  validate();
  track('transcricao_iniciada', {
    origem: isLink ? 'link' : 'arquivo',
    dominio: isLink ? linkHost(url) : 'arquivo',
    qualidade: MODEL_UI[model].label,
    motor: opts.device === 'webgpu' ? 'placa de video' : 'processador',
    falantes: opts.speakers,
    idioma: opts.language,
  });

  try {
    let file = state.file;
    if (isLink) {
      $('#workTitle').textContent = url;
      setStep('fetch');
      file = await getLinkMedia(url);
      $('#workTitle').textContent = file.name.replace(/\.[a-z0-9]+$/i, '');
    } else {
      $('#workTitle').textContent = file.name;
    }
    if (state.flag.cancelled) throw new Error('__cancelled__');
    state.run.file = file;
    state.run.title = file.name.replace(/\.[a-z0-9]+$/i, '');
    setMedia(file);
    ensureWorker().postMessage({ type: 'run', file, options: opts });
  } catch (err) {
    if (err.message === '__cancelled__') cancelled();
    else fail(err.message || String(err));
  }
}

async function getLinkMedia(url) {
  const viaExt = async () => {
    if (!state.ext) await refreshExt();
    if (!state.ext) throw new Error('Esse link precisa da extensão BaixaAI. Instale/ative a extensão neste Chrome, ou baixe o arquivo e use a aba Arquivo.');
    if (state.ext.host !== 'ok') throw new Error('O ajudante local do BaixaAI está desatualizado. Rode o instalador do BaixaAI de novo (install.sh no Mac ou install.ps1 no Windows).');
    return fetchAudioViaExtension(url, (st) => {
      if (st.state === 'starting') { stepVal('fetch', 'abrindo'); setOverall(0, 'O BaixaAI está abrindo o link…'); }
      else if (st.state === 'downloading') { stepVal('fetch', `${st.percent.toFixed(0)}%`); setOverall(0, `Baixando o áudio: ${st.percent.toFixed(0)}% · ${st.total || ''} · ${st.speed || ''}`); }
      else if (st.state === 'processing') { stepVal('fetch', 'convertendo'); setOverall(0, 'Convertendo o áudio…'); }
      else if (st.state === 'transfer') { stepVal('fetch', `${st.percent.toFixed(0)}%`); setOverall(0, 'Recebendo o áudio do BaixaAI…'); }
    }, state.flag);
  };

  if (needsExtension(url)) return viaExt();
  // link direto: tenta baixar pelo próprio navegador
  try {
    setOverall(0, 'Baixando o arquivo do link…');
    const resp = await fetch(url, { mode: 'cors' });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const type = resp.headers.get('content-type') || '';
    if (/text\/html/i.test(type)) throw new Error('não é arquivo de mídia');
    const blob = await resp.blob();
    const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'arquivo') || 'arquivo';
    return new File([blob], name, { type: blob.type || type });
  } catch (e) {
    if (state.ext && state.ext.host === 'ok') return viaExt();
    throw new Error('Não consegui baixar esse link direto pelo navegador (' + e.message + '). Com a extensão BaixaAI ativa isso funciona; sem ela, baixe o arquivo e envie pela aba Arquivo.');
  }
}

function setMedia(fileOrNull) {
  if (state.mediaUrl) URL.revokeObjectURL(state.mediaUrl);
  state.mediaUrl = fileOrNull ? URL.createObjectURL(fileOrNull) : null;
  const audio = $('#audio');
  if (state.mediaUrl) audio.src = state.mediaUrl;
  else audio.removeAttribute('src');
}

async function decodeInMain(file) {
  const ab = await file.arrayBuffer();
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  let buf;
  try { buf = await ctx.decodeAudioData(ab); } finally { ctx.close(); }
  const len = Math.ceil(buf.duration * 16000);
  const off = new OfflineAudioContext(1, len, 16000);
  const src = off.createBufferSource();
  src.buffer = buf;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  return rendered.getChannelData(0);
}

function onWorkerMessage(m) {
  if (!state.run) return;
  switch (m.type) {
    case 'step':
      setStep(m.step, { skip: m.skip });
      if (m.step === 'decode') setOverall(0, 'Extraindo e convertendo o áudio…');
      if (m.step === 'models') setOverall(0, 'Carregando modelos (na 1ª vez eles são baixados)…');
      if (m.step === 'vad') setOverall(0, 'Encontrando os trechos com fala…');
      if (m.step === 'speakers' && !m.skip) setOverall(0, 'Comparando as vozes…');
      if (m.step === 'asr') setOverall(0, 'Transcrevendo…');
      break;
    case 'status':
      if (m.step === 'models') stepVal('models', m.text);
      break;
    case 'download': {
      // sem mostrar o tamanho em GB: o número assusta e não muda nada para quem
      // já começou. A porcentagem e o "só na primeira vez" bastam.
      const pct = m.total ? (m.loaded / m.total) * 100 : 0;
      stepVal('models', `${m.label} ${pct.toFixed(0)}%`);
      setOverall(pct / 100, `Preparando o ${m.label} (só na primeira vez): ${pct.toFixed(0)}%`);
      break;
    }
    case 'progress':
      stepVal(m.step, `${Math.round(m.value * 100)}%`);
      setOverall(m.value);
      break;
    case 'audioInfo':
      state.run.duration = m.duration;
      stepVal('decode', shortTc(m.duration));
      break;
    case 'speakersFound':
      stepVal('speakers', m.count === 1 ? '1 voz' : `${m.count} vozes`);
      break;
    case 'partial':
      state.run.words.push(...m.words);
      stepVal('asr', `${Math.round(m.value * 100)}%`);
      setOverall(m.value, `Trecho ${m.piece} de ${m.pieces}` + (m.eta != null && m.piece > 1 ? ` · falta ~${fmtEta(m.eta)}` : ''));
      renderLive();
      break;
    case 'result':
      finish(m);
      break;
    case 'error':
      if (m.code === 'decode_failed' && state.run.file && !state.run.triedMainDecode) {
        state.run.triedMainDecode = true;
        decodeInMain(state.run.file)
          .then((pcm) => state.worker.postMessage({ type: 'run', pcm, options: state.run.opts }, [pcm.buffer]))
          .catch(() => fail(m.message));
      } else fail(m.message);
      break;
    case 'cancelled':
      cancelled();
      break;
    default:
      break;
  }
}

function renderLive() {
  const words = state.run.words;
  const segs = buildSegments(words);
  const paras = buildParagraphs(segs).slice(-6);
  const multi = state.run.opts.speakers !== 'off';
  const live = $('#live');
  live.innerHTML = paras
    .map((p) => `<p>${multi ? `<b style="color:${colorOf(p.spk)}">Locutor ${p.spk + 1}</b>` : ''}${escapeHtml(p.segs.map((s) => s.text).join(' '))}</p>`)
    .join('');
  live.scrollTop = live.scrollHeight;
}

function endBusy() {
  state.busy = false;
  document.body.classList.remove('busy');
  validate();
}

function fail(message) {
  track('transcricao_erro', {
    motivo: String(message || '').slice(0, 90),
    qualidade: state.run ? MODEL_UI[state.run.opts.model].label : 'desconhecida',
    motor: state.run && state.run.opts.device === 'webgpu' ? 'placa de video' : 'processador',
  });
  endBusy();
  state.run = null;
  show('viewInput');
  toast(message, { error: true, ms: 9000 });
}

function cancelled() {
  track('transcricao_cancelada');
  endBusy();
  state.run = null;
  show('viewInput');
  toast('Transcrição cancelada.');
}

async function finish(m) {
  const run = state.run;
  const words = m.words;
  const segments = buildSegments(words).map((s) => ({ ...s }));
  const doc = {
    id: 'd' + Date.now().toString(36),
    title: run.title || 'Transcrição',
    source: run.source,
    createdAt: Date.now(),
    duration: m.duration,
    language: run.opts.language,
    model: run.opts.model,
    diarized: m.diarized,
    speakers: m.diarized ? m.speakers : [0],
    names: {},
    segments,
    wordMode: m.wordMode,
    elapsed: m.elapsed,
  };
  state.doc = doc;
  state.run = null;
  endBusy();
  $$('#steps li').forEach((li) => { if (!li.classList.contains('skip')) { li.classList.remove('active'); li.classList.add('done'); } });
  if (!segments.length) {
    fail('Não saiu nenhum texto deste arquivo. Ele tem fala audível?');
    return;
  }
  track('transcricao_concluida', {
    qualidade: MODEL_UI[doc.model].label,
    motor: run.opts.device === 'webgpu' ? 'placa de video' : 'processador',
    duracao_s: Math.round(doc.duration || 0),
    tempo_s: Math.round(m.elapsed || 0),
    falantes_detectados: doc.diarized ? doc.speakers.length : 1,
  });
  await saveDoc(doc);
  renderResult();
  show('viewResult');
  if (m.warning) toast(m.warning, { ms: 6000 });
  else toast(`Pronto em ${fmtEta(m.elapsed)}.`);
}

// ---------------------------------------------------------------------
// resultado
// ---------------------------------------------------------------------
let saveTimer;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => state.doc && saveDoc(state.doc), 600);
}

function renderResult() {
  const doc = state.doc;
  $('#docTitle').value = doc.title;
  const bits = [shortTc(doc.duration)];
  if (doc.diarized) bits.push(doc.speakers.length === 1 ? '1 falante' : `${doc.speakers.length} falantes`);
  bits.push(MODEL_UI[doc.model]?.name || doc.model);
  bits.push(new Date(doc.createdAt).toLocaleDateString('pt-BR'));
  $('#docMeta').textContent = bits.join(' · ');
  renderSpeakers();
  renderTranscript();
  const hasMedia = !!state.mediaUrl;
  $('#player').hidden = !hasMedia;
  $('#noAudioHint').hidden = hasMedia;
}

function renderSpeakers() {
  const doc = state.doc;
  const box = $('#speakers');
  if (!doc.diarized) { box.innerHTML = ''; return; }
  box.innerHTML = doc.speakers
    .map((s) => `<button class="spk-chip" data-spk="${s}" title="Clique para renomear"><i style="background:${colorOf(s)}"></i><span>${escapeHtml(speakerName(doc.names, s))}</span><span class="pen">✎</span></button>`)
    .join('') + '<span class="hint">Clique num nome para renomear.</span>';
}

function renderTranscript() {
  const doc = state.doc;
  const paras = buildParagraphs(doc.segments);
  const idxOf = new Map(doc.segments.map((s, i) => [s, i]));
  $('#transcript').innerHTML = paras
    .map((p) => {
      const side = [
        doc.diarized ? `<span class="para-spk" data-spk="${p.spk}"><i style="background:${colorOf(p.spk)}"></i>${escapeHtml(speakerName(doc.names, p.spk))}</span>` : '',
        `<button class="para-tc" data-t="${p.start}">${tc(p.start)}</button>`,
      ].join('');
      const text = p.segs
        .map((s) => {
          const i = idxOf.get(s);
          return `<span class="seg${s.edited ? ' edited' : ''}" data-i="${i}">${escapeHtml(s.text)}</span>`;
        })
        .join(' ');
      return `<div class="para"><div class="para-side">${side}</div><div class="para-text">${text}</div></div>`;
    })
    .join('');
  applyEditMode();
}

function applyEditMode() {
  const on = $('#editMode').checked;
  document.body.classList.toggle('editing', on);
  $$('#transcript .seg').forEach((el) => {
    if (on) el.setAttribute('contenteditable', 'plaintext-only');
    else el.removeAttribute('contenteditable');
  });
}

function renameSpeaker(spk, chipEl) {
  const doc = state.doc;
  const input = document.createElement('input');
  input.value = speakerName(doc.names, spk);
  input.className = 'spk-chip';
  input.style.cursor = 'text';
  input.style.minWidth = '140px';
  chipEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const commit = (save) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (save) {
      if (v && v !== `Locutor ${spk + 1}`) doc.names[spk] = v;
      else delete doc.names[spk];
      saveSoon();
    }
    renderSpeakers();
    renderTranscript();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commit(true);
    if (e.key === 'Escape') commit(false);
  });
  input.addEventListener('blur', () => commit(true));
}

// sincronia com o player
let nowIdx = -1;
function onTime() {
  const doc = state.doc;
  if (!doc) return;
  const t = $('#audio').currentTime;
  const segs = doc.segments;
  let lo = 0, hi = segs.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segs[mid].start <= t) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (found >= 0 && t > segs[found].end + 1.5) found = -1;
  if (found === nowIdx) return;
  $$('#transcript .seg.now').forEach((el) => el.classList.remove('now'));
  nowIdx = found;
  if (found < 0) return;
  const el = $(`#transcript .seg[data-i="${found}"]`);
  if (el) {
    el.classList.add('now');
    if (!$('#audio').paused && !document.body.classList.contains('editing')) {
      const r = el.getBoundingClientRect();
      if (r.top < 80 || r.bottom > window.innerHeight - 110) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }
}

function seek(t) {
  const audio = $('#audio');
  if (!state.mediaUrl) { toast('Selecione o arquivo original para ouvir.'); return; }
  audio.currentTime = Math.max(0, t - 0.15);
  audio.play().catch(() => {});
}

// ---------------------------------------------------------------------
// exportação
// ---------------------------------------------------------------------
function download(name, data, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function exportAs(kind) {
  const doc = state.doc;
  track('exportar', { formato: kind, duracao_s: Math.round(doc.duration || 0) });
  const base = safeFileName(doc.title);
  if (kind === 'txt') download(`${base}.txt`, toPlainText(doc), 'text/plain;charset=utf-8');
  if (kind === 'tc') download(`${base}_timecode.txt`, toTimecodeText(doc), 'text/plain;charset=utf-8');
  if (kind === 'srt') download(`${base}.srt`, toSRT(doc), 'application/x-subrip;charset=utf-8');
  if (kind === 'vtt') download(`${base}.vtt`, toVTT(doc), 'text/vtt;charset=utf-8');
  if (kind === 'json') download(`${base}.json`, toJSON(doc), 'application/json;charset=utf-8');
  if (kind === 'docx') {
    const { zipSync, strToU8 } = await import('../vendor/fflate.mjs');
    const files = toDocxFiles(doc);
    const zipped = zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
    download(`${base}.docx`, new Blob([zipped], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }));
  }
}

// ---------------------------------------------------------------------
// histórico
// ---------------------------------------------------------------------
async function openDrawer() {
  const list = await listDocs();
  const ul = $('#histList');
  ul.innerHTML = list.length
    ? list.map((d) => `<li data-id="${d.id}"><div class="h-main"><div class="h-title">${escapeHtml(d.title)}</div><div class="h-meta">${new Date(d.createdAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })} · ${shortTc(d.duration)}${d.diarized ? ` · ${d.speakers.length} falantes` : ''}</div></div><button class="h-del" title="Apagar" aria-label="Apagar">×</button></li>`).join('')
    : '<li class="empty">Nenhuma transcrição ainda.</li>';
  $('#drawer').hidden = false;
  $('#scrim').hidden = false;
}
function closeDrawer() { $('#drawer').hidden = true; $('#scrim').hidden = true; }

async function openDoc(id) {
  const doc = await getDoc(id);
  if (!doc) return;
  if (state.busy) { toast('Espere a transcrição atual terminar.'); return; }
  state.doc = doc;
  setMedia(null);
  closeDrawer();
  renderResult();
  show('viewResult');
}

// ---------------------------------------------------------------------
// eventos
// ---------------------------------------------------------------------
function bind() {
  $$('.tab').forEach((t) => t.addEventListener('click', () => setTab(t.dataset.tab)));
  $('#fileInput').addEventListener('change', (e) => setFile(e.target.files[0]));
  const drop = $('#drop');
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) setFile(f); });
  $('#linkInput').addEventListener('input', validate);
  $('#linkInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !$('#btnStart').disabled) start(); });
  $('#optModel').addEventListener('change', updateModelHint);
  $('#btnStart').addEventListener('click', start);
  $('#btnCancel').addEventListener('click', () => {
    if (!state.run) return;
    state.flag.cancelled = true;
    if (state.worker) state.worker.postMessage({ type: 'cancel' });
    $('#barText').textContent = 'Cancelando…';
    // se o worker estiver preso num trecho longo, derruba e recria depois
    setTimeout(() => {
      if (state.run && state.busy) {
        try { state.worker.terminate(); } catch { /* ok */ }
        state.worker = null;
        cancelled();
      }
    }, 8000);
  });

  $('#btnNew').addEventListener('click', () => { setFile(null); $('#fileInput').value = ''; show('viewInput'); });
  $('#docTitle').addEventListener('input', (e) => { state.doc.title = e.target.value; saveSoon(); });
  $('#btnCopy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(toPlainText(state.doc)); toast('Texto copiado.'); } catch { toast('Não consegui copiar.', { error: true }); }
  });
  const menu = $('#menuExport');
  $('#btnExport').addEventListener('click', (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; $('#btnExport').setAttribute('aria-expanded', !menu.hidden); });
  document.addEventListener('click', () => { menu.hidden = true; });
  menu.addEventListener('click', (e) => { const b = e.target.closest('button[data-exp]'); if (b) exportAs(b.dataset.exp); });
  $('#btnInstallExt').addEventListener('click', () => track('abriu_guia_baixaai'));

  $('#speakers').addEventListener('click', (e) => { const c = e.target.closest('.spk-chip[data-spk]'); if (c) renameSpeaker(Number(c.dataset.spk), c); });
  $('#transcript').addEventListener('click', (e) => {
    const tcb = e.target.closest('.para-tc');
    if (tcb) { seek(Number(tcb.dataset.t)); return; }
    const sp = e.target.closest('.para-spk');
    if (sp && state.doc.diarized) {
      const chip = $(`#speakers .spk-chip[data-spk="${sp.dataset.spk}"]`);
      if (chip) renameSpeaker(Number(sp.dataset.spk), chip);
      return;
    }
    if (document.body.classList.contains('editing')) return;
    const seg = e.target.closest('.seg');
    if (seg) seek(state.doc.segments[Number(seg.dataset.i)].start);
  });
  $('#transcript').addEventListener('focusout', (e) => {
    const seg = e.target.closest && e.target.closest('.seg');
    if (!seg || !document.body.classList.contains('editing')) return;
    const s = state.doc.segments[Number(seg.dataset.i)];
    const v = seg.textContent.replace(/\s+/g, ' ').trim();
    if (v !== s.text) { s.text = v; s.edited = true; seg.classList.add('edited'); saveSoon(); }
  });
  $('#transcript').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.closest('.seg')) { e.preventDefault(); e.target.blur(); }
  });
  $('#editMode').addEventListener('change', applyEditMode);
  $('#audio').addEventListener('timeupdate', onTime);

  $('#btnAttach').addEventListener('click', () => $('#attachInput').click());
  $('#attachInput').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) return;
    setMedia(f);
    $('#player').hidden = false;
    $('#noAudioHint').hidden = true;
  });

  $('#btnHistory').addEventListener('click', openDrawer);
  $('#btnCloseDrawer').addEventListener('click', closeDrawer);
  $('#scrim').addEventListener('click', closeDrawer);
  $('#histList').addEventListener('click', async (e) => {
    const li = e.target.closest('li[data-id]');
    if (!li) return;
    if (e.target.closest('.h-del')) {
      await deleteDoc(li.dataset.id);
      li.remove();
      return;
    }
    openDoc(li.dataset.id);
  });

  window.addEventListener('beforeunload', (e) => { if (state.busy) { e.preventDefault(); e.returnValue = ''; } });
  window.addEventListener('focus', () => { if (!state.busy) refreshExt(); });
}

// ---------------------------------------------------------------------
// início
// ---------------------------------------------------------------------
async function init() {
  bind();
  $('#optLang').value = lsGet('tv_lang', 'pt');
  $('#optSpk').value = lsGet('tv_spk', 'auto');

  state.caps = await detectCaps();
  const chip = $('#chipEngine');
  chip.classList.add(state.caps.webgpu ? 'ok' : 'warn');
  chip.textContent = state.caps.webgpu ? 'WebGPU ativo' : 'Sem WebGPU (modo lento)';
  if (IS_WEBKIT) chip.title = 'Safari, iPhone e iPad ainda não rodam este motor na placa de vídeo.';
  if (!self.crossOriginIsolated && !state.caps.webgpu) chip.title = 'Sem isolamento de origem: o processador vai usar só 1 núcleo.';
  fillModels();

  const params = new URLSearchParams(location.search);
  const url = params.get('url');
  if (url) {
    $('#linkInput').value = url;
    setTab('link');
  }
  refreshExt();
  validate();
}

init();
