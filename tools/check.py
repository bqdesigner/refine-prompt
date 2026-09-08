#!/usr/bin/env python3
"""Sanidade da extensão, sem precisar instalar no Chrome.

Pega o erro mais comum: arquivo novo em content/ que ficou de fora da lista
FILES do service worker. Quando isso acontece o executeScript falha inteiro e
sem mensagem - a extensão simplesmente não faz nada.

    python3 tools/check.py
"""

import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
PERMISSOES_ESPERADAS = {"activeTab", "scripting", "sidePanel", "storage"}

falhas = []


def erro(msg):
    falhas.append(msg)
    print(f"  x {msg}")


def sintaxe():
    """node --check em tudo. Módulo ES precisa de extensão .mjs para o node
    aceitar `import`, então os arquivos do painel são checados numa cópia."""
    print("sintaxe")
    for arq in sorted(RAIZ.rglob("*.js")):
        if "node_modules" in arq.parts:
            continue
        alvo = arq
        temp = None
        if "import " in arq.read_text(encoding="utf-8"):
            temp = tempfile.NamedTemporaryFile(suffix=".mjs", delete=False)
            temp.write(arq.read_bytes())
            temp.close()
            alvo = Path(temp.name)
        r = subprocess.run(
            ["node", "--check", str(alvo)], capture_output=True, text=True
        )
        if temp:
            Path(temp.name).unlink()
        if r.returncode != 0:
            erro(f"{arq.relative_to(RAIZ)}: {r.stderr.strip().splitlines()[-1]}")
        else:
            print(f"  . {arq.relative_to(RAIZ)}")


def lista_de_arquivos():
    print("lista FILES do service worker")
    sw = (RAIZ / "background/service-worker.js").read_text(encoding="utf-8")
    bloco = re.search(r"const FILES = \[(.*?)\];", sw, re.S)
    if not bloco:
        erro("não achei a lista FILES no service worker")
        return
    declarados = re.findall(r"'([^']+)'", bloco.group(1))
    no_disco = sorted(p.name for p in (RAIZ / "content").glob("*.js"))
    declarados_nomes = [Path(d).name for d in declarados]

    faltando = [n for n in no_disco if n not in declarados_nomes]
    sobrando = [n for n in declarados_nomes if n not in no_disco]
    if faltando:
        erro(f"em content/ mas fora de FILES: {', '.join(faltando)}")
    if sobrando:
        erro(f"em FILES mas não existe em content/: {', '.join(sobrando)}")
    if declarados_nomes != sorted(declarados_nomes):
        erro("FILES fora de ordem - o número no nome documenta a dependência")
    if not faltando and not sobrando:
        print(f"  . {len(declarados)} arquivos, na ordem")


def permissoes():
    print("permissões do manifest")
    m = json.loads((RAIZ / "manifest.json").read_text(encoding="utf-8"))
    tem = set(m.get("permissions", []))
    extra = tem - PERMISSOES_ESPERADAS
    if extra:
        erro(f"permissão a mais: {', '.join(sorted(extra))}")
    if m.get("host_permissions"):
        erro("host_permissions no manifest - deve ser optional_host_permissions")
    if not m.get("side_panel", {}).get("default_path"):
        erro("manifest sem side_panel.default_path")
    for lado in (16, 48, 128):
        if not (RAIZ / f"icons/icon{lado}.png").exists():
            erro(f"falta icons/icon{lado}.png (rode tools/gen-icons.py)")
    if not extra:
        print(f"  . {', '.join(sorted(tem))} + optional_host_permissions")


def versao():
    """A versão vive em dois lugares: o manifest, que o Chrome lê, e RP.VERSION,
    que o content script carrega. Bump em um só passa despercebido - nada quebra,
    e a versão que aparece na página deixa de ser a que está instalada."""
    print("versão")
    m = json.loads((RAIZ / "manifest.json").read_text(encoding="utf-8"))
    ns = (RAIZ / "content/00-ns.js").read_text(encoding="utf-8")
    achado = re.search(r"RP\.VERSION\s*=\s*'([^']+)'", ns)
    if not achado:
        erro("não achei RP.VERSION em content/00-ns.js")
    elif achado.group(1) != m.get("version"):
        erro(f"manifest {m.get('version')} != RP.VERSION {achado.group(1)}")
    else:
        print(f"  . {m.get('version')} nos dois lugares")


def css():
    """Duas armadilhas de CSS, as duas silenciosas.

    Comentário de CSS não aninha e termina no primeiro `*/` - então um caminho
    com `/*` no meio do texto (`pasta/*/arquivo`) fecha o bloco cedo, o
    resto da prosa vira seletor inválido e o parser engole a regra seguinte
    inteira. Foi o que deixou todo botão primário branco no branco: a regra
    engolida era a `:root` com a paleta, e `var(--verde)` passou a não resolver.

    A tira de comentários abaixo é não-gulosa de propósito: imita exatamente o
    que o parser do navegador faz."""
    print("css")
    arq = RAIZ / "sidepanel/panel.css"
    bruto = arq.read_text(encoding="utf-8")
    limpo = re.sub(r"/\*.*?\*/", "", bruto, flags=re.S)

    # `:root` tem de abrir uma regra: só espaço ou um `}` antes dela.
    for m in re.finditer(r":root\s*\{", limpo):
        antes = limpo[: m.start()].rstrip()
        if antes and not antes.endswith("}"):
            erro(
                "regra :root engolida por comentário fechado cedo - "
                f"antes dela sobrou: ...{antes[-60:]!r}"
            )
            break

    declaradas = set(re.findall(r"(--[\w-]+)\s*:", limpo))
    usadas = set(re.findall(r"var\((--[\w-]+)", limpo))
    orfas = usadas - declaradas
    if orfas:
        erro(f"var() sem declaração: {', '.join(sorted(orfas))}")
    else:
        print(f"  . {len(declaradas)} variáveis, todas resolvem")


def shadow():
    """Os content scripts que pintam na página adotam as folhas deles no MESMO
    shadow root, então classe repetida entre dois arquivos é colisão de estilo,
    não coincidência: quem é adotado depois sobrescreve o outro.

    Foi assim que a caixa de comentário (`.caixa`) pintou de branco opaco as
    caixas de realce do overlay, que usavam a mesma classe genérica."""
    print("classes no shadow root")
    por_arquivo = {}
    for arq in sorted((RAIZ / "content").glob("*.js")):
        texto = arq.read_text(encoding="utf-8")
        blocos = re.findall(r"const CSS_\w+ = `(.*?)`", texto, re.S)
        if not blocos:
            continue
        classes = set()
        for b in blocos:
            classes |= set(re.findall(r"\.([a-z][\w-]*)", b))
        por_arquivo[arq.name] = classes

    nomes = list(por_arquivo)
    colidiu = False
    for i, a in enumerate(nomes):
        for b in nomes[i + 1 :]:
            comuns = por_arquivo[a] & por_arquivo[b]
            if comuns:
                colidiu = True
                erro(f"classe em {a} e {b}: {', '.join(sorted(comuns))}")
    if not colidiu:
        print(f"  . {len(nomes)} folhas, nenhuma classe repetida")


def namespace():
    """Todo `RP.x` lido tem de ser definido por algum arquivo de content/.

    Os módulos conversam por um namespace montado em tempo de injeção, então
    renomear ou remover um módulo não quebra em tempo de sintaxe - quebra na
    primeira tecla, no navegador, como `Cannot read properties of undefined`.
    Este é o único lugar que pega isso sem instalar."""
    print("namespace __RP")
    definidos = set()
    lidos = {}
    for arq in sorted((RAIZ / "content").glob("*.js")):
        texto = arq.read_text(encoding="utf-8")
        # tira comentários: prosa citando `RP.algo` não é uso
        codigo = re.sub(r"/\*.*?\*/", "", texto, flags=re.S)
        codigo = re.sub(r"//.*", "", codigo)
        definidos |= set(re.findall(r"RP\.(\w+)\s*=", codigo))
        for nome in re.findall(r"RP\.(\w+)", codigo):
            lidos.setdefault(nome, arq.name)

    orfaos = {k: v for k, v in lidos.items() if k not in definidos}
    if orfaos:
        for nome, arq in sorted(orfaos.items()):
            erro(f"RP.{nome} lido em {arq} e definido em lugar nenhum")
    else:
        print(f"  . {len(definidos)} membros, todos com dono")


def rede():
    """A extensão não manda nada para fora. O relatório sai pela mão do
    usuário, no copiar/colar - é o que sustenta rodar em site de terceiro."""
    print("nenhuma chamada de rede")
    suspeitos = ("fetch(", "XMLHttpRequest", "sendBeacon", "WebSocket", "eval(")
    achou = False
    for arq in sorted(RAIZ.rglob("*.js")):
        texto = arq.read_text(encoding="utf-8")
        for s in suspeitos:
            if s in texto:
                achou = True
                erro(f"{arq.relative_to(RAIZ)}: {s}")
    if not achou:
        print("  . nenhuma")


if __name__ == "__main__":
    sintaxe()
    lista_de_arquivos()
    permissoes()
    versao()
    css()
    shadow()
    namespace()
    rede()
    print()
    if falhas:
        print(f"{len(falhas)} problema(s)")
        sys.exit(1)
    print("tudo certo")
