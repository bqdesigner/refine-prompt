/* Refine Prompt - descrição de elementos.
 *
 * Produz o descritor que viaja para o side panel e depois para o relatório. O
 * consumidor final é uma IA lendo Markdown e tentando achar o elemento no
 * código-fonte, então a prioridade é contexto reconhecível (data-testid, id,
 * texto) e não o seletor mais curto possível.
 *
 * Três restrições que valem preservar:
 *
 * 1. O seletor sai DESAMBIGUADO. `seletor` só é emitido depois de conferido
 *    que casa com exatamente um nó - se nenhuma estratégia consegue, o
 *    descritor diz isso em `unico: false` em vez de fingir. Seletor ambíguo
 *    com aviso empurra a desambiguação para quem lê o relatório.
 *
 * 2. O HTML é do elemento, não de 2 níveis de ancestral. Subir 2 níveis
 *    arrasta o conteúdo dos irmãos junto, que é conteúdo da página entrando no
 *    relatório sem ninguém pedir. O contexto de estrutura, que era o motivo de
 *    subir, vem em `caminho`: a cadeia de ancestrais com id e classe, sem nó
 *    de texto nenhum.
 *
 * 3. O HTML é sanitizado. Nó de comentário, `<script>`, `on*` e
 *    `href="javascript:"` não têm valor para review de design e comentário
 *    HTML é vetor de prompt injection puro - o bloco é colado num agente.
 */
(() => {
  'use strict';

  const RP = globalThis.__RP;
  if (!RP) return;

  /** Opções vindas do painel. `redigir` mascara CPF/CNPJ/e-mail/telefone e
   *  sequência longa de dígitos no HTML e no texto capturados. Ligado por
   *  padrão porque a extensão é agnóstica ao site: assumir que a página é de quem
   *  a comenta é a suposição que vaza dado. */
  RP.opcoes = { redigir: true };

  /* Atributos que ajudam a achar o elemento no código, em ordem de utilidade.
   * Os data-* de teste vêm primeiro: mais estáveis e mais fáceis de grepar. */
  const ATTRS_UTEIS = [
    'data-testid',
    'data-test-id',
    'data-test',
    'data-cy',
    'data-qa',
    'id',
    'name',
    'aria-label',
    'role',
    'type',
    'placeholder',
    'alt',
    'title',
    'href',
  ];

  /** Os que servem de âncora de seletor, na mesma ordem de estabilidade. */
  const ATTRS_ANCORA = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa'];

  /** Nunca aparecem no HTML capturado: não ajudam a localizar nada e são o
   *  caminho por onde conteúdo da página entraria como instrução. */
  const TAGS_FORA = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED',
    'LINK', 'META', 'BASE',
  ]);

  const MAX_CLASSES_ETIQUETA = 3;
  const MAX_TEXTO = 60;
  const MAX_ATTR = 80;
  const MAX_HTML = 800;

  function classes(el) {
    if (!el.classList) return [];
    return [...el.classList].filter(Boolean);
  }

  function tag(el) {
    return el.tagName ? el.tagName.toLowerCase() : String(el.nodeName).toLowerCase();
  }

  const L = (RP.locate = {
    classes,
    tag,

    /** Raiz de busca: o shadow root que contém o elemento, ou o document.
     *  Buscar no document não encontra nada dentro de shadow DOM. */
    raiz(el) {
      const r = el.getRootNode ? el.getRootNode() : document;
      return r === document || r.nodeType === 11 || r.host ? r : document;
    },

    /** Etiqueta estilo devtools: "button.btn.btn-primary". Trunca as classes -
     *  em Tailwind um elemento tem 15 e a etiqueta viraria um parágrafo. */
    etiqueta(el) {
      if (!el || el.nodeType !== 1) return '';
      const cs = classes(el);
      let out = tag(el);
      if (cs.length) {
        out += '.' + cs.slice(0, MAX_CLASSES_ETIQUETA).join('.');
        if (cs.length > MAX_CLASSES_ETIQUETA) out += ' +' + (cs.length - MAX_CLASSES_ETIQUETA);
      }
      return out;
    },

    /** Rótulo humano para a lista de comentários: `button "Entrar"`. É o que
     *  quem comentou lê depois para saber onde - a etiqueta com 15 classes
     *  de Tailwind não identifica nada. */
    rotulo(el) {
      if (!el || el.nodeType !== 1) return '';
      const t = L.texto(el) || RP.enxuto(el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('placeholder')));
      return t ? tag(el) + ' "' + t + '"' : L.etiqueta(el);
    },

    /** Trecho do texto visível, com espaços colapsados. */
    texto(el) {
      const t = RP.enxuto(el.textContent);
      if (!t) return '';
      const curto = t.length > MAX_TEXTO ? t.slice(0, MAX_TEXTO - 1) + '…' : t;
      return RP.opcoes.redigir ? redigir(curto) : curto;
    },

    /** Seletor conferido: casa com exatamente um nó, ou `unico: false`.
     *
     *  Cascata do mais estável para o menos: data-* de teste, id, tag+classes,
     *  caminho com nth-of-type. O `curto` viaja junto porque é o que aparece
     *  na UI - `body > div:nth-of-type(2) > ...` é endereço, não nome. */
    seletor(el) {
      if (!el || el.nodeType !== 1) return { seletor: '', curto: '', unico: false };
      const raiz = L.raiz(el);
      const t = tag(el);
      const curto = L.seletorCurto(el);

      for (const nome of ATTRS_ANCORA) {
        if (!el.hasAttribute(nome)) continue;
        const s = t + '[' + nome + '="' + cssStr(el.getAttribute(nome)) + '"]';
        if (casaSo(raiz, s, el)) return { seletor: s, curto, unico: true };
      }

      if (el.id) {
        const s = t + '#' + CSS.escape(el.id);
        if (casaSo(raiz, s, el)) return { seletor: s, curto, unico: true };
      }

      const cs = classes(el);
      if (cs.length) {
        const s = t + cs.map((c) => '.' + CSS.escape(c)).join('');
        if (casaSo(raiz, s, el)) return { seletor: s, curto, unico: true };
      }

      const caminho = caminhoNth(el, raiz);
      if (caminho) return { seletor: caminho, curto, unico: true };

      /* Sem seletor único: shadow root, nó recém-removido, ou estrutura em que
       * nem nth-of-type desambigua. O relatório precisa dizer isso. */
      return { seletor: curto, curto, unico: false };
    },

    /** Seletor legível, sem garantia de unicidade - o que a UI mostra. */
    seletorCurto(el) {
      const t = tag(el);
      if (el.id) return t + '#' + CSS.escape(el.id);
      const cs = classes(el);
      if (cs.length) return t + cs.map((c) => '.' + CSS.escape(c)).join('');
      return t;
    },

    /** Caminho legível até o body: id quando o ancestral tem, senão uma classe,
     *  e a etiqueta completa no último segmento. É contexto para quem lê, não
     *  seletor.
     *
     *  Continua no relatório mesmo agora que existe seletor único: é o que
     *  separa vários irmãos de mesma tag e mesmas classes, em que o seletor
     *  único cai no `nth-of-type` e não diz de qual bloco da tela se trata.
     *
     *  O `#id` entrou quando a linha `Estrutura` saiu do relatório por ser
     *  quase a mesma informação: de tudo que a estrutura trazia, o id é o único
     *  token que se procura no código-fonte. */
    caminho(el) {
      const partes = [L.etiqueta(el)];
      let n = el.parentElement || hostDe(el);
      while (n && n.nodeType === 1) {
        const cs = classes(n);
        const marca = n.id ? '#' + n.id : cs.length ? '.' + cs[0] : '';
        partes.unshift(tag(n) + marca);
        if (n.tagName === 'BODY' || n.tagName === 'HTML') break;
        n = n.parentElement || hostDe(n);
      }
      return partes.join(' > ');
    },

    attrs(el) {
      const out = {};
      for (const nome of ATTRS_UTEIS) {
        if (!el.hasAttribute || !el.hasAttribute(nome)) continue;
        out[nome] = valorAttr(el.getAttribute(nome) || '');
      }
      return out;
    },

    /** outerHTML do elemento, sanitizado e truncado. Sem ancestrais. */
    html(el) {
      if (!el || el.nodeType !== 1) return '';
      let clone;
      try {
        clone = el.cloneNode(true);
      } catch (_) {
        return '';
      }
      limpar(clone);
      let html = '';
      try {
        html = clone.outerHTML;
      } catch (_) {
        return '';
      }
      if (RP.opcoes.redigir) html = redigir(html);
      return html.length > MAX_HTML ? html.slice(0, MAX_HTML) + '…(truncado)' : html;
    },

    /** true se o elemento está dentro de um shadow root da própria página. */
    emShadow(el) {
      const r = el.getRootNode ? el.getRootNode() : document;
      return r !== document && !!r.host;
    },

    tamanho(el) {
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    },

    /** Descritor completo. É o único formato que o painel e o relatório
     *  consomem - nenhum dos dois toca o elemento direto, e é por isso que a
     *  sessão sobrevive à navegação: o descritor é serializável. */
    describe(el) {
      if (!el || el.nodeType !== 1) return null;
      const sel = L.seletor(el);
      const tam = L.tamanho(el);
      const emShadow = L.emShadow(el);
      return {
        rotulo: L.rotulo(el),
        etiqueta: L.etiqueta(el),
        tag: tag(el),
        texto: L.texto(el),
        seletor: sel.seletor,
        seletorCurto: sel.curto,
        unico: sel.unico,
        caminho: L.caminho(el),
        attrs: L.attrs(el),
        html: L.html(el),
        react: RP.react ? RP.react.describe(el) : null,
        emShadow,
        hostShadow: emShadow ? L.etiqueta(L.raiz(el).host) : null,
        redigido: !!RP.opcoes.redigir,
        w: tam.w,
        h: tam.h,
      };
    },
  });

  /* ------------------------------------------------------------ seletores */

  function casaSo(raiz, seletor, el) {
    try {
      const achados = raiz.querySelectorAll(seletor);
      return achados.length === 1 && achados[0] === el;
    } catch (_) {
      return false;
    }
  }

  /** Caminho com `nth-of-type` em cada nível, conferido no fim. Para no
   *  primeiro ancestral com id único - sem isso o caminho de um app moderno
   *  sai com 15 segmentos e nenhum deles ajuda a grepar o código. */
  function caminhoNth(el, raiz) {
    const partes = [];
    let n = el;
    let voltas = 0;
    while (n && n.nodeType === 1 && voltas < 40) {
      let seg = tag(n);
      if (n.id && casaSo(raiz, seg + '#' + CSS.escape(n.id), n)) {
        partes.unshift(seg + '#' + CSS.escape(n.id));
        break;
      }
      const pai = n.parentElement;
      if (pai) {
        const irmaos = [...pai.children].filter((c) => c.tagName === n.tagName);
        if (irmaos.length > 1) seg += ':nth-of-type(' + (irmaos.indexOf(n) + 1) + ')';
      }
      partes.unshift(seg);
      /* Para no body: `html > body > ...` carrega dois segmentos que toda
       * página tem, e a unicidade é conferida no fim de qualquer jeito. */
      if (!pai || n.tagName === 'BODY' || n.tagName === 'HTML') break;
      n = pai;
      voltas++;
    }
    const s = partes.join(' > ');
    return s && casaSo(raiz, s, el) ? s : null;
  }

  /** Sobe do elemento para o host do shadow root que o contém, se houver.
   *  É o que faz o caminho atravessar a fronteira de um web component em vez
   *  de parar nele. */
  function hostDe(el) {
    const r = el.getRootNode ? el.getRootNode() : null;
    return r && r.host ? r.host : null;
  }

  /** Escapa para dentro de um seletor de atributo com aspas duplas. */
  function cssStr(v) {
    return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  /* ---------------------------------------------------------- sanitização */

  function valorAttr(v) {
    let out = RP.opcoes.redigir ? redigir(v) : v;
    if (out.length > MAX_ATTR) out = out.slice(0, MAX_ATTR - 1) + '…';
    return out;
  }

  /** Limpa o clone no lugar: fora as tags que não localizam nada, fora os nós
   *  de comentário, fora os atributos executáveis. SVG fica como marca de que
   *  há ícone ali, mas esvaziado - o `path` de um ícone é a metade do dump e
   *  não diz nada sobre onde o elemento está no código. */
  function limpar(no) {
    const paraRemover = [];
    const anda = document.createTreeWalker(
      no,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_COMMENT
    );
    let atual = anda.currentNode;
    while (atual) {
      if (atual.nodeType === 8) {
        paraRemover.push(atual);
      } else if (atual.nodeType === 1) {
        if (TAGS_FORA.has(atual.tagName)) {
          paraRemover.push(atual);
        } else {
          limparAttrs(atual);
          if (atual.tagName === 'svg' || atual.tagName === 'SVG') atual.textContent = '';
        }
      }
      atual = anda.nextNode();
    }
    for (const n of paraRemover) {
      if (n.parentNode) n.parentNode.removeChild(n);
    }
  }

  function limparAttrs(el) {
    if (!el.attributes) return;
    for (const attr of [...el.attributes]) {
      const nome = attr.name.toLowerCase();
      const valor = attr.value || '';
      /* A estampa de âncora é nossa, não da página: no bloco de referência ela
       * só faria o agente procurar no código um atributo que não existe lá. */
      if (nome.startsWith('on') || nome === 'srcdoc' || nome === RP.ATTR) {
        el.removeAttribute(attr.name);
        continue;
      }
      if (
        (nome === 'href' || nome === 'src' || nome === 'action' || nome === 'formaction') &&
        /^\s*(javascript|data|vbscript):/i.test(valor)
      ) {
        el.setAttribute(attr.name, '[removido]');
        continue;
      }
      if (valor.length > MAX_ATTR) {
        el.setAttribute(attr.name, valor.slice(0, MAX_ATTR - 1) + '…');
      }
    }
  }

  /* Mascaramento de dado pessoal. A ordem importa duas vezes: CNPJ tem 14
   * dígitos e CPF 11, então os dois vêm antes da regra de "sequência longa"
   * que os engoliria; e telefone exige separador ou parênteses, senão um id de
   * contrato de 10 dígitos sairia rotulado como telefone. O rótulo errado não
   * vaza nada, mas manda o agente atrás da coisa errada. */
  function redigir(s) {
    return String(s)
      .replace(/[\w.+-]+@[\w-]+\.[\w.-]{2,}/g, '[email]')
      .replace(/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, '[cnpj]')
      .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, '[cpf]')
      .replace(/\(\d{2}\)\s?9?\d{4}[-\s]?\d{4}\b/g, '[telefone]')
      .replace(/\b\d{2}[\s-]9?\d{4}[-\s]\d{4}\b/g, '[telefone]')
      .replace(/\b9?\d{4}[-\s]\d{4}\b/g, '[telefone]')
      .replace(/\b\d{8,}\b/g, '[numero]');
  }

  L.redigir = redigir;
})();
