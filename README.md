# Chatbot de Denúncias - Sprint 4 (Node.js + Dialogflow)

Este projeto consiste em um chatbot de denúncias completo, utilizando Google Dialogflow ES para a interface de conversa (NLP) e um backend Node.js (hospedado no Render) para orquestração, lógica de negócio, integrações e persistência de dados.

## Integrantes

* (Nickolas Ferraz - RM558458)
* (Marcos Paolucci - RM554941)
* (Sandron Oliveira - RM557172)
* (Paulo Carvalho - RM554562)
* (Lorena Bauer - RM555272)
* (Herbertt di Franco - RM556640)

---

## 1. Como Testar o Fluxo Completo

Existem 3 fluxos principais que podem ser testados:

### Fluxo 1: Abertura de Nova Denúncia

1.  **Usuário:** Diga "Olá" ou "Oi".
2.  **Bot:** Pedirá seu e-mail.
3.  **Usuário:** Forneça seu e-mail (ex: `teste@gmail.com`).
4.  **Bot:** Pedirá para escolher uma opção (`1:Restaurante`, `2:Clínica`, `3:Suporte`).
5.  **Usuário:** Digite `3` ou `Suporte`.
6.  **Bot:** Pedirá seu nome.
7.  **Usuário:** Forneça seu nome (ex: `Meu Nome`).
8.  **Bot:** Pedirá a descrição do problema.
9.  **Usuário:** Descreva a denúncia (ex: "Vi o funcionário com CPF 123.456.789-00...").
10. **Bot:** Pedirá a prioridade (`Alta`, `Média`, `Baixa`).
11. **Usuário:** Forneça a prioridade (ex: `Alta`).
12. **Bot:** Pedirá a data do ocorrido.
13. **Usuário:** Forneça a data (ex: `25/12/2025` ou `ontem`).
14. **Bot:** Pedirá a UF do ocorrido.
15. **Usuário:** Forneça a UF (ex: `sp`).
16. **Bot:** Processará tudo e retornará a mensagem de sucesso com o número do protocolo (ex: `SUP-20251030-XXXXX`).

### Fluxo 2: Consulta de Status (Item 1.b)

1.  **Usuário:** Diga "Quero consultar meu status" ou "verificar protocolo".
2.  **Bot:** Pedirá o número do protocolo (graças à entidade `protocolo-entity`).
3.  **Usuário:** Forneça o protocolo completo (ex: `SUP-20251030-XXXXX`).
4.  **Bot:** Consultará o banco Postgres e retornará o status (ex: "O status do seu protocolo... é: Revisão Pendente.").

### Fluxo 3: Anonimização de Dados (Item 3.c)

1.  **Usuário:** Diga "Quero excluir meus dados" ou "apagar denúncia".
2.  **Bot:** Pedirá o número do protocolo.
3.  **Usuário:** Forneça o protocolo completo (ex: `SUP-20251030-XXXXX`).
4.  **Bot:** Executará um `UPDATE` no banco Postgres e retornará a confirmação (ex: "Processo concluído. Os dados... foram permanentemente anonimizados.").

---

## 2. Arquitetura e Integrações Usadas

* **NLP/NLU:** Google Dialogflow ES.
* **Backend:** Node.js (Express) hospedado no **Render**.
* **Banco de Denúncias (Item 1.d):** **PostgreSQL** (hospedado no Render) para os dados operacionais (protocolos, status, UF, etc.).
* **Banco de Logs (Item 1.d):** **MongoDB** (hospedado no Atlas) para logs estruturados de observabilidade.
* **Notificações (Item 1.a / 1.c):** **SendGrid API** para envio de e-mails de confirmação ao usuário e alertas para a equipe antifraude.

---

## 3. Configuração (`.env.example`)

Para rodar este projeto, as seguintes variáveis de ambiente são necessárias. Crie um arquivo `.env` na raiz do projeto com base neste exemplo:

```.env
# Banco de Dados Operacional (Postgres - Usar a URL INTERNA no Render)
DATABASE_URL=postgres://usuario:senha@host-interno:5432/nomedobanco

# Banco de Dados de Logs (MongoDB Atlas)
MONGO_URI=mongodb+srv://usuario:senha@cluster.mongodb.net/

# API de E-mails
SENDGRID_API_KEY=SG.sua-chave-api-aqui

# E-mail da Equipe de Risco (para onde vão os alertas)
ANTIFRAUDE_EMAIL=email-da-equipe@empresa.com

# Credenciais de Segurança do Webhook (Item 3.b)
WEBHOOK_USER=meu_usuario_secreto
WEBHOOK_PASS=minha_senha_secreta
```

--- 

## 4. Configuração de Segurança e Políticas (Item 3.b)

Esta seção detalha o "Pacote de Configuração" de segurança implementado.

### 4.1. Variáveis de Ambiente (`.env.example`)
As seguintes variáveis de ambiente são necessárias para a operação do serviço. O arquivo `.env.example` na raiz do projeto serve como template.

* `DATABASE_URL`: String de conexão para o banco de dados **PostgreSQL** (operacional).
* `MONGO_URI`: String de conexão para o banco de dados **MongoDB Atlas** (logs).
* `SENDGRID_API_KEY`: Chave de API para o serviço de e-mail SendGrid.
* `ANTIFRAUDE_EMAIL`: E-mail da equipe de risco que recebe alertas de alta prioridade.
* `WEBHOOK_USER`: Nome de usuário para a autenticação do webhook.
* `WEBHOOK_PASS`: Senha para a autenticação do webhook.

### 4.2. Política de Autenticação de Webhooks
* **Método:** Autenticação Básica (`Basic Auth`).
* **Implementação:** O Dialogflow é configurado (em `Fulfillment > Headers`) para enviar as credenciais `WEBHOOK_USER` e `WEBHOOK_PASS`.
* **Proteção:** O backend (`index.js`) usa o middleware `checkAuth`, que intercepta **todas** as requisições. Ele decodifica o cabeçalho `Authorization` e o compara com as variáveis de ambiente. Requisições sem credenciais válidas são bloqueadas com um erro `401 Unauthorized` e logadas no MongoDB.

### 4.3. Política de Rate-Limit
* **Método:** Limitação de taxa por IP, usando a biblioteca `express-rate-limit`.
* **Implementação:** O middleware `limiter` é aplicado a **todas** as rotas do servidor.
* **Política:** A política definida no `index.js` é: **100 requisições a cada 15 minutos por IP**.
* **Proteção:** Se um IP exceder esse limite, ele receberá uma resposta `429 Too Many Requests` e a tentativa será logada como um erro de "RateLimit" no MongoDB, protegendo o servidor contra ataques de negação de serviço (DoS) básicos.

---

## 5. Regras de Risco e Política de Privacidade

### Regras de Risco e Escalonamento (Item 2.a)

* A regra de risco é definida pelo parâmetro **`prioridade`** coletado pelo bot.
* Se `prioridade` for `Alta`:
    1.  O status inicial da denúncia no Postgres é definido como **"Revisão Pendente"** (criando a fila de human-in-the-loop).
    2.  Uma notificação de alerta imediata (Item 1.c) é enviada via SendGrid para o e-mail definido em `ANTIFRAUDE_EMAIL`.
* Se a `prioridade` for `Média` ou `Baixa`, o status inicial é **"Recebido"** e nenhum alerta é enviado.

### Política de Privacidade e Anonimização (Item 3.c)

* **Mascaramento de PII:** Dados sensíveis (CPF/CNPJ) encontrados na conversação são mascarados (ex: `123.***.***-00`) ANTES de serem salvos nos logs do **MongoDB**. Os dados permanecem completos no **Postgres** (operacional) e nos e-mails (para a equipe de revisão).
* **Direito ao Esquecimento:** O processo é iniciado pela intent `excluir-dados`. O backend executa um `UPDATE` no Postgres, substituindo dados pessoais (`nome`, `email`, `descricao`, `titulo`, `uf`) pelo valor literal `[ANONIMIZADO]`. Esta ação é irreversível.

---

## 6. Metas de Qualidade e Painel (Seção 4)

* **Metas (Piloto):**
    * Taxa de Fallback (Fallback Rate): `< 15%`
    * Taxa de Preenchimento (Slot Fill): `> 85%`
    * SLA de Notificação (Alta Prioridade): `< 5 minutos`

* **Painel de Monitoramento (Item 4.c):**
    * (O painel será criado no Google Looker Studio, conectando-se ao banco de dados PostgreSQL).
    * *Link do Painel:* `(Link a ser adicionado)`