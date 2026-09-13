# TranscrevAI · Contexto do projeto

Handoff técnico. Leia antes de mexer no código.

## O que é

Site de transcrição de vídeos, áudios e links que roda **100% no navegador**
(sem API, sem custo por minuto, o arquivo não sai do computador). Feito para
o Marcus e depois para a equipe da SECOM/TCE-MT.

- Pasta versionada (fonte de verdade): `/Volumes/SSD_NVME/AgentesIA/TranscrevAI`
- Publicação prevista: `https://eusoumarcus.com.br/transcrevai/` (Hostinger,
  hospedagem compartilhada, só arquivos estáticos)
- Criado em 11/09/2026 (Claude Cowork)

## Como funciona

1. **Áudio**: o arquivo (ou o áudio vindo do BaixaAI) é convertido no próprio
   navegador para PCM mono 16 kHz com a biblioteca **mediabunny** (WebCodecs).
   Se falhar (ex.: codec sem suporte no WebCodecs), a página tenta de novo com
   `decodeAudioData` na thread principal (`decode_failed` no worker dispara isso).
2. **Detecção de fala (VAD)**: modelo `pyannote-segmentation-3.0` em janelas de
   10 s com 1 s de sobreposição. Se o modelo falhar, cai para um VAD por energia.
3. **Separação de falantes**: embeddings `wespeaker-voxceleb-resnet34-LM` por
   turno local + agrupamento hierárquico (ligação média, distância cosseno,
   limiar 0,70) implementado em `js/diarize.js` (nearest-neighbor chain).
4. **Transcrição**: Whisper via **transformers.js v4**, com timestamps por
   palavra (`return_timestamps: 'word'`, modelos `*_timestamped`). O áudio é
   cortado em trechos de até 28 s nas pausas; o falante de cada palavra vem da
   linha do tempo da etapa 3.
5. **Saída**: palavras → frases → parágrafos (`js/format.js`), com exportação
   TXT, TXT com timecode, DOCX (zip montado à mão com fflate), SRT, VTT e JSON.

Tudo o que é pesado roda num **Web Worker** (`js/worker.js`); a interface
(`js/app.js`) só desenha o progresso.

## Arquivos

```
TranscrevAI/
  index.html          # 3 telas: entrada, processando, resultado
  baixaai.html        # guia de instalação do BaixaAI (para quem não tem)
  baixaai.zip         # a extensão empacotada, para download
  css/app.css         # Apex DS (Syne + Plus Jakarta Sans, vermelho #E8341C), claro e escuro
  js/app.js           # interface, histórico, exportação, player sincronizado
  js/worker.js        # decodificação, VAD, falantes, Whisper
  js/diarize.js       # lógica pura (VAD, turnos, agrupamento) — testável em Node
  js/format.js        # frases, parágrafos, TXT/SRT/VTT/JSON/DOCX
  js/bridge.js        # conversa com a extensão BaixaAI
  js/store.js         # histórico em IndexedDB (só no navegador do usuário)
  vendor/             # transformers.min.js, mediabunny, fflate, ONNX Runtime (.wasm)
  .htaccess           # COOP/COEP, MIME de .wasm/.mjs, cache
```

## Decisões (e por quê)

1. **Motor no navegador, não API.** Escolha do usuário: grátis e privado.
   Custo: download único do modelo (1,6 GB na qualidade máxima) e velocidade
   dependente da máquina.
2. **Modelos `_timestamped`** (`onnx-community/whisper-*_timestamped`): são os
   únicos exportados com as cross-attentions que o transformers.js usa para
   calcular timestamp por palavra. Sem eles só dá para ter timecode por frase.
3. **Bibliotecas hospedadas no próprio site** (`vendor/`), não em CDN: rede
   corporativa (TCE) costuma bloquear CDN. Os **modelos** ainda vêm do
   huggingface.co; se a rede bloquear, nada funciona (ponto de atenção para a
   SECOM; alternativa futura é espelhar os modelos no Hostinger).
4. **`.htaccess` com COOP/COEP** (`credentialless`): libera o isolamento de
   origem, que permite ao WASM usar vários núcleos quando não há WebGPU. Sem
   esse arquivo o modo sem WebGPU fica com 1 núcleo (bem mais lento).
   Atenção: o worker só carrega se a resposta dele também tiver o cabeçalho
   COEP (foi o que quebrou no primeiro teste local sem os cabeçalhos).
5. **Diarização antes da transcrição**, com atribuição por palavra: evita
   rodar o Whisper uma vez por turno (muito mais lento) e ainda assim marca
   quem falou. Ajustes finos ficam em `labelWords()` (`diarize.js`): ilha de
   uma palavra curta é absorvida, e a troca de falante "pula" para a pontuação
   mais próxima.
6. **Links via extensão BaixaAI** (`externally_connectable`): o navegador não
   consegue baixar YouTube/Instagram (CORS e bloqueio de servidor). A extensão
   baixa só o áudio com yt-dlp e entrega em pedaços de 700 KB. Ver decisão #20
   no CONTEXTO.md do BaixaAI.
7. **Sem travessões nos textos da interface** (preferência do usuário).

## Estado atual

- Testado no container: leitura de mp4/mov/webm/mp3/m4a/flac/wav/ogg, telas,
  exportações (DOCX abre no Word), histórico, e a ponte completa com o BaixaAI
  (página → extensão → host → yt-dlp → ffmpeg → pedaços → página).
- Testado pelo usuário no Mac: WebGPU ativo, BaixaAI conectado, download do
  modelo iniciando.
- Ainda **não** houve uma transcrição real de ponta a ponta.

## Corrigido em 13/09/2026

1. **Barra mostrava 4,16 GB em vez de 1,6 GB.** O transformers.js usa duas
   chaves para o mesmo arquivo do encoder: na criação da sessão procura
   `encoder_model` (nome do arquivo), no cálculo do total procura `model` (nome
   da sessão). Sem a chave `model` o cálculo caía no fp32 e somava o
   `encoder_model.onnx_data` (2,55 GB), que nem era baixado. O `dt()` em
   `js/worker.js` agora escreve as duas chaves.
2. **Botão "Transcrever" travado com link do YouTube**: `refreshExt()` (app.js)
   agora chama `validate()` no fim, porque o ping responde depois da tela montar.
3. **Contadores de MB retirados** da barra e do seletor de qualidade (ficam só
   na linha de ajuda), a pedido do usuário.
4. **Celular**: a qualidade Máxima não aparece (não cabe na memória, o navegador
   derruba a aba perto de 1 GB) e a Rápida vem selecionada.
5. **Erro "webgpuInit is not a function" no iPhone e no Safari**: o ONNX Runtime
   que vem com o transformers.js não traz o motor WebGPU para o WebKit. O
   `IS_WEBKIT` (app.js) força o processador nesses navegadores.
6. **Erro "Missing required scale ... MatMulNBits"**: o q8 destes modelos
   `_timestamped` não roda no processador com o runtime v4 (issue 1707 do
   transformers.js, correção prevista para a v4.3.0). O processador passou a
   usar q4, com cadeia de reserva (`reserva` em `js/worker.js`) caso falhe.
7. **"Faltou memória" no iPhone**: o encoder fp32 estourava o limite. No
   processador o base agora começa em q4/q4 (uns 140 MB).
8. **Cache preso no celular**: o `.htaccess` passou a pedir revalidação de
   html/js/css, e o `worker.js` e os imports do worker carregam com `?v=N`.
   **Ao publicar uma correção, suba o número da versão em `index.html`,
   `js/app.js` (URL do worker) e nos imports do `js/worker.js`.**
9. **Fontes locais** (`vendor/fonts`) no lugar do Google Fonts: tira a
   dependência externa e permite o `COEP: require-corp`, que o Safari precisa
   para usar vários núcleos (o `credentialless` ele não entende).
10. **Compartilhamento**: `og.png` 1200x1200 mais og:title e og:description no
    `index.html`.

Testado pelo usuário: funcionando no Mac (Chrome, WebGPU) e no iPhone (Safari,
processador, qualidade Rápida, áudio curto).

## Feito em 13/09/2026 (tarde): página de instalação do BaixaAI

Resolve a pendência 1 (distribuição para outras pessoas).

- Novo arquivo `baixaai.html`: guia de instalação em quatro passos, no mesmo
  visual do site. Tem troca Mac/Windows, botão de copiar os comandos, um
  verificador ao vivo que diz se a extensão já está instalada e conectada
  (usa o `pingExtension` do `bridge.js`), e um bloco "Se der problema" com os
  casos conhecidos (volume externo no Mac, extensão desativada pelo Chrome,
  download silencioso, Safari/Firefox).
- Novo arquivo `baixaai.zip` (31 KB): a extensão empacotada, gerada a partir
  de `/Volumes/SSD_NVME/AgentesIA/BaixarVideos/baixaai` sem `__pycache__`,
  `CONTEXTO.md`, `paths.json` nem arquivos `._*`. Para atualizar a extensão
  distribuída, refazer o zip a partir dessa pasta.
  O `manifest.json` tem o campo `key`, então o ID da extensão é o mesmo em
  qualquer máquina: o `externally_connectable` e o `EXT_ID` do `bridge.js`
  continuam valendo para quem instalar.
- `index.html` + `js/app.js`: botão "Instalar o BaixaAI" ao lado do chip,
  visível só quando a extensão não responde e só no computador (no celular
  não existe extensão de Chrome). O aviso do campo de link e o rodapé
  também levam para a página.
- `.htaccess`: MIME e cache do `.zip`.
- Todos os arquivos passaram para `?v=7`.

## Pendências

Nenhuma aberta. As três que existiam foram fechadas em 13 e 14/09/2026:
o q8 no processador (feito), o espelho dos modelos (feito) e a VPS com yt-dlp
(descartada, ver abaixo).

## VPS com yt-dlp: descartada por ora (14/09/2026)

A ideia era deixar links do YouTube e afins funcionarem sem a extensão BaixaAI,
com um servidor rodando yt-dlp. Marcus tem uma VPS KVM 2 na Hostinger, então
não haveria custo novo, mas a decisão foi não fazer agora.

Por quê: a promessa da ferramenta deixaria de ser "nada sai do seu computador",
o yt-dlp vira manutenção contínua (quebra quando o YouTube muda), e o YouTube
costuma barrar IP de datacenter pedindo confirmação de que não é robô, o que
pode inviabilizar o caso de uso principal.

Se for retomar: testar primeiro, em 15 minutos, se o YouTube deixa a VPS baixar
um vídeo. Só seguir se passar. E considerar deixar o serviço fechado por senha,
só para a equipe da SECOM, em vez de público.

## Medição (Google Analytics 4)

Propriedade G-58MW9KB4N6, na conta Pessoal do eusoumarcus. A tag entra nas duas
páginas com `crossorigin="anonymous"`: sem isso o COEP `require-corp` bloqueia
script de outro domínio. Testado no Chrome em 13/09/2026: o gtag carrega, o
`crossOriginIsolated` continua true (o modo rápido não foi afetado) e os
eventos aparecem no relatório em tempo real.

Detalhe que engana: o leitor de rede da extensão do Chrome mostra 503 nas
chamadas para `google-analytics.com/g/collect`. É leitura errada da ferramenta.
Um `fetch` manual para a mesma URL devolve 204 e os eventos chegam no GA.

Eventos: `transcricao_iniciada` (origem, domínio do link, qualidade, motor,
falantes, idioma), `transcricao_concluida` (qualidade, motor, duração do áudio,
tempo de processamento, falantes detectados), `transcricao_erro` (motivo em 90
caracteres), `transcricao_cancelada`, `exportar` (formato, duração),
`abriu_guia_baixaai`, `baixaai_download` e `baixaai_estado` (conectado, sem
ajudante ou não instalado).

Nunca vai para o GA: nome de arquivo, link completo e qualquer trecho do texto
transcrito. O `track()` do `app.js` só dispara se o `gtag` existir, então o
site funciona normalmente para quem bloqueia o Google.

## Motor no processador: q8 liberado (13/09/2026)

O q8 dos modelos `*_timestamped` quebrava no processador com
"Missing required scale ... weight_merged_0_scale" (issue 1707 do
transformers.js). Testado: o bug é do ONNX Runtime e foi corrigido a partir da
versão 1.27. O transformers.js 4.2.0 traz o 1.26 embutido e não teve versão
nova desde abril de 2026, então o `vendor/transformers.min.js` agora é um
bundle próprio, montado com esbuild a partir do código-fonte do 4.2.0 e do
onnxruntime-web 1.29.0. Os quatro arquivos de `vendor/ort/` também são do
1.29.0.

Para remontar o bundle: instalar `@huggingface/transformers@4.2.0`,
`onnxruntime-web@1.29.0` e `esbuild` (com `--ignore-scripts`), e rodar esbuild
sobre `src/transformers.js` com format esm, platform browser, apontando
`onnxruntime-web` e `onnxruntime-web/webgpu` para
`node_modules/onnxruntime-web/dist/ort.webgpu.bundle.min.mjs` e substituindo
`onnxruntime-node`, `sharp` e os `node:*` por um stub vazio.

Com isso o processador voltou ao q8, que além de ser mais rápido é MENOR que o
q4 nestes modelos: o decoder do base tem 51 MB em q8 contra 124 MB em q4. A
cadeia de reserva no wasm é q8, depois q4, depois fp32.

Armadilha que custou tempo: os arquivos do ONNX Runtime têm cache de 7 dias no
`.htaccess` e a URL não mudava, então o navegador continuava rodando o runtime
antigo depois da atualização e o q8 parecia quebrado mesmo com o 1.29 no
servidor. Agora o `worker.js` põe `?v=` nessas URLs (constante `ORT_VER`).
Ao trocar o vendor/ort de novo, subir esse número junto.

Testado no site publicado em 13/09/2026: funciona na placa de vídeo (transcrição
completa pela interface) e no processador (q8 abrindo de primeira, sem cair para
a reserva).

O script `test/testar-q8.sh` refaz o teste. Atenção: no Hugging Face o arquivo
do q8 se chama `_quantized.onnx`, não `_q8.onnx`.

## Espelho dos modelos no Hostinger (14/09/2026)

Por padrão o transformers.js baixa os modelos do huggingface.co, que rede
corporativa costuma bloquear (caso provável no TCE). O `worker.js` agora
procura `modelos/ok.txt` no próprio domínio: se existir, as qualidades Rápida
e Equilibrada e os dois modelos de falante vêm daqui (`env.remoteHost` aponta
para `modelos/` e `env.remotePathTemplate` vira `{model}/`). A Máxima continua
vindo do Hugging Face, porque 1,6 GB é grande demais para espelhar. Se o
espelho falhar no meio, a segunda rodada tenta tudo de novo direto no Hugging
Face, então o site nunca fica pior do que era.

O espelho tem cerca de 1,4 GB e a estrutura de pastas é a mesma do Hugging
Face: `modelos/onnx-community/<modelo>/onnx/<arquivo>.onnx`.

Quem baixa é o próprio servidor, pelo `baixar-modelos.php`: sobe o arquivo,
abre com `?chave=transcrevai-2026`, a página recarrega sozinha baixando um
arquivo por vez (para não estourar o tempo limite do PHP) e no fim grava o
`modelos/ok.txt`. Depois o arquivo .php deve ser apagado do servidor. Rodar de
novo é seguro: ele pula o que já está lá.

A pasta `modelos/` está no .gitignore: existe só no servidor.

## Repositório

O código está versionado em https://github.com/eusoumarcusbr/transcrevai
(branch `main`). A pasta `/Volumes/SSD_NVME/AgentesIA/TranscrevAI` é a mesma
coisa: é de lá que o repositório foi criado e é ela que sobe para o Hostinger.
O `vendor/` (36 MB de ONNX Runtime) está no repositório de propósito, para que
um clone rode sem precisar baixar nada.

## Como testar

Local, na pasta do projeto:

```
cd /Volumes/SSD_NVME/AgentesIA/TranscrevAI && python3 -m http.server 8080
```

Abrir `http://localhost:8080` (o `localhost` já está liberado no
`externally_connectable` do BaixaAI). Em produção, subir a pasta inteira para
`public_html/transcrevai`, incluindo o `.htaccess` (arquivo oculto).

Testes automatizados que existem (rodaram no ambiente do Claude, não estão
nesta pasta): unidade em Node para `diarize.js`/`format.js`, decodificação de
7 formatos em Chromium, interface com worker simulado, e o fluxo completo com
a extensão carregada.
