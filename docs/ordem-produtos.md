# Escolher a ordem dos produtos

No painel, abra **Produtos** e encontre a coluna **Ordem na loja**.

- Use as setas para subir ou descer um produto na lista exibida.
- Para mudar diretamente, informe uma posição e clique em **Mover**. A posição **1** fica no começo.
- A alteração é salva imediatamente. Não precisa salvar novamente o formulário do produto.

Os filtros de busca, categoria, estoque e visibilidade continuam funcionando. Com filtros ativos, as setas usam o produto anterior ou seguinte entre os resultados. O número representa a posição no catálogo completo, incluindo os produtos ocultos. Produtos ocultos mantêm sua posição para quando forem reativados. Produtos novos entram no fim.

A primeira atualização mantém a sequência que o catálogo já usava. Depois, a loja e a lista administrativa seguem a ordem escolhida. As categorias continuam na sua própria sequência alfabética. **Mais vendidos** continua usando o ranking de vendas, e **Novidades** continua usando os produtos mais recentes. A página de ofertas acompanha a ordem do catálogo entre os produtos elegíveis.

Ordenar não altera nome, categoria, preço, custo, quantidade, fotos, promoção, visibilidade ou pedidos e não cria movimentação de estoque. Se outro atendimento mudar a lista antes do salvamento, o painel atualiza os produtos e pede que você confira a posição antes de tentar novamente.

A implementação usa o campo `products.display_order` e a rota autenticada `PATCH /api/admin/products/:id/order`. O envio inclui a posição e a sequência de IDs que o painel estava mostrando; a mudança é aplicada em uma transação. Migrações e testes preservam os dados existentes.
