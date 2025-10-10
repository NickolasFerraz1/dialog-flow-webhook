// index.js

const express = require('express');
const app = express();

// O Dialogflow envia requisições em JSON.
// Este middleware garante que nosso servidor Express consiga interpretar o corpo (body) da requisição.
app.use(express.json());

// Define a porta do servidor. O Render e outros serviços de hospedagem
// fornecem a porta através da variável de ambiente PORT.
const PORT = process.env.PORT || 3000;

// Cria o endpoint '/webhook' que receberá as requisições POST do Dialogflow
app.post('/webhook', (req, res) => {
  // Log para depuração: mostra o corpo da requisição recebida do Dialogflow.
  // ESSENCIAL para ver se os dados estão chegando corretamente.
  console.log('Requisição recebida do Dialogflow:');
  console.log(JSON.stringify(req.body, null, 2));

  // Extrai o nome da Intent da requisição.
  const intentName = req.body.queryResult.intent.displayName;

  // --- LÓGICA PRINCIPAL DO WEBHOOK ---
  // Verifica se a Intent é a que queremos tratar.
  if (intentName === 'AbrirChamadoSuporte') {
    // 1. Extrair parâmetros enviados pelo Dialogflow
    const nome = req.body.queryResult.parameters.nome;
    const descricaoProblema = req.body.queryResult.parameters.descricao_problema;

    // 2. Validar os dados recebidos (exemplo simples)
    if (!nome || !descricaoProblema) {
      // Se algum dado estiver faltando, retorna uma mensagem de erro.
      const response = {
        fulfillmentMessages: [{
          text: {
            text: ['Parece que o seu nome ou a descrição do problema não foram informados. Por favor, tente novamente.']
          },
        }, ],
      };
      return res.json(response);
    }

    // 3. Executar a lógica de negócio (gerar número do chamado)
    const numeroChamado = Math.floor(100000 + Math.random() * 900000); // Gera um número aleatório de 6 dígitos

    // 4. Montar a resposta no formato que o Dialogflow espera
    const mensagemConfirmacao = `Ok, ${nome.name || nome}! Seu chamado sobre "${descricaoProblema}" foi aberto com sucesso. O número do seu ticket é ${numeroChamado}.`;

    const response = {
      fulfillmentMessages: [{
        text: {
          text: [mensagemConfirmacao]
        },
      }, ],
    };

    // Envia a resposta de volta para o Dialogflow
    return res.json(response);

  } else {
    // Se a Intent não for a esperada, retorna uma resposta padrão.
    const response = {
      fulfillmentMessages: [{
        text: {
          text: [`Desculpe, não consegui processar sua solicitação. A intent "${intentName}" não é tratada por este webhook.`]
        },
      }, ],
    };
    return res.json(response);
  }
});

// Inicia o servidor para escutar as requisições
app.listen(PORT, () => {
  console.log(`Servidor do webhook rodando na porta ${PORT}`);
});