/* Refine Prompt - camada de destaque na página.
 *
 * Tudo que a extensão pinta sobre a página: realce do elemento sob o cursor,
 * tooltip com a etiqueta, realce do elemento de um comentário e os pins
 * numerados dos comentários daquela página.
 *
 * Três decisões de implementação que vale não desfazer:
 *
 * 1. Shadow root fechado + folha construída (CSSStyleSheet + adoptedStyleSheets).
 *    Folha construída não passa por `style-src`, então funciona em página com
 *    CSP estrita - ao contrário de injetar um `<style>`. O shadow isola o CSS
 *    da página (um `* { box-sizing }` ou `text-transform` global da página não
 *    deforma o realce).
 *
 * 2. `pointer-events: none` inline com `!important` no host. O picker
 *    neutraliza `pointer-events` da página inteira com uma folha `!important`
 *    (ver 40-picker.js) e essa folha pegaria o nosso host junto - aí o
 *    overlay engoliria o clique e nada seria selecionável. Declaração inline
 *    com `!important` vence folha de autor com `!important`, e é a única razão
 *    de o estilo do host estar em JS em vez de na folha.
 *
 * 3. Um loop de requestAnimationFrame em vez de listeners de scroll/resize/
 *    transitionend. `getBoundingClientRect()` e o host `position: fixed` são
 *    os dois relativos à viewport, então o rect entra direto, sem matemática
 *    de scroll - e um mecanismo só cobre scroll, resize, animação e reflow.
 */
(() => {
  'use strict';

  const RP = globalThis.__RP;
  if (!RP) return;

  const VERDE = '#008a00';
  const VERDE_CLARO = 'rgba(28, 235, 0, 0.14)';

  /** Lado do pin em px. Precisa casar com o CSS de .pin, porque a posição é
   *  calculada aqui em JS. */
  const PIN = 26;

  const CSS_OVERLAY = `
    .caixa {
      position: absolute; top: 0; left: 0;
      border-radius: 6px;
      pointer-events: none;
    }
    .hover { background: ${VERDE_CLARO}; outline: 2px solid ${VERDE}; }
    .foco  { outline: 2px solid ${VERDE}; outline-offset: 1px; }
    .tip {
      position: absolute; top: 0; left: 0;
      display: flex; gap: 6px; align-items: center;
      max-width: 340px;
      padding: 3px 7px;
      border-radius: 6px;
      background: rgba(0,0,0,0.85);
      color: #fff;
      font: 600 11px/14px ui-monospace, SFMono-Regular, Menlo, monospace;
      white-space: nowrap;
      pointer-events: none;
    }
    .tip b { font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
    .tip span { opacity: 0.6; font-weight: 500; }
    .tip span.dica:empty { display: none; }
    .tip span.dica { opacity: 1; color: #7dff4d; }
    .pin {
      position: absolute; top: 0; left: 0;
      width: ${PIN}px; height: ${PIN}px;
      display: flex; align-items: center; justify-content: center;
      border-radius: 999px 999px 999px 2px;
      background: ${VERDE};
      color: #fff;
      font: 600 11px/1 ui-sans-serif, system-ui, sans-serif;
      font-variant-numeric: tabular-nums;
      box-shadow: 0 6px 18px -8px rgba(0,0,0,0.5);
      /* Clicável: o pin é a porta de entrada para reler e editar o comentário
       * sem ir até o painel. É a única parte do overlay que recebe ponteiro. */
      pointer-events: auto;
      cursor: pointer;
    }
    .pin:hover { background: #007300; }
    .bolha {
      position: absolute; top: 0; left: 0;
      width: 240px;
      box-sizing: border-box;
      padding: 9px 11px;
      border-radius: 12px;
      background: #fff;
      box-shadow: 0 10px 30px -12px rgba(0,0,0,0.35);
      pointer-events: none;
      font: 400 13px/19px Inter, -apple-system, BlinkMacSystemFont, Arial, sans-serif;
      color: rgba(0,0,0,0.85);
      text-transform: none; letter-spacing: normal; text-align: left;
    }
    .bolha .texto { display: block; overflow-wrap: anywhere; }
    .bolha .rodape {
      display: block; margin-top: 4px;
      font-size: 11px; line-height: 15px; font-weight: 600;
      color: rgba(0,0,0,0.35);
    }
    [hidden] { display: none !important; }
  `;

  let host = null;
  let raiz = null;
  let nos = null;
  let folha = null;

  /** WeakRef: um elemento removido da página não pode ficar vivo só porque
   *  está destacado. Todo consumidor já trata "o elemento saiu". */
  let focoRef = null;
  let pinsRefs = [];
  let raf = 0;

  const O = (RP.overlay = {
    montado() {
      return !!host && host.isConnected;
    },

    montar() {
      if (O.montado()) return;

      /* Sobra de uma injeção anterior que não conseguiu se desmontar (extensão
       * recarregada com a página aberta): sai antes, senão a página fica com
       * dois overlays e o de cima é o morto. */
      for (const velho of document.querySelectorAll('[data-refine-prompt="overlay"]')) {
        velho.remove();
      }

      host = document.createElement('div');
      host.setAttribute('data-refine-prompt', 'overlay');
      /* Inline + important: ver decisão 2 no cabeçalho. */
      const fixo = {
        position: 'fixed',
        inset: '0',
        margin: '0',
        border: '0',
        padding: '0',
        background: 'none',
        'pointer-events': 'none',
        'z-index': '2147483647',
      };
      for (const [k, v] of Object.entries(fixo)) host.style.setProperty(k, v, 'important');

      raiz = host.attachShadow({ mode: 'closed' });
      if (!folha) {
        folha = new CSSStyleSheet();
        folha.replaceSync(CSS_OVERLAY);
      }
      raiz.adoptedStyleSheets = [folha];

      nos = {
        pins: criar('div'),
        foco: criar('div', 'caixa foco'),
        hover: criar('div', 'caixa hover'),
        tip: criar('div', 'tip'),
      };
      nos.tipEtiqueta = criar('b');
      nos.tipDim = criar('span');
      nos.tipDica = criar('span', 'dica');
      nos.tip.append(nos.tipEtiqueta, nos.tipDim, nos.tipDica);

      nos.bolha = criar('div', 'bolha');
      nos.bolhaTexto = criar('span', 'texto');
      nos.bolhaRodape = criar('span', 'rodape');
      nos.bolha.append(nos.bolhaTexto, nos.bolhaRodape);

      esconder(nos.foco);
      esconder(nos.hover);
      esconder(nos.tip);
      esconder(nos.bolha);
      raiz.append(nos.pins, nos.foco, nos.hover, nos.tip, nos.bolha);

      /* documentElement, não body: página com `body { overflow: hidden }` ou
       * body substituído por framework não leva o overlay embora. */
      document.documentElement.appendChild(host);
    },

    desmontar() {
      O.pararLoop();
      focoRef = null;
      pinsRefs = [];
      if (host && host.parentNode) host.parentNode.removeChild(host);
      host = null;
      raiz = null;
      nos = null;
    },

    /** Realce do elemento sob o cursor. `null` apaga. `dica` é o indicador de
     *  pilha do picker ("2/4 · alt") - entra na mesma chamada porque o
     *  tooltip é medido depois de escrito, e escrever em dois passos
     *  posicionaria com a largura errada. */
    hover(el, dica) {
      O.montar();
      if (!el || !el.isConnected) {
        esconder(nos.hover);
        esconder(nos.tip);
        return;
      }
      const r = el.getBoundingClientRect();
      posicionar(nos.hover, r);
      nos.hover.hidden = false;
      const tam = RP.locate.tamanho(el);
      nos.tipEtiqueta.textContent = RP.locate.etiqueta(el);
      nos.tipDim.textContent = tam.w + '×' + tam.h;
      nos.tipDica.textContent = dica || '';
      posicionarTip(r);
    },

    limparHover() {
      if (!nos) return;
      esconder(nos.hover);
      esconder(nos.tip);
    },

    /** Realce fixo de um elemento - usado quando o painel passa o mouse num
     *  comentário. Acompanha scroll pelo loop. */
    foco(el) {
      const alvo = el && el.isConnected ? el : null;
      /* Apagar realce numa página onde nada foi pintado ainda não é motivo
       * para montar overlay: o painel manda `foco: null` em cada mouseleave e
       * `pins: []` em cada página nova. */
      if (!alvo && !O.montado()) return;
      O.montar();
      focoRef = alvo ? new WeakRef(alvo) : null;
      if (!focoRef) esconder(nos.foco);
      O.sincronizarLoop();
    },

    /** Pins numerados dos comentários da página atual.
     *  `itens`: [{ n, el, id, texto, alvo }] - quem resolve elemento é o boot.
     *
     *  Os nós são construídos aqui, uma vez por lista, e o loop só move eles.
     *  A primeira versão recriava os nós a cada frame; com pin clicável isso
     *  não serve, porque um nó novo por frame perde o hover e o listener. */
    pins(itens) {
      const vivos = (itens || []).filter((i) => i && i.el && i.el.isConnected);
      if (!vivos.length && !O.montado()) return;
      O.montar();
      construirPins(vivos);
      O.sincronizarLoop();
    },

    /* ------------------------------------------------------------- loop */

    sincronizarLoop() {
      const precisa = !!focoRef || pinsRefs.length > 0;
      if (precisa) O.iniciarLoop();
      else O.pararLoop();
    },

    iniciarLoop() {
      if (raf) return;
      /* Embrulhado: exceção dentro de um rAF que roda a cada frame não pode
       * virar "Uncaught" - seria uma entrada nova a cada 16ms. */
      const passo = RP.seguro(() => {
        raf = 0;
        if (!O.montado()) return;

        const alvoFoco = focoRef && focoRef.deref();
        if (alvoFoco && alvoFoco.isConnected) {
          posicionar(nos.foco, alvoFoco.getBoundingClientRect());
          nos.foco.hidden = false;
        } else {
          esconder(nos.foco);
        }

        pintarPins();

        if (focoRef || pinsRefs.length) raf = requestAnimationFrame(passo);
      });
      raf = requestAnimationFrame(passo);
    },

    /* Não mexe nos nós dos pins: quem os cria e destrói é `construirPins`. O
     * loop só os move, então pará-lo não pode apagar a lista. */
    pararLoop() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      if (nos) esconder(nos.foco);
    },
  });

  /** Monta um nó por comentário da página, com o listener de hover e clique. */
  function construirPins(itens) {
    nos.pins.textContent = '';
    esconder(nos.bolha);
    pinsRefs = [];

    /* Quantos pins já foram colocados em CADA elemento: dois comentários no
     * mesmo elemento cairiam exatamente um sobre o outro, então o segundo em
     * diante desloca para o lado (mesma ideia do cluster de pins do Figma). */
    const porEl = new Map();

    for (const item of itens) {
      const pilha = porEl.get(item.el) || 0;
      porEl.set(item.el, pilha + 1);

      const no = criar('div', 'pin');
      no.textContent = String(item.n);
      no.addEventListener('pointerenter', RP.seguro(() => mostrarBolha(no, item)));
      no.addEventListener('pointerleave', RP.seguro(() => esconder(nos.bolha)));
      /* Editar no lugar: a caixa reabre encostada no elemento, com o texto que
       * já estava lá. Poupa a ida ao painel para um ajuste de uma palavra.
       *
       * `pointerdown` e não `click`: o supressor do picker dá `preventDefault`
       * nos eventos do pin (para o clique não navegar a página por baixo), e
       * `preventDefault` no pointerdown suprime os eventos de mouse de
       * compatibilidade - depender do `click` aqui seria depender de detalhe de
       * motor. É também o mesmo tempo em que a seleção de elemento acontece. */
      no.addEventListener('pointerdown', RP.seguro((e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        engolirProximoClique();
        esconder(nos.bolha);
        if (RP.caixa) RP.caixa.abrir(item.el, item.alvo, { id: item.id, texto: item.texto });
      }));

      nos.pins.appendChild(no);
      pinsRefs.push({ no, pilha, item, ref: new WeakRef(item.el) });
    }
  }

  /** Move os pins existentes. Roda a cada frame em vez de rastrear
   *  scroll/reflow por conta própria; o custo é só uma matriz por pin. */
  function pintarPins() {
    for (const p of pinsRefs) {
      const el = p.ref.deref();
      if (!el || !el.isConnected) {
        p.no.hidden = true;
        continue;
      }
      p.no.hidden = false;
      posicionarPin(p.no, el.getBoundingClientRect(), p.pilha);
    }
  }

  /** O clique no pin não pode virar clique na página - um pin sobre um link
   *  navegaria a aba no lugar de abrir a edição. Com a seleção armada, o
   *  supressor do picker já cobre isso; com ela desligada, não há supressor
   *  nenhum, e é este engolidor de um clique que fecha o buraco. O prazo
   *  existe para o caso do ponteiro sair do pin antes de soltar: aí o clique
   *  nunca vem, e o listener não pode ficar pendurado esperando um clique
   *  qualquer mais tarde. */
  function engolirProximoClique() {
    const engolir = RP.seguro((e) => {
      e.preventDefault();
      e.stopPropagation();
      janela();
    });
    const janela = () => {
      clearTimeout(prazo);
      window.removeEventListener('click', engolir, true);
    };
    const prazo = setTimeout(janela, 400);
    window.addEventListener('click', engolir, true);
  }

  /** Balão de leitura do comentário, ancorado no pin. */
  function mostrarBolha(pin, item) {
    nos.bolhaTexto.textContent = item.texto || '';
    nos.bolhaRodape.textContent = item.n + ' · clique para editar';
    nos.bolha.hidden = false;
    const r = pin.getBoundingClientRect();
    const alto = nos.bolha.offsetHeight || 60;
    const x = RP.clamp(r.left, 4, Math.max(4, window.innerWidth - 244));
    const y =
      r.bottom + 6 + alto > window.innerHeight - 4 ? r.top - alto - 6 : r.bottom + 6;
    nos.bolha.style.transform =
      'translate(' + Math.round(x) + 'px,' + Math.round(RP.clamp(y, 4, window.innerHeight - alto - 4)) + 'px)';
  }

  /* ------------------------------------------------------------ posições */

  function posicionar(no, r) {
    no.style.transform = 'translate(' + r.left + 'px,' + r.top + 'px)';
    no.style.width = Math.max(0, r.width) + 'px';
    no.style.height = Math.max(0, r.height) + 'px';
  }

  /** Acima do elemento; vira para baixo quando não cabe. Clamp na viewport
   *  porque elemento no topo deixaria o tooltip fora da tela. */
  function posicionarTip(r) {
    const tip = nos.tip;
    tip.hidden = false;
    const h = tip.offsetHeight || 20;
    const w = tip.offsetWidth || 60;
    const y = r.top < h + 6 ? r.bottom + 4 : r.top - h - 4;
    const x = RP.clamp(r.left, 2, Math.max(2, window.innerWidth - w - 2));
    tip.style.transform =
      'translate(' + x + 'px,' + RP.clamp(y, 2, window.innerHeight - h - 2) + 'px)';
  }

  /** Ponta do balão (canto vivo, embaixo à esquerda) no canto superior
   *  esquerdo do elemento: o pin fica logo acima, sem cobrir o conteúdo. */
  function posicionarPin(no, r, pilha) {
    const x = RP.clamp(
      r.left + pilha * (PIN * 0.7),
      2,
      Math.max(2, window.innerWidth - PIN - 2)
    );
    const y = RP.clamp(r.top - PIN - 2, 2, Math.max(2, window.innerHeight - PIN - 2));
    no.style.transform = 'translate(' + x + 'px,' + y + 'px)';
  }

  /* ------------------------------------------------------------ helpers */

  function criar(tag, cls) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    return n;
  }

  function esconder(n) {
    if (n) n.hidden = true;
  }

  /** O host é nosso: o picker precisa saber para não selecionar o overlay. */
  O.host = () => host;

  /** O shadow root, para a caixa de comentário (60-caixa.js) pendurar os nós
   *  dela e a folha dela no mesmo isolamento - em vez de abrir um segundo
   *  shadow root só para isso. */
  O.raiz = () => raiz;
})();
