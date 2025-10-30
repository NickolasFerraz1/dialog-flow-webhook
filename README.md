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