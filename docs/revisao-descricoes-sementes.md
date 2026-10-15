# Revisão das descrições de Sementes

Data: 15/10/2026.

Foram localizados 5 produtos na categoria **Sementes**: linhaça dourada, chia, linhaça marrom, girassol e abóbora. Os textos e as fontes por produto estão em [sementes-descricoes.json](sementes-descricoes.json). A loja exibe o campo `products.description` do SQLite, com limite atual de 200 caracteres no painel.

## Critérios e fontes

Os textos destacam versatilidade na cozinha, sabor e textura, sem promessas de cura, emagrecimento, saciedade, ação intestinal ou prevenção de doenças. Também não acrescentam declarações de teor de fibras, proteínas ou ômega-3, ausência de glúten/lactose, origem, pureza, certificações ou segurança para pessoas com alergias sem confirmação do fornecedor da loja.

- As fichas oficiais Vitalin de [linhaça dourada](https://loja.vitalin.com.br/produtos/linhaca-dourada-graos-sem-gluten-vitalin-120g/), [linhaça marrom](https://loja.vitalin.com.br/produtos/linhaca-marrom-graos-sem-gluten-vitalin-120g/) e [chia](https://loja.vitalin.com.br/produtos/chia-graos-sem-gluten-vitalin-120g/) apoiam usos culinários comuns. São referências sobre ingredientes, não fichas dos produtos Puro Grão. A ficha da linhaça marrom traz uma linha inconsistente de ingredientes; esse trecho não foi aproveitado.
- A receita própria Nestlé de [pudim de chia](https://www.receitasnestle.com.br/receitas/pudim-de-chia-com-uva-passa) apoia a textura obtida após hidratação. Não foram copiados doses, proporções, tempos ou ingredientes da receita para a descrição do produto.
- As receitas próprias Nestlé de [pão com sementes de girassol e abóbora](https://www.receitasnestle.com.br/receitas/receita-pao-aveia-nestle-iogurte-nestle-sem-farinha) e [pão com sementes de abóbora](https://www.receitasnestle.com.br/receitas/receita-pao-minuto-airfryer-brocolis-aveia) apoiam as sugestões culinárias. As fotos ilustrativas já cadastradas foram inspecionadas, sem tratá-las como confirmação de processamento, sal, torra ou ausência de casca.

As sementes não foram confundidas com as farinhas ou os óleos de outras categorias. Na linhaça dourada, a descrição anterior “Rica em fibras. 250 g” foi substituída para não sugerir embalagem fixa nem afirmar teor nutricional sem a ficha do produto a granel. A descrição genérica anterior da chia também foi substituída.

## Escopo da atualização

Somente `products.description` dos IDs 3, 10, 34, 35 e 36 é alterado, após conferir nome e categoria. O relatório em `artifacts/seeds-description-review/` guarda as descrições anteriores. A comparação de todos os registros e demais tabelas verifica a preservação de preços, estoques, fotos, nomes, categorias, ordem, visibilidade, promoções, pedidos e produtos das outras categorias.

Não é necessário alterar HTML, CSS, JavaScript, backend ou regras de negócio para exibir esses textos.

## Conferência concluída

As 5 descrições foram aplicadas e correspondem ao JSON na API da loja. Os textos têm entre 141 e 156 caracteres. A verificação de integridade do SQLite retornou `ok`; a comparação dos registros e das demais tabelas confirmou alterações somente nas descrições escolhidas.

No Chrome, os 5 cards foram conferidos em 1440 px e 390 px, nos temas claro e escuro: textos completos, sem cortes, sem rolagem horizontal e sem erros de JavaScript. Como não houve alteração de código funcional, a validação se concentrou no conteúdo, na preservação dos dados e na exibição real da loja.
