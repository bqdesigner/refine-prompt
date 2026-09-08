#!/usr/bin/env python3
"""Gera os ícones da extensão.

Balão de comentário branco sobre quadrado verde arredondado, com o canto de
baixo à esquerda vivo e o resto arredondado. Fica em script porque o ícone é
derivado, não desenhado à mão: mudou a cor, roda de novo.

    python3 tools/gen-icons.py
"""

from pathlib import Path

from PIL import Image, ImageDraw

VERDE = (0, 138, 0, 255)
BRANCO = (255, 255, 255, 255)

BASE = 512
TAMANHOS = (128, 48, 16)
DESTINO = Path(__file__).resolve().parent.parent / "icons"


def bolha(desenho: ImageDraw.ImageDraw, caixa, raio, cor):
    """Retângulo arredondado com o canto inferior esquerdo em ângulo reto."""
    x0, y0, x1, y1 = caixa
    desenho.rounded_rectangle(caixa, radius=raio, fill=cor)
    desenho.rectangle((x0, y1 - raio, x0 + raio, y1), fill=cor)


def gerar():
    img = Image.new("RGBA", (BASE, BASE), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Fundo: quadrado arredondado verde. O ícone vive numa barra de
    # ferramentas cheia de logos, e a mancha de cor é o que o torna achável.
    d.rounded_rectangle((0, 0, BASE - 1, BASE - 1), radius=112, fill=VERDE)

    # Balão em contorno: forma cheia branca, e a mesma forma menor em verde
    # por dentro. Contorno de verdade em PIL sai irregular nos cantos.
    traco = 38
    fora = (118, 124, BASE - 118, BASE - 124)
    dentro = (
        fora[0] + traco,
        fora[1] + traco,
        fora[2] - traco,
        fora[3] - traco,
    )
    bolha(d, fora, 96, BRANCO)
    bolha(d, dentro, 96 - traco // 2, VERDE)

    DESTINO.mkdir(parents=True, exist_ok=True)
    for lado in TAMANHOS:
        img.resize((lado, lado), Image.LANCZOS).save(DESTINO / f"icon{lado}.png")
        print(f"icons/icon{lado}.png")


if __name__ == "__main__":
    gerar()
