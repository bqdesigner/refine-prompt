/* Refine Prompt - modo de seleção.
 *
 * Fica armado indefinidamente: cada clique manda um alvo para o painel e o
 * picker continua pronto para o próximo. Sai só no Esc ou quando o painel
 * pede. Comentar 8 elementos em 3 páginas não pode custar 8 idas ao botão.
 *
 * O CONSERTO DO BUG QUE FALHAVA CALADO
 *
 * Elemento com `pointer-events: none` nunca é target de evento de ponteiro,
 * logo nunca entra no `composedPath()` - e `elementFromPoint()` respeita a
 * mesma regra. O picker antigo pegava o elemento de trás e selecionava a coisa
 * errada em silêncio (rodapé, badge, watermark, overlay decorativo: o padrão é
 * comum). O conserto é neutralizar `pointer-events` da página inteira enquanto
 * o picker está ativo, com uma folha construída `!important` - aí o elemento
 * volta a ser alcançável pelo próprio evento, sem hit-test geométrico na mão.
 *
 * Isso abre o caso espelho: uma camada que cobre a viewport inteira só para
 * não bloquear clique (container de toast, gradiente decorativo, portal de
 * modal) passa a receber tudo e viraria o alvo em qualquer ponto da tela. Daí
 * as duas defesas:
 *
 * - `passaVento()`: camada que cobre ~toda a viewport e não tem texto próprio
 *   sai da frente na ordem de preferência (html e body caem aqui também, o que
 *   é justamente o certo).
 * - `Alt` cicla a pilha sob o cursor, como o inspecionar do DevTools. É a saída
 *   determinística para qualquer caso que a heurística errar - e o tooltip
 *   mostra a etiqueta do alvo e a posição na pilha, então o designer vê o que
 *   vai comentar antes de clicar, em vez de descobrir depois no relatório.
 */
(() => {
  'use strict';

  const RP = globalThis.__RP;
  if (!RP) return;

  /* A sequência inteira, não só o click: muitos sites agem no mousedown, e
   * alguns no pointerdown. Deixar qualquer um passar significa navegar, abrir
   * menu ou submeter formulário quando o usuário só queria selecionar. */
  const SUPRIMIR = [
    'pointerdown',
    'mousedown',
    'pointerup',
    'mouseup',
    'click',
    'dblclick',
    'auxclick',
    'contextmenu',
    'dragstart',
  ];

  /* `pointer-events: auto` é o conserto do bug 3 (ver cabeçalho). O resto
   * evita que arrastar o cursor pela página selecione texto no caminho. */
  const CSS_PICKER =
    '*, *::before, *::after { pointer-events: auto !important; ' +
    'cursor: crosshair !important; user-select: none !important; ' +
    '-webkit-user-select: none !important; }';

  /** Fração da viewport a partir da qual uma camada sem texto é considerada
   *  de passagem. 0.85 e não 1: overlay costuma ter uma margem de alguns px. */
  const COBRE = 0.85;

  let folha = null;
  let pontoX = 0;
  let pontoY = 0;
  let profundidade = 0;
  let topoAnterior = null;
  let suprimindo = false;

  /** Ligado no clique, desligado quando o painel avisa que o comentário foi
   *  enviado ou descartado. Enquanto está ligado, mover o mouse não repinta
   *  nada: o realce fica travado no elemento escolhido.
   *
   *  Sem isto, o caminho do cursor até o campo de texto ia acendendo tudo o
   *  que passasse embaixo, e a referência visual do que estava sendo comentado
   *  se perdia no meio do trajeto. */
  let pausado = false;

  /** Candidatos sob o cursor, em ordem de preferência, medidos na última
   *  posição conhecida. `profundidade` é o índice escolhido nesta lista. */
  let ordem = [];

  /** Ligado pelo primeiro `Alt`: força montar a pilha inteira mesmo quando o
   *  caminho rápido já tinha um alvo bom. Sem isto o `Alt` não teria para onde
   *  ir justamente no caso mais comum, que é o caminho rápido. */
  let forcarPilha = false;

  /* As leituras de `RP.caixa` daqui para baixo são guardadas de propósito.
   * Num carregamento inteiro o módulo sempre existe - 60-caixa.js vem antes de
   * qualquer coisa poder chamar isto. A guarda cobre o carregamento PARCIAL:
   * recarregar a extensão no meio de um `executeScript` derruba os arquivos que
   * ainda não entraram, e aí o picker existe sem a caixa. Sem guarda, isso vira
   * exceção a cada tecla e a cada clique, no lugar de simplesmente não fazer
   * nada até a próxima injeção. */
  const P = (RP.picker = {
    ativo: false,

    ligar() {
      if (P.ativo) return;
      P.ativo = true;
      profundidade = 0;
      forcarPilha = false;
      pausado = false;
      topoAnterior = null;
      ordem = [];
      RP.overlay.montar();
      anexarFolha();
      armar();
      RP.on(window, 'pointermove', moverSeguro, true);
      RP.on(window, 'keydown', teclarSeguro, true);
    },

    desligar() {
      if (!P.ativo) return;
      P.ativo = false;
      pausado = false;
      if (RP.caixa) RP.caixa.fechar(true);
      RP.off(window, 'pointermove', moverSeguro, true);
      RP.off(window, 'keydown', teclarSeguro, true);
      soltarFolha();
      desarmar();
      RP.overlay.limparHover();
      RP.overlay.foco(null);
    },

    /** Congela a escolha no elemento dado: o mouse deixa de trocar de alvo e o
     *  realce fica travado nele. Pedido pela caixa de comentário ao abrir -
     *  tanto no clique num elemento novo quanto no clique num pin, que também
     *  abre a caixa e também não pode ficar com o hover solto por baixo. */
    pausar(el) {
      if (!P.ativo) return;
      pausado = true;
      RP.overlay.limparHover();
      RP.overlay.foco(el);
    },

    /** Comentário enviado ou descartado: o realce travado sai e o mouse volta
     *  a escolher alvo. */
    retomar() {
      if (!pausado) return;
      pausado = false;
      RP.overlay.foco(null);
    },
  });

  /* ------------------------------------------------------- alvo sob o cursor */

  /** Nosso overlay nunca é alvo. O shadow é fechado, mas o host está no light
   *  DOM e poderia aparecer na pilha. */
  function nosso(el) {
    const host = RP.overlay.host();
    return !!host && (el === host || host.contains(el));
  }

  /** Primeiro elemento do caminho do evento - atravessa shadow root aberto,
   *  que é o que `elementsFromPoint` não faz (ela devolve o host). */
  function doEvento(caminho) {
    for (const n of caminho) {
      if (n && n.nodeType === 1 && !nosso(n)) return n;
    }
    return null;
  }

  function temTextoProprio(el) {
    for (const n of el.childNodes) {
      if (n.nodeType === 3 && n.nodeValue && n.nodeValue.trim()) return true;
    }
    return false;
  }

  const ehRaiz = (el) => el === document.documentElement || el === document.body;

  /** Camada que cobre quase toda a viewport e não tem texto próprio: existe
   *  para pintar ou para hospedar portal, não para ser comentada. */
  function passaVento(el) {
    if (ehRaiz(el)) return true;
    const r = el.getBoundingClientRect();
    const cobre =
      r.width >= window.innerWidth * COBRE && r.height >= window.innerHeight * COBRE;
    return cobre && !temTextoProprio(el);
  }

  /** Mede os candidatos sob o cursor e guarda em `ordem`. O primeiro é o
   *  palpite; `Alt` avança para o seguinte.
   *
   *  Caminho rápido: sem `Alt` e com um alvo de evento que não é camada de
   *  passagem, nem chega a montar a pilha - `elementsFromPoint` a cada
   *  pointermove custaria caro em página grande sem mudar o resultado. */
  function medir(x, y, caminho) {
    /* Sem caminho de evento (repintura do Alt), vale o último alvo de evento
     * conhecido: `elementsFromPoint` não atravessa shadow root - devolve o
     * host - e sem isto o Alt dentro de um web component perderia o nó de
     * dentro que o cursor já tinha alcançado. */
    const evt = doEvento(caminho) || topoAnterior;
    if (!forcarPilha && evt && !passaVento(evt)) {
      ordem = [evt];
      return;
    }

    const pilha = [];
    if (evt) pilha.push(evt);
    for (const el of document.elementsFromPoint(x, y)) {
      if (!el || nosso(el) || pilha.includes(el)) continue;
      pilha.push(el);
    }
    /* Três faixas, nesta ordem: conteúdo de verdade, o fundo da página, e por
     * último as camadas de passagem.
     *
     * O fundo vem antes das camadas porque sobre uma área vazia da página não
     * existe conteúdo sob o cursor - o que existe ali é o fundo, e apontar
     * `div.toast-layer` só porque ela cobre a tela inteira descreveria o
     * cenário errado. As camadas continuam alcançáveis pelo `Alt`. */
    const conteudo = pilha.filter((e) => !passaVento(e));
    const fundo = pilha.filter((e) => ehRaiz(e));
    const camadas = pilha.filter((e) => passaVento(e) && !ehRaiz(e));
    ordem = conteudo.concat(fundo, camadas);
  }

  function alvoAtual() {
    if (!ordem.length) return null;
    return ordem[Math.min(profundidade, ordem.length - 1)];
  }

  /* ---------------------------------------------------------------- eventos */

  /* O que vai para `window` é a versão embrulhada: exceção aqui não pode virar
   * "Uncaught" na lista de erros da extensão nem no console de uma página que
   * não é nossa (ver RP.seguro em 00-ns.js). Precisa ser uma referência estável,
   * porque `RP.off` remove por identidade. */
  const moverSeguro = RP.seguro(aoMover);
  const teclarSeguro = RP.seguro(aoTeclar);
  const suprimirSeguro = RP.seguro(suprimir);

  function aoMover(e) {
    if (!RP.atual() || !P.ativo || pausado) return;
    /* Ponteiro em cima de um pin: o realce sai da frente, senão o elemento de
     * trás acenderia enquanto o balão do comentário está sendo lido. */
    if (e.composedPath().includes(RP.overlay.host())) {
      RP.overlay.limparHover();
      return;
    }
    pontoX = e.clientX;
    pontoY = e.clientY;
    const topo = doEvento(e.composedPath());
    /* Cursor mudou de elemento: o ciclo do Alt volta ao palpite. Sem isso a
     * profundidade escolhida num canto da tela viajaria para o próximo. */
    if (topo !== topoAnterior) {
      topoAnterior = topo;
      profundidade = 0;
      forcarPilha = false;
    }
    medir(pontoX, pontoY, e.composedPath());
    pintar();
  }

  function pintar() {
    const el = alvoAtual();
    if (!el) {
      RP.overlay.limparHover();
      return;
    }
    RP.overlay.hover(
      el,
      ordem.length > 1 ? profundidade + 1 + '/' + ordem.length + ' · alt' : ''
    );
  }

  function aoTeclar(e) {
    if (!RP.atual()) return;
    /* Caixa aberta: o teclado é dela. Este listener foi registrado primeiro
     * (no `ligar()`), então sem a saída ele pegaria o Esc antes da caixa e
     * fecharia o picker no lugar do rascunho. */
    if (RP.caixa && RP.caixa.aberta()) return;

    if (e.key === 'Escape') {
      /* Sem o stopImmediatePropagation, o Escape fecha o modal do site junto. */
      e.preventDefault();
      e.stopImmediatePropagation();
      P.desligar();
      RP.paraPainel({ rp: 'picker-desligou' });
      return;
    }
    if (e.key === 'Alt') {
      if (e.repeat) return; // segurar não pode girar a pilha
      e.preventDefault();
      e.stopImmediatePropagation();
      /* Mede antes de avançar: no caminho rápido a pilha ainda não existe, e
       * avançar sobre uma lista de um item deixaria o Alt sem efeito. Sem
       * evento novo aqui, então o caminho do evento vai vazio - a pilha é
       * remontada por geometria a partir do último ponto conhecido. */
      forcarPilha = true;
      medir(pontoX, pontoY, []);
      profundidade = (profundidade + 1) % Math.max(1, ordem.length);
      pintar();
    }
  }

  /* Um clique físico é uma sequência: pointerdown, mousedown, pointerup,
   * mouseup, click. A seleção acontece no pointerdown - o primeiro - e os
   * outros quatro precisam ser engolidos também, senão um clique num <a>
   * navega. Como o picker continua armado depois de selecionar, os supressores
   * vivem exatamente enquanto o modo vive: não há meio de gesto para cobrir. */
  function armar() {
    if (suprimindo) return;
    suprimindo = true;
    for (const t of SUPRIMIR) RP.on(window, t, suprimirSeguro, true);
  }

  function desarmar() {
    if (!suprimindo) return;
    suprimindo = false;
    for (const t of SUPRIMIR) RP.off(window, t, suprimirSeguro, true);
  }

  function suprimir(e) {
    if (!RP.atual()) return;
    /* Evento nascido na nossa UI passa intacto: caixa e pins vivem no shadow
     * root do overlay, e sem esta saída o próprio campo de texto ficaria morto
     * enquanto o picker está armado. `preventDefault` também não pode entrar
     * aqui - no mousedown é ele que impede o textarea de receber foco e cursor.
     *
     * O pin se defende sozinho, e não daqui: o shadow root é fechado, então o
     * `composedPath()` de um listener de window para no host e não dá para
     * distinguir pin de caixa deste lado. Quem impede o clique no pin de
     * navegar a página por baixo é o `pointerdown` do próprio pin, que dá
     * `preventDefault` e engole o `click` seguinte (ver 30-overlay.js). */
    if (e.composedPath().includes(RP.overlay.host())) {
      return;
    }

    e.preventDefault();
    e.stopImmediatePropagation();

    if (!P.ativo || e.type !== 'pointerdown' || e.button !== 0) return;

    /* Caixa aberta com rascunho escrito: clique na página não faz nada. Trocar
     * de alvo aqui jogaria fora um texto que ninguém pediu para jogar. Vazia,
     * reaponta - é a saída para o clique errado, que é justamente o motivo de a
     * caixa nascer encostada no elemento. */
    if (RP.caixa && RP.caixa.aberta() && !RP.caixa.vazia()) return;

    /* Mede no ponto do clique em vez de confiar na última medição: o picker
     * pode ser armado com o cursor já parado sobre o alvo, sem nenhum
     * pointermove antes. */
    pontoX = e.clientX;
    pontoY = e.clientY;
    medir(pontoX, pontoY, e.composedPath());
    const el = alvoAtual();
    if (!el) return;

    const alvo = RP.locate.describe(el);
    if (!alvo) return;
    alvo.rpId = RP.anchor.estampar(el);

    /* A caixa é quem pede o congelamento (RP.picker.pausar), para o clique num
     * pin ter o mesmo comportamento sem passar por aqui. */
    if (RP.caixa) RP.caixa.abrir(el, alvo);
  }

  /* ----------------------------------------------------------------- folha */

  /** Folha construída não passa por `style-src`, então funciona em página com
   *  CSP estrita - ao contrário de injetar um `<style>`. */
  function anexarFolha() {
    if (!folha) {
      folha = new CSSStyleSheet();
      folha.replaceSync(CSS_PICKER);
    }
    if (!document.adoptedStyleSheets.includes(folha)) {
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, folha];
    }
  }

  function soltarFolha() {
    if (!folha) return;
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== folha);
  }
})();
