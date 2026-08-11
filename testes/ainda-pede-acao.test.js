/* ============================================================
   Teste de regressão de "esta linha ainda pede ação?".

   O BUG QUE ORIGINOU ISTO
   O filtro "Atrasados" da aba Terceirizadas listava 8 serviços — e três deles
   estavam CONTRATADOS. O cartão ATRASADOS contava os mesmos 8. Depois de
   contratado o prazo não vence mais: o serviço estava resolvido e continuava
   sendo cobrado na tela.

   A linha já sabia: a coluna Situação mostrava "—" e a Ação mostrava
   "✓ contratado". Quem não sabia era o KPI e o filtro, que perguntavam o farol
   direto, sem olhar se a linha estava encerrada.

   POR QUE ISSO É PIOR QUE UM NÚMERO ERRADO
   A aba Relatório e o e-mail diário SEMPRE checaram `!contratado` antes do
   farol. Então a mesma obra tinha duas contagens de atrasado ao mesmo tempo,
   dependendo de onde se olhasse — e a que aparecia primeiro, na tela de
   trabalho, era a errada. Quem confere prazo na reunião de obra abre a aba, não
   o e-mail.

   O que este teste trava: a regra tem UM dono (`encerrada` / `farolAtivo` /
   `prioridadeAtiva`) e todos os pontos que contam ou filtram passam por ele.

   Rodar:  node testes/ainda-pede-acao.test.js
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP = path.join(__dirname, '..', 'app.js');
const app = fs.readFileSync(APP, 'utf8');

let falhas = 0, total = 0;
function conferir(nome, obtido, esperado) {
  total++;
  const a = JSON.stringify(obtido), b = JSON.stringify(esperado);
  if (a !== b) {
    falhas++;
    console.error(`  ✗ ${nome}\n      esperado: ${b}\n      obtido:   ${a}`);
  }
}
function exigir(nome, condicao) { conferir(nome, !!condicao, true); }

function fatia(de, ate) {
  const i = app.indexOf(de), j = app.indexOf(ate);
  if (i < 0) throw new Error(`trecho não encontrado em app.js: ${de}`);
  if (j < i) throw new Error(`fim não encontrado depois de ${de}: ${ate}`);
  return app.slice(i, j);
}

// As funções reais, na ordem em que dependem umas das outras.
const ctx = { S: null };
vm.createContext(ctx);
vm.runInContext(
  fatia('function hojeISO', 'function dataBase') +
  fatia('function dataBase', 'const moedaBR') +
  fatia('function temMovimento', 'const LEGENDA'), ctx);
const { encerrada, farolAtivo, prioridadeAtiva, farolDe, prioridadeDe } = ctx;

// Data-base congelada: o teste não pode mudar de resultado amanhã.
ctx.S = { obra: { data_base: '2026-08-11', alerta_atencao_dias: 5, urgente_dias: 3, proximo_dias: 10 } };

const VENCIDO = '2026-07-14';   // bem no passado da data-base
const LONGE   = '2027-06-30';   // bem no futuro

const ctrPendente   = { prazo_contratacao: VENCIDO, status_processo: 'PENDENTE' };
const ctrCotando    = { prazo_contratacao: VENCIDO, status_processo: 'EM COTAÇÃO' };
const ctrContratado = { prazo_contratacao: VENCIDO, status_processo: 'CONTRATADO', contratado: true };
const ctrSoStatus   = { prazo_contratacao: VENCIDO, status_processo: 'CONTRATADO' };
const ctrNA         = { prazo_contratacao: VENCIDO, status_processo: 'NÃO SE APLICA' };
const ctrNoPrazo    = { prazo_contratacao: LONGE,   status_processo: 'PENDENTE' };

console.log('Contratações');
conferir('vencida e pendente continua ATRASADO', farolAtivo(ctrPendente), 'ATRASADO');
conferir('vencida e em cotação continua ATRASADO', farolAtivo(ctrCotando), 'ATRASADO');
conferir('CONTRATADA não é mais atrasada', farolAtivo(ctrContratado), null);
conferir('status CONTRATADO sozinho já encerra', farolAtivo(ctrSoStatus), null);
conferir('NÃO SE APLICA não é atrasada', farolAtivo(ctrNA), null);
conferir('no prazo não é atrasada', farolAtivo(ctrNoPrazo) === 'ATRASADO', false);
// O farol cru continua existindo — é dele que a linha encerrada não depende mais.
conferir('o farol cru da contratada segue ATRASADO (a linha é que ignora)',
  farolDe(ctrContratado), 'ATRASADO');

console.log('Materiais');
const matPendente = { data_limite_compra: VENCIDO, status_compra: 'PENDENTE' };
const matComprado = { data_limite_compra: VENCIDO, status_compra: 'COMPRADO', comprado: true };
const matEntregue = { data_limite_compra: VENCIDO, status_compra: 'ENTREGUE' };
const matNA       = { data_limite_compra: VENCIDO, status_compra: 'NÃO SE APLICA' };
conferir('vencido e pendente continua ATRASADO', prioridadeAtiva(matPendente), 'ATRASADO');
conferir('COMPRADO não é mais atrasado', prioridadeAtiva(matComprado), null);
conferir('ENTREGUE não é mais atrasado', prioridadeAtiva(matEntregue), null);
conferir('NÃO SE APLICA não é atrasado', prioridadeAtiva(matNA), null);
conferir('a prioridade crua do comprado segue ATRASADO',
  prioridadeDe(matComprado), 'ATRASADO');

console.log('A cena da tela');
// Reprodução do que a captura mostrava: 8 vencidas, 3 já contratadas.
const listaDaTela = [
  ctrPendente, ctrPendente, ctrPendente, ctrCotando, ctrCotando,
  ctrContratado, ctrContratado, ctrContratado,
];
conferir('o cartão ATRASADOS conta 5, não 8',
  listaDaTela.filter(c => farolAtivo(c) === 'ATRASADO').length, 5);
conferir('somar sem a regra daria os 8 do bug',
  listaDaTela.filter(c => farolDe(c) === 'ATRASADO').length, 8);

console.log('Todos os pontos que contam ou filtram');
// Se um `=== 'ATRASADO'` voltar a perguntar o farol cru, o bug volta junto.
const cruas = app.match(/farolDe\(c\) === '(ATRASADO|ATENÇÃO)'/g) || [];
conferir('nenhum KPI compara o farol cru com ATRASADO/ATENÇÃO', cruas.length, 0);
const cruasMat = app.match(/includes\(prioridadeDe\(m\)\)/g) || [];
conferir('nenhum KPI de material usa a prioridade crua', cruasMat.length, 0);

exigir('o KPI de atrasados usa farolAtivo',
  /const atras = todos\.filter\(c => farolAtivo\(c\) === 'ATRASADO'\)/.test(app));
exigir('o KPI de atenção usa farolAtivo',
  /const aten = todos\.filter\(c => farolAtivo\(c\) === 'ATENÇÃO'\)/.test(app));
exigir('o filtro de contratações usa farolAtivo',
  /const linhas = todos\.filter\(c => \{\s*\n\s*const f = farolAtivo\(c\);/.test(app));
exigir('o KPI de urgentes usa prioridadeAtiva',
  /const urgentes = todos\.filter\(m => \['ATRASADO', 'URGENTE'\]\.includes\(prioridadeAtiva\(m\)\)\)/.test(app));
exigir('o filtro de materiais usa prioridadeAtiva',
  /const linhas = todos\.filter\(m => \{\s*\n\s*const p = prioridadeAtiva\(m\);/.test(app));
exigir('a lista "exige ação" do Relatório usa farolAtivo',
  /ctrAcao = ctr\.filter\(c => \['ATRASADO', 'ATENÇÃO'\]\.includes\(farolAtivo\(c\)\)\)/.test(app));
exigir('a lista de materiais do Relatório usa prioridadeAtiva',
  /matAcao = mat\.filter\(m => \['ATRASADO', 'URGENTE'\]\.includes\(prioridadeAtiva\(m\)\)\)/.test(app));
exigir('a tabela por serviço do Relatório usa farolAtivo',
  /const pend = ms\.filter\(m => !m\.comprado\)\.length;\s*\n\s*const f = farolAtivo\(c\);/.test(app));

console.log('Uma definição só');
// As duas linhas desenhadas têm de perguntar à mesma função. Redefinir
// "encerrado" localmente é como o desacordo começou.
conferir('as duas linhas usam o helper compartilhado',
  (app.match(/const encerrado = encerrada\(/g) || []).length, 2);
conferir('nenhuma linha redefine a regra na mão',
  (app.match(/const encerrado = estado === 'fechado'/g) || []).length, 0);

console.log(falhas ? `\n✗ ${falhas} de ${total} verificações falharam` : `\n✓ ${total}/${total} verificações passaram`);
process.exit(falhas ? 1 : 0);
