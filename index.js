// index.js
const express = require('express');
const app = express();
const sgMail = require('@sendgrid/mail');
const { Pool } = require('pg'); // <-- NOVO: Importa a biblioteca do Postgres

// Carrega as variáveis de ambiente
require('dotenv').config();

// --- CONFIGURAÇÃO DO SENDGRID ---
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// --- CONFIGURAÇÃO DO BANCO DE DADOS (POSTGRES) ---
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
      rejectUnauthorized: false // Necessário para conexões com o Render
    }
});

/**
 * [NOVO] Cria a nossa tabela "denuncias" se ela ainda não existir.
 * Isso roda toda vez que o servidor inicia.
 */
async function inicializarBanco() {
    const createTableQuery = `
    CREATE TABLE IF NOT EXISTS denuncias (
        id SERIAL PRIMARY KEY,
        protocolo VARCHAR(100) NOT NULL UNIQUE,
        nome VARCHAR(255) NOT NULL,
        email VARCHAR(255),
        descricao TEXT,
        status VARCHAR(50) DEFAULT 'Recebido',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    `;
    try {
        await pool.query(createTableQuery);
        console.log("Banco de dados inicializado. Tabela 'denuncias' pronta.");
    } catch (err) {
        console.error("Erro ao inicializar o banco de dados:", err);
    }
}


// Middleware para interpretar o corpo (body) da requisição como JSON
app.use(express.json());
const PORT = process.env.PORT || 3000;

// --- FUNÇÕES AUXILIARES DA SPRINT 4 ---

function gerarProtocolo() {
    const data = new Date();
    const ano = data.getFullYear();
    const mes = (data.getMonth() + 1).toString().padStart(2, '0');
    const dia = data.getDate().toString().padStart(2, '0');
    const aleatorio = Math.floor(10000 + Math.random() * 90000);
    return `SUP-${ano}${mes}${dia}-${aleatorio}`;
}

/**
 * [ITEM 1.a REALIZADO] Envia o ticket/denúncia por e-mail usando SendGrid.
 */
async function enviarTicketPorEmail(dadosTicket) {
    console.log("--- INICIANDO ENVIO DE E-MAIL VIA SENDGRID (Item 1.a) ---");
    const msg = {
        from: { email: 'ct.sprint4@gmail.com', name: 'Bot de Suporte' },
        to: ['ct.sprint4@gmail.com', dadosTicket.email],
        subject: `Novo Chamado: ${dadosTicket.protocolo} - ${dadosTicket.descricao.substring(0, 30)}...`,
        html: `
        <h3>Novo Chamado Aberto via Chatbot</h3>
        <ul>
            <li><strong>Protocolo:</strong> ${dadosTicket.protocolo}</li>
            <li><strong>Cliente:</strong> ${dadosTicket.nome}</li>
            <li><strong>E-mail do Cliente:</strong> ${dadosTicket.email}</li>
        </ul><hr><h4>Descrição do Problema</h4><p>${dadosTicket.descricao}</p>`
    };
    try {
        await sgMail.send(msg);
        console.log("E-mail enviado com sucesso via SendGrid!");
        return true;
    } catch (error) {
        console.error("Erro ao enviar e-mail pelo SendGrid:", error.response.body);
        return false;
    }
}

/**
 * [ITEM 1.d REALIZADO] Salva o núcleo da denúncia no banco de dados Postgres.
 */
async function salvarNoBancoPostgres(dadosTicket) {
    console.log("--- INICIANDO SALVAMENTO NO POSTGRES (Item 1.d) ---");
    
    const query = `
        INSERT INTO denuncias (protocolo, nome, email, descricao)
        VALUES ($1, $2, $3, $4)
        RETURNING id;
    `;
    const valores = [
        dadosTicket.protocolo,
        dadosTicket.nome,
        dadosTicket.email,
        dadosTicket.descricao
    ];

    try {
        const res = await pool.query(query, valores);
        console.log(`Dados salvos no banco! ID da nova denúncia: ${res.rows[0].id}`);
        return true;
    } catch (err) {
        console.error("Erro ao salvar no banco de dados:", err);
        return false;
    }
}

// --- ROTA PRINCIPAL DO WEBHOOK ---
app.post('/webhook', async (req, res) => {
    console.log('Requisição recebida do Dialogflow:');
    const intentName = req.body.queryResult.intent.displayName;

    if (intentName === 'AbrirChamadoSuporte') {
        try {
            // 1. Extrair dados
            const nomeParam = req.body.queryResult.parameters.nome;
            const nome = (nomeParam && nomeParam.name) ? nomeParam.name : (nomeParam || 'Não informado');
            const descricaoProblema = req.body.queryResult.parameters.descricao_problema;
            let email = 'Não informado';
            const contextoEmail = req.body.queryResult.outputContexts.find(ctx => ctx.parameters && ctx.parameters.email);
            if (contextoEmail) {
                email = contextoEmail.parameters.email;
            }

            // 2. Validar
            if (!nomeParam || !descricaoProblema) {
                return res.json({ fulfillmentMessages: [{ text: { text: ['Parece que o seu nome ou a descrição do problema não foram informados. Por favor, tente novamente.'] } }] });
            }

            // 3. Lógica de negócio
            const protocolo = gerarProtocolo();
            const dadosTicket = { protocolo, nome, email, descricao: descricaoProblema };

            // 4. Integrações (AGORA AS DUAS SÃO REAIS!)
            const salvoNoBanco = await salvarNoBancoPostgres(dadosTicket); // <-- MUDOU
            const emailEnviado = await enviarTicketPorEmail(dadosTicket);
            
            // 5. Resposta
            if (emailEnviado && salvoNoBanco) {
                const mensagemConfirmacao = `Ok, ${nome}! Seu chamado sobre "${descricaoProblema}" foi aberto com sucesso. O número do seu ticket é ${protocolo}. Uma confirmação foi enviada para ${email}.`;
                return res.json({ fulfillmentMessages: [{ text: { text: [mensagemConfirmacao] } }] });
            } else {
                throw new Error("Falha ao salvar no banco ou enviar e-mail.");
            }
        } catch (error) {
            console.error("Erro ao processar o webhook:", error);
            return res.json({ fulfillmentMessages: [{ text: { text: ['Desculpe, ocorreu um erro interno ao processar seu chamado. Nossa equipe já foi notificada. Por favor, tente mais tarde.'] } }] });
        }
    } else {
        return res.json({ fulfillmentMessages: [{ text: { text: [`Desculpe, não consegui processar sua solicitação. A intent "${intentName}" não é tratada por este webhook.`] } }] });
    }
});

// --- INICIA O SERVIDOR ---
app.listen(PORT, () => {
    console.log(`Servidor do webhook rodando na porta ${PORT}`);
    // [NOVO] Chama a função para criar a tabela assim que o servidor ligar
    inicializarBanco();
});
