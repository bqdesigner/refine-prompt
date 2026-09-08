# Distribuição da extensão - caminhos de instalação

> Levantado em 08/09/2026. Estado atual: só roda em modo desenvolvedor (`Carregar sem compactação`).

Chrome bloqueia `.crx` sideloaded desde o Chrome 33 (Windows/Mac): instala e desativa na hora. Não existe terceira via - ou Web Store, ou política de enterprise.

## Caminho 1 - Chrome Web Store (público, unlisted ou private)

### Conta
- Dev account, taxa única de US$ 5
- 2FA obrigatório
- E-mail de contato verificado

### Pacote
- ZIP da pasta (sem `.git`, sem `demo/` e `tools/` se não forem necessários)
- Bump de `version` no `manifest.json` a cada submissão
- Todo código dentro do pacote: zero remote code (sem `eval`, sem script vindo de CDN). Se tiver, reprova.
- Ícone 128 obrigatório - já existe em `icons/`

### Listing
- Descrição detalhada
- Mínimo 1 screenshot 1280×800 ou 640×400 (dá pra usar `docs/refine-prompt.png` como base)
- Categoria + idioma
- Tile promocional 440×280 (opcional, ajuda na aprovação)

### Privacy tab - onde reprova mais
- **Single purpose**: uma frase, propósito único e estreito
- **Justificativa por permissão**, uma a uma: `activeTab`, `scripting`, `sidePanel`, `storage` e o host permission
- **Data usage disclosure**: declarar que não vende dado, não usa para crédito etc.
- **Privacy policy URL**: obrigatória se coletar qualquer dado do usuário. Os comentários que o usuário escreve sobre a página contam como user-generated content, então provavelmente precisa.

### Ponto de atenção deste projeto
`optional_host_permissions: ["*://*/*"]` já é a escolha certa: pede acesso em runtime, não no install. Se virasse `host_permissions` fixo, cairia em review estendida (semanas). **Manter como optional.**

### Visibilidade

| Modo | Quem vê | Pra quê |
|---|---|---|
| Public | busca da store | distribuição aberta |
| Unlisted | só quem tem o link | time interno informal |
| Private | contas ou domínio Workspace específicos | uso interno de um domínio |

Tempo de review: dias a ~2 semanas. Unlisted/private passa pelo mesmo review, mas o risco de rejeição é menor.

## Caminho 2 - Política de enterprise (sem store)

Para máquina gerenciada pela empresa. Depende de IT / Workspace admin:
- `ExtensionInstallForcelist` = ID + URL de update, instala silencioso e o usuário não desativa
- ou `ExtensionInstallAllowlist` + host próprio do `.crx` e do `update.xml`
- aplicado via Google Workspace Admin ou MDM (Jamf)

Ainda precisa da extensão empacotada e assinada, mas **não** precisa de review nem dos US$ 5.

## Recomendação

Uso interno de um time: **Caminho 1 em modo Private**, limitado ao domínio. Review mais leve, zero dependência de IT, e o time instala com um clique. Se a ideia for push automático em todo mundo sem ação do usuário, ir de Caminho 2 com o Workspace admin.

## Próximos passos quando retomar

1. Decidir Private (store) vs. enterprise policy
2. Montar o ZIP de submissão limpo
3. Escrever single purpose + justificativa de cada permissão
4. Rascunhar a privacy policy e hospedar numa URL pública
5. Preparar screenshot 1280×800 e o tile 440×280
