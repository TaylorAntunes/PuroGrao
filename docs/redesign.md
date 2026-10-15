# Reformulação visual da Puro Grão

Implementada em 7 de outubro de 2026. Identidade: **Puro Grão — Produtos Naturais**, com a chamada **“Naturalmente, do seu jeito”**.

## Análise e escopo

O projeto usa Express, SQLite e HTML/CSS/JavaScript sem framework de componentes. A análise incluiu as três páginas existentes, os estilos globais, os scripts da loja e do painel, o tema salvo, as APIs, os cálculos compartilhados e os testes disponíveis.

As páginas continuam sendo `/`, `/ofertas` e `/admin`. Os detalhes e seletores de cada produto continuam no catálogo, com os links diretos existentes. A finalização continua pelo WhatsApp.

A implementação seguiu esta sequência: sistema visual compartilhado; elementos reutilizáveis; Home e navegação; catálogo e seletores; carrinho, entrega e checkout; ofertas e kits; conteúdo institucional e rodapé; painel; revisão de responsividade, acessibilidade e funcionalidades.

Não foram adicionadas dependências, alteradas tecnologias ou modificadas regras do servidor. Os novos módulos de interface trabalham sobre os elementos e eventos existentes.

## Arquivos criados

| Arquivo | Responsabilidade |
| --- | --- |
| `public/css/design-system.css` | Tokens compartilhados, tipografia, estados de foco, diálogos, acessibilidade e movimento reduzido. |
| `public/js/icons.js` | Conjunto local de ícones SVG coerentes, sem biblioteca ou script externo. |
| `public/js/store-ui.js` | Menu mobile, diálogo de filtros, atalhos de busca, categorias e apresentação dos estados do catálogo. |
| `public/js/admin-ui.js` | Apresentação dos estados dos pedidos usando os controles existentes. |
| `docs/redesign.md` | Este relatório. |

## Arquivos reformulados

| Arquivo | Alterações |
| --- | --- |
| `public/index.html` | Header, Hero, categorias, ordem dos destaques, entrega, conteúdo institucional, contato, rodapé e estrutura acessível dos diálogos. |
| `public/offers.html` | Navegação, busca, filtros mobile, carrinho, campos do checkout e rodapé consistentes com a Home. |
| `public/admin.html` | Sidebar com as cinco áreas existentes, login identificado, indicadores e formulários agrupados. |
| `public/css/store.css` | Layout completo da loja, cards, fotografias, seleção de peso/unidades, promoções, kits, carrinho, checkout e responsividade. |
| `public/css/admin.css` | Layout do painel, dashboard, estoque, tabelas, pedidos, formulários, editor de fotos e prévia do banner. |
| `public/css/theme.css` | Botão de tema alinhado ao sistema visual compartilhado. |
| `public/js/store.js` | Alterações localizadas no HTML renderizado: ícones, badges, categorias e atributos de apresentação. A visibilidade do contêiner de destaques passou a considerar também o banner editável. |
| `public/js/admin.js` | Ícones e nomes acessíveis para ações, identificação das células para leitura mobile e identificação do seletor de status. |
| `scripts/preview-check.cjs` | Ampliação da conferência real no Chrome, usando banco temporário. |
| `README.md` | Referência ao sistema visual e a este relatório. |

## Componentes visuais

Na arquitetura atual, os componentes são classes CSS compartilhadas, pequenos módulos de apresentação e os geradores de HTML já existentes; não foram introduzidos JSX ou um novo framework.

Foram criados o menu mobile, o diálogo de filtros, os cards de categoria ligados ao catálogo real, o conjunto de ícones e os blocos de informações de entrega.

Foram reformulados os botões, badges, inputs, cabeçalhos de seção, cards de produtos e kits, banner configurável, destaques, progresso do frete, drawer do carrinho, checkout, estados vazios/erro/carregamento, sidebar, cards de métricas, gráficos de estoque e tabelas do painel.

## Tokens de identidade

| Token | Claro | Escuro |
| --- | --- | --- |
| `--background` | `#F8F8F4` | `#0F1512` |
| `--surface` | `#FFFFFF` | `#17211B` |
| `--surface-secondary` | `#EEF3EA` | `#1E2B23` |
| `--primary` | `#2F6B47` | `#72C18A` |
| `--primary-hover` | `#24563A` | `#89D49E` |
| `--primary-soft` | `#DCE9D2` | `#263B2B` |
| `--accent` | `#7EAD5A` | `#A4D77B` |
| `--text` | `#1D2B23` | `#F2F5F1` |
| `--text-secondary` | `#68746C` | `#AAB5AD` |
| `--border` | `#DFE5DE` | `#2D3C32` |
| `--offer` | `#C98627` | `#E3AD57` |
| `--success` | `#378458` | `#69C387` |
| `--danger` | `#C94B4B` | `#E56D6D` |

Tokens auxiliares controlam texto sobre superfícies coloridas, promoções, erros, kits, fotografias, ilustrações, rodapé e overlays. `--offer-text`, `--danger-text` e `--text-on-tint` usam tons adequados para textos pequenos com contraste mínimo de 4,5:1 nas combinações verificadas.

- Tipografia: `--font-title` usa DM Serif Display; `--font-ui` usa Manrope. O painel usa Manrope, exceto a prévia do banner da loja.
- Espaçamento: `--space-1` até `--space-9`: 4, 8, 12, 16, 24, 32, 48, 64 e 96 px. `--section-space` adapta a separação das seções de 48 a 88 px.
- Cantos: `--radius-sm`, `--radius-md`, `--radius-lg`, `--radius-xl` e `--radius-pill`: 8, 12, 18, 24 e 999 px.
- Transições: `--duration` de 200 ms; desativadas com `prefers-reduced-motion`.
- Sombras: suaves no claro; desativadas no escuro. Bordas e superfícies definem a hierarquia no tema escuro.

O script `theme.js` e a chave de preferência `puro-theme` foram preservados. As páginas usam o mesmo layout e trocam os tokens de cores.

## Melhorias de uso

- Header compacto e fixo, com navegação principal, busca, tema e carrinho; menu simples no celular.
- Hero neutro com fotografia existente, chamada da marca e duas ações claras.
- Categorias compactas geradas a partir dos produtos reais e ligadas aos filtros originais.
- Destaques com a mesma linguagem de cards e badges. Banner entre Mais vendidos e Novidades. Seções sem conteúdo continuam ocultas; o banner pode aparecer sozinho.
- Fotografias com área consistente, sem distorção, respeitando enquadramento e modo de ajuste cadastrados.
- Seletores de peso e quantidade mais claros, estado selecionado visível e controles confortáveis para toque.
- Promoções em ocre, preços anteriores riscados, contagem regressiva e apresentação especial da Terça do Granel.
- Filtros em diálogo no celular e ação para limpar busca/categoria; busca tolerante a erros preservada.
- Carrinho lateral com mais espaço, ação discreta para esvaziar e checkout dividido em dados e entrega.
- Barra compacta de frete grátis, subtotal e acesso ao pedido, sem ocupar a tela inteira.
- Conteúdo institucional, quatro passos de compra, entrega/retirada e rodapé organizado.
- Painel com sidebar no desktop, navegação adaptada no celular, métricas sóbrias e tabelas transformadas em cards no mobile.
- Foco visível, labels, nomes acessíveis, retorno do foco ao fechar diálogos, estados identificados por texto e respeito a movimento reduzido.

## Preservação de funcionalidades e dados

Continuam funcionando: carrinho salvo e sincronização entre abas; esvaziar carrinho; estoque compartilhado; pesos predefinidos e personalizados; venda por unidade; kits mistos; busca tolerante a erros; compartilhamento; checkout; WhatsApp; pedidos e seus status; login/logout; dashboard; edição e prévia do banner.

Regras mantidas:

- Terça do Granel: 20% somente na terça-feira, nos produtos por peso selecionados, mantendo suas categorias originais.
- Frete: grátis para entrega em Maracanaú a partir de R$50 em produtos após descontos; outras cidades combinam frete com a loja.
- Estoque baixo: até 3 kg ou até 3 unidades, conforme a forma de venda.
- Finalização pelo WhatsApp, sem pagamento online.

Foi comparado o SHA-256 de 19 arquivos protegidos, incluindo todo o backend, os cálculos compartilhados, a busca, o tema e os arquivos de dependências: todos permanecem iguais à análise inicial. Também foram comparados contagem e hash de todas as linhas das cinco tabelas do banco original: **nenhuma alteração**. O `PRAGMA quick_check` retornou `ok`.

O banco original mantém 10 produtos, 1 pedido e 1 item de pedido. Não foram criados kits ou banners fictícios nele. Os produtos, kits, pedidos e banners usados nas capturas de teste existem apenas no banco temporário da conferência.

## Testes executados

- `npm.cmd run verify`: sintaxe de 34 arquivos JavaScript; **73 testes passaram, zero falhas**.
- `npm.cmd run preview`: Chrome sem janela, aplicação e banco temporários; sem exceções JavaScript registradas.
- Home, Ofertas e as cinco áreas do painel: **360, 390, 430, 768, 1024 e 1440 px**, nos modos claro e escuro, sem overflow horizontal. A conferência anterior de 320 px também permanece passando.
- Carrinho vazio e com produtos, esvaziamento, foco e navegação por teclado; peso padrão/personalizado, unidade, kits mistos, produto esgotado e atualização de estoque.
- Busca “psilium” encontrando Psyllium, compartilhamento e link direto ao produto.
- Frete abaixo e acima de R$50; checkout real na API temporária com pedido de R$56 e entrega grátis em Maracanaú. Apenas o destino de navegação da resposta foi redirecionado ao teste, evitando abrir ou enviar mensagens pelo WhatsApp.
- Terça do Granel usando os helpers reais de promoção com data simulada; desconto, preço riscado, contagem e página de ofertas. Fora da terça o desconto permanece inativo.
- Banner publicado pelo formulário, prévia, banner como único destaque e ocultação completa quando não há conteúdo.
- Login, logout, sessão revogada, armazenamento de sessão bloqueado, formulários e upload/posicionamento de fotos no painel.
- Contraste mínimo de 4,5:1 para 24 combinações principais de texto/fundo nos dois temas, incluindo o novo banner fotográfico, e desativação de transições com movimento reduzido.

O projeto não possui comandos separados de lint ou typecheck. A verificação de sintaxe e a suíte existente foram executadas.

## Capturas para revisão

O Hero foi atualizado posteriormente conforme a referência com potes e castanhas, nas versões clara e escura. Os arquivos adicionais, fotografias e prompts estão no [relatório do banner](banner-home.md). As capturas abaixo já mostram essa atualização.

- [Home clara — desktop](../artifacts/redesign-home-light-1440.png)
- [Home escura — celular](../artifacts/redesign-home-dark-390.png)
- [Painel claro — desktop](../artifacts/redesign-admin-light-1440.png)
- [Painel escuro — celular](../artifacts/redesign-admin-dark-390.png)
- [Terça do Granel — simulação visual](../artifacts/redesign-promotion-light.png)
- [Kits — dados temporários](../artifacts/redesign-kits-light.png)

## Problemas encontrados e pontos para revisão

Durante a conferência foram corrigidos o excesso de largura do header mobile, mensagens de erro vazias que exibiam fundo colorido, a visibilidade do banner sozinho e o contraste dos textos sobre superfícies coloridas. A verificação de largura também passou a considerar a barra de rolagem vertical do Chrome corretamente.

Não há erro impeditivo conhecido após os testes. A conferência automatizada cobre comportamento e dimensões, mas não substitui avaliação em aparelhos físicos e revisão de conteúdo.

Permanecem para revisão da loja:

- Informar endereço, horário de atendimento e Instagram reais para completar localização e rodapé; esses dados não foram inventados.
- Configurar o WhatsApp real no ambiente quando ainda estiver usando o número de exemplo.
- Revisar fotografias do catálogo e enviar imagens reais dos kits, caso queira ampliar a apresentação atual. As imagens e a logo existentes foram preservadas.
- Validar visualmente no celular usado pelos clientes e revisar textos do banner pelo painel.

