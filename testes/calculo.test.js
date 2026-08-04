/* ============================================================
   Teste de regressão do cálculo de prazos.

   O app reescreveu em JavaScript as fórmulas que viviam nas planilhas. Este
   teste prova que a tradução ficou fiel: alimenta as funções com os prazos
   reais da obra e compara com o que o PRÓPRIO Excel calculou nas colunas de
   fórmula (testes/planilhas.fixture.json, extraído dos arquivos de origem).

   Se alguém mexer nas janelas de alerta e quebrar a equivalência, quebra aqui.

   Rodar:  node testes/calculo.test.js
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Carrega só as funções puras do app.js. Executar o arquivo inteiro exigiria
// DOM, fetch e localStorage; aqui interessa a aritmética de datas.
const fonte = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const trecho = fonte.slice(
  fonte.indexOf('function hojeISO'),
  fonte.indexOf('function dataBase')
) + `
function fmtData(iso){ if(!iso) return ''; const [a,m,d]=String(iso).slice(0,10).split('-'); return d+'/'+m+'/'+a; }
`;
const ctx = {};
vm.createContext(ctx);
vm.runInContext(trecho, ctx);
const { diasEntre, farolContratacao, prioridadeMaterial, acaoContratacao, acaoMaterial, hojeISO } = ctx;

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'planilhas.fixture.json'), 'utf8'));

let falhas = 0, total = 0;
function conferir(nome, obtido, esperado) {
  total++;
  if (obtido !== esperado) {
    falhas++;
    console.error(`  ✗ ${nome}\n      esperado: ${JSON.stringify(esperado)}\n      obtido:   ${JSON.stringify(obtido)}`);
  }
}

/* ---- 1. Aritmética de datas ---- */
console.log('\nAritmética de datas');
conferir('mesmo dia = 0', diasEntre('2026-08-04', '2026-08-04'), 0);
conferir('dia seguinte = 1', diasEntre('2026-08-04', '2026-08-05'), 1);
conferir('passado = negativo', diasEntre('2026-08-04', '2026-08-01'), -3);
conferir('atravessa o mês', diasEntre('2026-08-25', '2026-09-01'), 7);
conferir('ano bissexto', diasEntre('2028-02-28', '2028-03-01'), 2);
// O horário de verão já produziu erro de ±1 dia em contas de data feitas com
// datas locais. Estas duas travam a comparação em UTC.
conferir('início do horário de verão', diasEntre('2026-10-17', '2026-10-19'), 2);
conferir('fim do horário de verão', diasEntre('2027-02-20', '2027-02-22'), 2);
conferir('data vazia', diasEntre(null, '2026-08-04'), null);
conferir('hojeISO tem formato ISO', /^\d{4}-\d{2}-\d{2}$/.test(hojeISO()), true);

/* ---- 2. Farol das contratações, contra o Excel ---- */
const c = fixture.contratacoes;
console.log(`\nFarol das contratações — ${c.casos.length} casos, data-base ${c.data_base}`);
for (const caso of c.casos) {
  conferir(`item ${caso.item} (prazo ${caso.prazo})`,
    farolContratacao(caso.prazo, c.data_base, c.alerta_atencao_dias), caso.situacao);
}

/* ---- 3. Prioridade e ação dos materiais, contra o Excel ---- */
const m = fixture.materiais;
console.log(`\nPrioridade dos materiais — ${m.casos.length} casos, data-base ${m.data_base}`);
for (const caso of m.casos) {
  const p = prioridadeMaterial(caso.limite, m.data_base, m.urgente_dias, m.proximo_dias);
  conferir(`item ${caso.item} prioridade (limite ${caso.limite})`, p, caso.prioridade);
  conferir(`item ${caso.item} ação`, acaoMaterial(caso.limite, p), caso.acao);
}

/* ---- 4. Limites exatos das janelas ---- */
// A planilha usa <= nas duas bordas. Um item que vence HOJE ainda é urgente,
// não atrasado — errar isso faria compras perder o último dia útil de reação.
console.log('\nBordas das janelas');
const base = '2026-08-04';
conferir('vence hoje → URGENTE', prioridadeMaterial('2026-08-04', base, 3, 10), 'URGENTE');
conferir('venceu ontem → ATRASADO', prioridadeMaterial('2026-08-03', base, 3, 10), 'ATRASADO');
conferir('exatamente 3 dias → URGENTE', prioridadeMaterial('2026-08-07', base, 3, 10), 'URGENTE');
conferir('4 dias → PRÓXIMO', prioridadeMaterial('2026-08-08', base, 3, 10), 'PRÓXIMO');
conferir('exatamente 10 dias → PRÓXIMO', prioridadeMaterial('2026-08-14', base, 3, 10), 'PRÓXIMO');
conferir('11 dias → PROGRAMADO', prioridadeMaterial('2026-08-15', base, 3, 10), 'PROGRAMADO');
conferir('contratação vence hoje → ATENÇÃO', farolContratacao('2026-08-04', base, 5), 'ATENÇÃO');
conferir('contratação venceu ontem → ATRASADO', farolContratacao('2026-08-03', base, 5), 'ATRASADO');
conferir('contratação em 5 dias → ATENÇÃO', farolContratacao('2026-08-09', base, 5), 'ATENÇÃO');
conferir('contratação em 6 dias → OK', farolContratacao('2026-08-10', base, 5), 'OK');
conferir('sem prazo → sem farol', farolContratacao(null, base, 5), null);

/* ---- 5. Texto da ação ---- */
// Na planilha de contratação esta coluna era digitada à mão e tinha divergência
// (um item dizia "OK" com o farol em ATENÇÃO). Aqui a regra é única.
console.log('\nTexto da ação');
conferir('contratação atrasada', acaoContratacao('2026-08-01', 'ATRASADO'), 'CONTRATAR ATÉ 01/08/2026');
conferir('contratação em atenção', acaoContratacao('2026-08-07', 'ATENÇÃO'), 'CONTRATAR ATÉ 07/08/2026');
conferir('contratação tranquila', acaoContratacao('2026-09-30', 'OK'), 'OK');
conferir('sem prazo não pede nada', acaoContratacao(null, null), '');
conferir('material programado', acaoMaterial('2026-09-30', 'PROGRAMADO'), 'OK');
conferir('material urgente', acaoMaterial('2026-08-07', 'URGENTE'), 'COMPRAR ATÉ 07/08/2026');

/* ---- Resultado ---- */
console.log(`\n${falhas ? '✗' : '✓'} ${total - falhas}/${total} verificações passaram\n`);
process.exit(falhas ? 1 : 0);
