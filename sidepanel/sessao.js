/* Refine Prompt - a sessão.
 *
 * A sessão é o dado central da extensão e mora aqui, no side panel, nunca no
 * content script. O motivo é o requisito: uma sessão atravessa páginas, e o
 * content script é destruído em cada navegação. Guardar comentário na página
 * seria perder tudo no primeiro clique de menu.
 *
 * Consequência de projeto: o comentário guarda um DESCRITOR serializável do
 * elemento (ver content/10-locate.js), nunca uma referência ao nó. O nó é
 * reencontrado quando dá - e quando não dá, o comentário continua legível e
 * exportável, que é o que importa na hora de gerar o prompt.
 *
 * chrome.storage.local e não sessionStorage: o painel é fechado e reaberto no
 * meio de uma revisão, e a sessão precisa estar lá quando ele voltar.
 */

const CHAVE = 'sessao';
const CHAVE_OPCOES = 'opcoes';

/** Opções padrão. `redigir` ligado porque a extensão é agnóstica ao site:
 *  assumir que a página é do próprio time é a suposição que vaza dado.
 *
 *  "Seguir navegação" não entra aqui: o estado dele é a permissão de host em
 *  si (`chrome.permissions.contains`). Guardar uma cópia só criaria a chance
 *  de o checkbox discordar do que o Chrome concedeu. */
const OPCOES_PADRAO = { redigir: true };

export function nova() {
  return {
    id: String(Date.now()),
    criadaEm: new Date().toISOString(),
    comentarios: [],
  };
}

export async function carregar() {
  const guardado = await chrome.storage.local.get([CHAVE, CHAVE_OPCOES]);
  return {
    sessao: guardado[CHAVE] || nova(),
    opcoes: Object.assign({}, OPCOES_PADRAO, guardado[CHAVE_OPCOES] || {}),
  };
}

export async function salvar(sessao) {
  await chrome.storage.local.set({ [CHAVE]: sessao });
}

export async function salvarOpcoes(opcoes) {
  await chrome.storage.local.set({ [CHAVE_OPCOES]: opcoes });
}

export function adicionar(sessao, { texto, pagina, alvo }) {
  sessao.comentarios.push({
    id: String(Date.now()) + '-' + sessao.comentarios.length,
    texto,
    pagina,
    alvo,
    criadoEm: new Date().toISOString(),
  });
  return sessao;
}

export function remover(sessao, id) {
  const i = sessao.comentarios.findIndex((c) => c.id === id);
  if (i !== -1) sessao.comentarios.splice(i, 1);
  return sessao;
}

export function atualizar(sessao, id, texto) {
  const c = sessao.comentarios.find((x) => x.id === id);
  if (c) c.texto = texto;
  return sessao;
}

/** Duas descrições de página são a mesma página?
 *
 *  Pela `chave` (hash da URL crua, ver content/99-boot.js) e não pela URL
 *  exibida: a URL exibida muda quando a máscara de dado sensível é ligada ou
 *  desligada no meio da sessão, e a mesma página passaria a contar como duas.
 *
 *  A queda para a URL cobre comentário gravado por versão anterior à chave - a
 *  sessão fica em `chrome.storage.local` e sobrevive à atualização da
 *  extensão. */
export function mesmaPaginaQue(a, b) {
  if (!a || !b) return false;
  if (a.chave && b.chave) return a.chave === b.chave;
  return !!a.url && a.url === b.url;
}

/** Comentários agrupados por página, na ordem em que as páginas apareceram.
 *  Cada item guarda o número global (1..n) - é o mesmo número do pin na
 *  página e do item no relatório, então voltar de um para o outro é direto. */
export function porPagina(sessao) {
  const grupos = [];
  sessao.comentarios.forEach((c, i) => {
    let grupo = grupos.find((g) => mesmaPaginaQue(g.pagina, c.pagina));
    if (!grupo) {
      grupo = { pagina: c.pagina, itens: [] };
      grupos.push(grupo);
    }
    grupo.itens.push({ n: i + 1, comentario: c });
  });
  return grupos;
}

/** Quantas páginas a sessão já cobriu. */
export function totalPaginas(sessao) {
  return porPagina(sessao).length;
}
