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
    
    // --- [ALTERADO] --- O HTML do e-mail agora usa a 'descricaoPadronizada'
    // que já vem formatada dentro de dadosTicket.descricao
    const msg = {
        from: { email: 'ct.sprint4@gmail.com', name: 'Bot de Suporte' },
        to: ['ct.sprint4@gmail.com'], // E-mail de suporte sempre
        subject: `Novo Chamado: ${dadosTicket.protocolo} - ${dadosTicket.titulo}`, // Usa o novo título
        html: dadosTicket.descricao // Usa a descrição padronizada
    };

    // Adiciona o e-mail do cliente APENAS se ele for válido
    if (dadosTicket.email && dadosTicket.email.includes('@')) {
        msg.to.push(dadosTicket.email);
        console.log(`Email do cliente ('${dadosTicket.email}') é válido. Adicionando à lista de destinatários.`);
    } else {
        console.warn(`Email do cliente ('${dadosTicket.email}') é inválido ou não informado. Envio será feito apenas para o suporte.`);
    }

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
   
    // --- [ALTERADO] --- O HTML do e-mail de alerta também usa a 'descricaoPadronizada'
    const msg = {
        from: { email: 'ct.sprint4@gmail.com', name: 'Bot Alerta de Risco' },
        to: emailEquipe,
        subject: `ALERTA (Revisão Pendente): Nova Denúncia de ALTA PRIORIDADE - Protocolo: ${dadosTicket.protocolo}`,
        html: dadosTicket.descricao // Usa a descrição padronizada
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
    
    // --- [ALTERADO] --- A query agora salva a 'descricao_padronizada' e o 'titulo'
    const query = `
        INSERT INTO denuncias (protocolo, nome, email, descricao, prioridade, status, data_ocorrido, titulo)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id;
    `;
    const valores = [
        dadosTicket.protocolo,
        dadosTicket.nome,
        dadosTicket.email,
        dadosTicket.descricao,
        dadosTicket.prioridade,
        dadosTicket.status,
        dadosTicket.data_ocorrido,
        dadosTicket.titulo // <-- NOVO
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

// --- [NOVO] --- Adicionada a coluna 'titulo' na tabela
async function inicializarBanco() {
    const client = await pool.connect(); 
    try {
        // ... (código de criação da tabela e colunas 'prioridade', 'status', 'data_ocorrido' ...
        // Vou omitir por brevidade, mas ele deve estar aqui)

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

        // Objeto para verificar colunas
        const colunas = {
            'prioridade': `ALTER TABLE denuncias ADD COLUMN prioridade VARCHAR(50);`,
            'data_ocorrido': `ALTER TABLE denuncias ADD COLUMN data_ocorrido TIMESTAMP WITH TIME ZONE;`,
            'titulo': `ALTER TABLE denuncias ADD COLUMN titulo VARCHAR(255);` // <-- NOVO
        };

        for (const [coluna, addQuery] of Object.entries(colunas)) {
            const checkQuery = `
            SELECT column_name FROM information_schema.columns 
            WHERE table_name='denuncias' AND column_name='${coluna}';
            `;
            const res = await client.query(checkQuery);
            if (res.rows.length === 0) {
                console.log(`Coluna '${coluna}' não encontrada. Adicionando...`);
                await client.query(addQuery);
                console.log(`Coluna '${coluna}' adicionada.`);
            } else {
                console.log(`Coluna '${coluna}' já existe.`);
            }
        }

        // Verifica e AJUSTA a coluna 'status' (Remove DEFAULT)
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

        console.log("Banco de dados inicializado e schema atualizado.");

    } catch (err) {
        console.error("Erro ao inicializar ou atualizar o schema:", err);
    } finally {
        client.release(); 
    }
}


// --- ROTA PRINCIPAL DO WEBHOOK ---
app.post('/webhook', async (req, res) => {
    const intentName = req.body.queryResult.intent.displayName;

    if (intentName === 'AbrirChamadoSuporte') {
        try {
            // --- 1. Extração de Dados ---
            const parameters = req.body.queryResult.parameters;
            const nomeParam = parameters.nome;
            const nome = (nomeParam && nomeParam.name) ? nomeParam.name : (nomeParam || 'Não informado');
            const descricaoProblema = parameters.descricao_problema;
            const prioridade = parameters.prioridade; 
            const dataOcorridoStr = parameters.data_ocorrido; 

            let email = 'Não informado';
            const contextoEmail = req.body.queryResult.outputContexts.find(ctx => ctx.parameters && ctx.parameters.email);
            if (contextoEmail) {
                email = contextoEmail.parameters.email;
            } else if (parameters.email) {
                email = parameters.email;
            }

            // --- 2. Validação de Data (Item 2.b) ---
            const dataOcorrido = new Date(dataOcorridoStr);
            const dataAgora = new Date();
            const dataOcorridoZerada = new Date(dataOcorrido).setHours(0, 0, 0, 0);
            const dataAgoraZerada = new Date(dataAgora).setHours(0, 0, 0, 0);

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

            // --- 3. Lógica de Negócio e Auto-Resumo (Item 2.c) ---
            const protocolo = gerarProtocolo();
            const dataOcorridoFormatada = dataOcorrido.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

            let statusInicial = 'Recebido'; 
            if (prioridade && prioridade.toLowerCase() === 'alta') {
                statusInicial = 'Revisão Pendente'; 
            }

            // --- [NOVO] --- Criando o Título (Auto-resumo)
            const tituloTicket = `Denúncia: ${descricaoProblema.substring(0, 40)}...`;

            // --- [NOVO] --- Criando a Descrição Padronizada (Auto-resumo)
            const descricaoPadronizada = `
            <h3>Resumo da Denúncia (Protocolo: ${protocolo})</h3>
            <ul>
                <li><strong>Denunciante:</strong> ${nome}</li>
                <li><strong>E-mail:</strong> ${email}</li>
                <li><strong>Data do Ocorrido:</strong> ${dataOcorridoFormatada}</li>
                <li><strong>Prioridade:</strong> ${prioridade}</li>
                <li><strong>Status Inicial:</strong> ${statusInicial}</li>
            </ul>
            <hr>
            <h4>Descrição Completa do Usuário</h4>
            <p>${descricaoProblema}</p>
            `;
            // --- Fim do Item 2.c ---

            // --- 4. Preparando Dados e Executando Ações ---
            const dadosTicket = { 
                protocolo, 
                nome, 
                email, 
                descricao: descricaoPadronizada, // <-- [ALTERADO]
                titulo: tituloTicket,            // <-- [NOVO]
                prioridade,
                status: statusInicial,
                data_ocorrido: dataOcorrido 
            };

            if (statusInicial === 'Revisão Pendente') {
                await enviarNotificacaoAntifraude(dadosTicket);
            }
            
            const salvoNoBanco = await salvarNoBancoPostgres(dadosTicket);
            const emailEnviado = await enviarTicketPorEmail(dadosTicket);
            
            // --- 5. Resposta Final ---
            if (emailEnviado && salvoNoBanco) {
                const mensagemConfirmacao = `Ok, ${nome}! Sua denúncia foi registrada com sucesso sob o protocolo ${protocolo}. O status atual é: ${statusInicial}. Uma confirmação foi enviada para ${email}.`;
                return res.json({ fulfillmentMessages: [{ text: { text: [mensagemConfirmacao] } }] });
            } else {
                if (!salvoNoBanco) throw new Error("Falha ao salvar no banco de dados.");
                if (!emailEnviado) throw new Error("Falha ao enviar e-mail de confirmação.");
            }
        } catch (error) {
            console.error("Erro ao processar webhook (AbrirChamadoSuporte):", error);
            return res.json({ fulfillmentMessages: [{ text: { text: [`Desculpe, ocorreu um erro interno. Nossa equipe já foi notificada. (${error.message})`] } }] });
        }
    
    } else if (intentName === 'consultar-status') {
        // ... (código da consulta de status permanece o mesmo)
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

