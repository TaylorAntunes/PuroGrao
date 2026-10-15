# Funcionalidades da Puro Grão

[Voltar para a documentação principal](../README.md)

## Venda por peso ou por unidade
- No painel, em **Produtos → Forma de venda**, escolha **Por peso (gramas)** ou **Por unidade (quantidade)** para cada produto.
- Por unidade, informe o preço de uma peça e o estoque em unidades inteiras. O catálogo mostra um campo de quantidade; o carrinho permite aumentar e diminuir unidades e aceita os dois tipos juntos.
- Produtos existentes continuam por peso, preservando preço, estoque e pedidos. A mudança de medida não converte automaticamente o estoque: confira o valor e a quantidade na nova medida antes de salvar.
- Pedidos guardam a medida original. Cancelamentos devolvem o estoque nessa medida uma única vez; reabrir exige a mesma forma de venda do pedido e estoque suficiente.
- Kits podem misturar peso e unidades. Ao alterar a forma de venda de um produto, os kits afetados ficam fora da vitrine até serem revisados e salvos. Carrinhos com a medida antiga são ajustados para o cliente escolher novamente.
- A API de produtos aceita `sale_unit: "weight"` com `stock_grams` e `price_weight_grams`, ou `sale_unit: "unit"` com `stock_units`. Itens por unidade no pedido enviam `sale_unit: "unit"`, `qty` e `weight_grams: 0` (ou omitem o peso). Produtos por peso mantêm o formato anterior.

## Estoque
- A vitrine atualiza estoque, preços, fotos e destaques enquanto a página está visível. O carrinho ajusta as porções que excedem o estoque e avisa o cliente antes de um novo envio.
- O painel mostra um gráfico de barras dos produtos com até 3 kg (3.000 g) ou 3 unidades, conforme a forma de venda, incluindo os esgotados e os ocultos. Cada barra mostra a proporção até esse limite. O gráfico acompanha alterações dos produtos e status de pedidos. Use **Atualizar estoque** para consultar novas vendas e **Editar** para repor um produto.
- Para produtos por peso, informe o estoque em gramas inteiras. Por exemplo, 5 kg = 5.000 g. Cadastre o preço junto com o peso de referência: R$ 24 por 400 g, R$ 18 por 100 g ou um preço por 1 kg. Para produtos por unidade, informe a quantidade de peças e o preço de uma unidade.
- Produtos novos começam com estoque zero. Informe as quantidades reais antes de receber pedidos; a migração acontece automaticamente na próxima inicialização e preserva os estoques e dados existentes.
- O cliente escolhe 100 g, 250 g, 500 g, 1 kg ou um peso personalizado de 1 a 100.000 gramas. A loja calcula o preço proporcional, arredondando cada porção para centavos, e permite até 99 porções por produto, limitadas ao estoque total.
- Pedidos do site iniciam como **novo**: o servidor valida a disponibilidade e salva os valores da época, sem baixar nem reservar estoque. A baixa ocorre na mesma transação ao mudar para **confirmado**, **pago** ou **entregue**. Se faltar qualquer item ou sua forma de venda tiver mudado, nenhum produto é descontado e o status permanece anterior. Vendas presenciais pagas continuam baixando estoque imediatamente.
- Cancelar devolve o estoque uma única vez, somente quando houve baixa. Reabrir como **novo** não baixa estoque; confirmar, pagar ou entregar baixa novamente com a medida original e estoque suficiente. Um pedido que já teve baixa mantém seus itens consumidos ao voltar para **novo**; para devolvê-los, cancele.
- Pedidos anteriores à implantação do estoque não devolvem unidades ao cancelar, pois não tiveram baixa. Confirmação, pagamento ou entrega passam a baixar estoque quando essa baixa ainda não existe. Pedidos antigos com baixa registrada mantêm esse controle.
- Envios públicos têm limites por IP e uma identificação única para evitar duplicação se a resposta se perder. Reenviar o mesmo pedido recupera o registro existente. Pedidos cancelados ou excluídos não são recriados por esse reenvio. Consulte o [guia de segurança](seguranca.md).
- Produtos com histórico de pedidos devem ser ocultados, em vez de excluídos, para preservar o controle de estoque.
- Produtos por peso exigem `stock_grams` (inteiro não negativo) e `price_weight_grams` (inteiro de 1 a 100.000), além do preço em reais. Produtos por unidade exigem `stock_units` (inteiro não negativo). O limite de compra é de 99 unidades ou porções por produto.

## Promoções e destaques
- As seções **Mais vendidos**, **Novidades** e **Kits prontos** aparecem na Home somente quando têm itens. Se todas as seções de destaque estiverem vazias, o espaço delas também fica oculto. Elas voltam a aparecer automaticamente quando há conteúdo disponível.
- No cadastro ou na edição, marque **Aplicar 20% de desconto na Terça do Granel** nos produtos por peso escolhidos. Produtos por unidade ficam fora dessa promoção. O desconto se ativa automaticamente às terças-feiras, das 0h às 23h59, no fuso `America/Sao_Paulo`. Os outros produtos mantêm o preço normal. Produtos existentes começam fora da promoção.
- A Terça do Granel é um desconto no preço do produto, mantendo sua categoria original. Na terça, o catálogo exibe o preço anterior riscado e o preço com 20% de desconto; nos outros dias, exibe o preço normal. Esses produtos não entram na seção nem na página de Ofertas. A seção Ofertas aparece somente quando há outras ofertas ativas.
- Marque **Destacar em ✨ Novidades** para incluir um produto nessa seção. A Home mostra até quatro novidades, com os cadastros mais recentes primeiro.
- **🔥 Mais vendidos** mostra até quatro produtos presentes no maior número de pedidos pagos ou entregues; o número de porções desempata. Pedidos novos, apenas confirmados e cancelados não entram nessa contagem. Produtos ocultos não aparecem na Home.
- O servidor aplica o desconto ao preço proporcional antes de arredondar cada porção para centavos e salva esse valor no pedido. Alterações de promoção não mudam pedidos anteriores. A loja confere os preços a cada minuto enquanto a página está visível; no envio, uma mudança de total pede nova revisão sem salvar o pedido nem descontar o estoque.
- As APIs administrativas aceitam `tuesday_promo` e `is_new` como booleanos. Omitir os campos na edição preserva a seleção. O catálogo mantém `price_cents` como preço original e informa `discount_percent`, `best_seller_rank` e `promotion`. Pedidos da loja enviam `expected_total_cents`, que o servidor valida antes de confirmar a compra.

## Compartilhamento, busca, dashboard e banner
- Cada produto tem **Compartilhar**, que abre o WhatsApp para escolher o destinatário. A mensagem inclui nome, preço da porção selecionada, peso, desconto ativo e link direto para o produto. O link abre o catálogo normal, posiciona a tela no produto e permite revisar os preços atuais. O botão também funciona em `/ofertas`.
- A busca reconhece acentos, partes de palavras, pequenas trocas de letras e grafias como **psilium → psyllium**. Todas as palavras da consulta precisam combinar com o produto. Nome e categoria aceitam aproximações; a descrição também pode ser encontrada por correspondência exata. O produto precisa estar cadastrado e visível.
- A aba inicial **Visão geral** mostra vendas do dia e mês, ticket médio do mês, pedidos do dia e mês, pendentes, cancelados, cinco produtos mais vendidos no mês e estoque baixo. Vendas e ticket incluem apenas pedidos **pagos ou entregues**, pela **data de criação do pedido**, no fuso `America/Sao_Paulo`. O ticket é o total vendido dividido pelo número desses pedidos. A quantidade de pedidos inclui todos os status, com pendências e cancelamentos identificados.
- Os mais vendidos são ordenados pelo número de pedidos pagos ou entregues, com porções como desempate. O gráfico mostra também valor vendido e peso conhecido; pedidos antigos sem peso continuam entrando no faturamento e na contagem. As métricas consideram o histórico completo, mesmo que a lista de pedidos mostre apenas os 200 mais recentes. Cancelamentos e alterações de produtos atualizam o dashboard; a aba aberta consulta os dados a cada minuto e tem **Atualizar painel**.
- Em **Banner da Home**, defina título, descrição, texto e link opcional do botão. Confira a prévia, marque **Mostrar banner na Home** e clique em **Salvar banner** para publicar. Desmarque e salve para ocultar, mantendo o conteúdo para uso posterior. O banner começa desativado, fica salvo no SQLite e pode apontar para `/ofertas`, `#produtos` ou um endereço http/https. A Home aberta verifica atualizações a cada minuto enquanto está visível.
- O banner é um aviso editorial: descontos continuam sendo calculados pelas regras dos produtos. Os endpoints `/api/admin/dashboard` e `/api/admin/banner` exigem login, e somente o banner ativo é enviado no catálogo público.

## Kits, entrega grátis e ofertas do dia
- O botão **Esvaziar carrinho**, acima dos itens, remove todo o pedido de uma vez e atualiza subtotal, quantidade e progresso do frete grátis. Ele aparece quando o carrinho tem itens e fica desabilitado durante o envio do pedido.
- O carrinho acompanha alterações recebidas de outras abas da loja e da página de ofertas. Durante o envio, as porções e os dados do pedido ficam bloqueados até a resposta; adições recebidas de outra aba são preservadas.
- Na aba **Kits** do painel, escolha um nome ou use os modelos Kit Temperos, Kit Chás, Kit Café da Manhã, Kit Fibras e Kit Sementes. Defina os produtos, os pesos de cada porção e as quantidades, depois salve. Os modelos não publicam composições inventadas: a loja mostra apenas kits configurados e visíveis.
- O preço do kit é a soma das porções, com os descontos ativos de cada produto. Adicionar um kit inclui esses itens no carrinho juntos e respeita o estoque, o limite de 99 porções por produto e 50 linhas no pedido. A baixa e a devolução de estoque seguem as regras normais dos produtos; alterar um kit não muda pedidos anteriores. Kits com algum produto oculto saem da vitrine.
- Use descrições de ingredientes, sabores e sugestões de preparo. Os nomes e textos de exemplo não prometem tratamento de doenças, efeitos médicos ou emagrecimento.
- Entregas em **Maracanaú** têm **frete grátis a partir de R$ 50**, considerando o subtotal após descontos. O carrinho mostra quanto falta e permite escolher entrega em Maracanaú, outra cidade ou retirada. Outros fretes são combinados com a loja. O servidor calcula e salva a condição de entrega no pedido e a inclui no WhatsApp e no painel.
- A página inicial também tem uma barra compacta e centralizada no rodapé da tela, com subtotal, número de itens (unidades e porções), progresso para os R$ 50 e botão **Ver pedido**. Ela acompanha adições, remoções e mudanças de quantidade e fica oculta enquanto o carrinho está aberto.
- A seção **Ofertas** da Home e a página **/ofertas** excluem os produtos selecionados para a **Terça do Granel**. Eles continuam no catálogo normal, com desconto automático às terças, inclusive no carrinho e nos kits. Sem outras ofertas ativas, a seção da Home fica oculta e a página apresenta uma mensagem com acesso ao catálogo.
- A contagem regressiva de Ofertas não exibe o prazo da Terça do Granel. A atualização da promoção e dos preços continua usando os horários enviados pelo servidor; o envio do pedido continua validando o total no servidor.

## Migração para venda por peso
- A migração automática mantém os preços e usa o peso indicado na descrição como referência. Se não houver peso, adota 1 kg; confira esses produtos no painel.
- Estoques anteriores em unidades são convertidos para gramas usando esse peso de referência. Não há reposição fictícia: estoques zerados continuam zerados.
- Pedidos antigos mantêm valores e descrições. As baixas anteriores são convertidas para gramas para permitir cancelamento correto. Pedidos sem baixa continuam sem devolver estoque ao cancelar.
- Produtos novos usam 1 kg como referência inicial no formulário. Você pode alterar o peso de referência.
- As duas logomarcas enviadas estão em `public/images/`. A foto de capa é uma imagem ilustrativa criada com a habilidade [imagegen](C:/Users/taylor/.codex/skills/.system/imagegen/SKILL.md).

## Fotos dos produtos
- No cadastro ou na edição de um produto, use **Foto do produto** para escolher um arquivo PNG, JPEG ou WebP de até 5 MB. A prévia aparece antes de salvar.
- Você pode substituir ou remover a foto. Editar os outros campos sem escolher uma nova imagem mantém a foto atual; sem foto, a loja mostra a ilustração padrão.
- A prévia permite ajustar a posição horizontal e vertical e usar **Centralizar imagem** para voltar ao centro. Escolha **Mostrar a imagem inteira** para evitar cortes ou **Preencher o espaço** para ocupar todo o cartão. O enquadramento é salvo e aplicado na loja, inclusive ao editar uma foto existente.
- As fotos ficam no próprio SQLite, junto com os produtos, e acompanham o backup do banco. A migração adiciona os campos automaticamente na próxima inicialização.
- As APIs de cadastro e edição aceitam `image_data_url` com a imagem em data URL/base64. Na edição, omitir o campo preserva a imagem e enviar `null` a remove. Os catálogos retornam apenas `image_url`, sem os arquivos binários.
- O enquadramento usa `image_position_x` e `image_position_y` (inteiros de 0 a 100; centro = 50) e `image_fit` (`cover` ou `contain`). Omitir esses campos na edição preserva a posição; fotos existentes começam centralizadas.
- Na loja, cada produto exibe o estoque disponível em gramas ou quilos, incluindo indicação de estoque zero.
