/* Refine Prompt - boot e canal com o side panel.
 *
 * Último arquivo a carregar. O content script não tem UI: ele responde ao
 * painel e avisa quando uma página nova está pronta.
 *
 * O aviso `pronto` é o que sustenta a sessão que atravessa páginas. Em cada
 * navegação o content script é recriado do zero, sem memória do que estava
 * ligado; o painel, que é quem guarda a sessão, recebe esse aviso e devolve o
 * estado (picker armado, pins da página nova). Assim dá para navegar pelo
 * sistema e continuar comentando, sem reabrir nada.
 */
(() => {
  'use strict';

  const RP = globalThis.__RP;
  if (!RP) return;

  /** Identidade de agrupamento, derivada da URL crua e não do texto exibido.
   *
   *  O painel agrupa comentários por página e decide de quem são os pins
   *  comparando páginas. Comparar pela URL exibida amarra isso à opção de
   *  máscara: ligar ou desligar no meio da sessão muda o texto da URL, e a
   *  mesma página passa a contar como duas. Hash e não a URL crua porque a
   *  chave é gravada junto do comentário, e a URL crua é justamente o que a
   *  máscara existe para não gravar - aqui só se compara por igualdade.
   *
   *  FNV-1a de 32 bits: sem dependência, estável entre carregamentos, e o
   *  espaço é de sobra para o punhado de páginas de uma sessão. */
  function chaveDaUrl(url) {
    let h = 0x811c9dc5;
    for (let i = 0; i < url.length; i++) {
      h ^= url.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
  }

  /** Identidade da página no comentário. Redigida junto com o resto quando a
   *  opção está ligada: query string carrega CPF e id de contrato com
   *  frequência, e a URL vai inteira para o relatório. */
  RP.pagina = () => {
    /* Página `file://` não tem host, e o pathname é o caminho absoluto no
     * disco - no cabeçalho do grupo isso viraria uma linha de 70 caracteres
     * repetida em cada comentário. O endereço completo continua no relatório,
     * numa linha própria, então encurtar aqui não esconde nada. */
    const local = !location.host;
    const chave = chaveDaUrl(location.href);
    const bruta = {
      chave,
      url: location.href,
      origem: local ? 'arquivo local' : location.host,
      caminho: local
        ? '/' + (location.pathname.split('/').pop() || '')
        : location.pathname + location.search,
      titulo: RP.enxuto(document.title),
    };
    if (!RP.opcoes.redigir) return bruta;
    const r = RP.locate.redigir;
    return {
      chave,
      url: r(bruta.url),
      origem: bruta.origem,
      caminho: r(bruta.caminho),
      titulo: r(bruta.titulo),
    };
  };

  const boot = (RP.boot = {
    /** Tira da página tudo o que a extensão pôs: caixa, overlay e as estampas
     *  de âncora. Não fecha o canal - o painel continua conversando com esta
     *  página depois de limpar a sessão, e o overlay volta sozinho no próximo
     *  movimento do mouse se a seleção ainda estiver armada. */
    limpar() {
      RP.caixa.fechar();
      RP.overlay.desmontar();
      RP.anchor.limpar();
    },
  });

  /** Resolve os alvos de uma lista de comentários da página atual. Os que não
   *  resolvem simplesmente não ganham pin. */
  function pinsDe(itens) {
    return (itens || [])
      .map((i) => ({
        n: i.n,
        id: i.id,
        texto: i.texto,
        alvo: i.alvo,
        el: RP.anchor.resolver(i.alvo),
      }))
      .filter((i) => i.el);
  }

  function ouvinte(msg, _remetente, responder) {
    if (!msg || !msg.rp) return;

    switch (msg.rp) {
      case 'ping':
        responder({ ok: true, pagina: RP.pagina() });
        return;

      case 'opcoes':
        if (msg.redigir != null) RP.opcoes.redigir = !!msg.redigir;
        responder({ ok: true });
        return;

      case 'picker':
        if (msg.redigir != null) RP.opcoes.redigir = !!msg.redigir;
        if (msg.on) RP.picker.ligar();
        else RP.picker.desligar();
        responder({ ok: true, ativo: RP.picker.ativo });
        return;

      case 'foco':
        RP.overlay.foco(msg.alvo ? RP.anchor.resolver(msg.alvo) : null);
        responder({ ok: true });
        return;

      case 'pins':
        RP.overlay.pins(pinsDe(msg.itens));
        responder({ ok: true });
        return;

      case 'limpar':
        boot.limpar();
        responder({ ok: true });
        return;
    }
  }

  /* O ouvinte fica pendurado em `globalThis`, não no namespace: o namespace é
   * reconstruído a cada injeção (ver 00-ns.js), e sem remover o anterior duas
   * injeções na mesma vida da extensão responderiam ao mesmo `ping` - o Chrome
   * reclama de resposta dupla e o painel lê a primeira que chegar. */
  RP.tentar(() => {
    if (globalThis.__RP_OUVINTE) {
      try {
        chrome.runtime.onMessage.removeListener(globalThis.__RP_OUVINTE);
      } catch (_) {}
    }
    globalThis.__RP_OUVINTE = RP.seguro(ouvinte);
    chrome.runtime.onMessage.addListener(globalThis.__RP_OUVINTE);
  });

  RP.paraPainel({ rp: 'pronto', pagina: RP.pagina() });
})();
