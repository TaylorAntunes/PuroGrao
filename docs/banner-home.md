# Banner principal da Home

Ajustado à referência enviada, com fotografia de potes, sementes e castanhas à direita e texto à esquerda. Fundo bege no claro e verde profundo no escuro, título em DM Serif Display, chamada “Mais vida em cada escolha” e botões reais para o catálogo e ofertas.

No celular, o texto e as ações aparecem antes da fotografia. As duas versões fotográficas acompanham o tema salvo, sem alterar o script de tema ou as regras da loja.

## Arquivos

- `public/index.html`: composição do Hero e botões existentes.
- `public/css/hero.css`: estilo isolado do banner e adaptações mobile.
- `public/css/design-system.css`: tokens `--hero-*` para cores dos dois temas.
- `public/css/store.css`: remoção dos estilos substituídos do Hero anterior.
- `public/images/hero-pantry-light.jpg` e `hero-pantry-dark.jpg`: fotografias geradas, 2172 × 724 px, otimizadas em JPEG sem redimensionamento.
- `scripts/preview-check.cjs`: conferência de tema, imagens, altura e botões do banner nas seis larguras, além dos fluxos existentes.

O arquivo original `hero-natural.png` foi preservado. Nenhuma mudança no backend, preços, estoque, carrinho ou banco.

## Verificação

`npm.cmd run verify`: 73 testes passaram e 34 arquivos JavaScript tiveram a sintaxe verificada. `npm.cmd run preview`: Home e painel conferidos nos dois temas, nas larguras de 360, 390, 430, 768, 1024 e 1440 px, sem overflow horizontal. O banner também passou na conferência de imagens por tema, destinos dos botões, altura compacta no desktop e contraste de seus textos e botões.

Fotografias finais: [clara](../public/images/hero-pantry-light.jpg) e [escura](../public/images/hero-pantry-dark.jpg). Capturas do banner integrado: [claro no desktop](../artifacts/redesign-home-light-1440.png), [escuro no desktop](../artifacts/redesign-home-dark-1440.png) e [escuro no celular](../artifacts/redesign-home-dark-390.png).

## Geração das fotografias

Usada a skill [imagegen](C:/Users/taylor/.codex/skills/.system/imagegen/SKILL.md), com a ferramenta integrada. A imagem enviada orientou a versão clara; a versão escura foi uma edição da fotografia clara, preservando a composição. Títulos e botões são HTML, sem texto embutido nas fotografias.

### Prompt da versão clara

Use case: ads-marketing. Asset type: photorealistic background photograph for the LIGHT-MODE Puro Grão website hero. The attached image is a composition and lighting reference, specifically its LEFT light-mode banner. Create ONLY the photographic background, with NO lettering, NO headlines, NO buttons, NO logo, NO graphic leaves, NO watermark. Wide horizontal 3:1 landscape composition, high resolution. LEFT 42%: nearly blank warm ivory cream wall with very subtle natural paper/plaster texture and soft sunlight, spacious negative area for live HTML text. RIGHT 58%: beautiful realistic upright glass pantry jars filled with seeds, granola, nuts and herbal tea, metal lids, rustic bowls full of brazil nuts, almonds, pumpkin seeds and grains, wooden scoop and scattered natural ingredients, all resting on a pale rustic wood table. Tall jars remain fully visible in the right half, arranged at differing heights; bowls in foreground. Soft green foliage in upper-right background, golden natural side lighting, editorial food photography, welcoming and refined, sharp natural food detail. Match the warmth and subject arrangement of the supplied light reference but produce an original professional image. Gradual, organic transition from blank ivory left into detailed food scene on right, no central seam. Do not include the dark reference side. Important: absolutely no embedded text; website supplies all text and actions.

### Prompt da versão escura

Use case: lighting-weather. Asset type: DARK-MODE background photograph for the Puro Grão website hero. Edit this supplied LIGHT photograph into a matching dark companion. Preserve exactly the wide 3:1 framing, pantry jars, metal lids, nuts, seeds, herbal tea, wooden bowls, scoop, scattered ingredients, foliage and their positions. Change only the lighting and background mood. LEFT 42% must be spacious, nearly blank, deep forest charcoal green approximately #14251B, with subtle natural texture for a cream live HTML title. The rest has a deep softly blurred green foliage background and a darker warm wood table; retain luminous golden light on jar rims, appetizing warm highlights and rich natural food detail, no crushed blacks. Premium editorial natural-food photography, cozy and elegant, no neon green, no pure black. Organic smooth transition between dark empty left and golden detailed food right. Absolutely NO embedded lettering, NO handwriting, NO headlines, NO buttons, NO logos and NO watermark; all website text and buttons remain HTML. Do not produce a split comparison; output the DARK version only.


## Alternância das imagens

Somente as camadas fotográficas alternam a cada 6 segundos. Os botões permanecem fixos. A segunda imagem, Terça do Granel_ Chá Natural em Destaque.png, tem 2244 × 701px (aproximadamente 16:5), na proporção correta para o banner desktop. Ela é exibida inteira, mantendo a proporção. O banner mantém a altura original no desktop, entre 320 e 390px. A arte usa contain para evitar distorção. Durante a promoção, os botões ficam no espaço reservado abaixo de “Terça do Granel — 20% OFF”, à esquerda da arte. No celular, aparecem abaixo da imagem para manter a leitura e o tamanho confortável dos botões. No desktop, o título e a assinatura da Home ficam ocultos durante a promoção para não sobrepor os textos da arte. No celular, o texto aparece primeiro; durante a promoção, os botões ficam abaixo da imagem. O gradiente fica desativado durante a promoção. A primeira mantém as versões clara e escura existentes. public/js/hero-images.js controla apenas essa apresentação, sem alterar promoções ou preços. Movimento reduzido e página em segundo plano suspendem a reprodução. Se a arte falhar no carregamento, a fotografia inicial permanece.

O carrossel funciona somente com a troca automática a cada 6 segundos, sem bolinhas ou botão de pausa. A preferência por movimento reduzido continua respeitada.
