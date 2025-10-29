// index.js
const express = require('express');
const app = express();
const sgMail = require('@sendgrid/mail');
const { Pool } = require('pg'); // Driver Postgres
const { MongoClient, ServerApiVersion } = require('mongodb'); // Driver MongoDB
const { Buffer } = require('buffer'); // Para Autenticação Basic
const rateLimit = require('express-rate-limit'); // Para Rate Limit

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

// --- CONFIGURAÇÃO DO BANCO DE DADOS (MONGODB) ---
const mongoUri = process.env.MONGO_URI;
const mongoClient = new MongoClient(mongoUri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});
let logDB; // Variável global para acessar o banco de logs

// --- FUNÇÃO DE MASCARAMENTO (Item 3.c) ---
/**
 * Mascara PII (CPF/CNPJ) em uma string de texto.
 * @param {string} text O texto para mascarar
 * @returns {string} O texto com PII mascarado
 */
function maskPII(text) {
    if (typeof text !== 'string' || !text) {
        return text;
    }
    
    let maskedText = text;

    // Regex para CPF (XXX.XXX.XXX-XX ou XXXXXXXXXXX)
    // Substitui por XXX.***.***-XX
    maskedText = maskedText.replace(
        /(\d{3})[\.]?(\d{3})[\.]?(\d{3})[-]?(\d{2})/g, 
        (match, p1, p2, p3, p4) => `${p1}.***.***-${p4}`
    );

    // Regex para CNPJ (XX.XXX.XXX/XXXX-XX ou XXXXXXXXXXXXXX)
    // Substitui por XX.***.***/XXXX-XX
    maskedText = maskedText.replace(
        /(\d{2})[\.]?(\d{3})[\.]?(\d{3})[\/]?(\d{4})[-]?(\d{2})/g,
        (match, p1, p2, p3, p4, p5) => `${p1}.***.***/${p4}-${p5}`
    );

    return maskedText;
}


// --- SISTEMA DE LOGS ESTRUTURADOS (Item 3.a) ---

/**
 * Conecta ao MongoDB e prepara a coleção de logs
 */
async function conectarMongo() {
    try {
        await mongoClient.connect();
        await mongoClient.db("admin").command({ ping: 1 });
        console.log("Conexão com MongoDB Atlas estabelecida com sucesso!");
        // Define o banco de dados e a coleção que vamos usar
        logDB = mongoClient.db("logs_sprint4").collection("denuncias_logs");
        logInfo("MongoDB", "Coletor de logs do MongoDB inicializado.");
    } catch (err) {
        // Se não conseguir conectar ao Mongo, loga no console e continua
        console.error("ERRO CRÍTICO AO CONECTAR NO MONGODB:", err);
    }
}

/**
 * Salva um log estruturado no MongoDB (Item 1.d)
 * @param {string} level - Nível do log (INFO, ERROR, WARN)
 * @param {string} component - Onde o log se originou (ex: Postgres, SendGrid, Webhook)
 * @param {string} message - A mensagem de log
 * @param {object} context - Dados adicionais (protocolo, intent, erro, etc.)
 */
async function salvarLog(level, component, message, context = {}) {
    // --- Mascaramento de PII para Logs (Item 3.c) ---
    const maskedContext = { ...context }; 
    const sensitiveKeys = ['nome', 'email', 'descricao', 'descricao_problema']; 

    for (const key of sensitiveKeys) {
        if (maskedContext[key] && typeof maskedContext[key] === 'string') {
            maskedContext[key] = maskPII(maskedContext[key]);
        }
    }
    const maskedMessage = maskPII(message);
    // --- Fim do Mascaramento ---

    const logEntry = {
        timestamp: new Date(),
        level,
        component,
        message: maskedMessage, // Usa a mensagem mascarada
        ...maskedContext // Usa o contexto mascarado
    };

    // 1. Imprime no console (para o log do Render)
    if (level === 'ERROR') {
        console.error(JSON.stringify(logEntry, null, 2));
    } else {
        console.log(JSON.stringify(logEntry, null, 2));
    }

    // 2. Tenta salvar no MongoDB
    if (logDB) {
        try {
            await logDB.insertOne(logEntry);
        } catch (err) {
            console.error("Falha ao salvar log no MongoDB:", err);
        }
    } else if (level === 'ERROR' && component !== 'MongoDB') {
        // Se o logDB não iniciou E temos um erro, loga no console
        console.error("logDB não inicializado. Log de ERRO não salvo no MongoDB.");
    }
}
// Funções auxiliares para facilitar o logging
const logInfo = (component, message, context) => salvarLog('INFO', component, message, context);
const logError = (component, message, error, context) => {
    const errorDetails = {
        message: error.message,
        stack: error.stack,
        code: error.code,
        ...error
    };
    salvarLog('ERROR', component, message, { ...context, error: errorDetails });
};
// --- Fim do Sistema de Logs ---


// --- FUNÇÕES DE BANCO (POSTGRES) ---
/**
 * Verifica o schema do banco Postgres e cria/altera colunas conforme necessário.
 */
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
        logInfo("Postgres", "Tabela 'denuncias' verificada/criada.");

        // Objeto para verificar colunas dinamicamente
        const colunas = {
            'prioridade': `ALTER TABLE denuncias ADD COLUMN prioridade VARCHAR(50);`,
            'data_ocorrido': `ALTER TABLE denuncias ADD COLUMN data_ocorrido TIMESTAMP WITH TIME ZONE;`,
            'titulo': `ALTER TABLE denuncias ADD COLUMN titulo VARCHAR(255);`
        };

        // Loop para verificar e adicionar cada coluna
        for (const [coluna, addQuery] of Object.entries(colunas)) {
            const checkQuery = `
            SELECT column_name FROM information_schema.columns 
            WHERE table_name='denuncias' AND column_name='${coluna}';
            `;
            const res = await client.query(checkQuery);
            if (res.rows.length === 0) {
                logInfo("Postgres", `Coluna '${coluna}' não encontrada. Adicionando...`);
                await client.query(addQuery);
                logInfo("Postgres", `Coluna '${coluna}' adicionada.`);
            } else {
                logInfo("Postgres", `Coluna '${coluna}' já existe.`);
            }
        }

        // Verifica e AJUSTA a coluna 'status' (Remove DEFAULT)
        const checkStatusQuery = `
        SELECT column_default FROM information_schema.columns 
        WHERE table_name='denuncias' AND column_name='status';
        `;
        const resStatus = await client.query(checkStatusQuery);
        if (resStatus.rows.length > 0 && resStatus.rows[0].column_default != null) {
            logInfo("Postgres", "Coluna 'status' possui um valor DEFAULT. Removendo...");
            await client.query(`ALTER TABLE denuncias ALTER COLUMN status DROP DEFAULT;`);
            logInfo("Postgres", "DEFAULT removido da coluna 'status'.");
        } else {
            logInfo("Postgres", "Coluna 'status' já está configurada corretamente (sem DEFAULT).");
        }

        logInfo("Postgres", "Banco de dados inicializado e schema atualizado.");

    } catch (err) {
        logError("Postgres", "Erro ao inicializar ou atualizar o schema", err);
    } finally {
        client.release(); 
    }
}

/**
 * [ITEM 1.d] Salva o núcleo da denúncia no banco de dados Postgres.
 */
async function salvarNoBancoPostgres(dadosTicket) {
    logInfo("Postgres", `Iniciando salvamento no Postgres. Status: ${dadosTicket.status}`, { protocolo: dadosTicket.protocolo });
    
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
        dadosTicket.titulo
    ];

    try {
        const res = await pool.query(query, valores);
        logInfo("Postgres", `Dados salvos no banco! ID da nova denúncia: ${res.rows[0].id}`, { protocolo: dadosTicket.protocolo, id: res.rows[0].id });
        return true;
    } catch (err) {
        logError("Postgres", "Erro ao salvar no banco de dados", err, { protocolo: dadosTicket.protocolo });
        return false;
    }
}


// --- FUNÇÕES DE E-MAIL (SENDGRID) ---

function gerarProtocolo() {
    const data = new Date();
    const ano = data.getFullYear();
    const mes = (data.getMonth() + 1).toString().padStart(2, '0');
    const dia = data.getDate().toString().padStart(2, '0');
    const aleatorio = Math.floor(10000 + Math.random() * 90000);
    return `SUP-${ano}${mes}${dia}-${aleatorio}`;
}

/**
 * [ITEM 1.a] Envia o ticket/denúncia por e-mail para o cliente e suporte.
 */
async function enviarTicketPorEmail(dadosTicket) {
    logInfo("SendGrid", "Iniciando envio de e-mail de confirmação", { protocolo: dadosTicket.protocolo, email: dadosTicket.email });
    
    const msg = {
        from: { email: 'ct.sprint4@gmail.com', name: 'Bot de Suporte' },
        to: ['ct.sprint4@gmail.com'], // E-mail de suporte sempre
        subject: `Novo Chamado: ${dadosTicket.protocolo} - ${dadosTicket.titulo}`, // Usa o novo título
        html: dadosTicket.descricao // Usa a descrição padronizada
    };

    // Adiciona o e-mail do cliente APENAS se ele for válido
    if (dadosTicket.email && dadosTicket.email.includes('@')) {
        msg.to.push(dadosTicket.email);
        logInfo("SendGrid", `Email do cliente ('${dadosTicket.email}') é válido. Adicionando à lista de destinatários.`, { protocolo: dadosTicket.protocolo });
    } else {
        logInfo("SendGrid", `Email do cliente ('${dadosTicket.email}') é inválido ou não informado. Envio será feito apenas para o suporte.`, { protocolo: dadosTicket.protocolo });
    }

    try {
        await sgMail.send(msg);
        logInfo("SendGrid", "E-mail de confirmação enviado com sucesso!", { protocolo: dadosTicket.protocolo });
        return true;
    } catch (error) {
        logError("SendGrid", "Erro ao enviar e-mail de confirmação", error, { protocolo: dadosTicket.protocolo });
        return false;
    }
}

/**
 * [ITEM 1.c] Envia notificação para a equipe antifraude.
 */
async function enviarNotificacaoAntifraude(dadosTicket) {
    logInfo("SendGrid", "Iniciando notificação para equipe antifraude (Alta Prioridade)", { protocolo: dadosTicket.protocolo });
    const emailEquipe = process.env.ANTIFRAUDE_EMAIL;
    if (!emailEquipe) {
        logError("SendGrid", "Variável de ambiente ANTIFRAUDE_EMAIL não definida. Notificação não enviada.", new Error("ANTIFRAUDE_EMAIL is not set"), { protocolo: dadosTicket.protocolo });
        return false;
    }
   
    const msg = {
        from: { email: 'ct.sprint4@gmail.com', name: 'Bot Alerta de Risco' },
        to: emailEquipe,
        subject: `ALERTA (Revisão Pendente): Nova Denúncia de ALTA PRIORIDADE - Protocolo: ${dadosTicket.protocolo}`,
        html: dadosTicket.descricao // Usa a descrição padronizada
    };
    try {
        await sgMail.send(msg);
        logInfo("SendGrid", `Notificação de alta prioridade enviada para ${emailEquipe}!`, { protocolo: dadosTicket.protocolo });
        return true;
    } catch (error) {
        logError("SendGrid", "Erro ao enviar notificação de alta prioridade", error, { protocolo: dadosTicket.protocolo });
        return false;
    }
}


// --- CONFIGURAÇÃO DO SERVIDOR (EXPRESS) ---
app.use(express.json());
const PORT = process.env.PORT || 3000;

// --- CONFIGURAÇÃO DE RATE LIMIT (Item 3.b) ---
const limiter = rateLimit({
	windowMs: 15 * 60 * 1000, // 15 minutos
	max: 100, // Limita cada IP a 100 requisições por janela de 15 minutos
	message: 'Muitas requisições deste IP. Por favor, tente novamente após 15 minutos.',
    standardHeaders: true, // Retorna informações do limite nos cabeçalhos `RateLimit-*`
	legacyHeaders: false, // Desabilita os cabeçalhos `X-RateLimit-*`
    handler: (req, res, next, options) => {
        // Loga a tentativa bloqueada
        logError("RateLimit", `Requisição bloqueada por excesso de tentativas (IP: ${req.ip}).`, new Error('Rate Limit Exceeded'), { ip: req.ip });
        res.status(options.statusCode).send(options.message);
    }
});
// Aplica o middleware de rate limit a TODAS as requisições
app.use(limiter);

// --- MIDDLEWARE DE AUTENTICAÇÃO (Item 3.b) ---
/**
 * Verifica as credenciais de Autenticação Basic enviadas pelo Dialogflow.
 */
function checkAuth(req, res, next) {
    logInfo("Auth", "Verificando autenticação do webhook...");
    
    const authHeader = req.headers['authorization'];
    
    if (!authHeader) {
        logError("Auth", "Falha de autenticação: Cabeçalho de autorização ausente.", new Error('Missing Auth Header'));
        return res.status(401).json({ error: 'Não autorizado. Cabeçalho de autenticação ausente.' });
    }

    const [type, credentials] = authHeader.split(' ');

    if (type !== 'Basic' || !credentials) {
        logError("Auth", "Falha de autenticação: Formato de cabeçalho incorreto.", new Error('Invalid Auth Header format'));
        return res.status(401).json({ error: 'Não autorizado. Formato de autenticação inválido.' });
    }

    const decoded = Buffer.from(credentials, 'base64').toString('ascii');
    const [user, pass] = decoded.split(':');

    const expectedUser = process.env.WEBHOOK_USER;
    const expectedPass = process.env.WEBHOOK_PASS;

    if (user === expectedUser && pass === expectedPass) {
        logInfo("Auth", "Autenticação bem-sucedida.", { user });
        next(); // Continua para a rota principal
    } else {
        logError("Auth", "Falha de autenticação: Credenciais inválidas.", new Error('Invalid credentials'), { user });
        return res.status(401).json({ error: 'Não autorizado. Credenciais inválidas.' });
    }
}


// --- ROTA PRINCIPAL DO WEBHOOK ---
app.post('/webhook', checkAuth, async (req, res) => {
    
    const intentName = req.body.queryResult.intent.displayName;
    const dialogflowSessionId = req.body.session.split('/').pop();
    let traceContext = { intentName, dialogflowSessionId };

    logInfo("Webhook", "Nova requisição recebida (pós-autenticação/rate-limit)", traceContext);

    // --- ROTA: AbrirChamadoSuporte ---
    if (intentName === 'AbrirChamadoSuporte') {
        let protocolo; 
        try {
            // --- 1. Extração de Dados ---
            const parameters = req.body.queryResult.parameters;
            const nomeParam = parameters.nome;
            const nome = (nomeParam && nomeParam.name) ? nomeParam.name : (nomeParam || 'Não informado');
            const descricaoProblema = parameters.descricao_problema;
            const prioridade = parameters.prioridade; 
            const dataOcorridoStr = parameters.data_ocorrido; 

            // Lógica de busca de e-mail robusta
            let email = 'Não informado';
            if (parameters.email && parameters.email !== '') {
                email = parameters.email;
            } else if (req.body.queryResult.outputContexts && req.body.queryResult.outputContexts.length > 0) {
                for (const ctx of req.body.queryResult.outputContexts) {
                    if (ctx.parameters && ctx.parameters.email && ctx.parameters.email !== '') {
                        email = ctx.parameters.email;
                        break; 
                    }
                }
            }
            // Adiciona PII ao contexto de log (será mascarado pelo salvarLog)
            traceContext.email = email; 
            traceContext.nome = nome;

            // --- 2. Validação de Data (Item 2.b) ---
            const dataOcorrido = new Date(dataOcorridoStr);
            const dataAgora = new Date();
            const dataOcorridoZerada = new Date(dataOcorrido).setHours(0, 0, 0, 0);
            const dataAgoraZerada = new Date(dataAgora).setHours(0, 0, 0, 0);

            if (dataOcorridoZerada > dataAgoraZerada) {
                logInfo("Webhook", `Validação falhou: Data do ocorrido (${dataOcorridoStr}) está no futuro.`, traceContext);
                return res.json({
                    fulfillmentMessages: [{
                        text: { text: [
                            `A data do ocorrido não pode ser no futuro (você informou: ${dataOcorrido.toLocaleDateString('pt-BR')}). Por favor, inicie o processo de denúncia novamente com uma data válida.`
                        ]}
                    }]
                });
            }

            // --- 3. Lógica de Negócio e Auto-Resumo (Item 2.c) ---
            protocolo = gerarProtocolo(); 
            traceContext.protocolo = protocolo; 
            
            const dataOcorridoFormatada = dataOcorrido.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

            // Item 2.a: Human-in-the-loop
            let statusInicial = 'Recebido'; 
            if (prioridade && prioridade.toLowerCase() === 'alta') {
                statusInicial = 'Revisão Pendente'; 
            }

            // Item 2.c: Título e Descrição Padronizada
            const tituloTicket = `Denúncia: ${descricaoProblema.substring(0, 40)}...`;
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
            
            // Adiciona a descrição ao contexto de log (será mascarada)
            traceContext.descricao_problema = descricaoProblema;
            logInfo("Webhook", "Auto-resumo e lógica de negócio concluídos", traceContext);

            // --- 4. Preparando Dados e Executando Ações ---
            const dadosTicket = { 
                protocolo, 
                nome, 
                email, 
                descricao: descricaoPadronizada,
                titulo: tituloTicket,
                prioridade,
                status: statusInicial,
                data_ocorrido: dataOcorrido 
            };

            if (statusInicial === 'Revisão Pendente') {
                await enviarNotificacaoAntifraude(dadosTicket); // Item 1.c
            }
            
            const salvoNoBanco = await salvarNoBancoPostgres(dadosTicket); // Item 1.d
            const emailEnviado = await enviarTicketPorEmail(dadosTicket); // Item 1.a
            
            // --- 5. Resposta Final ---
            if (emailEnviado && salvoNoBanco) {
                const mensagemConfirmacao = `Ok, ${nome}! Sua denúncia foi registrada com sucesso sob o protocolo ${protocolo}. O status atual é: ${statusInicial}. Uma confirmação foi enviada para ${email}.`;
                // Este log final também terá o nome/email mascarados no Mongo
                logInfo("Webhook", "Fluxo 'AbrirChamadoSuporte' concluído com sucesso.", traceContext);
                return res.json({ fulfillmentMessages: [{ text: { text: [mensagemConfirmacao] } }] });
            } else {
                if (!salvoNoBanco) throw new Error("Falha ao salvar no banco de dados.");
                if (!emailEnviado) throw new Error("Falha ao enviar e-mail de confirmação.");
            }
        } catch (error) {
            logError("Webhook", "Erro ao processar webhook (AbrirChamadoSuporte)", error, traceContext);
            return res.json({ fulfillmentMessages: [{ text: { text: [`Desculpe, ocorreu um erro interno. Nossa equipe já foi notificada. (${error.message})`] } }] });
        }
    
    // --- ROTA: consultar-status ---
    } else if (intentName === 'consultar-status') {
        const protocolo = req.body.queryResult.parameters.protocolo;
        traceContext.protocolo = protocolo; 

        if (!protocolo || protocolo.trim() === '') {
            logInfo("Webhook", "Tentativa de consulta sem protocolo.", traceContext);
            return res.json({ fulfillmentMessages: [{ text: { text: ['Não entendi o número do protocolo. Poderia repetir?'] } }] });
        }
        try {
            // Item 1.b: Consulta de status
            const query = 'SELECT status FROM denuncias WHERE protocolo = $1';
            const result = await pool.query(query, [protocolo]);
            let responseText = '';
            if (result.rows.length > 0) {
                const status = result.rows[0].status || 'Status não definido';
                responseText = `O status do seu protocolo ${protocolo} é: ${status}.`;
                logInfo("Webhook", "Consulta de status realizada com sucesso (Encontrado).", traceContext);
            } else {
                responseText = `Não foi possível encontrar uma denúncia com o protocolo ${protocolo}. Por favor, verifique o número e tente novamente.`;
                logInfo("Webhook", "Consulta de status realizada com sucesso (Não Encontrado).", traceContext);
            }
            return res.json({ fulfillmentMessages: [{ text: { text: [responseText] } }] });
        } catch (error) {
            logError("Webhook", "Erro ao consultar o banco (consultar-status)", error, traceContext);
            return res.json({ fulfillmentMessages: [{ text: { text: ['Ocorreu um erro ao consultar o status. Tente novamente mais tarde.'] } }] });
        }

    // --- ROTA: excluir-meus-dados (Item 3.c) ---
    } else if (intentName === 'excluir-dados') {
        const protocolo = req.body.queryResult.parameters.protocolo;
        traceContext.protocolo = protocolo; 

        if (!protocolo || protocolo.trim() === '') {
            logInfo("Webhook", "Tentativa de exclusão sem protocolo.", traceContext);
            return res.json({ fulfillmentMessages: [{ text: { text: ['Não entendi o número do protocolo. Poderia repetir?'] } }] });
        }
        
        logInfo("Webhook", `Iniciando processo de anonimização para o protocolo: ${protocolo}`, traceContext);

        try {
            const query = `
                UPDATE denuncias 
                SET 
                    nome = '[ANONIMIZADO]',
                    email = '[ANONIMIZADO]',
                    descricao = '[CONTEÚDO ANONIMIZADO PELO USUÁRIO]',
                    titulo = '[ANONIMIZADO]',
                    status = 'Anonimizado'
                WHERE protocolo = $1;
            `;
            
            const result = await pool.query(query, [protocolo]);
            let responseText = '';

            // result.rowCount informa quantas linhas foram afetadas
            if (result.rowCount > 0) {
                responseText = `Processo concluído. Os dados pessoais associados ao protocolo ${protocolo} foram permanentemente anonimizados.`;
                logInfo("Webhook", `Anonimização do protocolo ${protocolo} concluída com sucesso.`, traceContext);
            } else {
                responseText = `Não foi possível encontrar uma denúncia com o protocolo ${protocolo}. Nenhum dado foi alterado.`;
                logInfo("Webhook", `Tentativa de anonimização falhou: protocolo ${protocolo} não encontrado.`, traceContext);
            }
            
            return res.json({ fulfillmentMessages: [{ text: { text: [responseText] } }] });

        } catch (error) {
            logError("Webhook", "Erro ao anonimizar dados no banco (excluir-meus-dados)", error, traceContext);
            return res.json({ fulfillmentMessages: [{ text: { text: ['Ocorreu um erro ao processar sua solicitação de anonimização. Tente novamente mais tarde.'] } }] });
        }
    // --- Fim da Rota de Exclusão ---

    } else {
        // Rota para Intents não tratadas
        logInfo("Webhook", `Intent "${intentName}" não tratada por este webhook.`, traceContext);
        return res.json({ fulfillmentMessages: [{ text: { text: [`Intent "${intentName}" não tratada por este webhook.`] } }] });
    }
});

// --- INICIA O SERVIDOR ---
app.listen(PORT, () => {
    console.log(`Servidor do webhook rodando na porta ${PORT}`);
    
    // Inicia as conexões com os bancos
    inicializarBanco(); // Postgres
    conectarMongo();    // MongoDB
});

