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

// --- Função de inicialização do banco ---
async function inicializarBanco() {
    const client = await pool.connect(); 
    try {
        // Passo 1: Garante que a tabela exista
        const createTableQuery = `
        CREATE TABLE IF NOT EXISTS denuncias (
            id SERIAL PRIMARY KEY,
            protocolo VARCHAR(100) NOT NULL UNIQUE,
            nome VARCHAR(255) NOT NULL,
            email VARCHAR(255),
            descricao TEXT,
            status VARCHAR(50),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        `;
        await client.query(createTableQuery);
        console.log("Tabela 'denuncias' verificada/criada.");

        // Passo 2: Verifica e adiciona a coluna 'prioridade'
        const checkPrioridadeQuery = `
        SELECT column_name FROM information_schema.columns 
        WHERE table_name='denuncias' AND column_name='prioridade';
        `;
        const resPrioridade = await client.query(checkPrioridadeQuery);
        if (resPrioridade.rows.length === 0) {
            console.log("Coluna 'prioridade' não encontrada. Adicionando...");
            await client.query(`ALTER TABLE denuncias ADD COLUMN prioridade VARCHAR(50);`);
            console.log("Coluna 'prioridade' adicionada.");
        } else {
            console.log("Coluna 'prioridade' já existe.");
        }

        // Passo 3: Verifica e AJUSTA a coluna 'status' (Remove DEFAULT)
        const checkStatusQuery = `
        SELECT column_default FROM information_schema.columns 
        WHERE table_name='denuncias' AND column_name='status';
        `;
        const resStatus = await client.query(checkStatusQuery);
        if (resStatus.rows.length > 0 && resStatus.rows[0].column_default != null) {
            console.log("Coluna 'status' possui um valor DEFAULT. Removendo...");
            await client.query(`ALTER TABLE denuncias ALTER COLUMN status DROP DEFAULT;`);
            console.log("DEFAULT removido da coluna 'status'.");
        } else {
            console.log("Coluna 'status' já está configurada corretamente (sem DEFAULT).");
        }

        // Passo 4: Verifica e adiciona a coluna 'data_ocorrido'
        const checkDataQuery = `
        SELECT column_name FROM information_schema.columns 
        WHERE table_name='denuncias' AND column_name='data_ocorrido';
        `;
        const resData = await client.query(checkDataQuery);
        if (resData.rows.length === 0) {
            console.log("Coluna 'data_ocorrido' não encontrada. Adicionando...");
            await client.query(`ALTER TABLE denuncias ADD COLUMN data_ocorrido TIMESTAMP WITH TIME ZONE;`);
            console.log("Coluna 'data_ocorrido' adicionada.");
        } else {
            console.log("Coluna 'data_ocorrido' já existe.");
        }

        console.log("Banco de dados inicializado e schema atualizado.");

    } catch (err) {
        console.error("Erro ao inicializar ou atualizar o schema:", err);
    } finally {
        client.release(); 
    }
}


app.use(express.json());
const PORT = process.env.PORT || 3000;

// --- FUNÇÕES AUXILIARES ---

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
    const dataOcorridoFormatada = new Date(dadosTicket.data_ocorrido).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

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
            <li><strong>Data do Ocorrido:</strong> ${dataOcorridoFormatada}</li> 
            <li><strong>Prioridade:</strong> ${dadosTicket.prioridade}</li>
            <li><strong>Status Atual:</strong> ${dadosTicket.status}</li>
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

async function enviarNotificacaoAntifraude(dadosTicket) {
    console.log("--- INICIANDO NOTIFICAÇÃO PARA EQUIPE ANTIFRAUDE (Item 1.c) ---");
    const emailEquipe = process.env.ANTIFRAUDE_EMAIL;
    if (!emailEquipe) {
        console.error("Variável de ambiente ANTIFRAUDE_EMAIL não definida.");
        return false;
    }
    const dataOcorridoFormatada = new Date(dadosTicket.data_ocorrido).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

    const msg = {
        from: { email: 'ct.sprint4@gmail.com', name: 'Bot Alerta de Risco' },
        to: emailEquipe,
        subject: `ALERTA (Revisão Pendente): Nova Denúncia de ALTA PRIORIDADE - Protocolo: ${dadosTicket.protocolo}`,
        html: `
        <h3>ALERTA DE ALTA PRIORIDADE (REVISÃO PENDENTE)</h3>
        <p>Uma nova denúncia classificada como alta prioridade foi registrada e marcada como "Revisão Pendente".</p>
        <ul>
            <li><strong>Protocolo:</strong> ${dadosTicket.protocolo}</li>
            <li><strong>Denunciante:</strong> ${dadosTicket.nome}</li>
            <li><strong>E-mail:</strong> ${dadosTicket.email}</li>
            <li><strong>Data do Ocorrido:</strong> ${dataOcorridoFormatada}</li>
            <li><strong>Prioridade:</strong> ${dadosTicket.prioridade}</li>
            <li><strong>Status:</strong> ${dadosTicket.status}</li>
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
    console.log(`--- INICIANDO SALVAMENTO NO POSTGRES (Item 1.d) --- Status: ${dadosTicket.status}`);
    
    const query = `
        INSERT INTO denuncias (protocolo, nome, email, descricao, prioridade, status, data_ocorrido)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id;
    `;
    const valores = [
        dadosTicket.protocolo,
        dadosTicket.nome,
        dadosTicket.email,
        dadosTicket.descricao,
        dadosTicket.prioridade,
        dadosTicket.status,
        dadosTicket.data_ocorrido
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
            const parameters = req.body.queryResult.parameters;
            const nomeParam = parameters.nome;
            const nome = (nomeParam && nomeParam.name) ? nomeParam.name : (nomeParam || 'Não informado');
            const descricaoProblema = parameters.descricao_problema;
            const prioridade = parameters.prioridade; 
            const dataOcorridoStr = parameters.data_ocorrido; 

            let email = 'Não informado';
            // --- [CORREÇÃO] --- Buscando o e-mail do contexto corretamente
            const contextoEmail = req.body.queryResult.outputContexts.find(ctx => ctx.name.endsWith('/parameters/email'));
            if (contextoEmail) {
                email = contextoEmail.parameters.email;
            } else {
                // Tenta pegar do parâmetro, caso o contexto falhe (backup)
                if (parameters.email) email = parameters.email;
            }
            // --- Fim da Correção ---

            // --- [ALTERADO] --- Item 2.b: Lógica de Validação de Data Corrigida
            const dataOcorrido = new Date(dataOcorridoStr);
            const dataAgora = new Date();

            // Zeramos a hora, minutos e segundos de AMBAS as datas para comparar
            // apenas o DIA, não a HORA.
            const dataOcorridoZerada = new Date(dataOcorrido).setHours(0, 0, 0, 0);
            const dataAgoraZerada = new Date(dataAgora).setHours(0, 0, 0, 0);

            // Agora, "hoje" (meio-dia) > "agora" (10h) se torna
            // "hoje" (meia-noite) > "hoje" (meia-noite) -> false (Correto)
            // E "amanhã" (meio-dia) > "agora" (10h) se torna
            // "amanhã" (meia-noite) > "hoje" (meia-noite) -> true (Correto)

            if (dataOcorridoZerada > dataAgoraZerada) {
                console.log(`Validação falhou: Data do ocorrido (${dataOcorridoStr}) está no futuro.`);
                return res.json({
                    fulfillmentMessages: [{
                        text: { text: [
                            `A data do ocorrido não pode ser no futuro (você informou: ${dataOcorrido.toLocaleDateString('pt-BR')}). Por favor, inicie o processo de denúncia novamente com uma data válida.`
                        ]}
                    }]
                });
            }
            // --- Fim da Validação ---

            const protocolo = gerarProtocolo();

            let statusInicial = 'Recebido'; 
            if (prioridade && prioridade.toLowerCase() === 'alta') {
                statusInicial = 'Revisão Pendente'; 
            }

            const dadosTicket = { 
                protocolo, 
                nome, 
                email, 
                descricao: descricaoProblema, 
                prioridade,
                status: statusInicial,
                data_ocorrido: dataOcorrido 
            };

            if (statusInicial === 'Revisão Pendente') {
                await enviarNotificacaoAntifraude(dadosTicket);
            }
            
            const salvoNoBanco = await salvarNoBancoPostgres(dadosTicket);
            const emailEnviado = await enviarTicketPorEmail(dadosTicket);
            
            if (emailEnviado && salvoNoBanco) {
                const mensagemConfirmacao = `Ok, ${nome}! Sua denúncia foi registrada com sucesso sob o protocolo ${protocolo}. O status atual é: ${statusInicial}. Uma confirmação foi enviada para ${email}.`;
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
                const status = result.rows[0].status || 'Status não definido';
                responseText = `O status do seu protocolo ${protocolo} é: ${status}.`;
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

