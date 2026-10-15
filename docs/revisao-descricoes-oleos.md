# Revisão das descrições de Óleos

Data: 15/10/2026.

O catálogo atual tem 34 produtos na categoria **Óleos**. Todos receberam descrição. O conteúdo exibido na loja vem de `products.description` no SQLite, e não de uma lista fixa no JavaScript. Os textos revisados e as fontes por produto estão em [oleos-descricoes.json](oleos-descricoes.json). As descrições têm até 200 caracteres, respeitando o limite atual do painel.

Foram preparados textos comerciais curtos com a finalidade, o uso cosmético ou aromático identificado e benefícios discretos, como maciez, brilho, toque emoliente ou aroma. Não foram acrescentadas alegações contra doenças, dor, inflamação, fungos, queda de cabelo, cicatrizes ou envelhecimento. A Anvisa diferencia a finalidade cosmética de alegações terapêuticas; essa distinção orientou a revisão. [Referência da Anvisa](https://bibliotecadigital.anvisa.gov.br/jspui/handle/anvisa/8137).

## Evidências utilizadas

- **Fattore:** fichas oficiais de [coco e abacate](https://www.fattorecosmeticos.com.br/products/fattore-oleo-capilar-coco-e-abacate-100ml), [argan e rosa mosqueta](https://www.fattorecosmeticos.com.br/products/fattore-oleo-capilar-argan-e-rosa-mosqueta-100ml) e [babosa e amêndoa doce](https://www.fattorecosmeticos.com.br/products/fattore-oleo-capilar-babosa-e-amendoa-doce-100ml). A descrição de coco usa maciez, brilho e alinhamento, sem transferir automaticamente todas as alegações das outras versões.
- **Flora Pura:** fichas de [hortelã](https://www.florapura.com.br/oleos/essenciais/oleo-essencial-de-hortela) e [eucalipto](https://www.florapura.com.br/oleos/essenciais/oleo-essencial-de-eucalipto). A versão de hortelã descrita no site é diluída em base vegetal; não foi apresentada como pura.
- **Vegetal do Brasil:** ficha oficial do [óleo vegetal de rosa mosqueta](https://www.vegetaldobrasilonline.com/produto/oleo-vegetal-de-rosa-mosqueta-30ml), usada apenas para cuidado cosmético e hidratação da pele, sem inferir a fórmula da versão cadastrada.
- **Méldica:** fichas específicas de produto na MF Distribuidora, identificadas no JSON. Trata-se de uma fonte comercial de distribuição; o site do fabricante não pôde ser consultado. Foram usados somente cuidados cosméticos simples, sem reproduzir alegações terapêuticas de revendas.
- **NH New Hair:** [descrição da versão capilar na Drogasil](https://www.drogasil.com.br/belkit-nh-new-hair-oleo-capilar-tratamento-multifuncional-60ml-621306.html), conferida com a embalagem da foto do óleo multifuncional. É uma fonte comercial de revenda.
- **Fotos já cadastradas:** usadas para identificar marca, tipo de produto e finalidade visível na embalagem. A existência de um ingrediente não foi tratada como prova de benefício clínico. Onde o rótulo identifica um cosmético, o texto se limita a funções cosméticas básicas, sem alegar fórmula, concentração, pureza ou resultado garantido.

## Particularidades do cadastro

- **Gotinha** é uma loção hidratante para os pés da Bell Corpus, identificada na foto e confirmada pelo usuário. A descrição usa hidratação, maciez e suavização da aspereza. Não foram aproveitadas alegações sobre fungos, micoses, fissuras ou calos.
- **Extrato de propolis verde** tem rótulo de suplemento alimentar Commel. O texto descreve essa finalidade e não o apresenta como óleo cosmético nem promete benefícios imunológicos.
- **Óleo capilar alecrim**, ID 101, tem uma foto de óleo essencial Saudável Naturais. O texto segue o tipo indicado nessa foto, sem recomendar aplicação capilar direta. O nome cadastrado foi preservado.
- **Óleo de andibora**, ID 148, tem embalagem identificada como andiroba Méldica. A descrição usa a identificação da foto; o nome cadastrado foi preservado.
- Algumas embalagens Flora Pura dizem expressamente **diluído** ou **com óleo vegetal**. Não foram chamadas de óleos puros e não receberam dosagens inventadas.

## Confirmações do usuário e limites das fontes

O usuário identificou a Gotinha como loção hidratante para os pés Bell Corpus, informou uso externo/cosmético para copaíba e hortelã Commel e confirmou uso alimentar e cosmético para coco 180 ml e coco extravirgem Vicoco. Para abóbora sem marca e sucupira, babosa e semente de uva Saudável Naturais, orientou apresentar somente uso externo/cosmético enquanto o rótulo específico não confirmar indicação alimentar.

Essa orientação foi registrada como informação do usuário, sem ser apresentada como verificação do fabricante. A marca do coco 180 ml e a composição/concentração desses oito itens não foram confirmadas. Seus textos são mais gerais: não indicam dosagens, aplicação direta de concentrados, tratamento, pureza ou benefícios específicos sem evidência. Não foi copiada a descrição de outra marca para preencher essa lacuna. Rótulos completos podem permitir descrições mais específicas em uma revisão futura.

## Aplicação e conferência

A atualização é restrita ao campo `description` dos IDs revisados, com a condição de continuarem na categoria **Óleos** e com o mesmo nome. As descrições anteriores foram guardadas em relatório local em `artifacts/oils-description-review/`. Antes de confirmar a transação, a comparação dos registros garante que preços, estoques, fotos, ordem, visibilidade, pedidos, movimentações e produtos de outras categorias permaneçam intactos. HTML, CSS e as regras da loja não precisam ser alterados.

Conferência concluída: as 34 descrições cadastradas correspondem ao JSON e estão disponíveis na API da loja. O maior texto tem 168 caracteres. O SQLite retornou `ok` na verificação de integridade. A comparação dos registros e das demais tabelas confirmou que somente as descrições escolhidas foram alteradas.

No Chrome, os 34 cards de Óleos foram conferidos em 1440 px e 390 px, nos temas claro e escuro: textos completos, sem cortes, sem rolagem horizontal e sem erros de JavaScript. Não houve alteração de código funcional; a verificação ficou concentrada no conteúdo, na integridade dos dados e na exibição real da loja.
