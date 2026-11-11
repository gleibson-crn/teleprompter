# Teleprompter

## 👉 [Abrir o Teleprompter](https://gleibson-crn.github.io/teleprompter/)

**https://gleibson-crn.github.io/teleprompter/** — toque no link no celular. Para instalar, use o menu ⋮ do Chrome → **Instalar app**.

Teleprompter para celular em forma de **PWA**: você instala pelo navegador, sem loja de aplicativos, e ele funciona offline. É HTML, CSS e JS puro, sem build. A única biblioteca de terceiros é o detector de rosto (MediaPipe), guardado dentro do repositório. Os roteiros ficam só no aparelho (`localStorage`).

## Recursos

- Vários roteiros, com autosave, colar da área de transferência, excluir e contagem de palavras e tempo estimado.
- Rolagem automática com velocidade ajustável ao vivo (− / +).
- Toque inicia ou pausa a rolagem. Arrastar posiciona o texto.
- Ajustes salvos no aparelho:
  - tamanho da fonte;
  - margens;
  - linha de leitura (posição e liga/desliga);
  - contagem regressiva;
  - texto centralizado;
  - espelhamento horizontal e vertical (para teleprompter com vidro).
- **Modo câmera:**
  - preview da câmera, com o texto perto da lente: no topo com o celular em pé, e na lateral do lado da lente com o celular deitado;
  - gravação de áudio e vídeo **sem o texto**;
  - o vídeo é salvo em MP4 quando o navegador suporta (WebM nos demais) ou enviado pelo compartilhar.
- **Vertical inteligente (9:16):**
  - com o celular deitado, a câmera grava em 1080p e o preview mostra ao vivo o recorte vertical que **acompanha o seu rosto**;
  - com o celular **em pé**, a câmera já entrega o quadro vertical: o app grava um vídeo só, em resolução cheia, e não procura o rosto (não há o que recortar);
  - ao parar, você recebe **dois vídeos**: o horizontal (1920×1080) e o vertical (608×1080), gerado logo depois da gravação (leva mais ou menos a duração do vídeo; mantenha o app aberto);
  - durante a gravação só o horizontal é codificado (mais leve); o vertical gerado antecipa o movimento em 0,2 s, compensando o atraso do acompanhamento;
  - o recorte usa suavização e zona morta para não tremer; o detector de rosto roda numa thread separada (Web Worker), sem travar a tela;
  - o painel Câmera e áudio mostra o desempenho ao vivo (fps do preview, detector e tempo de detecção);
  - o detector de rosto (MediaPipe, ~12 MB) é baixado na 1ª vez que você liga o modo e depois funciona offline.
- **Câmera e áudio** (botão de controles na tela da câmera):
  - câmera frontal ou traseira, resolução 720p/1080p e 30/60 fps;
  - zoom, exposição, foco manual e lanterna, que só aparecem se o aparelho suportar;
  - grade de terços e guia vertical 9:16;
  - escolha do microfone (interno, com fio, USB);
  - modo **Voz** (redução de ruído, corte de grave, clareza, compressor) ou **Cru**;
  - ganho de até +20 dB com limitador que impede estourar;
  - opção de silenciar o fundo nas pausas (noise gate);
  - medidor de nível;
  - **teste de microfone** de 5 s com comparação entre som cru e tratado.
  - **diagnóstico de gravação** (8 s, nada é salvo): mostra o codificador de vídeo (hardware × software), quadros reais da câmera e do arquivo, maior buraco entre quadros e travadas da tela; botão Copiar para enviar o relatório.
- A tela não apaga durante a leitura (Wake Lock).
- Teclado ou pedal Bluetooth:
  - espaço inicia ou pausa;
  - ↑ e ↓ mudam a velocidade;
  - PgUp/PgDn e ←/→ saltam pelo texto.
- Importar e exportar roteiros (`.json` com todos, ou `.txt` avulso). Exporte de vez em quando como backup.

## Instalar no celular (Android / Chrome)

1. Abra a URL do app no Chrome.
2. Menu ⋮ → **Instalar app** ou **Adicionar à tela inicial**.
3. Pronto: o app abre como aplicativo e funciona sem internet.

## Rodar localmente

```bash
npx http-server -c-1 .
```

Câmera, service worker e Wake Lock exigem HTTPS ou `localhost`.

## Publicar nova versão

1. Altere os arquivos.
2. **Incremente `VERSION` em [sw.js](sw.js).** Sem isso, os celulares continuam com a versão em cache. Se criar arquivo novo, adicione-o a `ASSETS`. Os arquivos de `vendor/` não entram em `ASSETS`: eles têm cache próprio, preenchido no 1º uso. Se trocar a versão do MediaPipe, mude também `VENDOR_CACHE`.
3. Faça commit e push na `main`. O GitHub Pages publica sozinho, sem Actions.
4. No celular, aparece o aviso "Nova versão disponível". Toque nele para atualizar.

## Estrutura

| Arquivo | Papel |
|---|---|
| `index.html` | As 3 telas: lista, editor e teleprompter |
| `css/app.css` | Estilos (tema escuro, mobile-first) |
| `js/app.js` | Rotas (hash), lista, editor, ajustes, importar/exportar, registro do SW |
| `js/prompter.js` | Rolagem, gestos, contagem, Wake Lock, layout da câmera, painel Câmera e áudio, gravação |
| `js/capture.js` | Abre câmera e microfone, decide o que é gravado, controles de câmera, teste de microfone |
| `js/audio.js` | Cadeia de áudio (Web Audio): filtro, presença, compressor, ganho, noise gate, limitador, medidor |
| `js/diag.js` | Diagnóstico de gravação (codificadores, quadros do MP4, travadas) |
| `js/face-worker.js` | Detector de rosto (MediaPipe) num Web Worker, fora da thread que desenha a tela |
| `js/reframe.js` | Vertical inteligente: preview 9:16, acompanhamento do rosto, caminho do recorte e geração do vertical após a gravação |
| `vendor/mediapipe/` | MediaPipe Tasks Vision 0.10.34 + modelo BlazeFace (Apache-2.0), carregado sob demanda |
| `js/store.js` | Persistência em `localStorage` |
| `js/icons.js` | Ícones [Lucide](https://lucide.dev) (ISC) |
| `sw.js` | Cache offline e atualização |
| `tools/make-icons.mjs` | Gera os PNGs do ícone (`node tools/make-icons.mjs`) |
