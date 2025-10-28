// index.js
const express = require('express');
const app = express();
const sgMail = require('@sendgrid/mail');
const { Pool } = require('pg');

require('dotenv').config();

// --- CONFIGURAÇÃO DO SENDGRID ---
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// --- CONFIGURAÇÃO DO BANCO DE DADOS (POSTGRES) ---
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
      rejectUnauthorized: false
    }
});

// --- [ALTERADO] --- Função de inicialização do banco mais robusta
async function inicializarBanco() {
    const client = await pool.connect(); // Pega uma conexão do pool
    try {
        // Passo 1: Garante que a tabela exista
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
        await client.query(createTableQuery);
        console.log("Tabela 'denuncias' verificada/criada.");

        // Passo 2: Verifica se a coluna 'prioridade' já existe
        const checkColumnQuery = `
        SELECT column_name FROM information_schema.columns 
        WHERE table_name='denuncias' AND column_name='prioridade';
        `;
        const result = await client.query(checkColumnQuery);

        // Passo 3: Se a coluna não existir, adiciona
        if (result.rows.length === 0) {
            console.log("Coluna 'prioridade' não encontrada. Adicionando à tabela...");
            const addColumnQuery = `ALTER TABLE denuncias ADD COLUMN prioridade VARCHAR(50);`;
            await client.query(addColumnQuery);
            console.log("Coluna 'prioridade' adicionada com sucesso!");
        } else {
            console.log("Coluna 'prioridade' já existe.");
        }

        console.log("Banco de dados inicializado e schema atualizado.");

    } catch (err) {
        console.error("Erro ao inicializar ou atualizar o schema do banco de dados:", err);
    } finally {
        client.release(); // Libera a conexão de volta para o pool
    }
}

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
            <li><strong>Prioridade:</strong> ${dadosTicket.prioridade}</li>
        </ul><hr><h4>Descrição do Problema</h4><p>${dadosTicket.descricao}</p>`
    };
    try {
        await sgMail.send(msg);
        console.log("E-mail de confirmação enviado com sucesso!");
        return true;
    } catch (error) {
        console.error("Erro ao enviar e-mail de confirmação:", error?.response?.body || error);
        return false;
    }
}

// --- [NOVO] --- Função para o Item 1.c
async function enviarNotificacaoAntifraude(dadosTicket) {
    console.log("--- INICIANDO NOTIFICAÇÃO PARA EQUIPE ANTIFRAUDE (Item 1.c) ---");
    const emailEquipe = process.env.ANTIFRAUDE_EMAIL;

    if (!emailEquipe) {
        console.error("Variável de ambiente ANTIFRAUDE_EMAIL não definida. Notificação não enviada.");
        return false;
    }

    const msg = {
        from: { email: 'ct.sprint4@gmail.com', name: 'Bot Alerta de Risco' },
        to: emailEquipe,
        subject: `ALERTA: Nova Denúncia de ALTA PRIORIDADE - Protocolo: ${dadosTicket.protocolo}`,
        html: `
        <h3>ALERTA DE ALTA PRIORIDADE</h3>
        <p>Uma nova denúncia classificada como alta prioridade foi registrada e requer atenção imediata.</p>
        <ul>
            <li><strong>Protocolo:</strong> ${dadosTicket.protocolo}</li>
            <li><strong>Denunciante:</strong> ${dadosTicket.nome}</li>
            <li><strong>E-mail:</strong> ${dadosTicket.email}</li>
            <li><strong>Prioridade:</strong> ${dadosTicket.prioridade}</li>
        </ul><hr><h4>Descrição da Denúncia</h4><p>${dadosTicket.descricao}</p>`
    };
    try {
        await sgMail.send(msg);
        console.log(`Notificação de alta prioridade enviada para ${emailEquipe}!`);
        return true;
    } catch (error) {
        console.error("Erro ao enviar notificação de alta prioridade:", error?.response?.body || error);
        return false;
    }
}

async function salvarNoBancoPostgres(dadosTicket) {
    console.log("--- INICIANDO SALVAMENTO NO POSTGRES (Item 1.d) ---");
    // --- [ALTERADO] --- Query agora inclui a coluna 'prioridade'
    const query = `
        INSERT INTO denuncias (protocolo, nome, email, descricao, prioridade)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id;
    `;
    const valores = [
        dadosTicket.protocolo,
        dadosTicket.nome,
        dadosTicket.email,
        dadosTicket.descricao,
        dadosTicket.prioridade // --- [ALTERADO] --- Adicionado novo valor
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
    const intentName = req.body.queryResult.intent.displayName;

    if (intentName === 'AbrirChamadoSuporte') {
        try {
            // --- [ALTERADO] --- Extrai o novo parâmetro 'prioridade'
            const parameters = req.body.queryResult.parameters;
            const nomeParam = parameters.nome;
            const nome = (nomeParam && nomeParam.name) ? nomeParam.name : (nomeParam || 'Não informado');
            const descricaoProblema = parameters.descricao_problema;
            const prioridade = parameters.prioridade; // <-- NOVO

            let email = 'Não informado';
            const contextoEmail = req.body.queryResult.outputContexts.find(ctx => ctx.parameters && ctx.parameters.email);
            if (contextoEmail) {
                email = contextoEmail.parameters.email;
            }

            const protocolo = gerarProtocolo();
            const dadosTicket = { protocolo, nome, email, descricao: descricaoProblema, prioridade };

            // --- [NOVO] --- Lógica de Notificação do Item 1.c
            if (prioridade && prioridade.toLowerCase() === 'alta') {
                await enviarNotificacaoAntifraude(dadosTicket);
            }
            
            // --- [ALTERADO] --- Continua o fluxo normal
            const salvoNoBanco = await salvarNoBancoPostgres(dadosTicket);
            const emailEnviado = await enviarTicketPorEmail(dadosTicket);
            
            if (emailEnviado && salvoNoBanco) {
                const mensagemConfirmacao = `Ok, ${nome}! Sua denúncia foi registrada com sucesso sob o protocolo ${protocolo}. Uma confirmação foi enviada para ${email}.`;
                return res.json({ fulfillmentMessages: [{ text: { text: [mensagemConfirmacao] } }] });
            } else {
                throw new Error("Falha ao salvar no banco ou enviar e-mail de confirmação.");
            }
        } catch (error) {
            console.error("Erro ao processar webhook (AbrirChamadoSuporte):", error);
            return res.json({ fulfillmentMessages: [{ text: { text: ['Desculpe, ocorreu um erro interno. Nossa equipe já foi notificada.'] } }] });
        }
    
    } else if (intentName === 'consultar-status') {
        const protocolo = req.body.queryResult.parameters.protocolo;
        if (!protocolo || protocolo.trim() === '') {
            return res.json({ fulfillmentMessages: [{ text: { text: ['Não entendi o número do protocolo. Poderia repetir?'] } }] });
        }
        try {
            const query = 'SELECT status FROM denuncias WHERE protocolo = $1';
            const result = await pool.query(query, [protocolo]);
            let responseText = '';
            if (result.rows.length > 0) {
                responseText = `O status do seu protocolo ${protocolo} é: ${result.rows[0].status}.`;
            } else {
                responseText = `Não foi possível encontrar uma denúncia com o protocolo ${protocolo}. Por favor, verifique o número e tente novamente.`;
            }
            return res.json({ fulfillmentMessages: [{ text: { text: [responseText] } }] });
        } catch (error) {
            console.error('Erro ao consultar o banco (consultar-status):', error);
            return res.json({ fulfillmentMessages: [{ text: { text: ['Ocorreu um erro ao consultar o status. Tente novamente mais tarde.'] } }] });
        }
    } else {
        return res.json({ fulfillmentMessages: [{ text: { text: [`Intent "${intentName}" não tratada por este webhook.`] } }] });
    }
});

// --- INICIA O SERVIDOR ---
app.listen(PORT, () => {
    console.log(`Servidor do webhook rodando na porta ${PORT}`);
    inicializarBanco();
});