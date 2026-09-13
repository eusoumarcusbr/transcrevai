<?php
/*
 * baixar-modelos.php
 *
 * Faz o próprio servidor da Hostinger baixar os modelos de IA do Hugging Face
 * para a pasta modelos/, para que o TranscrevAI não dependa do huggingface.co
 * (rede corporativa costuma bloquear) e o download do usuário venha do mesmo
 * domínio.
 *
 * Como usar:
 *   1. suba este arquivo para public_html/transcrevai/
 *   2. abra https://eusoumarcus.com.br/transcrevai/baixar-modelos.php?chave=SUA_CHAVE
 *   3. deixe a aba aberta até aparecer "Espelho completo"
 *   4. APAGUE este arquivo do servidor
 *
 * Baixa um arquivo por requisição e a página se recarrega sozinha, para não
 * esbarrar no tempo limite do PHP da hospedagem compartilhada.
 */

$CHAVE = 'transcrevai-2026';   // troque se quiser
$BASE  = 'https://huggingface.co';
$DEST  = __DIR__ . '/modelos';

if (($_GET['chave'] ?? '') !== $CHAVE) {
    http_response_code(403);
    exit('Chave inválida. Use ?chave=SUA_CHAVE no fim do endereço.');
}

@set_time_limit(0);
ignore_user_abort(true);

// ---------------------------------------------------------------------
// Lista do que precisa ser espelhado
// ---------------------------------------------------------------------
$TEXTOS_WHISPER = [
    'config.json', 'generation_config.json', 'preprocessor_config.json',
    'tokenizer.json', 'tokenizer_config.json', 'added_tokens.json',
    'special_tokens_map.json', 'vocab.json', 'merges.txt', 'normalizer.json',
];

// os dtypes que o worker.js pode pedir, por caminho de processamento
$ONNX_BASE = [
    'onnx/encoder_model.onnx',                      // fp32, placa de vídeo
    'onnx/encoder_model_q4.onnx',                   // reserva
    'onnx/encoder_model_quantized.onnx',            // q8, processador
    'onnx/decoder_model_merged_q4.onnx',
    'onnx/decoder_model_merged_quantized.onnx',
];
$ONNX_SMALL = [
    'onnx/encoder_model.onnx',                      // fp32, placa sem fp16
    'onnx/encoder_model_fp16.onnx',                 // placa com fp16
    'onnx/encoder_model_q4.onnx',                   // reserva
    'onnx/encoder_model_quantized.onnx',            // q8, processador
    'onnx/decoder_model_merged_q4.onnx',
    'onnx/decoder_model_merged_quantized.onnx',
];

$LISTA = [];
$add = function ($repo, $arquivos) use (&$LISTA) {
    foreach ($arquivos as $a) $LISTA[] = [$repo, $a];
};
$add('onnx-community/whisper-base_timestamped', array_merge($TEXTOS_WHISPER, $ONNX_BASE));
$add('onnx-community/whisper-small_timestamped', array_merge($TEXTOS_WHISPER, $ONNX_SMALL));
$add('onnx-community/pyannote-segmentation-3.0', ['config.json', 'preprocessor_config.json', 'onnx/model.onnx']);
$add('onnx-community/wespeaker-voxceleb-resnet34-LM', ['config.json', 'preprocessor_config.json', 'onnx/model.onnx']);

// ---------------------------------------------------------------------
// Funções
// ---------------------------------------------------------------------
function urlRemota($base, $repo, $arquivo) {
    return "$base/$repo/resolve/main/$arquivo";
}

function tamanhoRemoto($url) {
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_NOBODY => true, CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 30,
        CURLOPT_USERAGENT => 'TranscrevAI-espelho/1.0',
    ]);
    curl_exec($ch);
    $t = (int) curl_getinfo($ch, CURLINFO_CONTENT_LENGTH_DOWNLOAD);
    $c = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    return $c === 200 ? $t : -1;
}

function baixar($url, $destino) {
    if (!is_dir(dirname($destino))) @mkdir(dirname($destino), 0755, true);
    $parcial = $destino . '.part';
    $fp = fopen($parcial, 'w');
    if (!$fp) return 'não consegui escrever em ' . dirname($destino);
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_FILE => $fp, CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_TIMEOUT => 0, CURLOPT_CONNECTTIMEOUT => 30,
        CURLOPT_USERAGENT => 'TranscrevAI-espelho/1.0',
        CURLOPT_FAILONERROR => true,
    ]);
    $ok = curl_exec($ch);
    $erro = curl_error($ch);
    curl_close($ch);
    fclose($fp);
    if (!$ok) { @unlink($parcial); return $erro ?: 'falhou'; }
    rename($parcial, $destino);
    return true;
}

function bonito($b) {
    if ($b >= 1073741824) return number_format($b / 1073741824, 2, ',', '.') . ' GB';
    if ($b >= 1048576) return number_format($b / 1048576, 0, ',', '.') . ' MB';
    return number_format($b / 1024, 0, ',', '.') . ' KB';
}

// ---------------------------------------------------------------------
// Ação: baixa o próximo arquivo que estiver faltando
// ---------------------------------------------------------------------
$mensagem = '';
$faltando = [];
$prontos  = 0;
$bytesOk  = 0;

foreach ($LISTA as [$repo, $arquivo]) {
    $destino = "$DEST/$repo/$arquivo";
    if (is_file($destino) && filesize($destino) > 0) {
        $prontos++; $bytesOk += filesize($destino);
    } else {
        $faltando[] = [$repo, $arquivo, $destino];
    }
}

if (isset($_GET['baixar']) && $faltando) {
    [$repo, $arquivo, $destino] = $faltando[0];
    $url = urlRemota($BASE, $repo, $arquivo);
    $r = baixar($url, $destino);
    if ($r === true) {
        $mensagem = "Baixado: $repo/$arquivo (" . bonito(filesize($destino)) . ")";
        $prontos++; $bytesOk += filesize($destino);
        array_shift($faltando);
    } else {
        $mensagem = "ERRO em $repo/$arquivo: $r";
    }
}

if (!$faltando) {
    @file_put_contents("$DEST/ok.txt", "espelho completo em " . date('d/m/Y H:i') . "\n");
}

$total = count($LISTA);
$pct = $total ? round($prontos / $total * 100) : 0;
$continuar = $faltando && !str_starts_with($mensagem, 'ERRO');
$proximo = $faltando ? $faltando[0][0] . '/' . $faltando[0][1] : '';
?>
<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<title>Espelho dos modelos · TranscrevAI</title>
<?php if ($continuar): ?><meta http-equiv="refresh" content="1;url=?chave=<?= urlencode($CHAVE) ?>&baixar=1"><?php endif; ?>
<style>
 body{font:15px/1.6 system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 20px;background:#0d0e11;color:#f1f2f5}
 h1{font-size:22px;margin:0 0 6px} .m{color:#9a9dab}
 .barra{height:12px;background:#2a2c35;border-radius:99px;overflow:hidden;margin:18px 0 8px}
 .barra i{display:block;height:100%;background:#e8341c;width:<?= $pct ?>%}
 .cx{background:#17181e;border:1px solid #2a2c35;border-radius:14px;padding:16px;margin:16px 0}
 .ok{color:#3ecf8e} .err{color:#ff6b5a} code{background:#23252d;padding:2px 6px;border-radius:5px;font-size:13px}
 a{color:#e8341c} .btn{display:inline-block;background:#e8341c;color:#fff;padding:10px 20px;border-radius:10px;text-decoration:none;font-weight:600}
</style></head><body>
<h1>Espelho dos modelos do TranscrevAI</h1>
<p class="m">Copiando os modelos do Hugging Face para este servidor. Deixe esta aba aberta.</p>

<div class="barra"><i></i></div>
<p><b><?= $prontos ?> de <?= $total ?></b> arquivos (<?= $pct ?>%) · <?= bonito($bytesOk) ?> no servidor</p>

<?php if ($mensagem): ?>
  <div class="cx <?= str_starts_with($mensagem, 'ERRO') ? 'err' : 'ok' ?>"><?= htmlspecialchars($mensagem) ?></div>
<?php endif; ?>

<?php if ($faltando): ?>
  <div class="cx">
    <p style="margin:0 0 10px">Próximo: <code><?= htmlspecialchars($proximo) ?></code></p>
    <?php if (!$continuar): ?>
      <p class="m" style="margin:0 0 12px">A página parou por causa do erro acima. Você pode tentar de novo.</p>
      <a class="btn" href="?chave=<?= urlencode($CHAVE) ?>&baixar=1">Tentar de novo</a>
    <?php else: ?>
      <p class="m" style="margin:0">Baixando, a página se recarrega sozinha. Arquivos grandes demoram.</p>
    <?php endif; ?>
  </div>
<?php else: ?>
  <div class="cx ok">
    <p style="margin:0 0 10px"><b>Espelho completo.</b> O TranscrevAI já pode usar os modelos deste domínio.</p>
    <p class="m" style="margin:0">Agora apague este arquivo <code>baixar-modelos.php</code> do servidor.</p>
  </div>
<?php endif; ?>

<p class="m" style="font-size:13px">Os arquivos ficam em <code>modelos/</code>, na mesma estrutura de pastas do Hugging Face.</p>
</body></html>
