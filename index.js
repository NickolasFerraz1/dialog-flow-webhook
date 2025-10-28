// index.js
const express = require('express');
const app = express();
const nodemailer = require('nodemailer'); // Importa o nodemailer

// Carrega as variáveis de ambiente (EMAIL_USER, EMAIL_PASS) do arquivo .env
// Garanta que você tenha o arquivo .env no mesmo diretório
require('dotenv').config();

// Middleware para interpretar o corpo (body) da requisição como JSON
app.use(express.json());

// Define a porta do servidor
const PORT = process.env.PORT || 3000;

// --- CONFIGURAÇÃO DO NODEMAILER (Transportador) ---
// Criamos o "transportador" que usará o Gmail para enviar os e-mails
// Isso só é criado uma vez quando o servidor liga
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER, // Seu e-mail do Gmail (do .env)
        pass: process.env.EMAIL_PASS  // Sua "Senha de App" de 16 letras (do .env)
    }
});


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
 * [ITEM 1.a REALIZADO] Envia o ticket/denúncia por e-mail para a equipe operacional.
 */
async function enviarTicketPorEmail(dadosTicket) {
    console.log("--- INICIANDO ENVIO DE E-MAIL REAL (Item 1.a) ---");

    const mailOptions = {
        from: `"Bot de Suporte" <${process.env.EMAIL_USER}>`, // Remetente
        to: "nickao69ferraz@gmail.com, " + dadosTicket.email, // Destinatários (equipe E o cliente)
        subject: `Novo Chamado: ${dadosTicket.protocolo} - ${dadosTicket.descricao.substring(0, 30)}...`, // Assunto
        // Corpo do e-mail em texto simples
        text: `
        Um novo chamado foi aberto pelo chatbot.

        --- DADOS DO CHAMADO ---
        Protocolo: ${dadosTicket.protocolo}
        Cliente: ${dadosTicket.nome}
        E-mail do Cliente: ${dadosTicket.email}
        
        --- DESCRIÇÃO DO PROBLEMA ---
        ${dadosTicket.descricao}
        `,
        // Corpo do e-mail em HTML (para ficar mais bonito)
        html: `
        <h3>Novo Chamado Aberto via Chatbot</h3>
        <p>Um novo chamado foi registrado com os seguintes dados:</p>
        <ul>
            <li><strong>Protocolo:</strong> ${dadosTicket.protocolo}</li>
            <li><strong>Cliente:</strong> ${dadosTicket.nome}</li>
            <li><strong>E-mail do Cliente:</strong> ${dadosTicket.email}</li>
        </ul>
        <hr>
        <h4>Descrição do Problema</h4>
        <p>${dadosTicket.descricao}</p>
        `
    };

    try {
        // Envia o e-mail usando o transportador que configuramos
        let info = await transporter.sendMail(mailOptions);
        console.log("E-mail enviado com sucesso! Message ID: " + info.messageId);
        return true; // Sucesso
    } catch (error) {
        console.error("Erro ao enviar e-mail:", error);
        return false; // Falha
    }
}

/**
 * [ITEM 1.d] Salva o núcleo da denúncia no banco de dados.
 */
async function salvarNoBancoMySQL(dadosTicket) {
    console.log("--- SIMULAÇÃO DE SALVAR NO MYSQL (Item 1.d) ---");
    // const [result] = await pool.execute( ... );
    console.log(`Dados do protocolo ${dadosTicket.protocolo} salvos no banco.`);
    return true;
}


// --- ROTA PRINCIPAL DO WEBHOOK ---
app.post('/webhook', async (req, res) => { // Marcamos como 'async'
    console.log('Requisição recebida do Dialogflow:');
    // console.log(JSON.stringify(req.body, null, 2)); // Descomente para depurar

    const intentName = req.body.queryResult.intent.displayName;

    if (intentName === 'AbrirChamadoSuporte') {
        try {
            // 1. Extrair parâmetros
            const nomeParam = req.body.queryResult.parameters.nome;
            const nome = (nomeParam && nomeParam.name) ? nomeParam.name : (nomeParam || 'Não informado');
            const descricaoProblema = req.body.queryResult.parameters.descricao_problema;

            // 1.b Extrair o e-mail do contexto
            let email = 'Não informado';
            const contextoEmail = req.body.queryResult.outputContexts.find(ctx => ctx.parameters && ctx.parameters.email);
            if (contextoEmail) {
                email = contextoEmail.parameters.email;
            }

            // 2. Validar os dados
            if (!nomeParam || !descricaoProblema) {
                return res.json({ fulfillmentMessages: [{ text: { text: ['Parece que o seu nome ou a descrição do problema não foram informados. Por favor, tente novamente.'] } }] });
            }

            // 3. Executar a lógica de negócio
            const protocolo = gerarProtocolo();

            const dadosTicket = {
                protocolo: protocolo,
                nome: nome,
                email: email,
                descricao: descricaoProblema
            };

            // 4. Chamar as funções de integração (e-mail, banco, etc.)
            const emailEnviado = await enviarTicketPorEmail(dadosTicket);
            const salvoNoBanco = await salvarNoBancoMySQL(dadosTicket);
            
            // 5. Montar a resposta de sucesso
            if (emailEnviado && salvoNoBanco) {
                const mensagemConfirmacao = `Ok, ${nome}! Seu chamado sobre "${descricaoProblema}" foi aberto com sucesso. O número do seu ticket é ${protocolo}. Uma confirmação foi enviada para ${email}.`;
                
                return res.json({ fulfillmentMessages: [{ text: { text: [mensagemConfirmacao] } }] });

            } else {
                throw new Error("Falha ao enviar e-mail de confirmação.");
            }

        } catch (error) {
            console.error("Erro ao processar o webhook:", error);
            return res.json({ fulfillmentMessages: [{ text: { text: ['Desculpe, ocorreu um erro interno ao processar seu chamado. Nossa equipe já foi notificada. Por favor, tente mais tarde.'] } }] });
        }

    } else {
        // Se a Intent não for a esperada
        return res.json({ fulfillmentMessages: [{ text: { text: [`Desculpe, não consegui processar sua solicitação. A intent "${intentName}" não é tratada por este webhook.`] } }] });
    }
});

// Inicia o servidor
app.listen(PORT, () => {
    console.log(`Servidor do webhook rodando na porta ${PORT}`);
});
