# Revisão do projeto — 7 de outubro de 2026

[Documentação principal](../README.md) · [Regras e funcionalidades](funcionalidades.md)

Foram revisados o servidor, as rotas, o banco, as regras de preço, estoque, promoção e entrega, os scripts da loja e do painel, as páginas, os estilos, as dependências e os testes.

## Correções

| Problema encontrado | Resultado da correção |
| --- | --- |
| A atualização periódica verificava preços, mas ignorava mudanças de estoque, nome, foto e destaques. | O catálogo compara todos os dados dos produtos e atualiza a vitrine e as quantidades do carrinho. |
| Kits verificavam o carrinho salvo antes de descartar itens inválidos. | O carrinho é validado antes de calcular a disponibilidade dos kits. |
| Carrinhos restaurados podiam ultrapassar o limite de 50 linhas. | O mesmo limite vale para restauração e novas adições. |
| Abas da loja e de ofertas mantinham cópias desatualizadas do carrinho. | Alterações recebidas pelo armazenamento do navegador atualizam o carrinho. |
| Alterar uma quantidade removia do HTML o botão que estava com foco. | O foco volta ao controle correspondente ou a um controle disponível. |
| A navegação por teclado do carrinho excluía os campos de seleção. | Seleções participam do ciclo de foco, inclusive com Tab e Shift+Tab. |
| Atualizar o catálogo podia interromper a digitação do peso personalizado. | A seleção e o foco são preservados após a atualização. |
| O mesmo pedido podia ser enviado novamente enquanto a primeira requisição estava pendente. | O envio é bloqueado durante o processamento, assim como a edição das porções e dos dados do pedido. |
| Uma resposta de pedido podia apagar adições recebidas de outra aba. | São retiradas do carrinho apenas as quantidades enviadas naquele pedido. |
| O painel falhava quando o navegador bloqueava o armazenamento da sessão. | O login funciona em memória; quando permitido, a sessão continua salva no navegador. |
| Sair do painel apagava apenas a sessão no navegador. | O logout também revoga o token no servidor. |
| Tokens expirados permaneciam na memória e havia apenas atraso nas senhas incorretas. | Sessões expiradas são removidas e cinco erros de senha geram bloqueio de cinco minutos. |
| Requisições inválidas ou grandes podiam retornar HTML ou mensagens inadequadas. | As APIs retornam JSON com status e mensagens adequados; erros internos têm mensagem genérica. |
| Alguns campos aceitavam objetos ou booleanos em lugar de textos e valores. | Validações de produtos, kits, pedidos e login rejeitam esses formatos. |
| Excluir um produto ou kit inexistente retornava sucesso. | A API retorna 404. |
| Totais muito grandes podiam ultrapassar a precisão segura de números em JavaScript. | O pedido é rejeitado e a transação devolve o estoque, sem salvar a compra. |
| O banco padrão dependia da pasta em que o comando era executado. | Caminhos relativos de banco são resolvidos a partir da pasta do projeto. |
| O texto principal podia juntar “nas” e “pequenas” em telas pequenas. | O espaço permanece quando a quebra de linha é ocultada no celular. |

## Organização

- `server.js` cuida da configuração e do ciclo do servidor; `src/app.js` registra a aplicação e as rotas.
- `src/auth.js` reúne autenticação e sessões; `src/middleware/http.js` reúne validação do corpo JSON e respostas de erro.
- `shared/pricing.js` é a implementação de preços usada pelo servidor e pelo navegador, inclusive na prévia dos kits.
- Dashboard e banner do painel foram separados em `public/js/admin-dashboard.js` e `public/js/admin-banner.js`.
- O HTML foi formatado, os scripts foram mantidos na ordem de carregamento e a inicialização do painel acontece após todos os módulos estarem disponíveis.
- O banco recebeu índices para os itens por pedido e por produto. Produtos e pedidos existentes foram preservados.
- `scripts/check.cjs` descobre automaticamente os arquivos JavaScript, substituindo a lista manual de arquivos do comando de verificação.
- O teste de navegador usa a aplicação real, inclui limite de espera nas chamadas e mantém as capturas em `artifacts/`.
- O README reúne instalação, configuração, estrutura e comandos. As regras detalhadas ficam em `docs/funcionalidades.md`.
- `.env.example` documenta as variáveis. Arquivos de configuração local, banco e capturas ficam fora do controle de versão.

## Verificações realizadas

- `npm run verify`: sintaxe de **30 arquivos JavaScript** verificada e **58 testes aprovados**.
- `npm run preview`: desktop, telas de 390 px e 320 px, temas claro e escuro, pesos, carrinho, teclado, busca, compartilhamento, dashboard, banner, kits, fotos, atualização de estoque e login com armazenamento bloqueado.
- `npm audit --omit=dev`: **zero vulnerabilidades conhecidas** informadas pelo registro do npm na data da revisão.
- SQLite: `PRAGMA quick_check` retornou **ok**. O banco original mantém **10 produtos e 1 pedido**; os testes usam bancos temporários.
- Servidor local: loja e módulo compartilhado retornam 200; o dashboard administrativo exige login.

## Configuração pendente

O WhatsApp da loja está usando o número padrão de exemplo. Defina o número real em `WHATSAPP_NUMBER`, no arquivo `.env`, e reinicie o servidor. Essa informação precisa vir da loja.

Para publicação, configure também uma senha própria em `ADMIN_PASSWORD`; o servidor exige essa variável quando `NODE_ENV=production`.
