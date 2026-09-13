// diarize.js: lógica pura (sem modelos) de VAD, separação de falantes e
// planejamento dos trechos que vão para o Whisper. Tudo aqui é testável em
// Node com dados simulados; o worker só alimenta com as saídas dos modelos.

export const SR = 16000;

// ---------------------------------------------------------------------
// Janelas de segmentação (pyannote-segmentation-3.0)
// ---------------------------------------------------------------------

export const SEG_WIN_S = 10;   // o modelo foi treinado com janelas de 10 s
export const SEG_HOP_S = 9;    // 1 s de sobreposição entre janelas
export const SEG_MARGIN_S = 0.5; // cada janela "manda" só no miolo dela

// Classes "powerset" do pyannote 3.0: até 3 falantes locais, no máx. 2 ao mesmo tempo.
export const POWERSET = [[], [0], [1], [2], [0, 1], [0, 2], [1, 2]];

/** Lista as janelas de segmentação para um áudio de `n` amostras. */
export function planSegWindows(n) {
  const win = SEG_WIN_S * SR;
  const hop = SEG_HOP_S * SR;
  const margin = SEG_MARGIN_S * SR;
  const out = [];
  if (n <= win) {
    out.push({ start: 0, end: n, ownStart: 0, ownEnd: n });
    return out;
  }
  for (let s = 0; ; s += hop) {
    const e = Math.min(s + win, n);
    const last = e >= n;
    out.push({
      start: s,
      end: e,
      ownStart: s === 0 ? 0 : s + margin,
      ownEnd: last ? n : Math.min(e - margin, s + hop + margin),
    });
    if (last) break;
  }
  // corrige a posse para não haver buraco nem sobreposição
  for (let i = 1; i < out.length; i++) out[i].ownStart = out[i - 1].ownEnd;
  return out;
}

/** Duração (s) de cada frame de saída do pyannote para uma janela de `samples` amostras. */
export function segFrameDuration(samples, cfg = { offset: 990, step: 270 }) {
  const frames = (samples - cfg.offset) / cfg.step;
  return samples / frames / SR;
}

/**
 * Decodifica os logits de uma janela.
 * @param {Float32Array} logits  [numFrames * 7]
 * @returns {{cls: Uint8Array, prob: Float32Array}}
 */
export function decodePowerset(logits, numFrames, numClasses = 7) {
  const cls = new Uint8Array(numFrames);
  const prob = new Float32Array(numFrames); // prob. de haver fala
  for (let f = 0; f < numFrames; f++) {
    let best = 0, bestV = -Infinity, max = -Infinity;
    const o = f * numClasses;
    for (let c = 0; c < numClasses; c++) if (logits[o + c] > max) max = logits[o + c];
    let sum = 0;
    const ex = new Array(numClasses);
    for (let c = 0; c < numClasses; c++) { ex[c] = Math.exp(logits[o + c] - max); sum += ex[c]; }
    for (let c = 0; c < numClasses; c++) if (ex[c] > bestV) { bestV = ex[c]; best = c; }
    cls[f] = best;
    prob[f] = 1 - ex[0] / sum;
  }
  return { cls, prob };
}

/**
 * Transforma a saída de uma janela em (a) quadros de fala para o VAD global e
 * (b) "turnos locais" (trechos contínuos de um mesmo falante local).
 */
export function windowTurns(win, cls, frameDur) {
  const t0 = win.start / SR;
  const own0 = win.ownStart / SR;
  const own1 = win.ownEnd / SR;
  const turns = [];
  for (let k = 0; k < 3; k++) {
    let runStart = -1, lastActive = -1, solo = 0, total = 0;
    const flush = () => {
      if (runStart < 0) return;
      const s = Math.max(t0 + runStart * frameDur, own0);
      const e = Math.min(t0 + (lastActive + 1) * frameDur, own1);
      if (e - s >= 0.1) turns.push({ start: s, end: e, k, solo: total ? solo / total : 0 });
      runStart = -1; solo = 0; total = 0;
    };
    const gapFrames = Math.round(0.15 / frameDur);
    for (let f = 0; f < cls.length; f++) {
      const set = POWERSET[cls[f]] || [];
      const active = set.includes(k);
      if (active) {
        if (runStart >= 0 && f - lastActive > gapFrames) flush();
        if (runStart < 0) runStart = f;
        lastActive = f;
        total++;
        if (set.length === 1) solo++;
      }
    }
    flush();
  }
  return turns.filter((t) => t.end > t.start);
}

/**
 * Monta a máscara global de fala (resolução de 20 ms) a partir das janelas.
 * @param {Array<{win, cls, frameDur}>} windows
 */
export function buildSpeechMask(windows, totalSec, res = 0.02) {
  const n = Math.ceil(totalSec / res) + 1;
  const mask = new Uint8Array(n);
  for (const { win, cls, frameDur } of windows) {
    const t0 = win.start / SR;
    const own0 = win.ownStart / SR, own1 = win.ownEnd / SR;
    for (let f = 0; f < cls.length; f++) {
      if (cls[f] === 0) continue;
      const s = Math.max(t0 + f * frameDur, own0);
      const e = Math.min(t0 + (f + 1) * frameDur, own1);
      for (let i = Math.floor(s / res); i < Math.ceil(e / res) && i < n; i++) mask[i] = 1;
    }
  }
  return mask;
}

/** VAD de reserva por energia (caso o modelo de segmentação falhe). */
export function energyMask(audio, res = 0.02) {
  const hop = Math.round(res * SR);
  const n = Math.ceil(audio.length / hop);
  const rms = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    const a = i * hop, b = Math.min(a + hop, audio.length);
    for (let j = a; j < b; j++) s += audio[j] * audio[j];
    rms[i] = Math.sqrt(s / Math.max(1, b - a));
  }
  const sorted = Float32Array.from(rms).sort();
  const noise = sorted[Math.floor(n * 0.1)] || 0;
  const loud = sorted[Math.floor(n * 0.95)] || 0;
  const thr = Math.max(noise + (loud - noise) * 0.15, 0.003);
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) mask[i] = rms[i] > thr ? 1 : 0;
  return mask;
}

/** Converte a máscara em regiões [{start,end}] (s), unindo pausas curtas. */
export function maskToRegions(mask, res = 0.02, { minGap = 0.5, minDur = 0.2, pad = 0.15 } = {}) {
  const regions = [];
  let s = -1;
  for (let i = 0; i <= mask.length; i++) {
    const on = i < mask.length && mask[i];
    if (on && s < 0) s = i;
    if (!on && s >= 0) { regions.push({ start: s * res, end: i * res }); s = -1; }
  }
  const merged = [];
  for (const r of regions) {
    const last = merged[merged.length - 1];
    if (last && r.start - last.end < minGap) last.end = r.end;
    else merged.push({ ...r });
  }
  const total = mask.length * res;
  return merged
    .filter((r) => r.end - r.start >= minDur)
    .map((r) => ({ start: Math.max(0, r.start - pad), end: Math.min(total, r.end + pad) }));
}

// ---------------------------------------------------------------------
// Trechos para o Whisper (máx. ~28 s cada, cortando nas pausas)
// ---------------------------------------------------------------------

/** Acha o ponto de menor energia (s) dentro de [a,b]. */
export function quietestPoint(audio, a, b, win = 0.25) {
  const w = Math.round(win * SR);
  const i0 = Math.round(a * SR), i1 = Math.round(b * SR) - w;
  let best = i0, bestE = Infinity;
  const step = Math.round(0.02 * SR);
  for (let i = i0; i <= i1; i += step) {
    let e = 0;
    for (let j = i; j < i + w; j += 4) e += audio[j] * audio[j];
    if (e < bestE) { bestE = e; best = i; }
  }
  return (best + w / 2) / SR;
}

export function planPieces(regions, audio, { maxLen = 28, maxGap = 3, cutFrom = 16 } = {}) {
  const pieces = [];
  let cur = null;
  const push = () => { if (cur) pieces.push(cur); cur = null; };
  for (const r of regions) {
    let { start, end } = r;
    // região longa demais: quebra nas pausas internas
    while (end - start > maxLen) {
      if (cur) push();
      const cut = quietestPoint(audio, start + cutFrom, start + maxLen);
      pieces.push({ start, end: cut });
      start = cut;
    }
    if (!cur) { cur = { start, end }; continue; }
    if (end - cur.start <= maxLen && start - cur.end <= maxGap) cur.end = end;
    else { push(); cur = { start, end }; }
  }
  push();
  return pieces;
}

// ---------------------------------------------------------------------
// Agrupamento (AHC, ligação média, distância cosseno) via nearest-neighbor chain
// ---------------------------------------------------------------------

export function l2normalize(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  s = Math.sqrt(s) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / s;
  return out;
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/**
 * Retorna as fusões ordenadas por distância: [{a, b, dist}] (índices de pontos).
 * @param {Float32Array[]} X vetores normalizados
 */
export function ahcAverage(X) {
  const n = X.length;
  const D = new Float32Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = 1 - dot(X[i], X[j]);
      D[i * n + j] = d;
      D[j * n + i] = d;
    }
  }
  const active = new Uint8Array(n).fill(1);
  const size = new Int32Array(n).fill(1);
  const merges = [];
  const chain = [];
  let remaining = n;
  while (remaining > 1) {
    if (chain.length === 0) {
      for (let i = 0; i < n; i++) if (active[i]) { chain.push(i); break; }
    }
    let a, b;
    for (;;) {
      a = chain[chain.length - 1];
      const prev = chain.length > 1 ? chain[chain.length - 2] : -1;
      let best = -1, bestD = Infinity;
      for (let j = 0; j < n; j++) {
        if (j === a || !active[j]) continue;
        const d = D[a * n + j];
        if (d < bestD) { bestD = d; best = j; }
      }
      if (prev >= 0 && D[a * n + prev] <= bestD) best = prev;
      if (best === prev) { b = prev; break; }
      chain.push(best);
    }
    chain.pop(); chain.pop();
    const dist = D[a * n + b];
    merges.push({ a, b, dist });
    const sa = size[a], sb = size[b];
    for (let k = 0; k < n; k++) {
      if (!active[k] || k === a || k === b) continue;
      const d = (sa * D[a * n + k] + sb * D[b * n + k]) / (sa + sb);
      D[b * n + k] = d;
      D[k * n + b] = d;
    }
    size[b] = sa + sb;
    active[a] = 0;
    remaining--;
  }
  merges.sort((x, y) => x.dist - y.dist);
  return merges;
}

/** Corta o dendrograma: por número de grupos (k) ou por limiar de distância. */
export function cutMerges(n, merges, { k = null, threshold = 0.7 } = {}) {
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  let groups = n;
  for (const m of merges) {
    if (k != null ? groups <= k : m.dist > threshold) break;
    const ra = find(m.a), rb = find(m.b);
    if (ra !== rb) { parent[ra] = rb; groups--; }
  }
  const labelOf = new Map();
  const labels = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!labelOf.has(r)) labelOf.set(r, labelOf.size);
    labels[i] = labelOf.get(r);
  }
  return labels;
}

/**
 * Agrupa os turnos locais em falantes globais.
 * @param {Array<{start,end,win,k,emb?:Float32Array}>} turns (emb já normalizado)
 * @param {{numSpeakers?: number|null, threshold?: number}} opts
 * @returns {number[]} rótulo de falante por turno (0..S-1, ordem de 1ª aparição)
 */
export function clusterTurns(turns, { numSpeakers = null, threshold = 0.7, maxPoints = 2000 } = {}) {
  const withEmb = turns.map((t, i) => ({ t, i })).filter((x) => x.t.emb);
  if (withEmb.length === 0) return turns.map(() => 0);
  if (numSpeakers === 1) return turns.map(() => 0);

  // pontos "confiáveis" para o agrupamento: turnos mais longos e limpos
  let pts = withEmb.filter((x) => x.t.end - x.t.start >= 1.0 && (x.t.solo ?? 1) >= 0.6);
  if (pts.length < Math.max(2, numSpeakers || 2)) pts = withEmb.slice();
  if (pts.length > maxPoints) {
    pts = pts.slice().sort((p, q) => (q.t.end - q.t.start) - (p.t.end - p.t.start)).slice(0, maxPoints);
  }
  const X = pts.map((p) => p.t.emb);
  let labels;
  if (X.length === 1) labels = new Int32Array([0]);
  else {
    const merges = ahcAverage(X);
    labels = cutMerges(X.length, merges, { k: numSpeakers, threshold });
  }

  // centróides e duração por grupo
  const dim = X[0].length;
  let groups = [];
  const nG = Math.max(...labels) + 1;
  for (let g = 0; g < nG; g++) groups.push({ sum: new Float32Array(dim), dur: 0, count: 0 });
  pts.forEach((p, idx) => {
    const g = groups[labels[idx]];
    const w = p.t.end - p.t.start;
    for (let d = 0; d < dim; d++) g.sum[d] += p.t.emb[d] * w;
    g.dur += w; g.count++;
  });

  // no modo automático, grupos minúsculos provavelmente são ruído: absorve
  if (numSpeakers == null && groups.length > 1) {
    const totalDur = groups.reduce((s, g) => s + g.dur, 0);
    const minDur = Math.max(3, totalDur * 0.015);
    const big = groups.filter((g) => g.dur >= minDur);
    if (big.length >= 1) groups = big;
  }
  const centroids = groups.map((g) => l2normalize(g.sum));

  // atribui todo turno com embedding ao centróide mais próximo
  const out = new Array(turns.length).fill(-1);
  for (const { t, i } of withEmb) {
    let best = 0, bestS = -Infinity;
    centroids.forEach((c, g) => { const s = dot(c, t.emb); if (s > bestS) { bestS = s; best = g; } });
    out[i] = best;
  }

  // turnos curtos sem embedding: herdam o rótulo majoritário do mesmo falante
  // local na mesma janela; se não houver, o do turno rotulado mais próximo
  const byLocal = new Map();
  turns.forEach((t, i) => {
    if (out[i] < 0) return;
    const key = t.win + ':' + t.k;
    const m = byLocal.get(key) || new Map();
    m.set(out[i], (m.get(out[i]) || 0) + (t.end - t.start));
    byLocal.set(key, m);
  });
  turns.forEach((t, i) => {
    if (out[i] >= 0) return;
    const m = byLocal.get(t.win + ':' + t.k);
    if (m) {
      out[i] = [...m.entries()].sort((a, b) => b[1] - a[1])[0][0];
      return;
    }
    let best = 0, bestD = Infinity;
    turns.forEach((u, j) => {
      if (out[j] < 0 || j === i) return;
      const d = Math.abs((u.start + u.end) / 2 - (t.start + t.end) / 2);
      if (d < bestD) { bestD = d; best = out[j]; }
    });
    out[i] = best;
  });

  // renumera pela ordem da primeira fala
  const order = new Map();
  turns
    .map((t, i) => ({ s: t.start, l: out[i] }))
    .sort((a, b) => a.s - b.s)
    .forEach(({ l }) => { if (!order.has(l)) order.set(l, order.size); });
  return out.map((l) => order.get(l));
}

/**
 * Linha do tempo de falantes (resolução de 20 ms). Turnos mais longos têm
 * prioridade em trechos de fala sobreposta.
 */
export function buildTimeline(turns, labels, totalSec, res = 0.02) {
  const n = Math.ceil(totalSec / res) + 1;
  const tl = new Int16Array(n).fill(-1);
  const idx = turns.map((t, i) => i).sort((a, b) => (turns[a].end - turns[a].start) - (turns[b].end - turns[b].start));
  for (const i of idx) {
    const t = turns[i];
    for (let f = Math.floor(t.start / res); f < Math.ceil(t.end / res) && f < n; f++) tl[f] = labels[i];
  }
  return tl;
}

/** Falante no instante `t` (procura o quadro rotulado mais próximo em até `radius` s). */
export function speakerAt(tl, t, res = 0.02, radius = 1.5) {
  const f = Math.round(t / res);
  if (f >= 0 && f < tl.length && tl[f] >= 0) return tl[f];
  const r = Math.round(radius / res);
  for (let d = 1; d <= r; d++) {
    if (f - d >= 0 && f - d < tl.length && tl[f - d] >= 0) return tl[f - d];
    if (f + d >= 0 && f + d < tl.length && tl[f + d] >= 0) return tl[f + d];
  }
  return -1;
}

/**
 * Atribui falante a cada palavra e suaviza trocas espúrias.
 * @param {Array<{text,start,end}>} words
 */
export function labelWords(words, tl, res = 0.02) {
  let prev = 0;
  for (const w of words) {
    const s = speakerAt(tl, (w.start + w.end) / 2, res);
    w.spk = s >= 0 ? s : prev;
    prev = w.spk;
  }
  // 1) palavra solta (<0.6 s, sem pontuação final) entre o mesmo falante → absorve.
  //    Respostas curtas de verdade ("Sim.") costumam vir com pontuação e ficam.
  for (let i = 1; i < words.length - 1; i++) {
    const a = words[i - 1].spk;
    const w = words[i];
    if (w.spk === a || words[i + 1].spk !== a) continue;
    if (w.end - w.start < 0.6 && !/[.?!…]["”')\]]*$/.test(w.text.trim())) w.spk = a;
  }
  // 2) desloca trocas de falante para a pontuação mais próxima (±2 palavras)
  const endsSentence = (t) => /[.?!…]["”')\]]*$/.test(t.trim());
  for (let i = 1; i < words.length; i++) {
    if (words[i].spk === words[i - 1].spk) continue;
    if (endsSentence(words[i - 1].text)) continue;
    // procura fim de frase logo antes (a troca veio tarde) ou logo depois (veio cedo)
    for (let d = 1; d <= 2; d++) {
      const back = i - 1 - d;
      if (back >= 0 && endsSentence(words[back].text) && words[back].spk === words[i - 1].spk) {
        for (let x = back + 1; x < i; x++) words[x].spk = words[i].spk;
        break;
      }
      const fwd = i - 1 + d;
      if (fwd < words.length && endsSentence(words[fwd].text) && (fwd + 1 >= words.length || words[fwd + 1].spk === words[i].spk)) {
        for (let x = i; x <= fwd; x++) words[x].spk = words[i - 1].spk;
        break;
      }
    }
  }
  return words;
}
