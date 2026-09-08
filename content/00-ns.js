/* Refine Prompt - namespace e helpers do content script.
 *
 * Primeiro arquivo a carregar. Cria globalThis.__RP, que todos os outros
 * estendem. Idempotente: reinjeção não zera o estado.
 *
 * Diferença de fundo em relação a uma extensão de painel injetado: aqui o
 * content script não tem UI nem estado de sessão. Ele só sabe olhar a página,
 * descrever elementos e pintar destaque. Quem guarda comentário é o side
 * panel - o content script morre em cada navegação, e a sessão não pode morrer
 * com ele.
 */
(() => {
  'use strict';

  /** Objeto que absorve qualquer acesso: `NADA.x.y()` não estoura e devolve
   *  `undefined`. Serve para tapar buraco no namespace abandonado (ver abaixo)
   *  sem manter uma lista de métodos falsos por módulo. */
  const NADA = new Proxy(function () {}, {
    get: () => NADA,
    apply: () => undefined,
  });

  /* Reinjeção derruba o que estava e reconstrói do zero, em vez de sair fora
   * quando `__RP` já existe.
   *
   * O motivo é o ciclo de desenvolvimento: recarregar a extensão órfã o content
   * script (o objeto `__RP` fica na página, mas todo `chrome.*` dele passa a
   * lançar). Na injeção seguinte, um `return` aqui deixava o namespace ANTIGO
   * de pé, e cada módulo depois deste, ao ver o seu próprio slot já preenchido,
   * também saía fora. O resultado era um Frankenstein: picker de uma versão,
   * caixa de outra - ou faltando, e aí `RP.caixa.aberta()` estourava
   * `Cannot read properties of undefined`.
   *
   * O `derrubar` chamado aqui é o do objeto antigo, com o código antigo: é ele
   * que sabe remover os próprios listeners. Versão anterior a este arquivo não
   * tem o método, daí o desmonte peça por peça como reserva. */
  const anterior = globalThis.__RP;
  if (anterior) {
    /* Um try POR PASSO, não um em volta de todos: com um try só, um passo que
     * estoura (módulo que aquela versão não tinha) cancelava os seguintes - e
     * o passo que importa é justamente o último, o que solta os listeners de
     * window. Listener velho sobrevivendo é o pior estado possível: ele guarda
     * o namespace antigo por closure e passa a ler módulo que não existe mais
     * ali, estourando a cada tecla. */
    for (const passo of [
      () => anterior.derrubar(),
      () => anterior.caixa.fechar(true),
      () => anterior.picker.desligar(),
      () => anterior.overlay.desmontar(),
      () => anterior.anchor.limpar(),
      () => anterior.offAll(),
    ]) {
      try {
        passo();
      } catch (_) {
        /* versão antiga sem este módulo, ou em estado imprevisível */
      }
    }
  }

  /* Depois de tentar derrubar, TAPA OS BURACOS do namespace antigo.
   *
   * Derrubar depende do código antigo ter sabido se desmontar. Versão anterior
   * ao `derrubar` não sabe, e aí sobra listener velho armado no window com o
   * objeto antigo preso na closure - e o objeto antigo pode não ter o módulo
   * que o próprio código dele lê (o caso real: `RP.caixa.aberta()` numa versão
   * anterior ao 60-caixa.js). Cada movimento do mouse virava exceção.
   *
   * O código velho não dá para consertar; o objeto que ele lê, dá. Todo membro
   * que falta recebe `NADA`, que responde qualquer propriedade com ela mesma e
   * qualquer chamada com `undefined`. O listener órfão passa a não fazer nada
   * em vez de estourar, até a página recarregar e ele morrer de vez.
   *
   * Só preenche o que falta: membro que existe continua o dele, porque código
   * velho pode depender do retorno de verdade para não quebrar de outro jeito. */
  if (anterior) {
    for (const nome of [
      'caixa', 'picker', 'overlay', 'anchor', 'locate', 'react', 'boot',
      'opcoes', 'pagina', 'atual', 'derrubar', 'offAll',
    ]) {
      if (anterior[nome] == null) anterior[nome] = NADA;
    }
  }

  const RP = (globalThis.__RP = {});

  /* Geração da injeção. Serve para um listener órfão se calar sozinho: cada
   * closure carrega a geração em que nasceu, e quando ela não é mais a atual o
   * listener volta na hora, sem tocar o namespace que já foi substituído.
   * É a rede embaixo do desmonte acima - que depende do código ANTIGO ter
   * sabido se desmontar, e versão antiga o bastante não sabe. */
  globalThis.__RP_GERACAO = (globalThis.__RP_GERACAO || 0) + 1;
  RP.GERACAO = globalThis.__RP_GERACAO;
  RP.atual = () => RP.GERACAO === globalThis.__RP_GERACAO;

  RP.VERSION = '0.1.1';

  /** Atributo de âncora estampado no elemento comentado (ver 50-anchor.js). */
  RP.ATTR = 'data-rp-id';

  /* ---------------------------------------------------------------
   * Listeners
   *
   * Tudo passa por RP.on para que o teardown remova exatamente o que
   * registrou. Listener com { capture: true } não é removível sem repassar a
   * mesma flag - guardar opts é o que torna a limpeza confiável.
   * --------------------------------------------------------------- */

  RP.listeners = [];

  RP.on = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    RP.listeners.push({ target, type, fn, opts });
    return fn;
  };

  RP.off = (target, type, fn, opts) => {
    try {
      target.removeEventListener(type, fn, opts);
    } catch (_) {}
    const i = RP.listeners.findIndex(
      (l) => l.target === target && l.type === type && l.fn === fn
    );
    if (i !== -1) RP.listeners.splice(i, 1);
  };

  RP.offAll = () => {
    for (const l of RP.listeners) {
      try {
        l.target.removeEventListener(l.type, l.fn, l.opts);
      } catch (_) {}
    }
    RP.listeners = [];
  };

  /** Devolve a página ao estado original e solta tudo o que esta injeção
   *  pendurou. Chamado pela injeção SEGUINTE (ver o topo do arquivo), então
   *  precisa tolerar módulo que não carregou. */
  RP.derrubar = () => {
    for (const passo of [
      () => RP.caixa.fechar(true),
      () => RP.picker.desligar(),
      () => RP.overlay.desmontar(),
      () => RP.anchor.limpar(),
      () => RP.offAll(),
    ]) {
      try {
        passo();
      } catch (_) {}
    }
  };

  /* ---------------------------------------------------------------
   * Rede contra "Uncaught"
   *
   * Exceção que escapa de um listener de content script vira duas coisas
   * ruins: entrada permanente na lista de erros da extensão (que só sai à mão,
   * e que quem instala lê como "isto está quebrado") e ruído no console de uma
   * página que não é nossa.
   *
   * Então nada que a extensão pendura em `window` sobe exceção. O erro não
   * desaparece: vai para `console.warn` com prefixo, uma vez por mensagem
   * distinta, o que dá para depurar sem repetir a cada movimento do mouse.
   * --------------------------------------------------------------- */

  const jaAvisado = new Set();

  RP.seguro = (fn) =>
    function (...args) {
      try {
        return fn.apply(this, args);
      } catch (e) {
        const msg = (e && e.message) || String(e);
        if (!jaAvisado.has(msg)) {
          jaAvisado.add(msg);
          console.warn('[Refine Prompt]', msg, e);
        }
      }
    };

  RP.clamp = (n, min, max) => (n < min ? min : n > max ? max : n);

  RP.enxuto = (t) => String(t == null ? '' : t).replace(/\s+/g, ' ').trim();

  /* ---------------------------------------------------------------
   * Sobrevivência
   *
   * Recarregar a extensão órfã o content script: qualquer chrome.* lança
   * "Extension context invalidated". No ciclo de dev isso acontece toda hora.
   * --------------------------------------------------------------- */

  RP.vivo = () => {
    try {
      return !!(chrome && chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  };

  RP.tentar = (fn) => {
    if (!RP.vivo()) return undefined;
    try {
      return fn();
    } catch (_) {
      return undefined;
    }
  };

  /** Manda um evento para o painel. Silencioso quando o painel está fechado:
   *  "sem receptor" é estado normal, não erro. */
  RP.paraPainel = (msg) =>
    RP.tentar(() => {
      const p = chrome.runtime.sendMessage(msg);
      if (p && p.catch) p.catch(() => {});
    });
})();
