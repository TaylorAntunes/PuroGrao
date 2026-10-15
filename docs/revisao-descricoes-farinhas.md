# Revisão das descrições de Farinhas

Data: 15/10/2026.

Foram localizados 12 produtos na categoria **Farinhas**, todos inicialmente sem descrição. Os textos e as fontes consultadas estão em [farinhas-descricoes.json](farinhas-descricoes.json). O conteúdo exibido na loja vem de `products.description` no SQLite, com limite atual de 200 caracteres no painel.

## Critérios da revisão

Os textos destacam usos na cozinha, praticidade, sabor e textura quando documentados. Não apresentam promessas de cura, emagrecimento, detox, tratamento intestinal, efeitos hormonais ou melhora do desempenho físico. Não acrescentam doses nem declarações de teor nutricional, ausência de glúten/lactose, pureza, origem ou segurança para pessoas com alergias sem confirmação do produto cadastrado.

As fontes sobre outras marcas e pesquisas de ingredientes apoiam somente usos culinários comuns; não são tratadas como fichas técnicas dos produtos da Puro Grão. Suas fórmulas, advertências, processos e certificações não foram copiados.

## Fontes e decisões por grupo

- **Beterraba:** pesquisa da [UNIARP](https://periodicos.uniarp.edu.br/index.php/ries/article/view/158) sobre aplicação em sobremesas e estudo da [UTFPR](https://repositorio.utfpr.edu.br/jspui/bitstream/1/13361/4/MD_COALM_2015_2_01.pdf) sobre pães apoiam o uso para variar receitas e cor, sem atribuir às farinhas da loja a composição das amostras estudadas.
- **Psyllium:** ficha do [fabricante Vitalin](https://loja.vitalin.com.br/produtos/psyllium-sem-gluten-vitalin-100g/) e receita da Jasmine indicada no JSON apoiam uso na textura e estrutura de massas. Não foi recomendado tomar o pó seco nem adotar doses da outra marca.
- **Aveia e linhaças:** as fichas oficiais Vitalin registradas no JSON apoiam as sugestões de pães, bolos, massas, panquecas e vitaminas. As declarações de ausência de glúten e valor nutricional das versões Vitalin não se aplicam automaticamente ao catálogo da loja.
- **Guaraná e maca peruana:** fichas oficiais Unilife apoiam uso em preparações e bebidas. No guaraná, foi mantida somente a informação de presença natural de cafeína, sem quantificar teor ou indicar dose. Para maca, não há promessas hormonais, sexuais ou de fertilidade.
- **Fibra de maçã:** a página comercial Magna Vita é uma referência de revenda, usada somente para combinações alimentares comuns. Foram descartadas suas promessas de emagrecimento e efeitos sobre colesterol, assim como doses e dados nutricionais.
- **Gengibre:** ficha oficial McCormick apoia aroma, picância e usos doces e salgados, sem transferir composição, certificações ou alegações de saúde.
- **Semente de abóbora:** receitas documentadas pela UFRJ e pelo Sesc, indicadas no JSON, apoiam usos em pães, biscoitos, omeletes e massas; resultados clínicos e doses do estudo não foram transferidos.
- **Uva:** publicações da Embrapa indicadas no JSON apoiam aplicações em panificação e iogurtes. Não foram acrescentadas promessas antioxidantes, antienvelhecimento ou de prevenção de doenças.

## Moringa: identificação e finalidade a revisar

A Anvisa [reafirmou em setembro de 2026](https://www.gov.br/anvisa/pt-br/assuntos/noticias-anvisa/2026/anvisa-proibe-produtos-com-moringa-oleifera) que a segurança de **Moringa oleifera** em alimentos não foi comprovada. O [registro oficial referente à proibição de alimentos com o ingrediente](https://bibliotecadigital.anvisa.gov.br/jspui/handle/anvisa/2915) também foi consultado.

O cadastro e a imagem ilustrativa dizem apenas “moringa em pó”, sem confirmar espécie, fornecedor ou finalidade. Por isso, a descrição não recomenda ingestão nem mistura em receitas e orienta esclarecer a identificação e finalidade com a loja. Esse item exige revisão com o fornecedor. Não foi criada uma alegação de benefício para preencher a falta de informação.

## Escopo da atualização

Somente o campo `description` dos 12 IDs listados no JSON é alterado no banco, após conferir nome e categoria. O relatório em `artifacts/flours-description-review/` guarda as descrições anteriores. A comparação dos registros e das demais tabelas verifica a preservação de preços, estoques, fotos, nomes, categorias, ordem, visibilidade, promoções, pedidos e descrições de outras categorias, incluindo Óleos e Chás.

HTML, CSS, JavaScript, backend, endpoints e regras de negócio não precisam ser modificados para exibir os textos.

## Conferência concluída

As 12 descrições foram aplicadas e correspondem ao JSON na API da loja. Os textos têm entre 125 e 150 caracteres. A verificação de integridade do SQLite retornou `ok`, e a comparação dos registros e das demais tabelas confirmou alterações somente nas descrições escolhidas.

No Chrome, os 12 cards foram conferidos em 1440 px e 390 px, nos temas claro e escuro: textos completos, sem cortes, sem rolagem horizontal e sem erros de JavaScript. A validação se concentrou no conteúdo, na preservação dos dados e na exibição real da loja, pois não houve alteração de código funcional.
