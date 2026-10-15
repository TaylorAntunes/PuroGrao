# Revisão das descrições de Chás

Data: 15/10/2026.

Foram localizados 10 produtos na categoria **Chás**. Os textos revisados e as fontes por item estão em [chas-descricoes.json](chas-descricoes.json). O conteúdo da loja vem do campo `products.description` no SQLite; a revisão altera somente esse campo, mantendo o limite de 200 caracteres do painel.

## Critérios dos textos

As descrições destacam sabor, aroma, versatilidade culinária e praticidade quando essas características estão documentadas. Não acrescentam alegações de cura, emagrecimento, detox, ação diurética, melhora da digestão, sono ou ansiedade. Também não indicam doses, frequência de consumo, pureza, ausência de cafeína ou composição não confirmada.

As páginas de [hibisco](https://twinings.co.uk/collections/hibiscus-tea) e [camomila](https://twinings.co.uk/products/pure-camomile-80-tea-bags) da Twinings apoiam somente perfis sensoriais e sugestões de apresentação. As fichas McCormick de louro, alecrim e orégano apoiam os usos culinários citados no JSON. São referências sobre ingredientes, não fichas dos fornecedores da Puro Grão; marca, origem, certificações e especificações das outras versões não foram transferidas para o catálogo.

## Particularidades do cadastro

- **Erva-doce:** [Barão](https://www.baraoshop.com/chas/chas-de-infusao/cha-infusao-de-erva-doce) e [Dr. Oetker](https://www.oetker.com.br/produtos/p/cha-de-erva-doce-10g) usam o nome popular para espécies diferentes. O texto conserva apenas características sensoriais comuns, sem afirmar espécie ou parte vegetal.
- **Espinheira-santa e cavalinha:** o cadastro não identifica espécie, ficha do fornecedor ou indicação específica. A [ReniSUS do Ministério da Saúde](https://www.gov.br/saude/pt-br/composicao/sectics/plantas-medicinais-e-fitoterapicos/plantas-medicinais-e-fitoterapicos-no-sus/tabela-renisus) e as [orientações da Anvisa](https://www.gov.br/anvisa/pt-br/centraisdeconteudo/publicacoes/medicamentos/publicacoes-sobre-medicamentos/orientacoes-sobre-o-uso-de-fitoterapicos-e-plantas-medicinais.pdf) contextualizam a necessidade de identificação; não são prova de indicação ou autorização dos produtos cadastrados. As descrições se limitam à venda a granel e às orientações do fornecedor, sem indicar infusão ou efeitos medicinais.
- **Boldo:** o [Horto Didático da UFSC](https://hortodidatico.ufsc.br/boldo-pequeno/) registra a ambiguidade do nome e o amargor. O texto descreve esse sabor, sem presumir espécie nem indicar consumo, dose ou ação no fígado/digestão.
- **Louro, alecrim e orégano:** as descrições explicam seus usos como temperos. A categoria **Chás** e os nomes existentes foram preservados.
- **Capim-cidreira:** a foto mostra uma caixa de sachês Naturais HappyLife, coerente com o [catálogo HappyLife/Junco](https://www.junco.com.br/chas-e-ervas). O [produto da Dr. Oetker](https://www.oetker.com.br/produtos/p/cha-de-capim-cidreira-15g) é referência somente para o sabor suave, sem transferir sua fórmula, advertências ou modo de preparo. O produto continua sendo vendido por unidade.
- **Hibisco:** a descrição anterior, “Flores secas. 100 g”, foi substituída para não sugerir embalagem fixa em um produto vendido pelo peso escolhido pelo cliente.

## Escopo da atualização

A alteração no banco é restrita às descrições dos 10 IDs listados no JSON, verificando nome e categoria antes de atualizar. O relatório local em `artifacts/teas-description-review/` guarda as descrições anteriores. A comparação dos registros e das demais tabelas verifica que preços, estoques, fotos, visibilidade, ordem, promoções, pedidos e produtos das outras categorias foram preservados. Não é necessário alterar HTML, CSS, JavaScript ou regras da loja.

As fichas completas do fornecedor poderão permitir textos mais específicos para espinheira-santa, cavalinha e boldo no futuro, sem atribuir benefícios de outra espécie ou versão.

## Conferência concluída

As 10 descrições foram aplicadas e correspondem ao JSON na API da loja. Os textos têm entre 110 e 151 caracteres. A verificação de integridade do SQLite retornou `ok`, e a comparação de todos os registros confirmou alterações somente nas descrições escolhidas, sem mudanças nas demais tabelas.

No Chrome, os 10 cards foram conferidos em 1440 px e 390 px, nos temas claro e escuro: todos exibem os textos completos, sem cortes, sem rolagem horizontal e sem erros de JavaScript. Como não houve alteração de código funcional, a validação ficou concentrada no conteúdo, na preservação dos dados e na exibição real da loja.
