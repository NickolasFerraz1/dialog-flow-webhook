// index.js
const express = require('express');
const app = express();

// Importa a biblioteca do SendGrid
const sgMail = require('@sendgrid/mail');

// Carrega as variáveis de ambiente (SENDGRID_API_KEY) do arquivo .env
require('dotenv').config();

// Configura o SendGrid com a sua API Key (lida do .env ou do Render)
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// Middleware para interpretar o corpo (body) da requisição como JSON
app.use(express.json());

// Define a porta do servidor
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
        // ATENÇÃO: Mude este e-mail para o e-mail que você VERIFICOU no SendGrid
        from: {
            email: 'ct.sprint4@gmail.com', // <-- SEU E-MAIL VERIFICADO
            name: 'Bot de Suporte'
        },
        
        // Para quem o e-mail vai
        to: [
            'nickao69ferraz@gmail.com', // <-- Mude para o e-mail da sua "equipe" (pode ser você)
            dadosTicket.email               // E-mail do cliente
        ],
        
        // Assunto
        subject: `Novo Chamado: ${dadosTicket.protocolo} - ${dadosTicket.descricao.substring(0, 30)}...`,
        
        // Corpo em texto (para clientes de e-mail que não suportam HTML)
        text: `Um novo chamado foi aberto pelo chatbot. Protocolo: ${dadosTicket.protocolo}, Cliente: ${dadosTicket.nome}, Descrição: ${dadosTicket.descricao}`,
        
        // Corpo em HTML
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
        await sgMail.send(msg); // Envia o e-mail
        console.log("E-mail enviado com sucesso via SendGrid!");
        return true; // Sucesso
    } catch (error) {
        console.error("Erro ao enviar e-mail pelo SendGrid:", error);
        if (error.response) {
            console.error(error.response.body) // Mostra detalhes do erro da API
        }
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
    
    const intentName = req.body.queryResult.intent.displayName;

    if (intentName === 'AbrirChamadoSuporte') {
        try {
            // 1. Extrair parâmetros
            const nomeParam = req.body.queryResult.parameters.nome;
            const nome = (nomeParam && nomeParam.name) ? nomeParam.name : (nomeParam || 'Não informado');
            
            // Corrigido para "descricao_problema" (conforme seu log)
            const descricaoProblema = req.body.queryResult.parameters.descricao_problema; 

            // 1.b Extrair o e-mail do contexto
            let email = 'Não informado';
            const contextoEmail = req.body.queryResult.outputContexts.find(ctx => ctx.parameters && ctx.parameters.email);
            if (contextoEmail) {
                email = contextoEmail.parameters.email;
            }

            // 2. Validar os dados
            if (!nomeParam || !descricaoProblema) {
                console.warn("Dados faltando: ", req.body.queryResult.parameters);
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
                throw new Error("Falha ao enviar e-mail de confirmação via SendGrid.");
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

