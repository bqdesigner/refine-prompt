/* Refine Prompt - service worker.
 *
 * Dois trabalhos:
 *
 * 1. Clique no ícone: abre o side panel E injeta os content scripts na aba.
 *    Os dois no mesmo handler de propósito. `sidePanel.open()` exige gesto do
 *    usuário, e `activeTab` só é concedido no `onClicked` - se o painel
 *    abrisse sozinho por `openPanelOnActionClick`, o `onClicked` não
 *    dispararia e a extensão perderia a permissão de injetar sem pedir
 *    host_permissions.
 *
 * 2. Reinjeção ao navegar. É o que sustenta a sessão que atravessa páginas:
 *    `activeTab` é revogado a cada navegação, então sem uma permissão de host
 *    concedida em runtime seria preciso clicar no ícone em cada página. A
 *    permissão é opcional e pedida pelo painel ("Seguir navegação") - nunca
 *    declarada no manifest.
 *
 * Nada é injetado enquanto o painel não estiver aberto: a porta aberta pelo
 * painel é o sinal de vida (`onDisconnect` avisa quando ele fecha).
 */
'use strict';

/* Ordem importa: os arquivos compartilham o escopo global do isolated world e
 * cada um escreve em globalThis.__RP. O número no nome documenta a dependência.
 * Arquivo novo entra aqui também, ou o executeScript falha inteiro sem avisar. */
const FILES = [
  'content/00-ns.js',
  'content/10-locate.js',
  'content/20-react.js',
  'content/30-overlay.js',
  'content/40-picker.js',
  'content/50-anchor.js',
  'content/60-caixa.js',
  'content/99-boot.js',
];

const TODAS_ORIGENS = { origins: ['*://*/*'] };

/* Páginas onde o Chrome não permite injeção. Testar ANTES de tentar, senão o
 * erro chega como exceção genérica e não dá para explicar o motivo. */
const BLOQUEADO =
  /^(chrome|chrome-untrusted|devtools|view-source|about|edge|moz-extension|chrome-extension|data|blob|filesystem):/i;
const BLOQUEADO_HOST =
  /^https?:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i;

function motivoBloqueio(url) {
  if (!url) return 'Não deu para ler a URL desta aba.';
  if (BLOQUEADO_HOST.test(url)) return 'O Chrome bloqueia extensões na Chrome Web Store.';
  if (BLOQUEADO.test(url)) return 'O Chrome não permite extensões em páginas internas do navegador.';
  return null;
}

/** Painéis abertos. Uma porta viva = um painel aberto. */
const paineis = new Set();

/** Abas onde já injetamos, para poder desarmar a seleção nelas quando o painel
 *  fecha. Sem isto, fechar o painel com a seleção armada deixaria a página com
 *  o clique suprimido e o cursor de mira até o reload - o pior estado possível,
 *  porque a extensão nem está mais à vista para explicar o que houve. */
const injetadas = new Set();

/* No topo e não no onInstalled: recarregar a extensão descompactada reinicia o
 * service worker, e o comportamento do painel tem de ser reafirmado aí também.
 * O clique no ícone precisa chegar no onClicked (ver cabeçalho). */
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});

chrome.runtime.onConnect.addListener((porta) => {
  if (porta.name !== 'painel') return;
  paineis.add(porta);
  porta.onDisconnect.addListener(() => {
    paineis.delete(porta);
    if (paineis.size) return;
    /* Painel fechado: a extensão não está mais à vista, então não pode deixar
     * nada dela na página - nem o clique suprimido, nem os pins dos
     * comentários pairando sobre o conteúdo. */
    for (const tabId of injetadas) {
      chrome.tabs.sendMessage(tabId, { rp: 'picker', on: false }).catch(() => {});
      chrome.tabs.sendMessage(tabId, { rp: 'limpar' }).catch(() => {});
    }
  });
});

chrome.tabs.onRemoved.addListener((tabId) => injetadas.delete(tabId));

/** Único canal de feedback quando não há painel nem página para mostrar UI. */
async function avisar(tabId, mensagem) {
  try {
    await chrome.action.setBadgeText({ tabId, text: '!' });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#D93025' });
    await chrome.action.setTitle({ tabId, title: 'Refine Prompt - ' + mensagem });
    setTimeout(() => {
      chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
      chrome.action.setTitle({ tabId, title: 'Refine Prompt' }).catch(() => {});
    }, 6000);
  } catch (_) {
    /* aba fechou no meio do caminho */
  }
}

/** Injeções em curso, por aba. Duas fontes pedem injeção na mesma carga de
 *  página - o painel, ao armar a seleção, e o `tabs.onUpdated` - e sem o
 *  cadeado elas se sobrepõem: a segunda derruba o namespace que a primeira
 *  ainda está montando (ver o topo de content/00-ns.js), e os arquivos
 *  restantes da primeira escrevem num objeto já morto. */
const emCurso = new Map();

function injetar(tabId, url) {
  const jaVai = emCurso.get(tabId);
  if (jaVai) return jaVai;
  const p = injetarAgora(tabId, url).finally(() => emCurso.delete(tabId));
  emCurso.set(tabId, p);
  return p;
}

/** Injeta os content scripts, se ainda não estiverem lá.
 *  Devolve { ok } ou { ok: false, motivo } - o painel mostra o motivo. */
async function injetarAgora(tabId, url) {
  const motivo = motivoBloqueio(url);
  if (motivo) return { ok: false, motivo };

  /* Ping antes de injetar: reinjetar rodaria as IIFEs de novo (a guarda em
   * 99-boot.js cobre, mas evitar é mais limpo) e reestamparia a página. */
  try {
    const res = await chrome.tabs.sendMessage(tabId, { rp: 'ping' });
    if (res && res.ok) {
      injetadas.add(tabId);
      return { ok: true, jaEstava: true };
    }
  } catch (_) {
    /* sem receptor: segue para a injeção */
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: FILES,
    });
    injetadas.add(tabId);
    return { ok: true };
  } catch (e) {
    const msg = (url || '').startsWith('file://')
      ? 'para páginas file://, habilite "Permitir acesso a URLs de arquivo" nos detalhes da extensão.'
      : 'não deu para injetar nesta página (' + ((e && e.message) || 'erro desconhecido') + ').';
    return { ok: false, motivo: msg };
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || typeof tab.id !== 'number') return;
  const url = tab.url || tab.pendingUrl || '';

  const motivo = motivoBloqueio(url);
  if (motivo) {
    await avisar(tab.id, motivo);
    return;
  }

  /* Abrir primeiro: `sidePanel.open` só vale dentro do gesto, e um await de
   * injeção antes dele pode passar do prazo do gesto em página lenta. */
  try {
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch (_) {
    /* Chrome < 116 ou janela sem painel: o ícone ainda injeta, o painel o
     * usuário abre pelo menu de extensões. */
  }

  const r = await injetar(tab.id, url);
  if (!r.ok) await avisar(tab.id, r.motivo);
});

/* Sessão que atravessa páginas: reinjeta a cada navegação concluída, desde que
 * (a) o painel esteja aberto, (b) a aba esteja à vista e (c) a permissão de
 * host tenha sido concedida. Sem (c) o executeScript falharia - `activeTab` já
 * morreu na navegação.
 *
 * (b) não é economia de trabalho: sem ele, uma aba de fundo terminando de
 * carregar (ctrl+clique, refresh automático) injeta, manda `pronto` e o painel
 * troca a página de referência por uma que ninguém está olhando. */
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== 'complete') return;
  if (!paineis.size) return;
  if (!tab || !tab.active) return;
  if (!(await chrome.permissions.contains(TODAS_ORIGENS))) return;
  const url = tab.url || '';
  if (motivoBloqueio(url)) return;
  await injetar(tabId, url);
});

chrome.runtime.onMessage.addListener((msg, _sender, responder) => {
  if (!msg || msg.rp !== 'injetar') return;
  /* Pedido do painel: garantir content script na aba antes de armar a seleção.
   * O tabId vem do painel - ele já resolveu a aba ativa da própria janela, e
   * repetir a consulta aqui só abriria espaço para as duas discordarem.
   * Assíncrono, então devolve true para manter o canal aberto. */
  (async () => {
    try {
      let tabId = msg.tabId;
      let url = msg.url;
      if (typeof tabId !== 'number') {
        const [aba] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!aba || typeof aba.id !== 'number') {
          responder({ ok: false, motivo: 'Nenhuma aba ativa.' });
          return;
        }
        tabId = aba.id;
        url = aba.url;
      }
      const r = await injetar(tabId, url || '');
      responder(Object.assign({ tabId }, r));
    } catch (e) {
      responder({ ok: false, motivo: (e && e.message) || 'erro desconhecido' });
    }
  })();
  return true;
});
