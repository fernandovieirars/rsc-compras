/* ============================================================
   importar.js — reimportação das planilhas de origem

   POR QUE ISSO EXISTE
   O cronograma muda. Quando muda, os prazos-limite mudam junto e o
   planejamento gera as planilhas de novo. Sem este caminho, a única saída
   seria recomeçar o acompanhamento do zero — e perder toda a cotação que o
   setor de compras já tinha lançado.

   A REGRA QUE GOVERNA TUDO AQUI
   A planilha manda no PLANEJAMENTO (datas, quantidades, valores da PC).
   O app manda na EXECUÇÃO (fornecedor, cotação, status, compra, entrega).
   A importação nunca escreve numa coluna de execução, e nunca apaga linha:
   o que sumiu da planilha é desativado, não excluído.

   As chaves de reconciliação:
     contratações → nome da atividade
     materiais    → linha da PC + nome do material

   ANTECEDÊNCIA
   `antecedencia_dias` não está em CAMPOS_PLANEJAMENTO de propósito: a planilha
   não tem essa coluna, e o prazo de fabricação por pacote é decisão de compras,
   não do cronograma. Quem recalcula o prazo é o gatilho no banco (migration
   0009) — a data limite que vier da planilha é sobrescrita quando o pacote tem
   antecedência própria. Sem isso, reimportar devolvia todo mundo para 10 dias.
   ============================================================ */
'use strict';

const CAMPOS_PLANEJAMENTO = {
  contratacoes: ['item', 'data_inicio', 'data_termino', 'prazo_contratacao',
                 'linhas_pc_mo', 'valor_pc_mo', 'linhas_pc_material', 'valor_pc_material', 'obs_composicao'],
  materiais: ['item', 'atividade', 'unidade', 'quantidade', 'custo_unit_pc', 'custo_total_pc',
              'data_necessaria', 'data_limite_compra', 'observacoes'],
};

// Cabeçalhos das planilhas → colunas. Aceita variações de acento e caixa,
// porque a planilha é reescrita a cada revisão e o título raramente volta igual.
const DE_PARA = {
  contratacoes: {
    'item': 'item',
    'atividade terceirizada': 'atividade',
    'data de inicio da atividade': 'data_inicio',
    'data de termino da atividade': 'data_termino',
    'prazo final para contratacao': 'prazo_contratacao',
    'linhas pc mao de obra': 'linhas_pc_mo',
    'valor pc mao de obra': 'valor_pc_mo',
    'linhas pc material': 'linhas_pc_material',
    'valor pc material': 'valor_pc_material',
    'observacao da composicao pc': 'obs_composicao',
  },
  materiais: {
    'item': 'item',
    'atividade': 'atividade',
    'linha pc': 'linha_pc',
    'material item a comprar': 'material',
    'unidade': 'unidade',
    'quantidade pc': 'quantidade',
    'custo unitario de material pc': 'custo_unit_pc',
    'custo total de material pc': 'custo_total_pc',
    'data necessaria na obra': 'data_necessaria',
    'data limite para compra': 'data_limite_compra',
    'observacoes validacoes necessarias': 'observacoes',
  },
};

function normalizarCabecalho(s) {
  return String(s == null ? '' : s)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Converte o que vier (Date do SheetJS, serial do Excel, texto dd/mm/aaaa ou
// ISO) para 'YYYY-MM-DD'. O serial existe porque .xlsx guarda data como número
// de dias desde 30/12/1899.
function paraISO(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  if (typeof v === 'number') {
    const d = new Date(Date.UTC(1899, 11, 30) + v * 86400000);
    return d.toISOString().slice(0, 10);
  }
  const t = String(v).trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

function paraNumero(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  const limpo = String(v).trim().replace(/[R$\s]/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.');
  const n = Number(limpo);
  return isNaN(n) ? null : n;
}

/* ---- Leitura dos arquivos ---- */

// SheetJS só é buscado quando alguém realmente importa um .xlsx. O
// acompanhamento do dia a dia não depende de CDN nenhum.
let _sheetJS = null;
function carregarSheetJS() {
  if (_sheetJS) return _sheetJS;
  _sheetJS = new Promise((ok, falha) => {
    if (window.XLSX) return ok(window.XLSX);
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
    s.onload = () => ok(window.XLSX);
    s.onerror = () => falha(new Error('Não consegui carregar o leitor de .xlsx. Sem internet aberta para o CDN, salve a planilha como CSV e importe o CSV.'));
    document.head.appendChild(s);
  });
  return _sheetJS;
}

function lerCSV(texto) {
  // Parser pequeno mas correto no que importa: campo entre aspas com ";" e
  // quebra de linha dentro. Detecta o separador na primeira linha.
  const sep = (texto.split('\n')[0].match(/;/g) || []).length >= (texto.split('\n')[0].match(/,/g) || []).length ? ';' : ',';
  const linhas = [];
  let campo = '', linha = [], aspas = false;
  const t = texto.replace(/^﻿/, '');
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (aspas) {
      if (c === '"' && t[i + 1] === '"') { campo += '"'; i++; }
      else if (c === '"') aspas = false;
      else campo += c;
    } else if (c === '"') aspas = true;
    else if (c === sep) { linha.push(campo); campo = ''; }
    else if (c === '\n') { linha.push(campo); linhas.push(linha); linha = []; campo = ''; }
    else if (c !== '\r') campo += c;
  }
  if (campo !== '' || linha.length) { linha.push(campo); linhas.push(linha); }
  return linhas;
}

async function lerArquivo(arquivo) {
  if (/\.csv$/i.test(arquivo.name)) return lerCSV(await arquivo.text());
  const XLSX = await carregarSheetJS();
  const wb = XLSX.read(await arquivo.arrayBuffer(), { type: 'array', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
}

// As planilhas têm título, data-base e KPIs antes da tabela. A linha de
// cabeçalho é aquela cuja primeira célula é "Item" — é o que ancora a leitura
// sem depender de o cabeçalho estar sempre na mesma linha.
function extrairTabela(matriz, tipo) {
  const iCab = matriz.findIndex(l => l && normalizarCabecalho(l[0]) === 'item');
  if (iCab < 0) throw new Error('Não achei a linha de cabeçalho (a que começa com "Item"). Confirme se é a planilha certa.');

  const mapa = DE_PARA[tipo];
  const colunas = matriz[iCab].map(c => mapa[normalizarCabecalho(c)] || null);
  const esperadas = tipo === 'contratacoes' ? ['atividade', 'prazo_contratacao'] : ['linha_pc', 'material', 'data_limite_compra'];
  const faltando = esperadas.filter(e => !colunas.includes(e));
  if (faltando.length) throw new Error(`A planilha não tem as colunas: ${faltando.join(', ')}. Parece ser a outra planilha.`);

  const datas = new Set(['data_inicio', 'data_termino', 'prazo_contratacao', 'data_necessaria', 'data_limite_compra']);
  const numeros = new Set(['item', 'valor_pc_mo', 'valor_pc_material', 'quantidade', 'custo_unit_pc', 'custo_total_pc']);

  const linhas = [];
  for (let i = iCab + 1; i < matriz.length; i++) {
    const bruta = matriz[i];
    if (!bruta || bruta.every(c => c == null || c === '')) continue;
    const r = {};
    colunas.forEach((col, j) => {
      if (!col) return;
      const v = bruta[j];
      r[col] = datas.has(col) ? paraISO(v) : numeros.has(col) ? paraNumero(v) : (v == null || v === '' ? null : String(v).trim());
    });
    const chave = tipo === 'contratacoes' ? r.atividade : r.material;
    if (chave) linhas.push(r);
  }
  return linhas;
}

/* ---- Reconciliação ---- */
function chaveMaterial(r) {
  return `${(r.linha_pc || '').trim()}||${(r.material || '').trim()}`;
}

function conciliar(tipo, daPlanilha) {
  const atuais = tipo === 'contratacoes' ? S.contratacoes : S.materiais;
  const chaveDe = tipo === 'contratacoes' ? (r => (r.atividade || '').trim()) : chaveMaterial;
  const porChave = new Map(atuais.map(r => [chaveDe(r), r]));
  const vistas = new Set();

  const novas = [], mudadas = [], iguais = [];
  for (const r of daPlanilha) {
    const k = chaveDe(r);
    vistas.add(k);
    const atual = porChave.get(k);
    if (!atual) { novas.push(r); continue; }

    const patch = {};
    for (const campo of CAMPOS_PLANEJAMENTO[tipo]) {
      if (!(campo in r)) continue;
      const antes = atual[campo], depois = r[campo];
      const iguaisValores = (antes == null && depois == null) ||
        (typeof depois === 'number' ? Math.abs(Number(antes || 0) - depois) < 0.005 : String(antes ?? '') === String(depois ?? ''));
      if (!iguaisValores) patch[campo] = depois;
    }
    if (Object.keys(patch).length) mudadas.push({ atual, patch });
    else iguais.push(atual);
  }

  const sumiram = atuais.filter(r => !vistas.has(chaveDe(r)));
  return { novas, mudadas, iguais, sumiram };
}

/* ---- Interface ---- */
function abrirImportador(tipo) {
  const qual = tipo === 'contratacoes' ? 'Prazos de contratação' : 'Materiais a comprar';
  const fundo = document.createElement('div');
  fundo.className = 'fundo';
  fundo.innerHTML = `<div class="modal" style="max-width:560px">
    <h3>Atualizar da planilha — ${qual}</h3>
    <p>Use quando o cronograma mudou e a planilha foi gerada de novo.
      A importação atualiza <b>datas, quantidades e valores da PC</b>.
      Não encosta em fornecedor, cotação, status, compra nem entrega — o que compras já lançou fica.
      Nada é excluído: item que sumiu da planilha é apenas desativado.</p>
    <input type="file" id="arqPlanilha" accept=".xlsx,.xlsm,.csv" style="padding:9px">
    <div id="previa"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:6px">
      <button class="btn" onclick="this.closest('.fundo').remove()">Cancelar</button>
      <button class="btn pri" id="btnAplicar" style="display:none">Aplicar</button>
    </div></div>`;
  fundo.addEventListener('click', e => { if (e.target === fundo) fundo.remove(); });
  document.body.appendChild(fundo);

  document.getElementById('arqPlanilha').addEventListener('change', async ev => {
    const arquivo = ev.target.files[0];
    if (!arquivo) return;
    const previa = document.getElementById('previa');
    previa.innerHTML = '<p class="mini">Lendo…</p>';
    try {
      const linhas = extrairTabela(await lerArquivo(arquivo), tipo);
      const plano = conciliar(tipo, linhas);
      previa.innerHTML = `<div class="nota" style="margin:12px 0">
        <b>${linhas.length}</b> linhas lidas da planilha:<br>
        · <b>${plano.mudadas.length}</b> com prazo/valor alterado<br>
        · <b>${plano.novas.length}</b> novas<br>
        · <b>${plano.iguais.length}</b> sem mudança<br>
        ${plano.sumiram.length ? `· <b>${plano.sumiram.length}</b> sumiram da planilha e serão desativadas` : ''}
      </div>`;
      const btn = document.getElementById('btnAplicar');
      btn.style.display = '';
      btn.onclick = () => aplicarImportacao(tipo, plano, fundo);
    } catch (e) {
      previa.innerHTML = `<div class="nota" style="margin:12px 0;background:var(--vermelho-bg);border-color:#fecdc9;color:var(--vermelho)">${esc(e.message)}</div>`;
      document.getElementById('btnAplicar').style.display = 'none';
    }
  });
}

async function aplicarImportacao(tipo, plano, fundo) {
  // Importar revisão de PC mexe em preço e prazo de muitas linhas de uma vez —
  // é a última mudança que deveria ficar órfã no histórico. Mesma trava da
  // edição campo a campo: sem nome identificado, não aplica.
  if (!await exigirNome()) return;
  const tabela = tipo === 'contratacoes' ? 'compras_contratacao' : 'compras_material';
  const btn = document.getElementById('btnAplicar');
  btn.disabled = true;
  btn.textContent = 'Aplicando…';
  try {
    for (const { atual, patch } of plano.mudadas) {
      const origem = tipo === 'contratacoes' ? 'contratacao' : 'material';
      const rotulo = tipo === 'contratacoes' ? atual.atividade : `${atual.linha_pc} — ${atual.material}`;

      // Um evento POR CAMPO, com o valor velho e o novo. Antes registrávamos só
      // a lista de nomes dos campos ("prazo_contratacao, valor_pc_material"),
      // o que respondia "mudou" mas não "mudou de quanto para quanto".
      // Quando a PC é revisada (REV05 → REV06) e um preço de referência sobe
      // 30%, é essa diferença que precisa ficar registrada — senão o número
      // novo vira verdade sem ninguém ter visto o antigo.
      const eventos = Object.keys(patch).map(campo => ({
        obra_id: S.obra.id, origem, ref_id: atual.id, referencia: rotulo,
        campo: `PC: ${campo}`,
        valor_antes: atual[campo] == null ? null : String(atual[campo]),
        valor_depois: patch[campo] == null ? null : String(patch[campo]),
        por_nome: S.eu || null,
      }));

      await api(`${tabela}?id=eq.${atual.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ ...patch, atualizado_em: new Date().toISOString(), atualizado_por_nome: S.eu || null }),
      });
      if (eventos.length) await api('compras_evento', { method: 'POST', body: JSON.stringify(eventos) });
    }
    if (plano.novas.length) {
      await api(tabela, { method: 'POST', body: JSON.stringify(plano.novas.map(r => ({ ...r, obra_id: S.obra.id }))) });
    }
    for (const r of plano.sumiram) {
      await api(`${tabela}?id=eq.${r.id}`, { method: 'PATCH', body: JSON.stringify({ ativo: false }) });
    }
    renovarIdentidade();   // aplicou agora → o nome segue valendo por mais um tempo
    fundo.remove();
    await recarregar();
    avisar(`Planilha aplicada: ${plano.mudadas.length} atualizadas, ${plano.novas.length} novas ✓`);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Aplicar';
    avisar('Falha ao aplicar: ' + e.message, true);
  }
}
