# Teleprompter

## 👉 [Abrir o Teleprompter](https://gleibson-crn.github.io/teleprompter/)

**https://gleibson-crn.github.io/teleprompter/** — toque no link no celular. Para instalar, use o menu ⋮ do Chrome → **Instalar app**.

Teleprompter para celular em forma de **PWA**: você instala pelo navegador, sem loja de aplicativos, e ele funciona offline. É HTML, CSS e JS puro, sem build e sem dependências. Os roteiros ficam só no aparelho (`localStorage`).

## Recursos

- Vários roteiros, com autosave, duplicar, excluir e contagem de palavras e tempo estimado.
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
  - preview da câmera frontal, com o texto no topo, perto da lente;
  - gravação de áudio e vídeo **sem o texto**;
  - o vídeo é salvo em MP4 quando o navegador suporta (WebM nos demais) ou enviado pelo compartilhar.
- A tela não apaga durante a leitura (Wake Lock). Tela cheia ao abrir o teleprompter.
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
2. **Incremente `VERSION` em [sw.js](sw.js).** Sem isso, os celulares continuam com a versão em cache. Se criar arquivo novo, adicione-o a `ASSETS`.
3. Faça commit e push na `main`. O GitHub Pages publica sozinho, sem Actions.
4. No celular, aparece o aviso "Nova versão disponível". Toque nele para atualizar.

## Estrutura

| Arquivo | Papel |
|---|---|
| `index.html` | As 3 telas: lista, editor e teleprompter |
| `css/app.css` | Estilos (tema escuro, mobile-first) |
| `js/app.js` | Rotas (hash), lista, editor, ajustes, importar/exportar, registro do SW |
| `js/prompter.js` | Rolagem, gestos, contagem, Wake Lock, câmera e gravação |
| `js/store.js` | Persistência em `localStorage` |
| `js/icons.js` | Ícones [Lucide](https://lucide.dev) (ISC) |
| `sw.js` | Cache offline e atualização |
| `tools/make-icons.mjs` | Gera os PNGs do ícone (`node tools/make-icons.mjs`) |
