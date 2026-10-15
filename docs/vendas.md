# Histórico de vendas

A aba **Vendas** reúne os pedidos que a loja registra automaticamente quando o cliente finaliza o pedido no site. Os pedidos já existentes aparecem no histórico; não é necessário cadastrá-los outra vez.

O filtro de origem começa em **Site**. Para consultar também os atendimentos da loja, selecione **Todas as origens** ou **Presencial**. A aba **Vendas presenciais** continua sendo o local para registrar uma venda realizada na loja.

## Consultar os registros

Use a busca por número do pedido, cliente ou telefone, os filtros de status e origem e o intervalo de datas. As datas seguem o horário de São Paulo e incluem os dias inicial e final. A paginação permite consultar registros antigos sem limitar o histórico aos últimos 200 pedidos.

Abra os detalhes para conferir os produtos, pesos ou unidades, valores da época, dados do cliente e observações. Os valores e custos guardados na venda são preservados mesmo se o produto for editado depois. Quando houver produtos sem custo cadastrado, o lucro estimado fica identificado como indisponível.

Clique em **Atualizar** para consultar os registros mais recentes. Trocar de aba e retornar a **Vendas** também atualiza o histórico e mantém os filtros escolhidos.

## Faturamento e status

O resumo considera todos os registros que correspondem aos filtros, inclusive os que estão em outras páginas. O faturamento confirmado e o ticket médio usam somente pedidos **pagos** ou **entregues**. Pedidos **novos** ou **confirmados** permanecem pendentes; pedidos **cancelados** continuam no histórico e não entram no faturamento.

O pedido enviado pelo site inicia com status **novo**, sem baixa ou reserva de estoque. A finalização pelo WhatsApp não confirma o pagamento automaticamente. Atualize o status na aba **Pedidos** conforme o atendimento: **confirmado**, **pago** ou **entregue** validam a disponibilidade e baixam os itens, se ainda não houve baixa. Se faltar algum produto, a alteração falha sem baixa parcial. Cancelar devolve somente estoque que tenha sido baixado.

A aba **Vendas** consulta os registros existentes. Ela não altera preços, estoque, pedidos ou regras de cancelamento. Pedidos excluídos definitivamente na aba **Pedidos** deixam de aparecer, conforme o comportamento existente.

## Implementação

O histórico usa a rota privada `GET /api/admin/sales-history`, com filtros e paginação. A rota exige login administrativo e não grava dados no banco. Os testes utilizam bancos temporários.
