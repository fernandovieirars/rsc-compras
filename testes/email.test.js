/* ============================================================
   Teste de regressão do envio de e-mail.

   O alerta passou a sair pelo Microsoft Graph. Duas coisas nesse caminho
   quebram calado — quebram no e-mail de alguém, dias depois, e não na tela de
   quem mexeu:

   1. ACENTUAÇÃO. O corpo vai ao Graph em JSON puro-ASCII. Se alguém "limpar" o
      código trocando jsonAscii por JSON.stringify, o e-mail continua sendo
      enviado e continua sendo aceito — só chega com "ATENÇÃO" ilegível, na
      linha que justamente pede ação. Nenhum erro aparece em lugar nenhum.

   2. ESCOLHA DO TRANSPORTE. Sem os secrets do Graph a função cai no Resend.
      Trocar o sentido dessa decisão faz o alerta voltar a sair pelo remetente
      de teste, que só entrega ao dono da conta — o defeito que a migração
      existiu para corrigir.

   Como os testes deste repo, este recorta as funções REAIS do index.ts em vez
   de recopiá-las aqui: cópia diverge do original sem avisar.

   Rodar:  node testes/email.test.js
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const CAMINHO = path.join(__dirname, '..', 'supabase', 'functions', 'alerta-compras-diario', 'index.ts');
const fonte = fs.readFileSync(CAMINHO, 'utf8');

let falhas = 0, total = 0;
function conferir(nome, obtido, esperado) {
  total++;
  if (obtido !== esperado) {
    falhas++;
    console.error(`  ✗ ${nome}\n      esperado: ${JSON.stringify(esperado)}\n      obtido:   ${JSON.stringify(obtido)}`);
  }
}
function exigir(nome, condicao) {
  conferir(nome, !!condicao, true);
}

// Recorta uma função do fonte TypeScript pelo nome, até a chave que a fecha na
// coluna zero, e tira as anotações de tipo — o Node não as entende.
function recortar(nomeFn) {
  const inicio = fonte.indexOf(`function ${nomeFn}`);
  if (inicio < 0) throw new Error(`função ${nomeFn} não encontrada em ${CAMINHO}`);
  const fim = fonte.indexOf('\n}\n', inicio);
  if (fim < 0) throw new Error(`fim da função ${nomeFn} não encontrado`);
  return fonte.slice(inicio, fim + 3)
    .replace(/:\s*unknown/g, '')
    .replace(/:\s*string/g, '')
    .replace(/:\s*boolean/g, '')
    .replace(/:\s*'graph'\s*\|\s*'resend'/g, '');
}

const ctx = {};
vm.createContext(ctx);
vm.runInContext(recortar('jsonAscii') + '\n' + recortar('escolherTransporte'), ctx);
const { jsonAscii, escolherTransporte } = ctx;

/* ---- 1. O JSON que vai ao Graph é puro ASCII ---- */
console.log('\nAcentuação no corpo enviado ao Graph');

const acentuado = {
  message: {
    subject: '🔴 Escola Ambev: 3 a contratar, 7 a comprar',
    body: { content: '<b>ATENÇÃO</b> · PRÓXIMO · contratações e manutenção' },
  },
};
const cru = jsonAscii(acentuado);

const foraDoAscii = [...cru].filter((c) => c.charCodeAt(0) > 0x7f);
conferir('nenhum byte acima de 0x7F sobra no JSON', foraDoAscii.length, 0);

/* ---- 2. …e ainda assim volta idêntico ---- */
// Escapar não pode ser mutilar. Esta é a verificação que pega o erro de verdade:
// um escape errado passa no teste acima (é ASCII) e chega ilegível no e-mail.
const volta = JSON.parse(cru);
conferir('acentos voltam intactos', volta.message.body.content,
  '<b>ATENÇÃO</b> · PRÓXIMO · contratações e manutenção');
conferir('emoji do assunto sobrevive ao par substituto', volta.message.subject,
  '🔴 Escola Ambev: 3 a contratar, 7 a comprar');
conferir('cedilha e til isolados', JSON.parse(jsonAscii({ x: 'ção ã õ é ê à' })).x, 'ção ã õ é ê à');
conferir('ASCII puro não é tocado', JSON.parse(jsonAscii({ x: 'OK 123' })).x, 'OK 123');

/* ---- 3. Escolha do transporte ---- */
console.log('\nEscolha do transporte');
conferir('com os secrets do Graph → graph', escolherTransporte(true), 'graph');
conferir('sem os secrets do Graph → resend', escolherTransporte(false), 'resend');

/* ---- 4. O fonte continua ligando as pontas ---- */
// Verificações sobre o texto do módulo. As funções acima podem estar perfeitas e
// mesmo assim não serem usadas no caminho do envio.
console.log('\nLigação no fonte');
exigir('o envio pelo Graph usa jsonAscii, não JSON.stringify',
  /body:\s*jsonAscii\(/.test(fonte));
exigir('os três secrets do Graph decidem TEM_GRAPH',
  /TEM_GRAPH\s*=\s*!!\(GRAPH_TENANT\s*&&\s*GRAPH_CLIENT\s*&&\s*GRAPH_SECRET\)/.test(fonte));
exigir('o remetente padrão é o do domínio da empresa',
  /GRAPH_FROM'\)\s*\|\|\s*'noreply@riosulconstrucoes\.com\.br'/.test(fonte));
exigir('o Graph só é dado por bom no 202',
  /r\.status\s*!==\s*202/.test(fonte));
// Precisa olhar o insert, não o fonte inteiro: `via: r.via` também aparece na
// resposta HTTP da função, e essa segunda ocorrência mascarava a perda do
// registro no log.
const blocoLog = (() => {
  const i = fonte.indexOf("from('compras_envio_log').insert(");
  return i < 0 ? '' : fonte.slice(i, fonte.indexOf('});', i));
})();
exigir('o insert no log foi encontrado', blocoLog.length > 0);
exigir('o transporte usado é gravado no log', /via:\s*r\.via/.test(blocoLog));
exigir('o HTML declara charset utf-8',
  /<meta charset="utf-8">/.test(fonte));
// O ?diag=1 é público como o resto da função. Ele pode dizer se um segredo
// existe; não pode dizer qual é. Aqui se olha o bloco do diagnóstico e se cobra
// que as constantes que GUARDAM valor não apareçam soltas dentro dele.
const blocoDiag = (() => {
  const i = fonte.indexOf("get('diag')");
  return i < 0 ? '' : fonte.slice(i, fonte.indexOf('}\n', fonte.indexOf('return new Response', i)));
})();
exigir('o bloco do diagnóstico foi encontrado', blocoDiag.length > 0);
exigir('o diagnóstico não toca na constante do client secret',
  !/\bGRAPH_SECRET\b/.test(blocoDiag));
exigir('o diagnóstico só testa a existência da chave do Resend, não a emite',
  !/\bRESEND_KEY\b/.test(blocoDiag.replace(/!!RESEND_KEY/g, '')));

/* ---- Resultado ---- */
console.log(`\n${falhas ? '✗' : '✓'} ${total - falhas}/${total} verificações passaram\n`);
process.exit(falhas ? 1 : 0);
