/* Refine Prompt - a caixa de comentário, ancorada no elemento.
 *
 * Escrever o comentário acontece na página, ao lado do que foi clicado. O
 * painel guarda a sessão e exporta; ele não é onde se escreve.
 *
 * O motivo é de leitura, não de gosto: o clique congela o realce (o mouse
 * deixa de escolher alvo até o comentário sair), e com o campo de texto do
 * outro lado da tela esse congelamento não tem explicação visível - parece que
 * a extensão travou. Com a caixa encostada no elemento, o congelamento é o
 * próprio estado da caixa aberta.
 *
 * Três coisas que a fronteira do shadow root obriga aqui:
 *
 * 1. `pointer-events: auto` explícito. A propriedade é herdada, e o host do
 *    overlay é `none !important` (para não engolir clique da página) - sem
 *    declarar de novo, a caixa nasceria intocável. Pelo mesmo motivo, `cursor`
 *    e `user-select` são redeclarados: a folha do picker põe `crosshair` e
 *    `none` na página inteira, e os dois atravessam a fronteira por herança.
 * 2. Fonte e propriedades de texto explícitas. Herança também traz o
 *    `text-transform: uppercase` global de um site, que deformaria a caixa.
 * 3. As teclas são tratadas num listener de captura no window, não no
 *    textarea. É o que impede a página de ver o que está sendo digitado: um
 *    site com atalho de tecla solta ("/" abre busca) reagiria a cada letra do
 *    comentário. `stopImmediatePropagation` sem `preventDefault` esconde o
 *    evento dos listeners da página e mantém a digitação funcionando, porque a
 *    ação padrão não depende da propagação.
 * 4. Classe própria (`.comentario`), porque a folha daqui é adotada no MESMO
 *    shadow root do overlay. A primeira versão usou `.caixa`, que é a classe
 *    genérica das caixas de realce em 30-overlay.js - e como esta folha é
 *    adotada depois, o realce herdou `background: #fff` e `pointer-events:
 *    auto`: virou cartão branco opaco cobrindo o elemento e engolindo o
 *    clique. Nome novo aqui precisa continuar fora do vocabulário do overlay
 *    (`caixa`, `hover`, `foco`, `tip`, `pin`).
 */
(() => {
  'use strict';

  const RP = globalThis.__RP;
  if (!RP) return;

  const VERDE = '#008a00';
  const LARGURA = 264;
  const MARGEM = 8;

  const CSS_CAIXA = `
    .comentario {
      position: absolute; top: 0; left: 0;
      width: ${LARGURA}px;
      box-sizing: border-box;
      padding: 12px;
      border: 1px solid rgba(0,0,0,0.06);
      border-radius: 16px;
      background: #fff;
      box-shadow: 0 10px 30px -12px rgba(0,0,0,0.3);
      pointer-events: auto;
      cursor: default;
      user-select: text;
      font: 400 13px/20px Inter, -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif;
      color: rgba(0,0,0,0.85);
    }
    .comentario, .comentario * {
      box-sizing: border-box;
      text-transform: none;
      letter-spacing: normal;
      font-style: normal;
      text-align: left;
      text-indent: 0;
      word-spacing: normal;
      text-shadow: none;
      direction: ltr;
    }
    .comentario .alvo {
      margin: 0 4px 6px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      font-size: 11px; line-height: 16px; font-weight: 400;
      color: rgba(0,0,0,0.45);
    }
    .comentario textarea {
      display: block; width: 100%;
      resize: none; border: 0; border-radius: 10px;
      padding: 8px 10px;
      background: rgba(0,0,0,0.04);
      font: inherit; color: inherit;
      outline: none; cursor: text; user-select: text;
    }
    .comentario textarea::placeholder { color: rgba(0,0,0,0.35); }
    .comentario textarea:focus { box-shadow: inset 0 0 0 2px rgba(0,138,0,0.35); }
    .comentario .linha {
      display: flex; align-items: center; justify-content: flex-end;
      gap: 2px; margin-top: 8px;
    }
    .comentario button {
      border: 0; border-radius: 10px;
      padding: 6px 12px;
      font: 600 12px/1 inherit;
      cursor: pointer;
    }
    .comentario .cancelar { background: none; color: rgba(0,0,0,0.45); }
    .comentario .cancelar:hover { color: rgba(0,0,0,0.85); }
    .comentario .enviar { background: ${VERDE}; color: #fff; }
    .comentario .enviar:disabled { opacity: 0.4; cursor: default; }
  `;

  /* Embrulhados por identidade estável, igual ao picker: exceção em listener
   * de content script não pode virar "Uncaught". */
  const posicionarSeguro = RP.seguro(() => posicionar());
  const teclarSeguro = RP.seguro((e) => aoTeclar(e));

  let folha = null;
  let no = null;
  let campo = null;
  let botao = null;
  /** Elemento comentado e seu descritor, enquanto a caixa está aberta. */
  let alvoEl = null;
  let alvoDesc = null;
  /** { id, texto } quando a caixa está editando um comentário existente. */
  let editando = null;

  const C = (RP.caixa = {
    aberta() {
      return !!no;
    },

    /** true quando não há nada escrito - o que autoriza reapontar a caixa para
     *  outro elemento sem perder texto. */
    vazia() {
      return !campo || !campo.value.trim();
    },

    /** `edicao` = { id, texto } quando a caixa reabre sobre um comentário que
     *  já existe (clique no pin). Sem ela, é comentário novo. */
    abrir(el, descritor, edicao) {
      C.fechar(true);
      alvoEl = el;
      alvoDesc = descritor;
      editando = edicao || null;

      RP.overlay.montar();
      const raiz = RP.overlay.raiz();
      if (!raiz) return;
      anexarFolha(raiz);

      no = criar('div', 'comentario');

      const rotulo = criar('p', 'alvo');
      rotulo.textContent = descritor.rotulo || descritor.etiqueta;
      rotulo.title = descritor.caminho || '';

      campo = document.createElement('textarea');
      campo.rows = 3;
      campo.placeholder = 'O que muda aqui?';
      campo.spellcheck = false;
      if (editando) campo.value = editando.texto || '';
      campo.addEventListener('input', RP.seguro(sincronizarBotao));

      const linha = criar('div', 'linha');
      const cancelar = criar('button', 'cancelar');
      cancelar.type = 'button';
      cancelar.textContent = 'Cancelar';
      cancelar.addEventListener('click', RP.seguro(() => C.fechar()));

      botao = criar('button', 'enviar');
      botao.type = 'button';
      botao.textContent = editando ? 'Salvar' : 'Comentar';
      botao.disabled = !campo.value.trim();
      botao.addEventListener('click', RP.seguro(enviar));

      linha.append(cancelar, botao);
      no.append(rotulo, campo, linha);
      raiz.appendChild(no);

      posicionar();
      if (RP.picker) RP.picker.pausar(el);
      RP.on(window, 'scroll', posicionarSeguro, true);
      RP.on(window, 'resize', posicionarSeguro);
      RP.on(window, 'keydown', teclarSeguro, true);

      /* O foco espera o nó existir de fato no layout; sem o frame, o textarea
       * ainda não é focável em alguns caminhos de render. Editando, o cursor
       * vai para o fim do texto em vez de selecionar tudo - o caso comum é
       * completar a frase, não reescrever. */
      requestAnimationFrame(() => {
        if (!campo) return;
        campo.focus();
        const fim = campo.value.length;
        campo.setSelectionRange(fim, fim);
      });
    },

    /** `silencioso` evita retomar o picker quando o fechamento é só a troca de
     *  alvo (abrir() fecha a caixa anterior antes de montar a nova). */
    fechar(silencioso) {
      if (!no) return;
      RP.off(window, 'scroll', posicionarSeguro, true);
      RP.off(window, 'resize', posicionarSeguro);
      RP.off(window, 'keydown', teclarSeguro, true);
      if (no.parentNode) no.parentNode.removeChild(no);
      no = null;
      campo = null;
      botao = null;
      alvoEl = null;
      alvoDesc = null;
      editando = null;
      if (!silencioso && RP.picker) RP.picker.retomar();
    },
  });

  function sincronizarBotao() {
    if (botao && campo) botao.disabled = !campo.value.trim();
  }

  function enviar() {
    if (!campo || !alvoDesc) return;
    const texto = campo.value.trim();
    if (!texto) return;
    RP.paraPainel(
      editando
        ? { rp: 'comentario-editado', id: editando.id, texto }
        : { rp: 'comentario', texto, alvo: alvoDesc, pagina: RP.pagina() }
    );
    C.fechar();
  }

  /** Encostada no elemento: embaixo por padrão, em cima quando não cabe.
   *  Presa na viewport nas duas direções - elemento no canto deixaria a caixa
   *  metade fora da tela. */
  function posicionar() {
    if (!RP.atual() || !no || !alvoEl || !alvoEl.isConnected) return;
    const r = alvoEl.getBoundingClientRect();
    const alto = no.offsetHeight || 140;
    const x = RP.clamp(r.left, MARGEM, Math.max(MARGEM, window.innerWidth - LARGURA - MARGEM));
    let y = r.bottom + MARGEM;
    if (y + alto > window.innerHeight - MARGEM) y = r.top - alto - MARGEM;
    y = RP.clamp(y, MARGEM, Math.max(MARGEM, window.innerHeight - alto - MARGEM));
    no.style.transform = 'translate(' + Math.round(x) + 'px,' + Math.round(y) + 'px)';
  }

  /** Enquanto a caixa está aberta, o teclado é dela: o picker não cicla pilha
   *  com Alt (ver a guarda em 40-picker.js) e a página não vê a digitação. */
  function aoTeclar(e) {
    if (!RP.atual() || !no) return;
    if (!e.composedPath().includes(RP.overlay.host())) return;

    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      C.fechar();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      enviar();
      return;
    }
    /* Sem preventDefault: a letra continua entrando no textarea, só não chega
     * aos listeners da página. */
    e.stopImmediatePropagation();
  }

  function anexarFolha(raiz) {
    if (!folha) {
      folha = new CSSStyleSheet();
      folha.replaceSync(CSS_CAIXA);
    }
    if (!raiz.adoptedStyleSheets.includes(folha)) {
      raiz.adoptedStyleSheets = [...raiz.adoptedStyleSheets, folha];
    }
  }

  function criar(tag, cls) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    return n;
  }
})();
