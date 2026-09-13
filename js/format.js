// format.js: agrupa palavras em frases/parágrafos e gera as exportações.

export function tc(sec, { ms = false, sep = '.' } = {}) {
  const total = Math.round(Math.max(0, sec || 0) * 1000);
  const h = Math.floor(total / 3600000);
  const m = Math.floor((total % 3600000) / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  let out = `${pad(h)}:${pad(m)}:${pad(s)}`;
  if (ms) out += sep + pad(total % 1000, 3);
  return out;
}

export function shortTc(sec) {
  sec = Math.max(0, sec || 0);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

const SENT_END = /[.?!…]["”')\]]*$/;
const SOFT_END = /[,;:]["”')\]]*$/;

/** Junta tokens de palavra do Whisper em texto, cuidando dos espaços. */
export function joinWords(words) {
  let out = '';
  for (const w of words) {
    const t = w.text;
    if (!out) out = t.trimStart();
    else out += /^\s/.test(t) || /^[.,!?;:…%)\]”]/.test(t) ? t : ' ' + t;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * Frases (segmentos): quebram em troca de falante, fim de frase, pausa longa
 * ou quando ficam longas demais.
 */
export function buildSegments(words, { maxDur = 14, pauseBreak = 1.2 } = {}) {
  const segs = [];
  let cur = null;
  const close = () => {
    if (cur && cur.words.length) {
      segs.push({
        start: cur.words[0].start,
        end: cur.words[cur.words.length - 1].end,
        spk: cur.spk,
        words: cur.words,
        text: joinWords(cur.words),
      });
    }
    cur = null;
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const prev = words[i - 1];
    if (cur) {
      const gap = w.start - prev.end;
      const dur = w.end - cur.words[0].start;
      const prevT = prev.text.trim();
      if (
        w.spk !== cur.spk ||
        gap > pauseBreak ||
        (SENT_END.test(prevT) && dur > 2.5) ||
        (dur > maxDur && SOFT_END.test(prevT)) ||
        dur > maxDur * 1.6
      ) close();
    }
    if (!cur) cur = { spk: w.spk, words: [] };
    cur.words.push(w);
  }
  close();
  return segs;
}

/** Parágrafos: frases seguidas do mesmo falante (quebra em pausa longa ou texto grande). */
export function buildParagraphs(segs, { pauseBreak = 3, maxChars = 900 } = {}) {
  const paras = [];
  let cur = null;
  for (const s of segs) {
    const len = cur ? cur.segs.reduce((n, x) => n + x.text.length, 0) : 0;
    if (!cur || s.spk !== cur.spk || s.start - cur.end > pauseBreak || len > maxChars) {
      cur = { spk: s.spk, start: s.start, end: s.end, segs: [] };
      paras.push(cur);
    }
    cur.segs.push(s);
    cur.end = s.end;
  }
  return paras;
}

export function speakerName(names, spk) {
  return (names && names[spk]) || `Locutor ${spk + 1}`;
}

// ---------------------------------------------------------------------
// Exportações
// ---------------------------------------------------------------------

export function toPlainText(doc) {
  const paras = buildParagraphs(doc.segments);
  return paras
    .map((p) => {
      const text = p.segs.map((s) => s.text).join(' ');
      return doc.diarized ? `${speakerName(doc.names, p.spk)}: ${text}` : text;
    })
    .join('\n\n') + '\n';
}

export function toTimecodeText(doc) {
  return doc.segments
    .map((s) => `[${tc(s.start)}] ` + (doc.diarized ? `${speakerName(doc.names, s.spk)}: ` : '') + s.text)
    .join('\n') + '\n';
}

/** Legendas: cues de até 2 linhas × 42 caracteres e 6 s. */
export function buildCues(doc, { maxChars = 84, maxDur = 6 } = {}) {
  const cues = [];
  for (const seg of doc.segments) {
    // se a frase foi editada, não dá para confiar nas palavras: usa a frase inteira
    if (seg.edited || !seg.words?.length) {
      splitText(seg.text, maxChars).forEach((t, i, arr) => {
        const d = (seg.end - seg.start) / arr.length;
        cues.push({ start: seg.start + i * d, end: seg.start + (i + 1) * d, text: t });
      });
      continue;
    }
    let buf = [];
    const flush = () => {
      if (!buf.length) return;
      cues.push({ start: buf[0].start, end: buf[buf.length - 1].end, text: joinWords(buf) });
      buf = [];
    };
    for (const w of seg.words) {
      const next = joinWords([...buf, w]);
      if (buf.length && (next.length > maxChars || w.end - buf[0].start > maxDur)) flush();
      buf.push(w);
      if (SENT_END.test(w.text.trim()) && joinWords(buf).length > maxChars * 0.5) flush();
    }
    flush();
  }
  // garante duração mínima e sem sobreposição
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    if (c.end - c.start < 0.8) c.end = c.start + 0.8;
    if (cues[i + 1] && c.end > cues[i + 1].start) c.end = Math.max(c.start + 0.3, cues[i + 1].start - 0.02);
  }
  return cues.map((c) => ({ ...c, text: wrapLines(c.text, 42) }));
}

function splitText(text, max) {
  const words = text.split(/\s+/);
  const out = [];
  let cur = '';
  for (const w of words) {
    if (cur && (cur + ' ' + w).length > max) { out.push(cur); cur = w; } else cur = cur ? cur + ' ' + w : w;
  }
  if (cur) out.push(cur);
  return out;
}

function wrapLines(text, max) {
  if (text.length <= max) return text;
  const mid = text.length / 2;
  let best = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === ' ' && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i;
  }
  return best < 0 ? text : text.slice(0, best) + '\n' + text.slice(best + 1);
}

export function toSRT(doc) {
  return buildCues(doc)
    .map((c, i) => `${i + 1}\n${tc(c.start, { ms: true, sep: ',' })} --> ${tc(c.end, { ms: true, sep: ',' })}\n${c.text}\n`)
    .join('\n');
}

export function toVTT(doc) {
  return 'WEBVTT\n\n' + buildCues(doc)
    .map((c) => `${tc(c.start, { ms: true })} --> ${tc(c.end, { ms: true })}\n${c.text}\n`)
    .join('\n');
}

export function toJSON(doc) {
  return JSON.stringify({
    ferramenta: 'TranscrevAI',
    versao: 1,
    titulo: doc.title,
    criado_em: doc.createdAt,
    duracao_s: doc.duration,
    idioma: doc.language,
    modelo: doc.model,
    separou_falantes: !!doc.diarized,
    falantes: Object.fromEntries((doc.speakers || []).map((s) => [s, speakerName(doc.names, s)])),
    segmentos: doc.segments.map((s) => ({
      inicio: +s.start.toFixed(2),
      fim: +s.end.toFixed(2),
      falante: doc.diarized ? speakerName(doc.names, s.spk) : null,
      texto: s.text,
      palavras: s.edited ? undefined : s.words.map((w) => ({ t: w.text.trim(), i: +w.start.toFixed(2), f: +w.end.toFixed(2) })),
    })),
  }, null, 2);
}

// ---------------------------------------------------------------------
// DOCX (Word) montado à mão: poucos XMLs zipados com fflate
// ---------------------------------------------------------------------

const xmlEsc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  // remove caracteres de controle que invalidam o XML
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

function run(text, { bold = false, color = null, size = null, font = null } = {}) {
  const props = [
    font ? `<w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:cs="${font}"/>` : '',
    bold ? '<w:b/>' : '',
    color ? `<w:color w:val="${color}"/>` : '',
    size ? `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>` : '',
  ].join('');
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${xmlEsc(text)}</w:t></w:r>`;
}

function para(runs, { after = 160, keepNext = false } = {}) {
  return `<w:p><w:pPr>${keepNext ? '<w:keepNext/>' : ''}<w:spacing w:after="${after}" w:line="300" w:lineRule="auto"/></w:pPr>${runs}</w:p>`;
}

export function toDocxFiles(doc, { withTimecode = true } = {}) {
  const paras = buildParagraphs(doc.segments);
  const body = [];
  body.push(para(run(doc.title || 'Transcrição', { bold: true, size: 36 }), { after: 80 }));
  const meta = [
    `Duração: ${tc(doc.duration)}`,
    doc.diarized ? `Falantes: ${(doc.speakers || []).length}` : null,
    `Transcrito em ${new Date(doc.createdAt).toLocaleString('pt-BR')}`,
    'TranscrevAI',
  ].filter(Boolean).join('  ·  ');
  body.push(para(run(meta, { color: '777777', size: 18 }), { after: 320 }));
  for (const p of paras) {
    const text = p.segs.map((s) => s.text).join(' ');
    const head = [];
    if (withTimecode) head.push(run(`[${tc(p.start)}]  `, { color: '999999', size: 18 }));
    if (doc.diarized) head.push(run(`${speakerName(doc.names, p.spk)}: `, { bold: true }));
    body.push(para(head.join('') + run(text)));
  }
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1417" w:right="1417" w:bottom="1417" w:left="1417" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="pt-BR"/></w:rPr></w:rPrDefault></w:docDefaults></w:styles>`;
  return {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/_rels/document.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'word/document.xml': documentXml,
    'word/styles.xml': stylesXml,
  };
}

export function safeFileName(name) {
  return (name || 'transcricao')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\.[a-z0-9]{2,4}$/i, '')
    .replace(/[^\w\-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')
    .slice(0, 80) || 'transcricao';
}
