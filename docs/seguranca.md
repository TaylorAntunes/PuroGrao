# Segurança dos pedidos e do painel

## Pedidos do site

O cliente salva um pedido com status **novo** antes de abrir o WhatsApp. Esse registro valida o estoque disponível, mas não o reserva nem o desconta. Na aba **Pedidos**, a loja confirma a disponibilidade e muda o status para **confirmado**, **pago** ou **entregue**. Só então o estoque é baixado. Todos os itens são processados na mesma transação; falta de estoque ou mudança da forma de venda impede a confirmação inteira. Pedidos anteriores que já tiveram baixa continuam com essa baixa registrada.

Cancelar um pedido com baixa devolve seus itens uma única vez. Cancelar um pedido novo não altera estoque. Reabrir como **novo** aguarda confirmação; reabrir como confirmado, pago ou entregue exige estoque suficiente. Voltar um pedido com baixa para **novo** não devolve estoque: use **cancelado** para isso. Vendas presenciais continuam sendo registradas como pagas, com baixa imediata.

O checkout gera um UUID e mantém a mesma solicitação no armazenamento da aba por até 24 horas quando há falha de comunicação. A ação **Verificar pedido anterior** recupera o pedido já salvo sem duplicá-lo, inclusive após recarregar, alterar ou esvaziar o carrinho, ou quando o catálogo remove um produto indisponível. O envio anterior precisa ser resolvido antes de enviar outro. Uma rejeição definitiva permite revisar e reenviar com outra identificação. O registro de repetição fica no SQLite, sobrevive ao reinício e impede recriar pedidos cancelados ou excluídos. Excluir o pedido remove o texto de WhatsApp desse controle, preservando apenas sua identificação e impressão digital.

Por padrão, cada IP pode criar **10 pedidos** e realizar **30 tentativas** em **15 minutos**. O limite de tentativas também conta solicitações inválidas e repetições. Ao exceder o limite, a API responde com status 429 e `Retry-After`. Estes limites aceitam ajuste pelas variáveis `ORDER_RATE_WINDOW_MS`, `ORDER_RATE_MAX_NEW`, `ORDER_RATE_MAX_ATTEMPTS` e `ORDER_RATE_MAX_IPS`.

O controle de limites fica em memória e reinicia com o processo. São acompanhados até 5.000 IPs; se a capacidade estiver ocupada, novos IPs aguardam a expiração da janela. Em uma publicação com vários processos, o limite por processo deve ser complementado por um controle compartilhado na infraestrutura. Uma rede com muitos clientes usando o mesmo IP também compartilha o limite.

## Sessões administrativas

Sair revoga a sessão no servidor e limpa tabelas, dados de clientes, formulários, métricas, fotos em edição e rascunhos privados no navegador. Respostas e tarefas iniciadas na sessão anterior são ignoradas, inclusive quando chegam depois de um novo login. Sessão expirada ou revogada exige novo login. A senha configurada não foi alterada por estas correções.

## Cabeçalhos e uso local

Todas as respostas recebem Content Security Policy, `nosniff`, bloqueio de enquadramento, política de referência e restrição de permissões do navegador. A CSP permite os scripts locais, as fontes atuais do Google, imagens locais e prévias de fotos. JavaScript inline/eval e conteúdo incorporado em frames são bloqueados. Estilos em atributos são permitidos porque o editor de imagens e os gráficos existentes dependem deles.

O padrão local é `NODE_ENV=development`, `HOST=127.0.0.1` e `TRUST_PROXY=false`. A loja continua acessível por HTTP no próprio computador. Não se instala um certificado falso e não se obriga HTTPS nessa situação.

## Publicação com HTTPS

A hospedagem precisa fornecer o certificado real e um proxy reverso HTTPS. Exemplo quando o proxy roda no mesmo servidor:

```dotenv
NODE_ENV=production
HOST=127.0.0.1
TRUST_PROXY=127.0.0.1/32,::1/128
PUBLIC_URL=https://seu-dominio.example
```

Troque a origem pelo domínio real e informe somente os IPs ou redes específicas do proxy utilizado. Ele precisa preservar `Host`, substituir os cabeçalhos encaminhados e ser o único serviço autorizado a acessar a porta interna. Nunca configure confiança irrestrita com `TRUST_PROXY=true`. Se a infraestrutura exigir outra interface em `HOST`, proteja essa porta pela rede da hospedagem.

Em produção, GET/HEAD por HTTP redirecionam para a origem HTTPS configurada. Envios de login, pedido ou alterações por HTTP são rejeitados sem processar seus dados. Sem `PUBLIC_URL`, HTTP é rejeitado; a URL configurada deve ser uma origem HTTPS sem caminho ou credenciais. Respostas HTTPS de produção incluem HSTS. Hosts diferentes da origem oficial são rejeitados.

## Verificação

Os testes automatizados usam bancos temporários e cobrem limites, repetição, confirmação atômica, cancelamentos, sessões antigas, cabeçalhos e HTTPS/proxies. `npm run preview` testa o navegador com uma loja isolada, incluindo checkout, painel, fotos e os dois temas. O banco real e a configuração local não precisam ser alterados para testar.

Na revisão de 13/10/2026, `npm run verify` aprovou **170 testes** e a sintaxe de **53 arquivos JavaScript**. `npm run preview` passou nos dois temas e nas larguras de 360, 390, 430, 768, 1024 e 1440 px, incluindo recuperação após resposta perdida com carrinho vazio, bloqueio de script inline e limpeza de dados privados após respostas atrasadas. A comparação de conteúdo das tabelas confirmou que o banco real permaneceu intacto. O servidor principal permaneceu parado.

Referências técnicas: [segurança no Express](https://expressjs.com/en/advanced/best-practice-security/), [configuração de proxies](https://expressjs.com/en/guide/behind-proxies/) e [CSP para estilos em atributos](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/style-src-attr).
