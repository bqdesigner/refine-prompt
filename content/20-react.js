/* Refine Prompt - arquivo:linha via fiber do React.
 *
 * Portado da versão anterior sem mudança de lógica: é a linha do relatório que
 * mais reduz ida e volta com o agente, porque elimina a busca manual pelo
 * componente no código.
 *
 * Só existe dado em build de DESENVOLVIMENTO: a fiber carrega _debugSource
 * (fileName/lineNumber) e _debugOwner (a fiber do componente que criou este
 * elemento via JSX). Em produção essas chaves não existem - describe() volta
 * null e o resto do relatório segue igual, sem essa linha. Vale rodar contra o
 * servidor local do app, não contra produção.
 *
 * Tudo dentro de try/catch: são propriedades internas do React, sem contrato
 * público entre versões - quebrar aqui nunca pode tirar o relatório do ar.
 */
(() => {
  'use strict';

  const RP = globalThis.__RP;
  if (!RP) return;

  /** Chave própria do React em cada nó DOM que ele gerencia:
   *  "__reactFiber$xxxxx" (React 17+) ou "__reactInternalInstance$xxxxx"
   *  (React <=16). O sufixo é aleatório por build, por isso a busca por
   *  prefixo em vez de nome fixo. */
  function fiberDe(el) {
    if (!el || !el.nodeType) return null;
    for (const k in el) {
      if (k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')) {
        return el[k] || null;
      }
    }
    return null;
  }

  /** Sobe .return até achar uma fiber com _debugSource - o próprio host node
   *  quase sempre tem a sua, mas alguns wrappers (Fragment, Context.Provider)
   *  não guardam _debugSource e a mais próxima fica um nível acima. */
  function fonteMaisProxima(fiber) {
    let f = fiber;
    let saltos = 0;
    while (f && saltos < 20) {
      if (f._debugSource) return f._debugSource;
      f = f.return;
      saltos++;
    }
    return null;
  }

  /** Nome amigável do componente: displayName > name do function/class > null
   *  para host elements (div, span...), que não interessam nesta cadeia. */
  function nomeDono(fiber) {
    const t = fiber && fiber.type;
    if (!t) return null;
    if (typeof t === 'string') return null;
    return t.displayName || t.name || null;
  }

  /** Cadeia de componentes que criaram o elemento via JSX, de fora para
   *  dentro. Vizinhos de mesmo nome são colapsados - um componente que
   *  re-renderiza filhos do mesmo tipo não deve virar "Text > Text > Text". */
  function cadeiaDonos(fiber) {
    const nomes = [];
    let f = fiber && fiber._debugOwner;
    let saltos = 0;
    while (f && saltos < 20) {
      const nome = nomeDono(f);
      if (nome && nomes[nomes.length - 1] !== nome) nomes.push(nome);
      f = f._debugOwner;
      saltos++;
    }
    return nomes.reverse();
  }

  RP.react = {
    /** { fonte: "src/a.tsx:22", componente: "TelaLogin > Botao" } ou null
     *  quando não há fiber (produção, ou página sem React). `componente` pode
     *  vir null mesmo com `fonte` presente, se não houver _debugOwner. */
    describe(el) {
      try {
        const fiber = fiberDe(el);
        if (!fiber) return null;

        const ds = fonteMaisProxima(fiber);
        const fonte = ds && ds.fileName ? ds.fileName + ':' + (ds.lineNumber || '?') : null;

        const cadeia = cadeiaDonos(fiber);
        const componente = cadeia.length ? cadeia.join(' > ') : null;

        if (!fonte && !componente) return null;
        return { fonte, componente };
      } catch (_) {
        return null;
      }
    },
  };
})();
