# Histórico de estoque, custo e lucro

## Movimentações de estoque

A aba **Estoque** mostra data e horário de São Paulo, produto, entrada ou saída com sinal, saldo após a movimentação, motivo, descrição e número do pedido quando houver. Use os filtros de produto e tipo e a paginação de 50 registros.

Para reposição, escolha **Compra / reposição**, informe o produto, a quantidade e uma descrição. Produtos por peso usam gramas: 10 kg = 10.000 g. Produtos por unidade usam peças inteiras. Para perdas ou conferências, escolha **Ajuste manual** e **Entrada** ou **Saída**. O sistema rejeita saldo negativo, frações, limites excedidos e uma medida que tenha mudado desde a consulta.

Pedidos novos do site não geram baixa nem reserva. Ao confirmar, pagar ou entregar um pedido que ainda não teve baixa, todos os itens são descontados e registrados na mesma transação. Vendas presenciais pagas baixam imediatamente. Cancelamentos devolvem somente itens com baixa registrada; reaberturas voltam a consumir estoque na confirmação, pagamento ou entrega. Cancelar duas vezes não devolve nem registra duas vezes. Pedidos que falham não deixam baixa ou registros parciais. Alterar o estoque no cadastro do produto também registra a diferença como **Ajuste no cadastro**; alterar apenas custo, foto ou descrição não cria movimentação de estoque.

Na primeira inicialização após a atualização, o banco recebe um **Saldo inicial** com o estoque real existente. Não se reconstrói o histórico anterior. Reiniciar não repete esses registros. Ao mudar a forma de venda, cada medida mantém seu próprio saldo e não há conversão automática.

O histórico permanece quando um pedido ou produto é excluído. Os novos cadastros e pedidos não reutilizam IDs presentes nesse histórico. A exclusão de um pedido continua sem devolver estoque: cancele antes, se a intenção for devolver seus itens.

## Custo, lucro e margem

Em **Produtos**, informe **Custo por kg (R$)** ou **Custo por unidade (R$)**. O custo é opcional: vazio significa desconhecido e zero significa custo zero informado. Ao trocar a forma de venda, confira o custo da nova medida. A prévia e a tabela mostram custo, venda normalizada por kg/unidade, lucro bruto estimado e margem. A prévia também mostra o efeito da Terça do Granel nos produtos participantes.

- **Lucro bruto estimado** = preço de venda − custo dos produtos.
- **Margem bruta** = lucro bruto ÷ preço de venda × 100.
- Exemplo: custo R$ 28/kg e venda R$ 49/kg resultam em R$ 21/kg de lucro bruto e margem de aproximadamente 42,86%.
- A margem fica sem valor quando a venda é zero. Vendas abaixo do custo mostram prejuízo estimado.

São estimativas antes de frete, embalagens, impostos, taxas e demais despesas. Custos e margens são privados do painel e não aparecem no catálogo ou na mensagem de WhatsApp.

Cada novo item de pedido guarda o custo da porção ou unidade no momento da compra, com arredondamento para centavos por porção. Alterações futuras de custo não recalculam pedidos antigos. Descontos reduzem o valor vendido, mantendo o custo registrado.

O dashboard mostra lucro bruto estimado do dia e do mês e margem bruta do mês. Usa os mesmos períodos e a mesma regra de vendas existente: pedidos pagos ou entregues, pela data de criação e no horário de São Paulo. Só entram no cálculo os pedidos com custo informado em todos os itens. Pedidos sem custo completo são identificados e contabilizados separadamente, sem receber custo zero fictício. Pedidos antigos mantêm custo desconhecido.

## Implementação e verificação

A atualização adiciona `products.cost_cents`, `order_items.cost_cents` e a tabela `stock_movements`, sem alterar preços, estoque ou pedidos existentes. O custo do produto usa a referência de 1 kg ou 1 unidade; o custo do item de pedido corresponde à sua porção ou unidade original.

As consultas e inclusões de movimentações ficam em `/api/admin/stock-movements` e exigem a sessão administrativa. Não há alteração ou exclusão individual de lançamentos; correções são novas movimentações.

Os testes usam bancos temporários e verificam migração, autenticação, privacidade, custos desconhecidos/zerados, arredondamento, descontos, histórico persistente, exclusões, concorrência e reversão de transações com falha. O teste de navegador verifica formulários, prévia, filtros, estoque negativo, dashboard e responsividade nos dois temas.
