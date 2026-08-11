/* ============================================================
   Teste de regressão da referência de PC contada duas vezes.

   O ACHADO QUE ORIGINOU ISTO
   Na PC REV05 da Escola, a linha 2.6.3 (pintura de paredes) é a TOTALIDADE do
   pacote 14 (Pintura externa) e ao mesmo tempo está DENTRO do pacote 13
   (Pintura interna, bloco 2.6 completo). O app somava os 18 pacotes direto e
   exibia R$ 2.368.296,64 de "Referência PC" — R$ 58.770,77 a mais que os
   R$ 2.309.525,86 reais, 2,5% de inflação num número que vai para reunião.

   POR QUE ISSO QUEBRA CALADO
   Um total errado não tem sintoma: a tela carrega, a coluna soma, ninguém vê
   erro. Só aparece quando alguém compara com a PC na mão — foi assim que
   apareceu. Se um refactor trocar `pcReferencia(...)` por um `reduce` direto, o
   número volta a inflar sem nenhum aviso.

   E o inverso também precisa valer: a linha marcada NÃO pode sumir da tela nem
   perder a referência dela. Para o contrato da fachada aquele valor é real — é
   contra ele que a cotação vai ser comparada. Só o somatório muda.

   Rodar:  node testes/referencia-pc.test.js
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP = path.join(__dirname, '..', 'app.js');
const IMP = path.join(__dirname, '..', 'importar.js');
const MIG = path.join(__dirname, '..', 'supabase', 'migrations', '0012_referencia_compartilhada.sql');

const app = fs.readFileSync(APP, 'utf8');
const imp = fs.readFileSync(IMP, 'utf8');
const mig = fs.readFileSync(MIG, 'utf8');

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

/* ---- As funções reais de soma ---- */

const inicio = app.indexOf('function pcReferencia');
if (inicio < 0) throw new Error('função pcReferencia não encontrada em app.js');
const trecho = app.slice(inicio, app.indexOf('/* ---- KPIs ---- */'));
const ctx = {
  // A formatação curta não é o assunto do teste; basta ser reconhecível.
  fmtMoedaCurta: v => 'R$ ' + Math.round(v).toLocaleString('pt-BR'),
};
vm.createContext(ctx);
vm.runInContext(trecho, ctx);
const { pcReferencia, pcRepetida, pePcReferencia } = ctx;

// Os 18 pacotes da Escola, reduzidos ao que importa aqui. Valores reais da PC.
const ESCOLA = [
  { item: 13, valor_pc_total: 169994.71 },
  { item: 14, valor_pc_total: 58770.77, referencia_compartilhada: true },
  { item: 1, valor_pc_total: 112062.15 },
  { item: 2, valor_pc_total: 252106.16 },
];
const SEM_MARCA = ESCOLA.map(({ item, valor_pc_total }) => ({ item, valor_pc_total }));

console.log('Soma da referência');
conferir('a linha marcada fica fora do total',
  Number(pcReferencia(ESCOLA).toFixed(2)), 534163.02);
conferir('somando tudo daria o número inflado',
  Number(SEM_MARCA.reduce((s, c) => s + c.valor_pc_total, 0).toFixed(2)), 592933.79);
conferir('o que ficou de fora é exatamente o pacote 14',
  Number(pcRepetida(ESCOLA).toFixed(2)), 58770.77);
conferir('a diferença entre os dois é o valor repetido',
  Number((592933.79 - 534163.02).toFixed(2)), 58770.77);
conferir('sem nenhuma marca, nada é excluído',
  Number(pcReferencia(SEM_MARCA).toFixed(2)), 592933.79);
conferir('sem nenhuma marca, o rodapé volta ao texto neutro',
  pePcReferencia(SEM_MARCA), 'mão de obra + material');
exigir('com marca, o rodapé diz quanto ficou de fora',
  /sem R\$ 58\.771 de referência repetida/.test(pePcReferencia(ESCOLA)));
conferir('lista vazia não estoura', pcReferencia([]), 0);

/* ---- Os pontos de uso ---- */

console.log('Onde o total é calculado');
// Três lugares exibem a soma: KPI da aba Terceirizadas, KPI do Relatório e a
// linha do resumo. Nenhum pode voltar a somar direto.
// Conta só FORA das funções auxiliares — dentro delas a soma crua é o próprio
// trabalho. Deve sobrar exatamente uma: a comparação por contrato, que mantém a
// linha marcada de propósito (ver o comentário dela em app.js).
const foraDosAuxiliares = app.slice(0, inicio) + app.slice(app.indexOf('/* ---- KPIs ---- */'));
const somasCruas = foraDosAuxiliares.match(/reduce\(\(s, c\) => s \+ Number\(c\.valor_pc_total/g) || [];
conferir('fora das auxiliares, só resta a comparação por contrato', somasCruas.length, 1);
const ondeFechados = app.indexOf('const pcDosFechados');
exigir('a que resta é a pcDosFechados', ondeFechados > 0);
exigir('e a decisão de manter a linha nela está escrita logo acima',
  app.slice(Math.max(0, ondeFechados - 700), ondeFechados).includes('de propósito'));
conferir('as duas telas usam a função de soma',
  (app.match(/pcReferencia\((todos|ctr)\)/g) || []).length, 2);
exigir('o rodapé explicativo é usado nos dois cartões',
  (app.match(/pePcReferencia\((todos|ctr)\)/g) || []).length === 2);

console.log('O que NÃO pode mudar');
// Duas telas desenham a célula "Referência PC" — a aba Terceirizadas e a tabela
// do Relatório. AS DUAS têm de mostrar o valor cru da linha, marcada ou não;
// conferir só uma deixa passar a alteração feita na outra.
conferir('as duas telas exibem a referência da linha sem condicional',
  (app.match(/data-r="Referência PC" class="num">\$\{fmtMoeda\(c\.valor_pc_total\)\}/g) || []).length, 2);
exigir('a linha marcada ganha aviso visível na tela',
  /c\.referencia_compartilhada[\s\S]{0,220}já contada/.test(app));
// Filtrar a linha para fora da LISTA seria pior que o bug: some da tela o
// serviço que alguém precisa contratar.
exigir('a linha não é filtrada para fora da listagem',
  !/filter\([^)]*!c\.referencia_compartilhada[^)]*\)[\s\S]{0,40}map\(linha/.test(app));

console.log('Migration e importação');
exigir('a marca é amarrada a obra, item e atividade — não só ao número do item',
  /o\.slug = 'escola-ambev'[\s\S]*c\.item = 14[\s\S]*c\.atividade ilike 'Pintura externa%'/.test(mig));
exigir('a coluna nasce falsa, para obra nova não excluir nada por acidente',
  /referencia_compartilhada boolean not null default false/.test(mig));
exigir('o update é idempotente',
  /is distinct from true/.test(mig));
// Se a coluna entrasse em CAMPOS_PLANEJAMENTO, reimportar a planilha apagaria a
// marca e o total voltaria a inflar — semanas depois, sem ninguém ligar uma
// coisa à outra.
exigir('reimportar a planilha não apaga a marca',
  !imp.includes('referencia_compartilhada'));

console.log(falhas ? `\n✗ ${falhas} de ${total} verificações falharam` : `\n✓ ${total}/${total} verificações passaram`);
process.exit(falhas ? 1 : 0);
