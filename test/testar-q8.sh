#!/bin/bash
# Testa se o q8 dos modelos Whisper *_timestamped já funciona no processador
# (WASM) com uma versão mais nova do ONNX Runtime. O erro conhecido é
# "Missing required scale ... weight_merged_0_scale", issue 1707 do
# transformers.js. Resultado fica em test/q8-resultado.txt.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
TMP="$DIR/.q8"
LOG="$DIR/q8-resultado.txt"
ORT_ATUAL="1.26.0-dev.20260416-b7804b056c"   # a que o transformers.js 4.2.0 usa
ORT_NOVA="1.29.0"
REPO="https://huggingface.co/onnx-community/whisper-base_timestamped/resolve/main/onnx"

mkdir -p "$TMP/modelos"
: > "$LOG"
say(){ echo "$@" | tee -a "$LOG"; }

say "Teste do q8 no processador"
say "Data: $(date '+%d/%m/%Y %H:%M')"
say ""

# no Hugging Face o q8 do transformers.js é o arquivo _quantized (não existe _q8)
for f in encoder_model_quantized.onnx decoder_model_merged_quantized.onnx encoder_model_int8.onnx encoder_model_q4.onnx; do
  if [ ! -s "$TMP/modelos/$f" ]; then
    echo "Baixando $f..."
    curl -sL --fail -o "$TMP/modelos/$f" "$REPO/$f" || { say "FALHOU o download de $f"; exit 1; }
  fi
done
say "Modelos baixados:"
ls -lh "$TMP/modelos" | awk 'NR>1 {print "  " $9 "  " $5}' | tee -a "$LOG"
say ""

cat > "$TMP/teste.mjs" <<'JS'
import * as ort from 'onnxruntime-web';
import fs from 'node:fs';
ort.env.wasm.numThreads = 1;
const dir = process.argv[2];
for (const f of ['encoder_model_q4.onnx', 'encoder_model_quantized.onnx', 'decoder_model_merged_quantized.onnx', 'encoder_model_int8.onnx']) {
  try {
    const s = await ort.InferenceSession.create(new Uint8Array(fs.readFileSync(`${dir}/${f}`)), { executionProviders: ['wasm'] });
    console.log(`  ${f}: ABRIU (entradas: ${s.inputNames.length})`);
  } catch (e) {
    console.log(`  ${f}: FALHOU -> ${String(e.message || e).slice(0, 130)}`);
  }
}
JS

for v in "$ORT_ATUAL" "$ORT_NOVA"; do
  say "ONNX Runtime $v"
  rm -rf "$TMP/pasta"; mkdir -p "$TMP/pasta"
  ( cd "$TMP/pasta" && npm init -y >/dev/null 2>&1 && npm i --silent "onnxruntime-web@$v" >/dev/null 2>&1 )
  if [ ! -d "$TMP/pasta/node_modules/onnxruntime-web" ]; then say "  não consegui instalar essa versão"; say ""; continue; fi
  cp "$TMP/teste.mjs" "$TMP/pasta/teste.mjs"
  ( cd "$TMP/pasta" && node teste.mjs "$TMP/modelos" 2>&1 | grep -E 'ABRIU|FALHOU' ) | tee -a "$LOG"
  say ""
done

say "Leitura: se o q8 aparecer como ABRIU na versão nova, dá para trocar o"
say "ONNX Runtime do vendor/ e usar q8 no processador."
echo "Pronto. Resultado em $LOG"
