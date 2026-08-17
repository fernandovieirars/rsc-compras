/* ============================================================
   Teste de regressão de QUEM ASSINA a edição.

   O bug que este teste tranca: o app guardava o nome "para sempre" no
   aparelho. No tablet do canteiro, alguém digitava "Fernando" uma vez e daí
   TODA edição de TODO mundo saía como Fernando — o histórico virava ficção.

   Sem login não dá para provar identidade; dá para parar de assumir. Duas
   travas, conferidas aqui contra o código REAL (recortado, não recopiado):

     1. A identidade VENCE. `identidadeFresca()` só confia no nome enquanto ele
        foi confirmado há menos que `JANELA_IDENTIDADE`. Passou disso,
        `exigirNome()` volta a perguntar — quem senta depois do intervalo se
        identifica em vez de herdar o nome anterior. Cada gravação renova o
        prazo (`renovarIdentidade`), então quem edita seguido não é interrompido.

     2. O campo NÃO vem preenchido. Reaproveitar o nome anterior tem de ser um
        clique consciente ("sou eu"), nunca o padrão silencioso que gerou o bug.

   Rodar:  node testes/identidade.test.js
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP = path.join(__dirname, '..', 'app.js');
const IMP = path.join(__dirname, '..', 'importar.js');
const app = fs.readFileSync(APP, 'utf8');
const imp = fs.readFileSync(IMP, 'utf8');

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

/* ---- Recorta as funções reais e roda com stubs ---- */

function recorteBloco(fonte, assinatura) {
  const i = fonte.indexOf(assinatura);
  if (i < 0) throw new Error('não achei em app.js: ' + assinatura);
  return fonte.slice(i, fonte.indexOf('\n}\n', i) + 3);
}
function recorteLinha(fonte, assinatura) {
  const i = fonte.indexOf(assinatura);
  if (i < 0) throw new Error('não achei em app.js: ' + assinatura);
  return fonte.slice(i, fonte.indexOf('\n', i) + 1);
}

let RELOGIO = 1_700_000_000_000;
const guardado = {};
const ctx = {
  S: { eu: '', euEm: 0 },
  Date: { now: () => RELOGIO },
  localStorage: {
    getItem: k => (k in guardado ? guardado[k] : null),
    setItem: (k, v) => { guardado[k] = String(v); },
  },
  _resolverNome: null,
  perguntou: undefined,
  perguntarQuemSou: obrigatorio => { ctx.perguntarQuemSou.chamado = obrigatorio; },
};
ctx.perguntarQuemSou.chamado = undefined;
vm.createContext(ctx);
vm.runInContext([
  // `const` no topo de um script vm fica no escopo do script, não no contexto;
  // vira atribuição global para o teste enxergar o valor e as funções o usarem.
  recorteLinha(app, 'const JANELA_IDENTIDADE =').replace('const ', ''),
  recorteBloco(app, 'function identidadeFresca'),
  recorteBloco(app, 'function renovarIdentidade'),
  recorteBloco(app, 'function exigirNome'),
].join('\n'), ctx);

const JANELA = ctx.JANELA_IDENTIDADE;
exigir('JANELA_IDENTIDADE é um número de ms plausível (minutos, não dias)',
  Number.isFinite(JANELA) && JANELA >= 60_000 && JANELA <= 6 * 60 * 60_000);

console.log('identidadeFresca — o nome vence quando o tablet troca de mãos');
ctx.S.eu = ''; ctx.S.euEm = 0;
conferir('sem nenhum nome, nunca é fresca', ctx.identidadeFresca(), false);

ctx.S.eu = 'Fernando'; ctx.S.euEm = RELOGIO;
conferir('nome recém-confirmado é fresca', ctx.identidadeFresca(), true);

ctx.S.euEm = RELOGIO - (JANELA - 1000);
conferir('dentro da janela, ainda fresca', ctx.identidadeFresca(), true);

ctx.S.euEm = RELOGIO - (JANELA + 1000);
conferir('passada a janela, VENCE (o próximo se reidentifica)', ctx.identidadeFresca(), false);

console.log('renovarIdentidade — editar estende o prazo');
ctx.S.eu = 'Marina'; ctx.S.euEm = RELOGIO - JANELA * 2;
RELOGIO += 5000;
ctx.renovarIdentidade();
conferir('renova o carimbo para agora', ctx.S.euEm, RELOGIO);
conferir('persiste o carimbo no aparelho', guardado['rsc_compras_quem_em'], String(RELOGIO));
conferir('depois de renovar, volta a ser fresca', ctx.identidadeFresca(), true);

ctx.S.eu = ''; const antes = guardado['rsc_compras_quem_em'];
ctx.renovarIdentidade();
conferir('sem nome, renovar não grava carimbo órfão', guardado['rsc_compras_quem_em'], antes);

console.log('exigirNome — só passa direto quando a identidade está fresca');
ctx.perguntarQuemSou.chamado = undefined;
ctx.S.eu = 'Fernando'; ctx.S.euEm = RELOGIO;
const passouDireto = ctx.exigirNome();
exigir('identidade fresca resolve sem reabrir a caixa', ctx.perguntarQuemSou.chamado === undefined);
passouDireto.then(v => exigir('resolve true quando fresca', v === true));

ctx.perguntarQuemSou.chamado = undefined;
ctx.S.eu = 'Fernando'; ctx.S.euEm = RELOGIO - (JANELA + 1000);
ctx.exigirNome();
conferir('identidade vencida REABRE a caixa (obrigatória)', ctx.perguntarQuemSou.chamado, true);

ctx.perguntarQuemSou.chamado = undefined;
ctx.S.eu = ''; ctx.S.euEm = 0;
ctx.exigirNome();
conferir('sem nome nenhum, também exige a caixa', ctx.perguntarQuemSou.chamado, true);

/* ---- Checagens estáticas: o padrão silencioso não pode voltar ---- */

console.log('app.js — a caixa não entrega o nome anterior de bandeja');
exigir('o campo de nome abre VAZIO (não pré-preenche com S.eu)',
  /id="campoNome"[^>]*value=""/.test(app));
exigir('não existe mais value="${esc(S.eu)}" no campo de nome',
  !/id="campoNome"[^>]*value="\$\{esc\(S\.eu\)\}"/.test(app));
exigir('exigirNome decide pela validade (identidadeFresca), não por S.eu truthy',
  /function exigirNome\(\)\s*\{\s*if \(identidadeFresca\(\)\)/.test(app));
exigir('reaproveitar o nome anterior é um clique explícito ("sou eu")',
  /id="souEu"/.test(app) && /salvarQuemSou\(S\.eu\)/.test(app));
exigir('gravar renova a identidade após registrar o evento',
  app.indexOf('renovarIdentidade()') > app.indexOf('async function gravar'));

console.log('importar.js — importar também tem autor');
exigir('aplicarImportacao exige nome antes de aplicar',
  /async function aplicarImportacao[\s\S]*?if \(!await exigirNome\(\)\) return;/.test(imp));
exigir('e renova a identidade depois de aplicar',
  imp.includes('renovarIdentidade()'));

console.log(falhas ? `\n✗ ${falhas} de ${total} verificações falharam` : `\n✓ ${total}/${total} verificações passaram`);
process.exit(falhas ? 1 : 0);
