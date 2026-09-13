// worker.js: roda fora da tela principal: decodifica o áudio, encontra as
// falas, separa os falantes e transcreve com o Whisper (tudo no navegador).

import {
  env,
  pipeline,
  AutoProcessor,
  AutoModelForAudioFrameClassification,
  AutoModel,
  AutoFeatureExtractor,
} from '../vendor/transformers.min.js?v=9';
import {
  Input, ALL_FORMATS, BlobSource, Output, WavOutputFormat, BufferTarget, Conversion,
} from '../vendor/mediabunny.min.mjs?v=9';
import * as dz from './diarize.js?v=9';

// ---------------------------------------------------------------------
// Configuração do ONNX Runtime (arquivos .wasm servidos pelo próprio site)
// ---------------------------------------------------------------------
const ORT_BASE = new URL('../vendor/ort/', import.meta.url).href;
const IS_SAFARI = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
env.allowLocalModels = false;
env.backends.onnx.wasm.wasmPaths = IS_SAFARI
  ? { mjs: ORT_BASE + 'ort-wasm-simd-threaded.mjs', wasm: ORT_BASE + 'ort-wasm-simd-threaded.wasm' }
  : { mjs: ORT_BASE + 'ort-wasm-simd-threaded.asyncify.mjs', wasm: ORT_BASE + 'ort-wasm-simd-threaded.asyncify.wasm' };
env.backends.onnx.wasm.numThreads = self.crossOriginIsolated
  ? Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1))
  : 1;

// Atenção ao nome das chaves de dtype: o transformers.js usa DUAS chaves para o
// mesmo arquivo do encoder. Na hora de criar a sessão ele procura por
// 'encoder_model' (o nome do arquivo), mas na hora de calcular o tamanho total
// do download ele procura por 'model' (o nome da sessão). Se faltar 'model', o
// cálculo cai no padrão fp32 e soma o `encoder_model.onnx_data` (2,55 GB) que
// nem chega a ser baixado: era isso que fazia a barra mostrar 4,16 GB em vez de
// 1,6 GB. Por isso as duas chaves aparecem sempre com o mesmo valor.
const dt = (encoder, decoder) => ({ model: encoder, encoder_model: encoder, decoder_model_merged: decoder });

// O q8 no processador (wasm) ficou bloqueado por um bug do ONNX Runtime até a
// versão 1.26 ("Missing required scale ... weight_merged_0_scale", issue 1707
// do transformers.js). Testado em 13/09/2026: corrigido a partir do ONNX
// Runtime 1.27, e o vendor/ agora traz um bundle do transformers.js 4.2.0
// montado com o 1.29. Por isso o processador volta ao q8, que além de rodar
// mais rápido é MENOR que o q4 nestes modelos (o decoder do base tem 51 MB em
// q8 contra 124 MB em q4). `reserva` é a cadeia de tentativas caso o primeiro
// dtype falhe ao criar a sessão.
export const MODELS = {
  turbo: {
    id: 'onnx-community/whisper-large-v3-turbo_timestamped',
    dtype: { webgpu: dt('fp16', 'q4'), webgpu_nof16: dt('q4', 'q4') },
  },
  small: {
    id: 'onnx-community/whisper-small_timestamped',
    dtype: { webgpu: dt('fp16', 'q4'), webgpu_nof16: dt('fp32', 'q4'), wasm: dt('q8', 'q8') },
    reserva: { wasm: [dt('q4', 'q4'), dt('fp32', 'q4')] },
  },
  base: {
    id: 'onnx-community/whisper-base_timestamped',
    // no processador começa pelo q8 (uns 75 MB): o fp32 estoura o limite do
    // navegador do iPhone, que derruba a aba por volta de 1 GB
    dtype: { webgpu: dt('fp32', 'q4'), webgpu_nof16: dt('fp32', 'q4'), wasm: dt('q8', 'q8') },
    reserva: { wasm: [dt('q4', 'q4'), dt('fp32', 'q4')] },
  },
};
const SEG_MODEL = 'onnx-community/pyannote-segmentation-3.0';
const EMB_MODEL = 'onnx-community/wespeaker-voxceleb-resnet34-LM';

// frases que o Whisper costuma "inventar" em silêncio/música
const HALLUCINATIONS = /amara\.org|adriana zanotto|legendas? pela comunidade|legendado por|transcri[çc][aã]o e legendas|www\.\S+\.com\.br$/i;

const post = (type, data = {}, transfer) => self.postMessage({ type, ...data }, transfer || []);

let cancelled = false;
const checkCancel = () => { if (cancelled) throw new Error('__cancelled__'); };

// cache dos modelos entre execuções
const loaded = { asrKey: null, asr: null, seg: null, segProc: null, emb: null, embFE: null };

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === 'cancel') { cancelled = true; return; }
  if (msg.type === 'run') {
    cancelled = false;
    try {
      await run(msg);
    } catch (err) {
      if (err && err.message === '__cancelled__') post('cancelled');
      else post('error', { message: humanError(err), code: err && err.code });
    }
  }
};

function humanError(err) {
  const m = String((err && err.message) || err || 'Erro desconhecido');
  if (/out of memory|OOM|allocation|Array buffer allocation failed|RangeError/i.test(m)) {
    return 'Faltou memória para este arquivo/modelo. Tente a qualidade "Equilibrada" ou "Rápida", ou um arquivo menor.';
  }
  if (/Failed to fetch|NetworkError|network/i.test(m)) {
    return 'Não consegui baixar o modelo de IA (conexão com huggingface.co). Confira a internet ou se a rede bloqueia esse site.';
  }
  return m;
}

// ---------------------------------------------------------------------
// Decodificação: qualquer vídeo/áudio → PCM mono 16 kHz (Float32)
// ---------------------------------------------------------------------
async function decodeFile(file) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const track = await input.getPrimaryAudioTrack();
  if (!track) {
    const err = new Error('Esse arquivo não tem trilha de áudio.');
    err.code = 'no_audio';
    throw err;
  }
  const output = new Output({ format: new WavOutputFormat(), target: new BufferTarget() });
  const conv = await Conversion.init({
    input,
    output,
    tracks: 'primary',
    video: { discard: true },
    audio: { numberOfChannels: 1, sampleRate: dz.SR, codec: 'pcm-s16', forceTranscode: true },
  });
  if (!conv.isValid) {
    const why = (conv.discardedTracks || []).map((d) => d.reason).join(', ');
    const err = new Error('Não consegui ler o áudio deste arquivo (' + (why || 'formato não suportado') + ').');
    err.code = 'decode_failed';
    throw err;
  }
  conv.onProgress = (p) => post('progress', { step: 'decode', value: p });
  await conv.execute();
  return wavToFloat32(output.target.buffer);
}

function wavToFloat32(buf) {
  const v = new DataView(buf);
  let p = 12, fmt = null;
  while (p + 8 <= v.byteLength) {
    const id = String.fromCharCode(v.getUint8(p), v.getUint8(p + 1), v.getUint8(p + 2), v.getUint8(p + 3));
    let size = v.getUint32(p + 4, true);
    const body = p + 8;
    if (id === 'fmt ') fmt = { bits: v.getUint16(body + 14, true), ch: v.getUint16(body + 2, true) };
    if (id === 'data') {
      if (size === 0xffffffff || body + size > v.byteLength) size = v.byteLength - body;
      const n = Math.floor(size / 2 / (fmt?.ch || 1));
      const out = new Float32Array(n);
      const ch = fmt?.ch || 1;
      for (let i = 0; i < n; i++) out[i] = v.getInt16(body + i * 2 * ch, true) / 32768;
      return out;
    }
    p = body + size + (size & 1);
  }
  throw new Error('WAV inválido');
}

// ---------------------------------------------------------------------
// Modelos
// ---------------------------------------------------------------------
function progressCb(label) {
  return (info) => {
    if (info.status === 'progress_total') {
      post('download', { label, loaded: info.loaded, total: info.total });
    }
  };
}

async function loadModels({ modelKey, device, f16, diarize }) {
  const spec = MODELS[modelKey];
  const dkey = device === 'webgpu' ? (f16 ? 'webgpu' : 'webgpu_nof16') : 'wasm';
  const dtype = spec.dtype[dkey] || spec.dtype.wasm;
  const asrKey = `${spec.id}|${device}|${JSON.stringify(dtype)}`;

  if (!loaded.seg) {
    post('status', { step: 'models', text: 'Detector de fala' });
    loaded.seg = await AutoModelForAudioFrameClassification.from_pretrained(SEG_MODEL, {
      device: 'wasm', dtype: 'fp32', progress_callback: progressCb('Detector de fala'),
    });
    loaded.segProc = await AutoProcessor.from_pretrained(SEG_MODEL);
  }
  checkCancel();
  if (diarize && !loaded.emb) {
    post('status', { step: 'models', text: 'Reconhecimento de voz' });
    loaded.emb = await AutoModel.from_pretrained(EMB_MODEL, {
      device: 'wasm', dtype: 'fp32', progress_callback: progressCb('Reconhecimento de voz'),
    });
    loaded.embFE = await AutoFeatureExtractor.from_pretrained(EMB_MODEL);
  }
  checkCancel();
  if (loaded.asrKey !== asrKey) {
    if (loaded.asr) { try { await loaded.asr.dispose(); } catch { /* ok */ } loaded.asr = null; }
    post('status', { step: 'models', text: 'Whisper' });
    // tentativas em ordem: o combinado para este aparelho, depois as reservas e,
    // por último, o processador (se a placa de vídeo falhar)
    const tentativas = [
      { device, dtype },
      ...((spec.reserva?.[dkey] || []).map((d) => ({ device, dtype: d }))),
    ];
    if (device === 'webgpu') {
      tentativas.push({ device: 'wasm', dtype: spec.dtype.wasm });
      for (const d of spec.reserva?.wasm || []) tentativas.push({ device: 'wasm', dtype: d });
    }
    let erro = null;
    for (const t of tentativas) {
      if (!t.dtype) continue;
      try {
        loaded.asr = await pipeline('automatic-speech-recognition', spec.id, {
          device: t.device, dtype: t.dtype, progress_callback: progressCb('Whisper'),
        });
        erro = null;
        break;
      } catch (err) {
        if (err.message === '__cancelled__') throw err;
        console.warn('falhou com', t, err);
        erro = err;
        post('status', { step: 'models', text: 'Whisper (outra versão)' });
      }
    }
    if (erro) {
      // mostra o que foi tentado: ajuda a diagnosticar sem abrir o console
      erro.message += ' [tentei: ' + tentativas.map((t) => `${t.device} ${t.dtype.model}/${t.dtype.decoder_model_merged}`).join(' + ') + ']';
      throw erro;
    }
    loaded.asrKey = asrKey;
  }
}

// ---------------------------------------------------------------------
// Execução principal
// ---------------------------------------------------------------------
async function run(msg) {
  const opts = msg.options;
  const t0 = performance.now();

  // 1) áudio
  post('step', { step: 'decode' });
  let audio = msg.pcm || null;
  if (!audio) audio = await decodeFile(msg.file);
  checkCancel();
  const duration = audio.length / dz.SR;
  if (duration < 0.3) throw new Error('O áudio é curto demais (ou está vazio).');
  post('audioInfo', { duration });

  // 2) modelos
  post('step', { step: 'models' });
  const diarizeWanted = opts.speakers !== 'off';
  await loadModels({ modelKey: opts.model, device: opts.device, f16: opts.f16, diarize: diarizeWanted });
  checkCancel();

  // 3) segmentação (VAD + falantes locais)
  post('step', { step: 'vad' });
  const windows = dz.planSegWindows(audio.length);
  const segOut = [];
  const turns = [];
  let segOk = true;
  try {
    for (let wi = 0; wi < windows.length; wi++) {
      checkCancel();
      const win = windows[wi];
      let chunk = audio.subarray(win.start, win.end);
      if (chunk.length < dz.SR) { // janelas muito curtas: completa com silêncio
        const padded = new Float32Array(dz.SR);
        padded.set(chunk);
        chunk = padded;
      }
      const inputs = await loaded.segProc(chunk);
      const { logits } = await loaded.seg(inputs);
      const [, numFrames, numClasses] = logits.dims;
      const { cls } = dz.decodePowerset(logits.data, numFrames, numClasses);
      const frameDur = dz.segFrameDuration(chunk.length);
      segOut.push({ win, cls, frameDur });
      for (const t of dz.windowTurns(win, cls, frameDur)) turns.push({ ...t, win: wi });
      if (wi % 5 === 0) post('progress', { step: 'vad', value: (wi + 1) / windows.length });
    }
  } catch (err) {
    if (err.message === '__cancelled__') throw err;
    console.warn('segmentação falhou, usando VAD por energia', err);
    segOk = false;
  }
  const mask = segOk ? dz.buildSpeechMask(segOut, duration) : dz.energyMask(audio);
  const regions = dz.maskToRegions(mask);
  post('progress', { step: 'vad', value: 1 });
  if (!regions.length) throw new Error('Não encontrei fala neste arquivo.');

  // 4) falantes
  let timeline = null;
  let numSpk = 1;
  let diarize = diarizeWanted && segOk && turns.length > 0;
  if (diarize) {
    post('step', { step: 'speakers' });
    try {
      const toEmbed = turns.filter((t) => t.end - t.start >= 0.6);
      for (let i = 0; i < toEmbed.length; i++) {
        checkCancel();
        const t = toEmbed[i];
        const slice = audio.subarray(Math.floor(t.start * dz.SR), Math.ceil(t.end * dz.SR));
        const feats = await loaded.embFE(slice);
        const out = await loaded.emb(feats);
        const tensor = out.embeddings || out.last_hidden_state || Object.values(out)[0];
        t.emb = dz.l2normalize(Float32Array.from(tensor.data));
        if (i % 10 === 0) post('progress', { step: 'speakers', value: (i + 1) / toEmbed.length });
      }
      const fixed = opts.speakers === 'auto' ? null : Number(opts.speakers);
      const labels = dz.clusterTurns(turns, { numSpeakers: fixed });
      numSpk = Math.max(1, ...labels.map((l) => l + 1));
      timeline = dz.buildTimeline(turns, labels, duration);
      post('progress', { step: 'speakers', value: 1 });
      post('speakersFound', { count: numSpk });
    } catch (err) {
      if (err.message === '__cancelled__') throw err;
      console.warn('separação de falantes falhou', err);
      diarize = false;
      timeline = null;
      numSpk = 1;
    }
  } else {
    post('step', { step: 'speakers', skip: true });
  }

  // 5) transcrição por trechos
  post('step', { step: 'asr' });
  const pieces = dz.planPieces(regions, audio);
  const totalSpeech = pieces.reduce((s, p) => s + (p.end - p.start), 0);
  let done = 0;
  const words = [];
  let wordMode = true;
  const tAsr = performance.now();
  const language = opts.language === 'auto' ? null : opts.language;

  for (let pi = 0; pi < pieces.length; pi++) {
    checkCancel();
    const piece = pieces[pi];
    const a = Math.floor(piece.start * dz.SR);
    const b = Math.min(audio.length, Math.ceil(piece.end * dz.SR));
    const clip = audio.slice(a, b);
    const pieceWords = await transcribePiece(clip, language, wordMode).catch(async (err) => {
      if (!wordMode || err.message === '__cancelled__') throw err;
      console.warn('timestamps por palavra falharam, usando por frase', err);
      wordMode = false;
      return transcribePiece(clip, language, false);
    });
    const pdur = piece.end - piece.start;
    const fresh = [];
    for (const w of pieceWords) {
      const s = Math.min(Math.max(0, w.start), pdur) + piece.start;
      const e = Math.min(Math.max(w.end ?? w.start + 0.3, w.start), pdur) + piece.start;
      const word = { text: w.text, start: s, end: Math.max(e, s + 0.05) };
      word.spk = timeline ? Math.max(0, dz.speakerAt(timeline, (word.start + word.end) / 2)) : 0;
      fresh.push(word);
    }
    const cleaned = cleanPiece(fresh);
    words.push(...cleaned);
    done += pdur;
    const elapsed = (performance.now() - tAsr) / 1000;
    const eta = done > 0 ? (elapsed / done) * (totalSpeech - done) : null;
    post('partial', { words: cleaned, value: done / totalSpeech, eta, piece: pi + 1, pieces: pieces.length });
  }

  if (timeline) dz.labelWords(words, timeline);

  post('result', {
    words,
    duration,
    diarized: !!diarize,
    speakers: Array.from({ length: numSpk }, (_, i) => i),
    wordMode,
    elapsed: (performance.now() - t0) / 1000,
    warning: diarizeWanted && !diarize ? 'Não foi possível separar os falantes neste arquivo.' : null,
  });
}

async function transcribePiece(clip, language, wordMode) {
  const out = await loaded.asr(clip, {
    language,
    task: 'transcribe',
    return_timestamps: wordMode ? 'word' : true,
  });
  const chunks = out.chunks || [];
  if (wordMode) {
    return chunks
      .filter((c) => c.text && c.text.trim())
      .map((c) => ({ text: c.text, start: c.timestamp[0] ?? 0, end: c.timestamp[1] }));
  }
  // modo frase: reparte o tempo da frase entre as palavras (aproximado)
  const res = [];
  for (const c of chunks) {
    const s = c.timestamp[0] ?? 0;
    const e = c.timestamp[1] ?? s + 2;
    const parts = c.text.trim().split(/\s+/).filter(Boolean);
    const totalChars = parts.reduce((n, p) => n + p.length + 1, 0);
    let acc = 0;
    for (const p of parts) {
      const ws = s + ((e - s) * acc) / totalChars;
      acc += p.length + 1;
      const we = s + ((e - s) * acc) / totalChars;
      res.push({ text: ' ' + p, start: ws, end: we });
    }
  }
  return res;
}

/** Remove alucinações conhecidas e laços de repetição do Whisper. */
function cleanPiece(words) {
  const text = words.map((w) => w.text).join('').trim();
  if (!text || HALLUCINATIONS.test(text)) {
    // descarta só se o trecho inteiro for a alucinação
    if (!text || text.length < 80) return [];
  }
  // laços: mesma sequência de 1 a 6 palavras repetida mais de 3 vezes seguidas
  const norm = words.map((w) => w.text.trim().toLowerCase().replace(/[.,!?;:…]/g, ''));
  const keep = new Array(words.length).fill(true);
  for (let n = 1; n <= 6; n++) {
    for (let i = 0; i + n * 4 <= words.length; i++) {
      let reps = 1;
      while (i + (reps + 1) * n <= words.length) {
        let same = true;
        for (let k = 0; k < n; k++) if (norm[i + k] !== norm[i + reps * n + k]) { same = false; break; }
        if (!same) break;
        reps++;
      }
      if (reps > 3) {
        for (let j = i + n; j < i + reps * n; j++) keep[j] = false;
        i += reps * n - 1;
      }
    }
  }
  return words.filter((_, i) => keep[i]);
}
