# TranscrevAI

Transcrição de vídeos, áudios e links que roda inteira no navegador. O arquivo
não é enviado para servidor nenhum: o Whisper é baixado uma vez e processa na
própria máquina.

Em produção: https://eusoumarcus.com.br/transcrevai/

## O que faz

- Transcreve arquivos de vídeo e áudio (MP4, MOV, MKV, WEBM, MP3, M4A, WAV, OGG, FLAC)
- Transcreve links do YouTube, Instagram, TikTok, Facebook e Globo, pela
  extensão [BaixaAI](baixaai.html) rodando no computador de quem usa
- Saídas: texto corrido, texto com timecode, separação de falantes
- Exporta em TXT, TXT com timecode, DOCX, SRT, VTT e JSON
- Histórico local em IndexedDB e player sincronizado com o texto
- Três qualidades: Whisper Large v3 Turbo, Small e Base

## Como funciona

| Etapa | O que usa |
|---|---|
| Decodificar o áudio | mediabunny (WebCodecs), com `decodeAudioData` de reserva |
| Encontrar as falas | pyannote-segmentation-3.0 (ONNX) |
| Separar os falantes | wespeaker-voxceleb-resnet34-LM + agrupamento aglomerativo |
| Transcrever | Whisper `*_timestamped` com timestamp por palavra |
| Rodar os modelos | transformers.js + ONNX Runtime Web (WebGPU, ou processador) |

Tudo acontece num Web Worker. O site precisa dos cabeçalhos COOP/COEP para
liberar vários núcleos do processador quando não há WebGPU: eles estão no
`.htaccess`.

## Rodar localmente

```bash
python3 -m http.server 8080
```

Abrir `http://localhost:8080`. O `localhost` já está liberado no
`externally_connectable` da extensão BaixaAI.

Observação: o servidor simples do Python não manda os cabeçalhos COOP/COEP, o
que só deixa o modo sem WebGPU mais lento. O resto funciona igual.

## Publicar

Subir a pasta inteira para `public_html/transcrevai`, incluindo o `.htaccess`
(é um arquivo oculto e é ele que liga o modo rápido).

## Estrutura

```
index.html          três telas: entrada, processando, resultado
baixaai.html        guia de instalação da extensão BaixaAI
baixaai.zip         a extensão empacotada, para download
css/app.css         design system (Syne + Plus Jakarta Sans), claro e escuro
js/app.js           interface, histórico, exportação, player
js/worker.js        decodificação, VAD, falantes, Whisper
js/diarize.js       lógica pura de VAD, turnos e agrupamento
js/format.js        frases, parágrafos, TXT/SRT/VTT/JSON/DOCX
js/bridge.js        conversa com a extensão BaixaAI
js/store.js         histórico em IndexedDB
vendor/             transformers.js, mediabunny, fflate, ONNX Runtime, fontes
.htaccess           COOP/COEP, MIME de .wasm/.mjs, cache
```

O `CONTEXTO.md` tem o histórico das decisões e o handoff técnico.

## Navegadores

Funciona melhor no Chrome e no Edge atualizados, onde o WebGPU acelera o
processamento. No Safari e no iPhone roda pelo processador, com as qualidades
Equilibrada e Rápida (a Máxima não cabe na memória do celular).
