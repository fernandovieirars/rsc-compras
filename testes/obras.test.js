/* ============================================================
   Teste de regressão do acompanhamento com VÁRIAS obras.

   O app nasceu para uma obra só. Ao abrir para várias, três coisas passam a
   poder quebrar em silêncio — quebram na obra de outra pessoa, dias depois:

   1. QUAL OBRA ABRIR. Se `?obra=` deixar de mandar, um link errado abre OUTRA
      obra em vez de dar erro. Compras leria o prazo da obra errada achando que
      é a certa. É a falha mais cara do conjunto, e a mais silenciosa: a tela
      carrega normalmente.

   2. CRIAR OBRA POR INSERT. A tabela `compras_obra` é somente-leitura para o
      app desde a 0006 — quem escreve nela escreve em `data_base`, e data-base
      preenchida congela o farol num dia fixo. Além disso o guarda de
      permissões da 0007 revoga qualquer `grant insert` na tabela em até uma
      hora, então um insert direto passaria no teste de hoje e quebraria no
      canteiro amanhã. O caminho tem de ser a RPC.

   3. ALERTA DE OBRA VAZIA. Obra recém-cadastrada não tem planilha. Sem a
      guarda, o alerta diário manda um panorama de tabelas vazias todo dia para
      a lista copiada — e ruído diário ensina a lista a ignorar o alerta.

   Como os outros testes do repo, este recorta o código REAL em vez de recopiar
   a regra aqui: cópia diverge do original sem avisar.

   Rodar:  node testes/obras.test.js
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP = path.join(__dirname, '..', 'app.js');
const FN = path.join(__dirname, '..', 'supabase', 'functions', 'alerta-compras-diario', 'index.ts');
const MIG = path.join(__dirname, '..', 'supabase', 'migrations', '0011_criar_obra_pelo_app.sql');

const app = fs.readFileSync(APP, 'utf8');
const fn = fs.readFileSync(FN, 'utf8');
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

/* ---- 1. Qual obra abrir ---- */

const inicio = app.indexOf('function escolherObra');
if (inicio < 0) throw new Error('função escolherObra não encontrada em app.js');
const ctx = {};
vm.createContext(ctx);
vm.runInContext(app.slice(inicio, app.indexOf('\n}\n', inicio) + 3), ctx);
const { escolherObra } = ctx;

const OBRAS = [
  { slug: 'escola-ambev', nome: 'Escola — Obra Ambev' },
  { slug: 'ufes-goiabeiras', nome: 'Reforma UFES' },
];
const nome = o => (o ? o.slug : null);

console.log('Qual obra abrir');
conferir('?obra= manda, mesmo com outra lembrada',
  nome(escolherObra(OBRAS, 'ufes-goiabeiras', 'escola-ambev')), 'ufes-goiabeiras');
conferir('?obra= inexistente devolve nulo (o app transforma em erro), NUNCA outra obra',
  nome(escolherObra(OBRAS, 'obra-que-nao-existe', 'escola-ambev')), null);
conferir('sem ?obra=, vale a última aberta neste aparelho',
  nome(escolherObra(OBRAS, null, 'ufes-goiabeiras')), 'ufes-goiabeiras');
conferir('lembrança apontando para obra que sumiu cai na primeira',
  nome(escolherObra(OBRAS, null, 'obra-removida')), 'escola-ambev');
conferir('primeira visita, sem nada guardado, cai na primeira',
  nome(escolherObra(OBRAS, null, null)), 'escola-ambev');
conferir('lista vazia não estoura', nome(escolherObra([], null, null)), null);

/* ---- 2. Criar obra é RPC, não insert ---- */

console.log('Criação de obra');
exigir('o app chama a RPC compras_criar_obra',
  /api\(\s*['"]rpc\/compras_criar_obra['"]/.test(app));
exigir('o app NÃO insere direto em compras_obra',
  !/api\(\s*['"]compras_obra['"]\s*,\s*\{\s*method:\s*['"]POST/.test(app));
exigir('a data_base não é enviada pelo app em nenhuma chamada de criação',
  !/p_data_base|data_base\s*:/.test(app.slice(app.indexOf('async function criarObra'),
                                              app.indexOf('function blocoPrimeiraImportacao'))));

console.log('Migration 0011');

// Tudo daqui para baixo é conferido contra o SQL EXECUTÁVEL — sem os
// comentários `--` e sem os textos de `comment on`. O cabeçalho desta migration
// explica em prosa por que a função é `security definer` e por que `data_base`
// ficou de fora; conferir o arquivo cru faria o teste passar por causa da
// explicação, mesmo com o código dizendo o contrário. Foi exatamente o que
// aconteceu na primeira versão deste teste.
const migExecutavel = mig
  .replace(/comment on [\s\S]*?;/gi, '')
  .split('\n').filter(l => !l.trim().startsWith('--')).join('\n');

exigir('a RPC é security definer', /^security definer$/m.test(migExecutavel));
exigir('o insert da RPC lista só slug, nome, cliente e término',
  /insert into public\.compras_obra \(slug, nome, cliente, termino_obra\)/.test(migExecutavel));
exigir('nenhum comando da migration toca em data_base', !migExecutavel.includes('data_base'));
exigir('execute concedido ao anon (o app não tem login)',
  /grant execute on function public\.compras_criar_obra[^;]*to anon/i.test(migExecutavel));
exigir('a RPC deriva o slug pela função do banco, não por conta própria',
  /public\.compras_slug\(v_nome\)/.test(migExecutavel));

/* ---- 3. Obra sem planilha não vira e-mail vazio ---- */

console.log('Alerta diário');
const trecho = fn.slice(fn.indexOf('for (const obra of obras'), fn.indexOf('const resumo ='));
exigir('obra sem contratações e sem materiais é pulada',
  /if \(!contratacoes\.length && !materiais\.length\)/.test(trecho));
exigir('a obra pulada aparece no relatório, para o pulo não ser invisível',
  /relatorio\.push\(\{[^}]*planilha ainda não importada/.test(trecho));
exigir('a guarda vem ANTES de montar o html',
  trecho.indexOf('!contratacoes.length && !materiais.length') < trecho.indexOf('montarHtml'));

console.log(falhas ? `\n✗ ${falhas} de ${total} verificações falharam` : `\n✓ ${total}/${total} verificações passaram`);
process.exit(falhas ? 1 : 0);
