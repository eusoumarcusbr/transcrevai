// bridge.js: conversa com a extensão BaixaAI (links de YouTube, Instagram etc.).
// A extensão declara este site em "externally_connectable", então a página
// ganha chrome.runtime.sendMessage(ID_DA_EXTENSAO, ...).

export const EXT_ID = 'dflppeifdophmkfncbkkafpfnbnfhajp';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function extensionApiAvailable() {
  return !!(globalThis.chrome && chrome.runtime && typeof chrome.runtime.sendMessage === 'function');
}

function send(msg, timeout = 20000) {
  return new Promise((resolve, reject) => {
    if (!extensionApiAvailable()) return reject(new Error('Extensão BaixaAI não encontrada neste navegador.'));
    const timer = setTimeout(() => reject(new Error('A extensão BaixaAI não respondeu.')), timeout);
    try {
      chrome.runtime.sendMessage(EXT_ID, msg, (resp) => {
        clearTimeout(timer);
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve(resp);
      });
    } catch (e) {
      clearTimeout(timer);
      reject(e);
    }
  });
}

/** Retorna {ok, version, host} ou null se a extensão não estiver instalada. */
export async function pingExtension() {
  if (!extensionApiAvailable()) return null;
  try {
    const r = await send({ type: 'TRANSCREVAI_PING' }, 6000);
    return r && r.ok ? r : null;
  } catch {
    return null;
  }
}

/** Sites que precisam do BaixaAI (yt-dlp). */
export function needsExtension(url) {
  try {
    const h = new URL(url).hostname.replace(/^www\.|^m\./, '');
    return /(^|\.)(youtube\.com|youtu\.be|instagram\.com|tiktok\.com|facebook\.com|fb\.watch|globo\.com|vimeo\.com|x\.com|twitter\.com|kwai\.com|threads\.net|drive\.google\.com|soundcloud\.com|spotify\.com)$/.test(h);
  } catch {
    return false;
  }
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Pede ao BaixaAI para baixar só o áudio do link e devolve um File.
 * @param {string} url
 * @param {(s: {state: string, percent?: number, speed?: string, eta?: string}) => void} onStatus
 * @param {{cancelled: boolean}} flag
 */
export async function fetchAudioViaExtension(url, onStatus, flag = {}) {
  const start = await send({ type: 'TRANSCREVAI_AUDIO', url }, 30000);
  if (!start || !start.ok) throw new Error((start && start.error) || 'O BaixaAI não conseguiu iniciar o download.');
  const jobId = start.jobId;

  let unknownSince = Date.now();
  for (;;) {
    if (flag.cancelled) throw new Error('__cancelled__');
    await sleep(1200);
    let st;
    try { st = await send({ type: 'TRANSCREVAI_STATUS', jobId }, 15000); } catch { st = { state: 'unknown' }; }
    if (!st || st.state === 'unknown') {
      if (Date.now() - unknownSince > 45000) throw new Error('O ajudante local do BaixaAI parou de responder.');
      continue;
    }
    unknownSince = Date.now();
    onStatus(st);
    if (st.state === 'done') break;
    if (st.state === 'error') throw new Error(st.message || 'Erro no download pelo BaixaAI.');
  }

  const parts = [];
  let offset = 0;
  let meta = null;
  for (;;) {
    if (flag.cancelled) throw new Error('__cancelled__');
    const r = await send({ type: 'TRANSCREVAI_READ', jobId, offset }, 30000);
    if (!r || !r.ok) throw new Error((r && r.error) || 'Falha ao receber o áudio do BaixaAI.');
    const bytes = b64ToBytes(r.data);
    parts.push(bytes);
    offset += bytes.length;
    meta = r;
    onStatus({ state: 'transfer', percent: r.total ? (offset / r.total) * 100 : 0 });
    if (r.eof || bytes.length === 0) break;
  }
  send({ type: 'TRANSCREVAI_CLEANUP', jobId }, 8000).catch(() => {});
  const name = (meta.title || 'audio') + '.' + (meta.ext || 'ogg');
  return new File(parts, name, { type: meta.mime || 'audio/ogg' });
}
