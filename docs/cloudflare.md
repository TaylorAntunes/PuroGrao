# Publicar a Puro Grão no Cloudflare Workers

O projeto mantém Express, as páginas e as APIs existentes. No computador, `npm start` continua usando `loja.db`. Na Cloudflare, um Durable Object com SQLite guarda o catálogo, fotos, pedidos, estoque e configurações. O nome do objeto e a migração `v1` são permanentes: não renomeie `ShopDatabase` nem `puro-grao-store-v1` para atualizar o código.

## Campos da tela de criação

Envie primeiro os arquivos desta adaptação ao repositório GitHub que você conectou à Cloudflare. O banco e a exportação ficam fora do Git.

| Campo | Preenchimento |
| --- | --- |
| Project name | `purograo` |
| Build command | Deixe vazio. O `build.command` de `wrangler.jsonc` prepara as imagens, páginas, scripts e estilos automaticamente. |
| Deploy command | `npm run deploy:cloudflare` |
| Enable Preview builds | Desativado inicialmente. |
| Protect with Cloudflare Access | Desativado para a loja pública. O painel mantém seu login. |
| Root directory | A raiz do repositório, onde estão `package.json` e `wrangler.jsonc`. |
| API token | Pode manter a criação automática da Cloudflare. |
| Build variables / Variable value | Não precisa colocar dados da loja aqui. São diferentes das variáveis de execução abaixo. |

Use Node.js 24 no ambiente de build (`NODE_VERSION=24`, se precisar escolher a versão nas configurações avançadas). A instalação usa o `package-lock.json`; Wrangler está nas dependências de desenvolvimento.

O comando de deploy do projeto executa Wrangler com o modo de compilação Node, necessário para as dependências atuais do Express. Use esse comando também nas atualizações automáticas pelo GitHub.

O primeiro deploy cria o banco persistente vazio. Até a importação terminar, a API retorna 503 e não aceita pedidos; ela não cria produtos de exemplo. As páginas e os arquivos visuais já podem ser acessados.

## Variáveis de execução

Depois de criar o Worker, abra **Settings → Variables and Secrets** do Worker e cadastre estes valores como **Secret**. Assim o próximo deploy do Wrangler também preserva a configuração.

| Nome | Valor |
| --- | --- |
| `ADMIN_PASSWORD` | A senha escolhida para o painel publicado. A senha do servidor local permanece independente. |
| `WHATSAPP_NUMBER` | O WhatsApp real da loja, com país e DDD e somente dígitos. |
| `IMPORT_TOKEN` | Um token aleatório exclusivo para a migração. Guarde uma cópia para executar o importador local. |
| `PUBLIC_URL` | A origem HTTPS oficial, por exemplo `https://purograo.seu-subdominio.workers.dev`, sem caminhos. Pode ser cadastrada depois de conhecer o endereço. |

`ENVIRONMENT=production` já está no arquivo de configuração. Não cadastre `DB_FILE`, `PORT`, `HOST` ou `TRUST_PROXY` no Worker: a entrada Cloudflare cuida da execução e dos headers recebidos da borda.

Para gerar um token no PowerShell, use `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. Copie-o para o secret `IMPORT_TOKEN`; ele não é a senha do painel. Depois de alterar secrets, aplique a alteração no Worker conforme a tela da Cloudflare.

Também é possível configurar secrets pelo terminal com `npx wrangler secret put ADMIN_PASSWORD` e repetir o comando para os demais nomes. Esse comando pede o valor sem colocá-lo nos argumentos do processo.

## Levar os dados atuais para o site

1. Instale as dependências com `npm ci`.
2. Pouco antes da publicação definitiva, evite novos cadastros ou vendas locais e gere uma exportação atualizada:

   ```powershell
   npm.cmd run cloudflare:export
   ```

3. Confira o endereço oficial e importe:

   ```powershell
   npm.cmd run cloudflare:import -- --url https://SEU-ENDERECO.workers.dev
   ```

   Cole o `IMPORT_TOKEN` quando solicitado. Em automação, forneça `IMPORT_TOKEN` como variável de ambiente; ele nunca deve ir no endereço ou no arquivo de exportação.

4. O resultado deve mostrar `ready: true`, a mesma sessão e as contagens esperadas. Confira a loja e o painel no endereço publicado.
5. Remova o secret `IMPORT_TOKEN` das variáveis do Worker depois de conferir a migração. Sem ele, as rotas de importação ficam desativadas.

O arquivo padrão é `artifacts/cloudflare-data.jsonl`. Ele contém dados reais, inclusive fotos e eventuais dados de clientes; está ignorado pelo Git e nunca entra nos assets públicos. A exportação usa uma transação de leitura consistente, inclusive com WAL, sem modificar o banco da loja.

Se a conexão cair, repita **o mesmo comando com o mesmo arquivo**. As linhas já importadas são reconhecidas. O importador só ativa a loja depois de conferir contagens e hashes de todas as tabelas e fotos. Um banco já ativado não pode ser sobrescrito por esse importador.

Outros comandos:

```powershell
npm.cmd run cloudflare:status -- --url https://SEU-ENDERECO.workers.dev
npm.cmd run cloudflare:export -- --db caminho\outro.db --out artifacts\outra-exportacao.jsonl
```

Após a migração, o banco local e o da Cloudflare são independentes. Faça os cadastros e vendas no painel publicado. Atualizações de código não apagam o banco da Cloudflare; não é necessário reimportar a cada deploy. Uma troca de domínio também não exige trocar o nome do banco.

## Executar e validar no computador

```powershell
npm.cmd run verify
npm.cmd run check:cloudflare
npm.cmd run test:cloudflare
```

`check:cloudflare` compila com `wrangler deploy --dry-run`, sem publicar. `test:cloudflare` usa o runtime real do Workers em Miniflare e bancos temporários. O teste não usa `loja.db`.

Para abrir o simulador no navegador:

```powershell
Copy-Item .dev.vars.example .dev.vars
npm.cmd run dev:cloudflare
```

Edite `.dev.vars` com credenciais de teste. Importe uma exportação no endereço local informado pelo Wrangler, usando o mesmo token do arquivo `.dev.vars`. O simulador também começa sem dados de exemplo. O armazenamento local do Wrangler fica em `.wrangler/`; ele não é o banco publicado nem o banco de `npm start`.

## O que a adaptação preserva

- URLs da loja, painel, ofertas e APIs.
- Venda por peso/unidade, cálculos de preço e custos.
- Promoções de terça-feira no horário de São Paulo, kits e banner.
- Frete grátis para Maracanaú a partir de R$ 50 após descontos.
- Checkout pelo WhatsApp, idempotência, pedidos e vendas presenciais.
- Baixa e devolução de estoque em transações, movimentações e relatórios.
- Fotos originais, sem redimensionamento; imagens grandes usam blocos internos de 256 KiB para respeitar o limite de registro.
- Sessões de até 12 horas e limites de tentativas persistentes entre reinícios. Trocar a senha publicada revoga as sessões anteriores.

Os limites de armazenamento e uso dependem do plano Cloudflare. O catálogo exportado nesta adaptação tem aproximadamente 242 MB de fotos. Monitore o uso do Durable Object no painel da hospedagem; a exportação inicial não substitui uma rotina de backup dos dados criados depois da publicação.

## Arquivos principais

| Arquivo | Responsabilidade |
| --- | --- |
| `wrangler.jsonc` | Worker, assets, compatibilidade Node e criação do banco. |
| `cloudflare/worker.mjs` | Entrada HTTP, segurança, encaminhamento Express e banco persistente. |
| `cloudflare/sqlite-adapter.cjs` | SQL síncrono, transações e fotos em blocos. |
| `cloudflare/persistent-map.cjs` | Sessões e limites persistentes. |
| `cloudflare/importer.cjs` | Importação autenticada, retomável e verificada. |
| `src/database-schema.js`, `src/transactions.js` | Mesmo esquema e transações nos dois ambientes. |
| `scripts/build-cloudflare.cjs` | Publica somente os arquivos de `public/` e `shared/`. |
| `scripts/cloudflare-data.cjs` | Exportação e importação dos dados. |
| `scripts/cloudflare-check.cjs` | Verificação do runtime Cloudflare em ambiente temporário. |

Referências oficiais: [Express em Workers](https://developers.cloudflare.com/workers/tutorials/deploy-an-express-app/), [SQLite dos Durable Objects](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), [limites](https://developers.cloudflare.com/durable-objects/platform/limits/) e [configuração do Wrangler](https://developers.cloudflare.com/workers/wrangler/configuration/).

## Validação desta adaptação

- Compilação Wrangler com `--dry-run`, sem deploy remoto.
- Testes automatizados de regras existentes, banco, imagens, importação e estado persistente.
- Chrome: loja e painel em 360, 390, 430, 768, 1024 e 1440 px, nos dois temas; carrinho, checkout, busca, kits, banner, pedidos, estoque e vendas presenciais.
- Runtime Workers/Miniflare: 10 grupos de integração com login, HTTPS, pedidos, vendas presenciais, rollback, fotos grandes, reinício e troca de senha.
- Exportação real: 173 produtos, 232 movimentações e a sequência SQLite; 406 linhas importadas em banco temporário. As 128 fotos tiveram seus hashes SHA-256 integrais conferidos, totalizando 241.666.933 bytes originais. O commit e o reinício passaram sem erro de memória ou timeout.

O banco local não foi modificado e não houve publicação. A próxima etapa é enviar os arquivos de código ao GitHub, criar o Worker, configurar seus secrets e importar a exportação atualizada no endereço definitivo.
