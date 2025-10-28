// index.js
const express = require('express');
const app = express();

// Middleware para interpretar o corpo (body) da requisição como JSON
app.use(express.json());

// Importe a biblioteca de envio de e-mail (ex: nodemailer)
// Você precisará instalá-lo: npm install nodemailer
// const nodemailer = require('nodemailer');

// Define a porta do servidor
const PORT = process.env.PORT || 3000;

// --- FUNÇÕES AUXILIARES DA SPRINT 4 ---

/**
 * Gera um protocolo de atendimento mais estruturado.
 * Ex: SUP-20251028-12345
 */
function gerarProtocolo() {
    const data = new Date();
    const ano = data.getFullYear();
    const mes = (data.getMonth() + 1).toString().padStart(2, '0');
    const dia = data.getDate().toString().padStart(2, '0');
    const aleatorio = Math.floor(10000 + Math.random() * 90000);
    return `SUP-${ano}${mes}${dia}-${aleatorio}`;
}

/**
 * [ITEM 1.a] Envia o ticket/denúncia por e-mail para a equipe operacional.
 * Esta é uma função assíncrona (async) pois o envio de e-mail demora.
 */
async function enviarTicketPorEmail(dadosTicket) {
    console.log("--- SIMULAÇÃO DE ENVIO DE E-MAIL (Item 1.a) ---");
    console.log("Protocolo:", dadosTicket.protocolo);
    console.log("Nome:", dadosTicket.nome);
    console.log("Email:", dadosTicket.email);
    console.log("Descrição:", dadosTicket.descricao);

    // ----- AQUI ENTRARIA A LÓGICA REAL DO NODEMAILER -----
    // const transporter = nodemailer.createTransport({ ... });
    // await transporter.sendMail({
    //   from: '"Bot de Suporte" <bot@suaempresa.com>',
    //   to: "suporte-operacional@suaempresa.com",
    //   subject: `Novo Chamado: ${dadosTicket.protocolo} - ${dadosTicket.descricao.substring(0, 20)}...`,
    //   text: `Nome: ${dadosTicket.nome}\nEmail: ${dadosTicket.email}\n\nDescrição:\n${dadosTicket.descricao}`
    // });
    // ----- FIM DA LÓGICA REAL -----

    console.log("----------------------------------------------");
    // Por enquanto, apenas simulamos que foi um sucesso
    return true;
}

/**
 * [ITEM 1.d] Salva o núcleo da denúncia no banco de dados.
 */
async function salvarNoBancoMySQL(dadosTicket) {
    console.log("--- SIMULAÇÃO DE SALVAR NO MYSQL (Item 1.d) ---");
    // Aqui você usaria uma biblioteca (ex: 'mysql2')
    // const [result] = await pool.execute(
    //   'INSERT INTO denuncias (protocolo, nome_cliente, email, descricao, status) VALUES (?, ?, ?, ?, ?)',
    //   [dadosTicket.protocolo, dadosTicket.nome, dadosTicket.email, dadosTicket.descricao, 'Aberto']
    // );
    console.log(`Dados do protocolo ${dadosTicket.protocolo} salvos no banco.`);
    return true;
}


// --- ROTA PRINCIPAL DO WEBHOOK ---
// Cria o endpoint '/webhook' que receberá as requisições POST do Dialogflow
app.post('/webhook', async (req, res) => { // Marcamos como 'async'
    console.log('Requisição recebida do Dialogflow:');
    console.log(JSON.stringify(req.body, null, 2));

    const intentName = req.body.queryResult.intent.displayName;

    if (intentName === 'AbrirChamadoSuporte') {
        try {
            // 1. Extrair parâmetros (como você já fazia)
            const nomeParam = req.body.queryResult.parameters.nome;
            const nome = (nomeParam && nomeParam.name) ? nomeParam.name : (nomeParam || 'Não informado');
            const descricaoProblema = req.body.queryResult.parameters.descricao_problema;

            // 1.b [NOVO] Extrair o e-mail do contexto (com base no seu log)
            let email = 'Não informado';
            const contextoEmail = req.body.queryResult.outputContexts.find(ctx => ctx.parameters && ctx.parameters.email);
            if (contextoEmail) {
                email = contextoEmail.parameters.email;
            }

            // 2. Validar os dados
            if (!nomeParam || !descricaoProblema) {
                const response = {
                    fulfillmentMessages: [{ text: { text: ['Parece que o seu nome ou a descrição do problema não foram informados. Por favor, tente novamente.'] } }],
                };
                return res.json(response);
            }

            // 3. [NOVO] Executar a lógica de negócio da Sprint 4
            const protocolo = gerarProtocolo();

            const dadosTicket = {
                protocolo: protocolo,
                nome: nome,
                email: email,
                descricao: descricaoProblema
            };

            // 4. [NOVO] Chamar as funções de integração (e-mail, banco, etc.)
            // Usamos 'await' para esperar que elas terminem
            const emailEnviado = await enviarTicketPorEmail(dadosTicket);
            const salvoNoBanco = await salvarNoBancoMySQL(dadosTicket);
            
            // 5. Montar a resposta de sucesso
            if (emailEnviado && salvoNoBanco) {
                const mensagemConfirmacao = `Ok, ${nome}! Seu chamado sobre "${descricaoProblema}" foi aberto com sucesso. O número do seu ticket é ${protocolo}. Enviaremos atualizações para o e-mail ${email}.`;
                
                const response = {
                    fulfillmentMessages: [{ text: { text: [mensagemConfirmacao] } }],
                };
                return res.json(response);

            } else {
                // Se falhar o envio de e-mail ou salvar no banco
                throw new Error("Falha nas integrações de back-end.");
            }

        } catch (error) {
            // Em caso de qualquer erro na nossa lógica, informa o usuário
            console.error("Erro ao processar o webhook:", error);
            const response = {
                fulfillmentMessages: [{ text: { text: ['Desculpe, ocorreu um erro interno ao processar seu chamado. Nossa equipe já foi notificada. Por favor, tente mais tarde.'] } }],
            };
            return res.json(response);
        }

    } else {
        // Se a Intent não for a esperada, retorna uma resposta padrão.
        const response = {
            fulfillmentMessages: [{ text: { text: [`Desculpe, não consegui processar sua solicitação. A intent "${intentName}" não é tratada por este webhook.`] } }],
        };
        return res.json(response);
    }
});

// Inicia o servidor
app.listen(PORT, () => {
    console.log(`Servidor do webhook rodando na porta ${PORT}`);
});
