# Puro Grão

Loja com catálogo por peso ou por unidade, carrinho, pedidos no WhatsApp e painel administrativo. O banco SQLite guarda produtos, fotos, kits, banner e histórico de pedidos.

## Iniciar

Use Node.js 22.5 ou superior. A instalação atual foi verificada com Node.js 24.

1. Instale as dependências com `npm ci`.
2. Copie `.env.example` para `.env` e ajuste a senha e o WhatsApp da loja.
3. Inicie com `npm start`.
4. Abra [a loja](http://localhost:3000) ou [o painel](http://localhost:3000/admin).

No PowerShell, use `npm.cmd` caso a política do Windows bloqueie `npm.ps1`. Para copiar a configuração, use `Copy-Item .env.example .env`.

O servidor lê `.env` na inicialização. Variáveis já definidas no ambiente têm prioridade. Alterações nessa configuração exigem reiniciar o servidor.

| Variável | Uso |
| --- | --- |
| `PORT` | Porta do servidor; padrão 3000. |
| `ADMIN_PASSWORD` | Senha do painel; obrigatória em produção. |
| `WHATSAPP_NUMBER` | Número real com país e DDD, somente dígitos. |
| `DB_FILE` | Arquivo SQLite; padrão `loja.db`. |
| `NODE_ENV` | Use `production` no servidor publicado. |
| `HOST` | Endereço de escuta; padrão `127.0.0.1` para uso local. |
| `TRUST_PROXY` | IPs ou redes específicas dos proxies confiáveis; padrão `false`. |
| `PUBLIC_URL` | Origem HTTPS oficial para publicação, por exemplo `https://loja.example`. |

Os números e a senha de `.env.example` são exemplos e devem ser substituídos. O padrão de desenvolvimento do painel continua disponível quando nenhuma senha é configurada.

## Organização

| Pasta ou arquivo | Responsabilidade |
| --- | --- |
| `server.js` | Configuração, inicialização e encerramento do servidor. |
| `src/app.js` | Aplicação Express e registro das páginas e APIs. |
| `src/routes/` | Rotas públicas e administrativas. |
| `src/middleware/` | Validação do JSON e respostas de erro. |
| `src/auth.js` | Login, sessões, logout e limite de tentativas. |
| `src/database.js` | Banco, migrações e índices. |
| `src/` | Regras de kits, banner, promoções, entrega, imagens e dashboard. |
| `shared/pricing.js` | Cálculo de preços usado pelo servidor e pelo navegador. |
| `public/` | HTML, CSS, JavaScript e imagens da loja. |
| `public/js/admin-*.js` | Recursos do painel separados por função. |
| `test/` | Testes com bancos temporários. |
| `scripts/` | Verificação de sintaxe e conferência no navegador. |
| `docs/` | Funcionalidades e relatório da revisão. |
| `artifacts/` | Capturas geradas durante as conferências; fora do código da aplicação. |

O banco existente permanece em `loja.db`. Migrações são automáticas e preservam os produtos e pedidos. Não substitua esse arquivo por um banco vazio.

## Verificar

O sistema visual compartilhado fica em `public/css/design-system.css`. Os arquivos `store-ui.js`, `admin-ui.js` e `icons.js` cuidam de apresentação e navegação, aproveitando as funções existentes. Consulte o [relatório do redesign](docs/redesign.md) para tokens, arquivos alterados, funcionalidades preservadas e capturas da revisão.

- `npm run check`: verifica automaticamente todos os arquivos JavaScript, incluindo testes e scripts.
- `npm test`: executa os testes sem modificar o banco da loja.
- `npm run verify`: executa as duas verificações acima.
- `npm run preview`: confere a loja e o painel no Chrome sem janela, com banco temporário.
- `npm audit --omit=dev`: consulta vulnerabilidades conhecidas das dependências.

A conferência visual usa o Chrome instalado no caminho padrão do Windows. Para outro caminho, defina `PREVIEW_BROWSER`. As capturas ficam em `artifacts/`.

## Usar o painel

A aba **Visão geral** reúne as métricas, o lucro bruto estimado e o estoque baixo. As abas **Produtos**, **Kits**, **Pedidos** e **Banner da Home** cuidam dos respectivos cadastros. A aba **Estoque** permite registrar compras e ajustes e consultar o histórico de entradas, vendas e cancelamentos. A aba **Vendas presenciais** registra o atendimento na loja, com produtos por peso ou unidade, forma de pagamento, baixa automática de estoque e histórico. Consulte o [guia de vendas presenciais](docs/vendas-presenciais.md). O tema claro ou escuro é salvo no navegador.

A aba **Vendas** reúne os pedidos do site, com filtros por cliente, número, telefone, datas, status e origem, detalhes e paginação para consultar todo o histórico. O resumo calcula faturamento e ticket médio somente com pedidos pagos ou entregues. Consulte o [guia do histórico de vendas](docs/vendas.md).

Em **Produtos**, cadastre o custo por kg ou unidade para conferir lucro estimado e margem. Custos ficam restritos ao painel e novos pedidos guardam os valores da época; pedidos antigos sem custo continuam identificados como incompletos. Consulte [histórico de estoque, custo e lucro](docs/estoque-e-lucro.md) para exemplos e regras.

Em **Produtos → Categoria → Sem categoria**, consulte os produtos com categoria vazia ou cadastrados como **Geral**, o valor usado quando a categoria não foi informada. Use **Editar** para atribuir uma categoria. Esse filtro organiza a visualização do painel sem modificar os cadastros automaticamente.

No formulário de produto, **Categoria** mostra as categorias existentes para seleção. **Sem categoria** mantém o produto no grupo de organização. Para acrescentar uma categoria, escolha **Criar nova categoria…**, informe o nome e salve o produto.

Na lista de **Produtos**, use **Ordem na loja** para escolher a sequência do catálogo. As setas movem o produto entre os resultados do filtro; para escolher outra posição, digite o número e clique em **Mover**. A ordem fica salva e não altera preços ou estoque. Consulte o [guia de ordenação](docs/ordem-produtos.md).

Em **Produtos → Forma de venda**, escolha **Por peso (gramas)** ou **Por unidade (quantidade)** para cada produto. Por peso, cadastre o preço de referência, seu peso e o estoque em gramas. Por unidade, cadastre o preço de uma peça e o estoque em unidades inteiras. Produtos existentes continuam por peso. O carrinho aceita os dois tipos juntos, inclusive em kits, com limite de 99 unidades ou porções por produto.

O alerta de estoque baixo considera até **3 kg** para produtos por peso e até **3 unidades** para produtos por quantidade. A Terça do Granel aplica desconto apenas aos produtos por peso selecionados no painel. Ao mudar a forma de venda, confira o preço e o estoque na nova medida; revise e salve os kits afetados. Itens antigos no carrinho são removidos para o cliente escolher novamente. Pedidos guardam a forma de venda original, e cancelamentos devolvem o estoque na medida original. Para reabrir um pedido, o produto deve continuar na mesma forma de venda.

Pedidos do site começam como **novo**, sem baixar ou reservar estoque. Na aba **Pedidos**, altere para **confirmado**, **pago** ou **entregue** para validar a disponibilidade e baixar todos os itens juntos. Se faltar um produto, a alteração é rejeitada sem baixa parcial. Vendas presenciais continuam baixando estoque no registro do pagamento.

O botão **Sair** revoga a sessão no servidor, limpa os dados privados da tela e descarta respostas da sessão anterior. Cinco senhas incorretas bloqueiam novas tentativas por cinco minutos. Uma sessão dura até 12 horas. Consulte o [guia de segurança](docs/seguranca.md) para os limites de pedidos e a configuração de publicação.

Consulte [as funcionalidades e regras da loja](docs/funcionalidades.md) para pesos, descontos de terça-feira, frete grátis, kits, compartilhamento e banner. O [relatório da revisão](docs/revisao.md) registra as correções e verificações realizadas.

## Publicar e preservar os dados

Use uma hospedagem com disco persistente e configure `DB_FILE` para esse disco. Defina uma senha própria, o WhatsApp real e HTTPS antes de publicar. Configure o domínio em `PUBLIC_URL` e declare os IPs do proxy em `TRUST_PROXY`, seguindo o [guia de segurança](docs/seguranca.md). O uso local continua por HTTP; o modo de produção rejeita envios sem HTTPS.

Para uma cópia simples do SQLite, pare o servidor antes de copiar `loja.db`. Ao copiar com o servidor ativo, use uma ferramenta de backup SQLite; copiar apenas o arquivo principal pode deixar dados recentes de fora por causa do WAL.

Fotos dos produtos e banner ficam dentro do SQLite e acompanham o backup. As imagens de marca e da capa ficam em `public/images/`.
