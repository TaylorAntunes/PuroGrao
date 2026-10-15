# Vendas presenciais

A aba **Vendas presenciais** permite registrar os produtos vendidos no atendimento da loja. Cada confirmação cria uma venda com status **pago**, baixa o estoque e atualiza o faturamento, o ticket médio, os mais vendidos e o lucro bruto estimado.

## Registrar uma venda

1. Encontre o produto pela busca ou pela categoria.
2. Para produtos por peso, informe gramas inteiras: 250 g = 250; 1 kg = 1.000. Para produtos por unidade, informe a quantidade de peças ou pacotes.
3. Adicione os produtos à venda e confira as quantidades e o total. Você pode remover itens antes de registrar.
4. Se desejar, informe o nome do cliente e as observações.
5. Selecione a forma de pagamento: Pix, dinheiro, cartão ou outro.
6. Registre a venda após receber o pagamento.

Ao digitar na busca, os produtos encontrados aparecem abaixo do campo. A busca ignora acentos e aceita palavras fora de sequência: “óleo sucupira” encontra “Óleo de sucupira”. Clique em um resultado para escolher o produto e depois informe a quantidade e adicione à venda. O filtro de categoria continua sendo respeitado.

A forma de pagamento é um registro do atendimento. Os produtos usam os preços cadastrados e a promoção vigente: a Terça do Granel continua aplicando 20% somente às terças-feiras, no horário de São Paulo, aos produtos por peso selecionados no painel. Produtos por unidade mantêm seu preço normal.

O atendimento presencial também permite selecionar produtos ocultos no catálogo do site. A indicação de produto oculto continua visível no painel. O estoque disponível é compartilhado com os pedidos do site: a venda só é confirmada se todos os itens estiverem disponíveis.

## Histórico e cancelamento

A seção mostra as últimas 50 vendas presenciais e seus itens, valores, forma de pagamento e status. Elas também aparecem em **Pedidos**, identificadas como vendas presenciais.

Ao cancelar uma venda, os itens retornam ao estoque na medida original e o dashboard deixa de contabilizá-la como faturamento. O histórico de estoque registra a venda e o cancelamento. Repetir o cancelamento não duplica a devolução.

O custo e o preço de cada item são guardados no momento da venda. Alterações posteriores no cadastro não mudam esses valores. Se algum item não tiver custo informado, o lucro bruto dessa venda permanece desconhecido, conforme a regra existente do dashboard.

## Conferência e tentativas de registro

O servidor valida preços, medidas e estoque novamente ao registrar. Se algum deles mudar durante o atendimento, confira a venda atualizada antes de confirmar outra vez.

Cada venda recebe uma identificação única para impedir duplicação quando uma resposta se perde. Quando o resultado de um registro fica incerto, use a ação de verificar o registro antes de iniciar outra venda. O reenvio da mesma venda usa a mesma identificação e não baixa o estoque novamente.

A operação aguardando confirmação permanece salva na sessão da aba, inclusive ao recarregar a página. Abra **Vendas presenciais** e use **Verificar registro** para recuperá-la. Sair da conta encerra essa recuperação. Se o navegador bloquear o armazenamento da sessão, o painel orienta manter a aba aberta até concluir a verificação.

## Implementação

As rotas privadas `GET /api/admin/sales` e `POST /api/admin/sales` exigem a sessão administrativa. O registro de venda, os itens, seus custos e as movimentações de estoque são gravados na mesma transação.

As migrações adicionam a origem da venda, a forma de pagamento e o controle de identificação única. Produtos, preços, estoques, fotos e pedidos anteriores são preservados. Os testes utilizam bancos temporários.
