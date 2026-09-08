/* Refine Prompt - o painel.
 *
 * Dono do estado. O content script é descartável (morre em cada navegação) e
 * só sabe olhar a página; quem guarda a sessão, decide o que salvar e gera o
 * relatório é este arquivo. É o que faz uma sessão atravessar várias páginas
 * de um sistema sem perder nada no caminho.
 *
 * O protocolo com a página é curto de propósito:
 *
 *   painel -> página   ping | opcoes | picker | foco | pins | limpar
 *   página -> painel   pronto | comentario | comentario-editado | picker-desligou
 *
 * `pronto` é o coração da sessão longa: chega sozinho a cada nova injeção
 * (navegação, aba nova) e é o gancho para o painel devolver o estado - picker
 * armado e pins da página que acabou de abrir.
 */

import {
  adicionar,
  atualizar,
  carregar,
  mesmaPaginaQue,
  nova,
  porPagina,
  remover,
  salvar,
  salvarOpcoes,
  totalPaginas,
} from './sessao.js';
import { gerar, nomeArquivo } from './report.js';

const TODAS_ORIGENS = { origins: ['*://*/*'] };

const $ = (id) => document.getElementById(id);

const el = {
  contador: $('contador'),
  meta: $('meta'),
  aviso: $('aviso'),
  historico: $('historico'),
  compositor: $('compositor'),
  alvoRotulo: $('alvoRotulo'),
  texto: $('texto'),
  cancelar: $('cancelar'),
  comentar: $('comentar'),
  gaveta: $('gaveta'),
  resumoGaveta: $('resumoGaveta'),
  previa: $('previa'),
  mira: $('mira'),
  miraTexto: $('miraTexto'),
  copiar: $('copiar'),
  baixar: $('baixar'),
  redigir: $('redigir'),
  seguir: $('seguir'),
  limpar: $('limpar'),
};

let sessao = nova();
let opcoes = { redigir: true };

/** Identidade da página da aba ativa, como o próprio content script a
 *  descreve. Vem sempre dele (nunca de chrome.tabs.url) porque a redação de
 *  dado sensível é aplicada lá, e o que se compara aqui - a chave que decide de
 *  quem são os pins - vem do mesmo lado (ver `mesmaPaginaQue` em sessao.js). */
let paginaAtual = null;
/** Aba a que o painel está falando agora. Guardado para poder desarmar a
 *  seleção nela quando a aba ativa muda. */
let tabAtual = null;
let pickerLigado = false;
let editandoId = null;
let confirmandoLimpar = false;
let timerLimpar = 0;

/* Sinal de vida para o service worker: enquanto esta porta existe, ele
 * reinjeta os content scripts a cada navegação, e quando ela cai ele desarma a
 * seleção nas abas - senão fechar o painel deixaria a página com o clique
 * morto. O service worker de MV3 pode ser desligado por inatividade, então a
 * porta é reaberta; a exceção só acontece com a extensão recarregada, e aí não
 * há a quem reconectar. */
function conectar() {
  try {
    chrome.runtime.connect({ name: 'painel' }).onDisconnect.addListener(() => {
      setTimeout(conectar, 250);
    });
  } catch (_) {
    /* extensão recarregada: este painel é órfão até ser reaberto */
  }
}

conectar();
iniciar();

async function iniciar() {
  const guardado = await carregar();
  sessao = guardado.sessao;
  opcoes = guardado.opcoes;

  el.redigir.checked = !!opcoes.redigir;
  el.seguir.checked = await chrome.permissions.contains(TODAS_ORIGENS);

  ligarEventos();
  render();

  /* Garantir antes de perguntar: o painel abre no mesmo clique que dispara a
   * injeção, e um ping aqui costuma chegar primeiro. Sem isto, a primeira
   * abertura acusaria "página sem script" justamente quando o ícone acabou de
   * ser clicado. `garantirScript` é idempotente - o service worker faz o ping
   * antes de injetar de novo. */
  const r = await garantirScript();
  if (!r.ok) {
    avisar(r.motivo, 'alerta');
    return;
  }
  await pingar();

  /* Painel aberto em sessão vazia: quem abriu quer comentar. Com sessão em
   * andamento não arma sozinho - pode ter aberto para exportar, e armar
   * sequestraria o clique da página sem ninguém pedir. */
  if (!sessao.comentarios.length) alternarPicker(true);
}

/* ----------------------------------------------------------------- eventos */

function ligarEventos() {
  el.mira.addEventListener('click', () => alternarPicker(!pickerLigado));

  el.texto.addEventListener('input', () => {
    el.comentar.disabled = !el.texto.value.trim();
  });

  el.texto.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      salvarComentario();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      fecharCompositor();
    }
  });

  el.comentar.addEventListener('click', salvarComentario);
  el.cancelar.addEventListener('click', fecharCompositor);

  /* O rótulo diz a ação, não o estado: aberto, o que o clique faz é ocultar. */
  el.gaveta.addEventListener('toggle', () => {
    el.resumoGaveta.textContent = el.gaveta.open ? 'Ocultar prompt' : 'Ver prompt';
  });

  el.copiar.addEventListener('click', copiar);
  el.baixar.addEventListener('click', baixar);
  el.limpar.addEventListener('click', limparSessao);

  el.redigir.addEventListener('change', async () => {
    opcoes.redigir = el.redigir.checked;
    await salvarOpcoes(opcoes);
    enviarAba({ rp: 'opcoes', redigir: opcoes.redigir });
    avisar(
      opcoes.redigir
        ? 'Dados sensíveis serão mascarados nas próximas capturas.'
        : 'Captura sem máscara. Revise o prompt antes de colar num agente.',
      opcoes.redigir ? '' : 'alerta'
    );
  });

  /* A permissão é pedida no gesto do próprio clique - fora dele o Chrome
   * recusa. Sem ela, `activeTab` morre na navegação e a sessão só continua com um
   * clique no ícone em cada página. */
  el.seguir.addEventListener('change', async () => {
    if (el.seguir.checked) {
      const concedida = await chrome.permissions.request(TODAS_ORIGENS);
      el.seguir.checked = concedida;
      if (!concedida) {
        avisar('Sem a permissão, clique no ícone da extensão em cada página.', 'alerta');
        return;
      }
      avisar('A sessão segue a navegação: comente em várias páginas seguidas.');
      return;
    }
    await chrome.permissions.remove(TODAS_ORIGENS);
    avisar('');
  });

  /* Todo painel aberto recebe o que TODO content script manda - inclusive o de
   * uma aba de fundo e o de uma aba de outra janela. Duas coisas quebram sem
   * este filtro: uma aba de fundo que termina de carregar reescreve
   * `paginaAtual` (os pins da aba à vista somem e os comentários dela passam a
   * contar como "outra página"), e com dois painéis abertos o mesmo comentário
   * é salvo duas vezes, um por painel.
   *
   * O critério é a aba ativa DESTA janela, a mesma que `enviarAba` usa: o
   * painel só fala com ela, então também só pode ouvir dela. */
  chrome.runtime.onMessage.addListener((msg, remetente) => {
    if (!msg || !msg.rp) return;
    daAbaAtiva(remetente).then((sim) => {
      if (sim) receber(msg);
    });
  });

  function receber(msg) {
    if (msg.rp === 'pronto') {
      paginaAtual = msg.pagina;
      /* Página nova, content script novo: devolve o estado que ele não tem. */
      if (pickerLigado) enviarAba({ rp: 'picker', on: true, redigir: opcoes.redigir });
      enviarPins();
      render();
      return;
    }
    /* Comentário chega escrito: quem escreve é a caixa ancorada no elemento
     * (content/60-caixa.js). O painel só persiste, redesenha e devolve os
     * pins. */
    if (msg.rp === 'comentario') {
      paginaAtual = msg.pagina;
      salvarNovo(msg);
      return;
    }
    /* Edição feita no pin, na própria página. O painel é a única cópia da
     * sessão, então a página sempre volta aqui para gravar. */
    if (msg.rp === 'comentario-editado') {
      salvarEdicao(msg.id, msg.texto);
      return;
    }
    if (msg.rp === 'picker-desligou') {
      pickerLigado = false;
      sincronizarMira();
      avisar('');
    }
  }

  /** true quando a mensagem veio da aba ativa desta janela. */
  async function daAbaAtiva(remetente) {
    const id = remetente && remetente.tab && remetente.tab.id;
    if (typeof id !== 'number') return false;
    const aba = await abaAtiva();
    if (!aba || aba.id !== id) return false;
    tabAtual = id;
    return true;
  }

  /* Trocar de aba muda a página de referência: sem isso os pins e o realce
   * continuariam mirando a aba anterior.
   *
   * A seleção anda junto: a aba que sai é desarmada e a que entra é armada. Sem
   * desarmar a que sai, ela ficaria com o clique suprimido pelas costas - e sem
   * armar a que entra, o botão diria "Selecionando…" sobre uma página que não
   * está. */
  chrome.tabs.onActivated.addListener(async ({ tabId }) => {
    const anterior = tabAtual;
    if (pickerLigado && anterior != null && anterior !== tabId) {
      chrome.tabs.sendMessage(anterior, { rp: 'picker', on: false }).catch(() => {});
    }
    const estava = pickerLigado;
    await pingar();
    if (estava) alternarPicker(true);
  });

  /* Navegação sem "Seguir navegação" ligado não gera `pronto` (nada é
   * injetado), e `paginaAtual` ficaria apontando para a página anterior - os
   * comentários da antiga apareceriam como se fossem da nova. */
  chrome.tabs.onUpdated.addListener(async (tabId, info) => {
    if (info.status !== 'complete') return;
    const aba = await abaAtiva();
    if (aba && aba.id === tabId) pingar();
  });
}

/* ------------------------------------------------------------------- canal */

async function abaAtiva() {
  const janela = await chrome.windows.getCurrent();
  const [aba] = await chrome.tabs.query({ active: true, windowId: janela.id });
  return aba || null;
}

/** Manda uma mensagem para a página da aba ativa. Devolve null quando não há
 *  content script lá - estado normal (aba nova, página bloqueada), não erro. */
async function enviarAba(msg) {
  const aba = await abaAtiva();
  if (!aba || typeof aba.id !== 'number') return null;
  try {
    return await chrome.tabs.sendMessage(aba.id, msg);
  } catch (_) {
    return null;
  }
}

/** Garante content script na aba ativa. O service worker é quem injeta: ele
 *  tem o motivo pronto quando a página é bloqueada (chrome://, Web Store). */
async function garantirScript() {
  const aba = await abaAtiva();
  if (!aba || typeof aba.id !== 'number') {
    return { ok: false, motivo: 'Nenhuma aba ativa nesta janela.' };
  }
  const r = await chrome.runtime.sendMessage({ rp: 'injetar', tabId: aba.id, url: aba.url });
  return r || { ok: false, motivo: 'service worker não respondeu.' };
}

async function pingar() {
  const aba = await abaAtiva();
  tabAtual = aba && typeof aba.id === 'number' ? aba.id : null;
  const r = await enviarAba({ rp: 'ping' });
  if (r && r.ok) {
    paginaAtual = r.pagina;
    enviarPins();
    render();
    return true;
  }
  paginaAtual = null;
  render();
  return false;
}

/* ------------------------------------------------------------------ picker */

async function alternarPicker(ligar) {
  if (ligar) {
    const r = await garantirScript();
    if (!r.ok) {
      /* O botão não pode continuar dizendo que está selecionando numa página
       * onde não deu para injetar. */
      pickerLigado = false;
      sincronizarMira();
      avisar(r.motivo, 'alerta');
      return;
    }
    if (!paginaAtual) await pingar();
    const res = await enviarAba({ rp: 'picker', on: true, redigir: opcoes.redigir });
    pickerLigado = !!(res && res.ativo);
    avisar(
      pickerLigado
        ? 'Clique no elemento que precisa mudar. Alt cicla o que está embaixo, Esc sai.'
        : 'Não deu para armar a seleção nesta página.',
      pickerLigado ? '' : 'alerta'
    );
  } else {
    await enviarAba({ rp: 'picker', on: false });
    pickerLigado = false;
    avisar('');
  }
  sincronizarMira();
}

function sincronizarMira() {
  el.mira.setAttribute('aria-pressed', pickerLigado ? 'true' : 'false');
  el.miraTexto.textContent = pickerLigado ? 'Selecionando…' : 'Selecionar elemento';
}

/* -------------------------------------------------------------- compositor
 *
 * Só edição. Comentário novo nasce na caixa ancorada no elemento, na própria
 * página; editar um que já existe não tem ponto de clique (o elemento pode
 * estar em outra página da sessão), então esse caso fica aqui. */

async function salvarNovo({ texto, alvo, pagina }) {
  adicionar(sessao, { texto, pagina, alvo });
  await salvar(sessao);
  render();
  enviarPins();
}

async function salvarEdicao(id, texto) {
  atualizar(sessao, id, texto);
  await salvar(sessao);
  if (editandoId === id) fecharCompositor();
  render();
  /* Reenvia os pins: o texto que o balão do pin mostra viaja na carga deles. */
  enviarPins();
}

function abrirEdicao(comentario) {
  editandoId = comentario.id;
  el.alvoRotulo.textContent = comentario.alvo.rotulo || comentario.alvo.etiqueta;
  el.texto.value = comentario.texto;
  el.comentar.disabled = false;
  el.compositor.hidden = false;
  el.texto.focus();
  el.texto.setSelectionRange(el.texto.value.length, el.texto.value.length);
}

function fecharCompositor() {
  editandoId = null;
  el.texto.value = '';
  el.compositor.hidden = true;
}

async function salvarComentario() {
  const texto = el.texto.value.trim();
  if (!texto || !editandoId) return;
  atualizar(sessao, editandoId, texto);
  await salvar(sessao);
  fecharCompositor();
  render();
}

/* ------------------------------------------------------------------ render */

function render() {
  const total = sessao.comentarios.length;
  const paginas = totalPaginas(sessao);

  el.contador.textContent = String(total);
  el.meta.textContent = total
    ? total + (total === 1 ? ' comentário' : ' comentários') +
      ' em ' + paginas + (paginas === 1 ? ' página' : ' páginas')
    : 'Nenhum comentário nesta sessão';

  el.copiar.disabled = !total;
  el.baixar.disabled = !total;
  el.limpar.disabled = !total;
  el.gaveta.hidden = !total;
  if (total) el.previa.textContent = gerar(sessao);
  else el.gaveta.removeAttribute('open');

  el.historico.textContent = '';
  if (!total) {
    el.historico.appendChild(vazio());
    return;
  }

  for (const grupo of porPagina(sessao)) {
    el.historico.appendChild(cartaoGrupo(grupo));
  }
}

function vazio() {
  const p = document.createElement('p');
  p.className = 'vazio';
  const b = document.createElement('b');
  b.textContent = 'Selecionar elemento';
  p.append(
    'Clique em ',
    b,
    ' e depois no que precisa mudar na página. Os comentários ficam aqui, de várias páginas na mesma sessão, e saem juntos como prompt ou .md.'
  );
  return p;
}

function cartaoGrupo(grupo) {
  const bloco = document.createElement('section');
  bloco.className = 'grupo';

  const topo = document.createElement('div');
  topo.className = 'grupo-topo';

  const titulo = document.createElement('span');
  const daPagina = mesmaPagina(grupo.pagina);
  titulo.className = 'grupo-titulo' + (daPagina ? '' : ' outra');
  titulo.textContent = (grupo.pagina.origem || '') + (grupo.pagina.caminho || '');
  titulo.title = grupo.pagina.titulo
    ? grupo.pagina.titulo + '\n' + grupo.pagina.url
    : grupo.pagina.url;

  const qtd = document.createElement('span');
  qtd.className = 'grupo-qtd';
  qtd.textContent = String(grupo.itens.length);

  topo.append(titulo, qtd);

  const cartoes = document.createElement('div');
  cartoes.className = 'cartoes';
  for (const item of grupo.itens) {
    cartoes.appendChild(cartao(item.n, item.comentario, daPagina));
  }

  bloco.append(topo, cartoes);
  return bloco;
}

function cartao(n, c, daPagina) {
  const linha = document.createElement('div');
  linha.className = 'cartao';

  const num = document.createElement('span');
  num.className = 'cartao-n';
  num.textContent = String(n).padStart(2, '0');

  /* Botão e não div: o cartão é clicável (abre a edição), e o teclado tem de
   * chegar nele igual ao mouse. */
  const corpo = document.createElement('button');
  corpo.type = 'button';
  corpo.className = 'cartao-corpo';

  const texto = document.createElement('span');
  texto.className = 'cartao-texto';
  texto.textContent = c.texto;

  const alvo = document.createElement('span');
  alvo.className = 'cartao-alvo' + (daPagina ? '' : ' cartao-fora');
  alvo.textContent = c.alvo.rotulo || c.alvo.etiqueta;

  corpo.append(texto, alvo);
  corpo.addEventListener('click', () => abrirEdicao(c));

  /* Realce só faz sentido na página do comentário: em outra, o seletor pode
   * até casar (um header compartilhado, por exemplo) e acenderia a coisa
   * errada. */
  if (daPagina) {
    corpo.addEventListener('mouseenter', () => enviarAba({ rp: 'foco', alvo: c.alvo }));
    corpo.addEventListener('mouseleave', () => enviarAba({ rp: 'foco', alvo: null }));
  }

  const lixo = document.createElement('button');
  lixo.type = 'button';
  lixo.className = 'remover';
  lixo.title = 'Remover comentário';
  lixo.innerHTML =
    '<svg viewBox="0 0 256 256" aria-hidden="true">' +
    '<line x1="216" y1="56" x2="40" y2="56" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="20"/>' +
    '<path d="M200,56V208a8,8,0,0,1-8,8H64a8,8,0,0,1-8-8V56" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="20"/>' +
    '<path d="M168,56V40a16,16,0,0,0-16-16H104A16,16,0,0,0,88,40V56" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="20"/>' +
    '</svg>';
  lixo.addEventListener('click', async () => {
    remover(sessao, c.id);
    if (editandoId === c.id) fecharCompositor();
    await salvar(sessao);
    render();
    enviarPins();
  });

  linha.append(num, corpo, lixo);
  return linha;
}

function mesmaPagina(pagina) {
  return mesmaPaginaQue(paginaAtual, pagina);
}

/** Pins da página aberta agora. O número é o global da sessão, o mesmo do
 *  relatório - é assim que o pin na tela e o item no .md se encontram. */
function enviarPins() {
  const itens = porPagina(sessao)
    .filter((g) => mesmaPaginaQue(g.pagina, paginaAtual))
    .flatMap((g) =>
      g.itens.map(({ n, comentario: c }) => ({
        n,
        id: c.id,
        texto: c.texto,
        alvo: c.alvo,
      }))
    );
  enviarAba({ rp: 'pins', itens });
}

function avisar(texto, tipo) {
  el.aviso.textContent = texto || '';
  el.aviso.className = 'aviso' + (tipo ? ' ' + tipo : '');
  el.aviso.hidden = !texto;
}

/* ---------------------------------------------------------------- exportar */

async function copiar() {
  const texto = gerar(sessao);
  if (!texto) return;
  await navigator.clipboard.writeText(texto);
  el.copiar.textContent = 'Copiado';
  setTimeout(() => (el.copiar.textContent = 'Copiar prompt'), 2000);
}

/** Mesmo texto do prompt, em arquivo. Serve para guardar a rodada ou levar os
 *  comentários para outra sessão - por isso é byte a byte o que está na
 *  gaveta, e não um segundo formato para manter. */
function baixar() {
  const texto = gerar(sessao);
  if (!texto) return;
  const url = URL.createObjectURL(new Blob([texto], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = nomeArquivo();
  link.click();
  /* Revogar na tarefa seguinte, não na mesma: o clique só agenda o download, e
   * revogar antes de ele começar a ler o blob cancela o arquivo. */
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Dois toques em vez de um confirm(): apagar a sessão é o único caminho sem
 *  volta aqui, e o rótulo virando pergunta deixa isso explícito sem depender
 *  de diálogo do navegador. */
async function limparSessao() {
  if (!confirmandoLimpar) {
    confirmandoLimpar = true;
    el.limpar.textContent = 'Apagar tudo?';
    clearTimeout(timerLimpar);
    timerLimpar = setTimeout(() => {
      confirmandoLimpar = false;
      el.limpar.textContent = 'Limpar';
    }, 4000);
    return;
  }
  clearTimeout(timerLimpar);
  confirmandoLimpar = false;
  el.limpar.textContent = 'Limpar';
  sessao = nova();
  await salvar(sessao);
  fecharCompositor();
  render();
  /* Tira pins e estampas da página junto - a sessão zerada não pode continuar
   * marcada na tela. */
  enviarAba({ rp: 'limpar' });
}
