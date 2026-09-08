/* Refine Prompt - âncora do comentário no elemento.
 *
 * O comentário vive no side panel e sobrevive à navegação; o elemento não. Daí
 * duas formas de reencontrar o nó, em ordem de confiança:
 *
 * 1. `data-rp-id`, estampado no clique. Vale enquanto a página não recarregar:
 *    resiste a re-render que só reescreve classe/estilo, que é o caso comum de
 *    framework, e não custa uma busca.
 * 2. O seletor conferido do descritor (ver 10-locate.js). É o que reencontra o
 *    elemento depois de recarregar ou de voltar para a página mais tarde.
 *
 * O id leva um token do carregamento da página. Sem ele, o primeiro comentário
 * de uma página e o primeiro de outra dividiriam `rp-1`, e um pin da página A
 * poderia cair num elemento da página B com o mesmo id.
 *
 * Quando nenhuma das duas resolve - elemento dentro de shadow root, nó que
 * saiu do ar, página que mudou de estrutura - o consumidor recebe `null` e
 * trata isso como normal: o comentário continua na lista, legível pelo rótulo,
 * só não tem pin nem realce.
 */
(() => {
  'use strict';

  const RP = globalThis.__RP;
  if (!RP) return;

  const TOKEN = Math.random().toString(36).slice(2, 8);
  let contador = 0;

  RP.anchor = {
    /** Estampa (ou reaproveita) o id do elemento e devolve. */
    estampar(el) {
      if (!el || el.nodeType !== 1) return null;
      const atual = el.getAttribute(RP.ATTR);
      if (atual) return atual;
      const id = 'rp-' + TOKEN + '-' + ++contador;
      el.setAttribute(RP.ATTR, id);
      return id;
    },

    /** Reencontra o elemento de um comentário, ou null. */
    resolver(alvo) {
      if (!alvo) return null;

      if (alvo.rpId) {
        const porId = document.querySelector(
          '[' + RP.ATTR + '="' + CSS.escape(alvo.rpId) + '"]'
        );
        if (porId && porId.isConnected) return porId;
      }

      for (const sel of [alvo.seletor, alvo.seletorCurto]) {
        if (!sel) continue;
        try {
          const achados = document.querySelectorAll(sel);
          /* Só com um casamento. Pin no elemento errado é pior que pin
           * nenhum: o comentário passa a apontar para outra coisa. */
          if (achados.length === 1) return achados[0];
        } catch (_) {
          /* seletor que não vale mais nesta página */
        }
      }

      return null;
    },

    /** Tira todas as estampas - a página volta ao HTML que tinha. */
    limpar() {
      for (const el of document.querySelectorAll('[' + RP.ATTR + ']')) {
        el.removeAttribute(RP.ATTR);
      }
    },
  };
})();
