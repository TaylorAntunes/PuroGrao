# Revisão das descrições de Temperos

Data: 15/10/2026.

Foram localizados 13 produtos na categoria **Temperos**, todos inicialmente sem descrição. Os textos e as fontes por produto estão em [temperos-descricoes.json](temperos-descricoes.json). A loja exibe `products.description` do SQLite, com limite atual de 200 caracteres no painel.

## Critérios e fontes

Os textos destacam sabor, aroma, cor, praticidade e sugestões culinárias. Não acrescentam promessas medicinais, emagrecimento, efeitos digestivos, benefícios de minerais ou declarações nutricionais. Não há estimativas de sódio nem afirmações de ausência de glúten, lactose, sal, conservantes ou alérgenos sem a ficha do fornecedor.

- **Edu Guedes e Ana Maria:** referências comerciais Grupo Rocha Saúde e Grão Forte, indicadas no JSON, apoiam usos em receitas. A primeira foi consultada pelo resultado de pesquisa, pois a abertura integral não estava disponível. Não foram copiadas as fórmulas nem sugeridos vínculos com chefs ou apresentadores.
- **Páprica doce, cúrcuma, colorau, pimenta-do-reino, sal rosa e Lemon Pepper:** fichas oficiais Kitano indicadas no JSON apoiam perfis sensoriais e aplicações culinárias. Suas fórmulas, certificações, origem e advertências não são atribuídas aos produtos da Puro Grão.
- **Páprica defumada:** fichas oficiais McCormick apoiam sabor defumado e usos em carnes, batatas, arroz e molhos, sem presumir o processo industrial do produto da loja.
- **Chimichurri:** receitas próprias Kitano de [frango grelhado](https://www.kitano.com.br/receitas/frango-grelhado-ao-chimichurri) e [pimentões recheados](https://www.kitano.com.br/receitas/kitano-pimentoes-recheados) apoiam usos culinários. A identificação com ou sem pimenta vem dos nomes já cadastrados. Não foi presumida uma lista fixa de ervas, sal ou tipo de pimenta para essas misturas.
- **Caldo de galinha:** receitas próprias Nestlé indicadas no JSON apoiam aplicações culinárias, sem transferir doses, fórmula ou formato em tablete de outra marca.
- **Alho frito:** o [fabricante ADKO](https://www.adko.com.br/blog/alho-frito/como-usar-alho-frito/) documenta usos no preparo e na finalização. Não foram atribuídos ao produto da loja seu formato, óleo ou teor de sal.

O sal rosa não foi apresentado como mais saudável que outros sais. O nome caseiro do colorau não foi tratado como prova de fabricação artesanal. Açafrão-da-terra foi descrito como cúrcuma, sem confusão com açafrão verdadeiro. As descrições não acrescentam dados de composição que precisem de confirmação do fornecedor.

## Escopo da atualização

Somente `products.description` dos IDs 37 a 48 e 50 é alterado, após conferir nome e categoria. O relatório em `artifacts/spices-description-review/` guarda as descrições anteriores. A comparação de todos os registros e demais tabelas verifica a preservação de preços, estoques, fotos, nomes, categorias, ordem, visibilidade, promoções, pedidos e produtos das outras categorias.

HTML, CSS, JavaScript, backend, endpoints e regras da loja não precisam ser alterados para exibir os textos.

## Conferência concluída

As 13 descrições foram aplicadas e correspondem ao JSON na API da loja. Os textos têm entre 125 e 156 caracteres. A verificação de integridade do SQLite retornou `ok`; a comparação dos registros e das demais tabelas confirmou alterações somente nas descrições escolhidas.

No Chrome, os 13 cards foram conferidos em 1440 px e 390 px, nos temas claro e escuro: textos completos, sem cortes, sem rolagem horizontal e sem erros de JavaScript. Como não houve alteração de código funcional, a validação se concentrou no conteúdo, na preservação dos dados e na exibição real da loja.
