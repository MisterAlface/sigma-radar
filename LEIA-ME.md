# Porcentagem de captura de Pokemons: como colocar no ar

Esta pasta é o site completo: a página com as capturas e a aba **Doações**. Na aba de doações, o Pix é gerado pelo Mercado Pago, e o ranking de top doadores se atualiza sozinho.

```
server.js          servidor (gera o Pix, recebe o aviso do Mercado Pago, monta o ranking)
index.html         o site
package.json       dependências
render.yaml        configuração pronta para o Render
```

Nenhuma senha ou token fica no código. Eles entram só nas configurações do Render (passo 3).

---

## 1. Mercado Pago: pegar o Access Token

1. Entre em **mercadopago.com.br/developers** com a conta que vai receber as doações.
2. **Suas integrações → Criar aplicação**. Escolha *Pagamentos online* e *Checkout Transparente (API)*.
3. Dentro da aplicação, abra **Credenciais de produção** e ative-as, se o painel pedir.
4. Copie o **Access Token** (começa com `APP_USR-`). Ele é a senha da sua conta para receber pagamentos: não mande para ninguém nem cole no código.
5. A conta precisa ter uma **chave Pix cadastrada no Mercado Pago**, senão o Pix não é gerado.

## 2. GitHub: subir a pasta

1. Crie um repositório (pode ser privado) em github.com.
2. Envie os arquivos desta pasta: `server.js`, `package.json`, `package-lock.json`, `render.yaml`, `.gitignore` e `index.html`.

## 3. Render: criar o site

1. No Render: **New → Web Service → conecte o repositório**.
2. Build Command: `npm install` · Start Command: `npm start` · Plano: Free.
3. Em **Environment**, adicione:

| Nome | Valor |
|---|---|
| `MP_ACCESS_TOKEN` | o Access Token do passo 1 |
| `PUBLIC_URL` | o endereço que o Render der, ex.: `https://sigma-radar.onrender.com` |
| `DONOR_FALLBACK_EMAIL` | um e-mail seu que **não** seja o da conta do Mercado Pago (usado quando o doador não informa e-mail) |
| `DONATIONS_SINCE` | data a partir da qual as doações contam, ex.: `2026-11-08` |
| `MP_WEBHOOK_SECRET` | deixe para o passo 4 |

4. Clique em **Deploy**. Quando terminar, abra o endereço e confira se o site aparece.

## 4. Mercado Pago: ligar o aviso de pagamento (webhook)

1. Na sua aplicação no Mercado Pago: **Webhooks → Configurar notificações**.
2. URL de produção: `https://SEU-SITE.onrender.com/api/webhook`
3. Evento: **Pagamentos**. Salve.
4. Copie a **Assinatura secreta** que aparece ali e coloque no Render como `MP_WEBHOOK_SECRET`. O Render vai reiniciar o site sozinho.

## 5. Testar

Faça uma doação de R$ 1 com seu nick. Em alguns segundos deve aparecer “Obrigado!” e seu nick no ranking.

---

## Bom saber

- **Render gratuito dorme** depois de 15 minutos sem visitas. O primeiro acesso depois disso demora uns 50 segundos.
- **O ranking não se perde.** Ele é remontado direto do Mercado Pago sempre que o site liga e a cada 10 minutos. Só entram pagamentos aprovados feitos por este site, e as vendas das rifas na mesma conta ficam de fora.
- Doações **anônimas** somam no total arrecadado, mas não aparecem no ranking.
- Se um Pix for **estornado**, ele sai do ranking.
- O Mercado Pago pode cobrar taxa sobre o Pix recebido. Confira no seu painel.
- **Segurança:** se o Access Token vazar, gere um novo no painel do Mercado Pago e troque no Render.
- Para atualizar os números das capturas, peça para ler o #sigma-radar de novo e trocar o `index.html`.
