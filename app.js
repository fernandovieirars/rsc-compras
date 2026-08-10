/* ============================================================
   Contratações & Compras — Rio Sul Construções
   Acompanhamento compartilhado dos prazos-limite de contratação de
   terceirizadas e de compra de materiais.

   O QUE ESTE APP SUBSTITUI
   Duas planilhas que circulavam por e-mail. O cálculo delas está preservado
   aqui linha por linha (ver as funções puras abaixo); o que muda é que a
   linha é uma só e todo mundo edita a mesma.

   SEM DEPENDÊNCIA EXTERNA no caminho crítico: fetch direto no PostgREST.
   Só o importador de .xlsx carrega uma biblioteca, e sob demanda — se o CDN
   cair, o acompanhamento continua funcionando.
   ============================================================ */
'use strict';

const CFG = {
  url: 'https://sxinynzkudlkzvjajvaq.supabase.co',
  key: 'sb_publishable_sNkBN4Of2r7WzVD1aaJvjQ_6myl1uXZ',
  // Obra pedida na URL (?obra=escola-ambev). Nulo é o caso normal de quem
  // abre o app pelo favorito: aí vale a última obra aberta neste aparelho e,
  // na primeira visita, a primeira da lista. Slug fixo no código não serve
  // mais — a empresa tem várias obras e nenhuma delas é "a padrão".
  obra: new URLSearchParams(location.search).get('obra'),
};

// Guardada por aparelho: quem cuida da obra X abre o app e cai na obra X, sem
// precisar do link certo no bolso.
const CHAVE_OBRA = 'rsc_compras_obra';

const S = {
  obra: null,
  obras: [],
  contratacoes: [],
  materiais: [],
  eventos: [],
  destinatarios: [],
  envios: [],
  aba: 'contratacoes',
  filtro: 'todos',
  busca: '',
  abertos: new Set(),
  eu: localStorage.getItem('rsc_compras_quem') || '',
};

/* ============================================================
   1. CÁLCULO — a tradução fiel das fórmulas da planilha
   Puras de propósito: entram datas e parâmetros, sai texto. É o que dá para
   testar sem navegador e sem banco (ver testes/calculo.test.js).
   ============================================================ */

// Data de hoje no fuso local, em ISO. Usar new Date().toISOString() aqui seria
// errado: ele converte para UTC e, à noite no Brasil, devolve o dia seguinte —
// um item venceria um dia antes na tela de quem abrisse depois das 21h.
function hojeISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Diferença em dias corridos entre duas datas ISO (fim - inicio).
// Comparação em UTC puro: 'YYYY-MM-DD' vira meia-noite UTC nos dois lados, então
// o horário de verão não introduz o erro de ±1 dia que apareceria com datas locais.
function diasEntre(inicioISO, fimISO) {
  if (!inicioISO || !fimISO) return null;
  const a = Date.parse(inicioISO + 'T00:00:00Z');
  const b = Date.parse(fimISO + 'T00:00:00Z');
  if (isNaN(a) || isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

// Planilha de contratação, coluna Status:
//   =SE(prazo<base;"ATRASADO";SE(prazo-base<=alerta;"ATENÇÃO";"OK"))
function farolContratacao(prazo, base, alertaDias) {
  if (!prazo) return null;
  const d = diasEntre(base, prazo);
  if (d === null) return null;
  if (d < 0) return 'ATRASADO';
  if (d <= alertaDias) return 'ATENÇÃO';
  return 'OK';
}

// Planilha de materiais, coluna Prioridade:
//   =SE(limite<base;"ATRASADO";SE(limite-base<=3;"URGENTE";SE(limite-base<=10;"PRÓXIMO";"PROGRAMADO")))
function prioridadeMaterial(limite, base, urgenteDias, proximoDias) {
  if (!limite) return null;
  const d = diasEntre(base, limite);
  if (d === null) return null;
  if (d < 0) return 'ATRASADO';
  if (d <= urgenteDias) return 'URGENTE';
  if (d <= proximoDias) return 'PRÓXIMO';
  return 'PROGRAMADO';
}

// Planilha de materiais, coluna Ação:
//   =SE(prioridade="PROGRAMADO";"OK";"COMPRAR ATÉ "&TEXTO(limite;"dd/mm/aaaa"))
//
// A planilha de contratação trazia esta coluna digitada à mão, e por isso ela
// tinha divergências (o item 4 dizia "OK" com o farol em ATENÇÃO). Aqui a regra
// é a mesma nas duas telas e a divergência não se repete.
function acaoPrazo(data, situacaoTranquila, verbo) {
  if (!data) return '';
  return situacaoTranquila ? 'OK' : `${verbo} ATÉ ${fmtData(data)}`;
}
function acaoContratacao(prazo, farol) {
  return acaoPrazo(prazo, farol === 'OK', 'CONTRATAR');
}
function acaoMaterial(limite, prioridade) {
  return acaoPrazo(limite, prioridade === 'PROGRAMADO', 'COMPRAR');
}

// A data-base é a de hoje, salvo quando a obra congela uma foto no banco.
function dataBase() {
  return (S.obra && S.obra.data_base) || hojeISO();
}
function par(nome, padrao) {
  const v = S.obra && S.obra[nome];
  return (v === null || v === undefined) ? padrao : v;
}

function farolDe(c) {
  return farolContratacao(c.prazo_contratacao, dataBase(), par('alerta_atencao_dias', 5));
}
function prioridadeDe(m) {
  return prioridadeMaterial(m.data_limite_compra, dataBase(), par('urgente_dias', 3), par('proximo_dias', 10));
}

/* ============================================================
   2. FORMATAÇÃO
   ============================================================ */
const moedaBR = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const numBR = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 });

function fmtData(iso) {
  if (!iso) return '';
  const [a, m, d] = String(iso).slice(0, 10).split('-');
  return `${d}/${m}/${a}`;
}
function fmtMoeda(v) {
  return (v === null || v === undefined || v === '') ? '—' : moedaBR.format(Number(v));
}
function fmtMoedaCurta(v) {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  if (Math.abs(n) >= 1000) return 'R$ ' + numBR.format(Math.round(n / 1000)) + ' mil';
  return moedaBR.format(n);
}
function fmtNum(v) {
  return (v === null || v === undefined || v === '') ? '—' : numBR.format(Number(v));
}
// Campo de dinheiro. Mostra "98.000" em vez de "98000" — o valor cru numa
// coluna de moeda faz a pessoa conferir duas vezes se são 98 mil ou 980 mil.
// Não precisa de máscara: o parser do editar() já aceita "1.234,56" e "1234.56".
function campoMoeda(tipo, id, campo, valor) {
  const v = (valor === null || valor === undefined || valor === '') ? '' : numBR.format(Number(valor));
  return `<input class="ed n" value="${v}" placeholder="—"
    onchange="editar('${tipo}','${id}','${campo}',this.value,true)">`;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
// O valor calculado continua sendo 'OK' — é o que a planilha produz, e é contra
// ele que testes/calculo.test.js prova a fidelidade. Só o RÓTULO muda: na tela,
// "OK" lia como "resolvido", quando significa apenas que o prazo ainda não
// apertou. Nenhum item ali está resolvido — nenhum foi contratado ainda.
// Misturar valor e rótulo quebrou 12 testes antes de eu separar os dois.
function rotuloSituacao(t) {
  return { 'OK': 'NO PRAZO', 'PROGRAMADO': 'NO PRAZO' }[t] || t;
}

/* ------------------------------------------------------------
   ESTADO DA LINHA — a cor que a pessoa lê antes de ler qualquer texto.

   São dois eixos diferentes, e misturá-los era o que tornava a tela cansativa:

     SITUAÇÃO (selo)  = o prazo aperta?   → vem do cronograma, ninguém controla
     ESTADO (cor)     = alguém está agindo? → vem de compras, é o que dá para mudar

   Um item pode estar ATRASADO e amarelo: venceu, mas tem gente cotando. E pode
   estar NO PRAZO e sem cor nenhuma: não venceu e ninguém precisou tocar ainda.
   O vermelho fica reservado para o cruzamento que ninguém quer e que a tela
   antiga não mostrava — venceu E está parado.
   ------------------------------------------------------------ */
function temMovimento(it) {
  if (it.status_processo && it.status_processo !== 'PENDENTE') return true;
  if (it.status_compra && it.status_compra !== 'PENDENTE') return true;
  if (it.fornecedor_escolhido || it.fornecedor) return true;
  if (it.valor_unit_cotado != null || it.valor_contratado != null) return true;
  return [1, 2, 3].some(i => it[`cot${i}_fornecedor`] || it[`cot${i}_valor`] != null);
}

function estadoLinha(it) {
  const st = it.status_processo || it.status_compra;
  if (st === 'NÃO SE APLICA') return 'na';
  if (it.contratado || it.comprado || ['CONTRATADO', 'COMPRADO', 'ENTREGUE'].includes(st)) return 'fechado';
  const vencido = (it.prazo_contratacao ? farolDe(it) : prioridadeDe(it)) === 'ATRASADO';
  if (vencido && !temMovimento(it)) return 'parado';
  if (temMovimento(it)) return 'andando';
  return '';
}

const LEGENDA = `<div class="legenda">
  <span><i class="pt fechado"></i>fechado</span>
  <span><i class="pt andando"></i>alguém está cotando</span>
  <span><i class="pt parado"></i>venceu e ninguém tocou</span>
  <span><i class="pt"></i>no prazo, ainda não começou</span>
</div>`;

function classeSelo(t) {
  return { 'ATRASADO': 'atrasado', 'URGENTE': 'urgente', 'ATENÇÃO': 'atencao',
           'PRÓXIMO': 'proximo', 'OK': 'ok', 'PROGRAMADO': 'programado' }[t] || 'neutro';
}
function classeStatus(st) {
  if (st === 'CONTRATADO' || st === 'COMPRADO' || st === 'ENTREGUE') return 'st-fechado';
  if (st === 'EM COTAÇÃO') return 'st-cotacao';
  if (st === 'EM NEGOCIAÇÃO') return 'st-negociacao';
  if (st === 'NÃO SE APLICA') return 'st-na';
  return 'st-pendente';
}

/* ============================================================
   3. BANCO (PostgREST direto)
   ============================================================ */
async function api(caminho, opcoes = {}) {
  const r = await fetch(`${CFG.url}/rest/v1/${caminho}`, {
    ...opcoes,
    headers: {
      apikey: CFG.key,
      Authorization: `Bearer ${CFG.key}`,
      'Content-Type': 'application/json',
      ...(opcoes.headers || {}),
    },
  });
  const txt = await r.text();
  const dados = txt ? JSON.parse(txt) : null;
  if (!r.ok) throw new Error((dados && dados.message) || `HTTP ${r.status}`);
  return dados;
}

// Qual obra abrir. Fora do fetch de propósito, para poder ser testada:
//   · ?obra= na URL manda sempre. Link errado tem de dar ERRO, nunca abrir
//     outra obra caladamente — quem recebeu o link precisa saber que é inválido,
//     e compras lendo o prazo da obra errada é o pior desfecho possível aqui.
//   · sem ?obra=, vale a última obra aberta neste aparelho;
//   · se ela não existir mais (obra removida, aparelho novo), a primeira da lista.
function escolherObra(obras, daUrl, lembrada) {
  if (daUrl) return obras.find(o => o.slug === daUrl) || null;
  return obras.find(o => o.slug === lembrada) || obras[0] || null;
}

async function carregar() {
  // A lista inteira vem junto: ela alimenta o trocador do cabeçalho e custa
  // uma linha por obra.
  S.obras = await api('compras_obra?select=*&order=nome.asc');
  if (!S.obras.length) throw new Error('Nenhuma obra cadastrada ainda.');

  S.obra = escolherObra(S.obras, CFG.obra, localStorage.getItem(CHAVE_OBRA));
  if (!S.obra) throw new Error(`Obra "${CFG.obra}" não encontrada.`);
  localStorage.setItem(CHAVE_OBRA, S.obra.slug);
  const [ctr, mat] = await Promise.all([
    api(`compras_contratacao?obra_id=eq.${S.obra.id}&ativo=is.true&select=*&order=prazo_contratacao.asc,item.asc`),
    api(`compras_material?obra_id=eq.${S.obra.id}&ativo=is.true&select=*&order=data_limite_compra.asc,item.asc`),
  ]);
  S.contratacoes = ctr;
  S.materiais = mat;
}

async function carregarEventos() {
  S.eventos = await api(`compras_evento?obra_id=eq.${S.obra.id}&select=*&order=em.desc&limit=300`);
}

async function carregarRelatorio() {
  const [dest, envios] = await Promise.all([
    api(`compras_destinatario?obra_id=eq.${S.obra.id}&select=*&order=papel.asc,nome.asc`),
    api(`compras_envio_log?obra_id=eq.${S.obra.id}&select=*&order=em.desc&limit=12`),
  ]);
  S.destinatarios = dest;
  S.envios = envios;
}

// Grava um campo e registra o que mudou. O registro é o que transforma isto
// num acompanhamento: sem ele, editar é sobrescrever e a pergunta "por que
// este item está parado há três semanas?" fica sem resposta.
async function gravar(tipo, linha, campo, valor) {
  const tabela = tipo === 'contratacao' ? 'compras_contratacao' : 'compras_material';
  const antes = linha[campo];
  if (antes === valor) return;

  const patch = { [campo]: valor, atualizado_em: new Date().toISOString(), atualizado_por_nome: S.eu || null };

  // Status e a marcação Sim/Não são a mesma informação em dois lugares — a
  // planilha tinha as duas colunas e as pessoas usam ambas. Mantemos em
  // sincronia aqui para não existir linha "CONTRATADO / Contratado: Não".
  if (tipo === 'contratacao') {
    if (campo === 'status_processo') patch.contratado = (valor === 'CONTRATADO');
    if (campo === 'contratado') patch.status_processo = valor ? 'CONTRATADO' : (linha.status_processo === 'CONTRATADO' ? 'EM NEGOCIAÇÃO' : linha.status_processo);
    if (patch.contratado && !linha.data_contratacao) patch.data_contratacao = hojeISO();
  } else {
    if (campo === 'status_compra') patch.comprado = (valor === 'COMPRADO' || valor === 'ENTREGUE');
    if (campo === 'comprado') patch.status_compra = valor ? 'COMPRADO' : (['COMPRADO', 'ENTREGUE'].includes(linha.status_compra) ? 'EM NEGOCIAÇÃO' : linha.status_compra);
    if (patch.comprado && !linha.data_compra) patch.data_compra = hojeISO();
  }

  Object.assign(linha, patch);   // otimista: a tela responde antes da rede
  render();

  try {
    await api(`${tabela}?id=eq.${linha.id}`, { method: 'PATCH', body: JSON.stringify(patch) });
    const rotulo = tipo === 'contratacao' ? linha.atividade : `${linha.linha_pc} — ${linha.material}`;
    await api('compras_evento', {
      method: 'POST',
      body: JSON.stringify({
        obra_id: S.obra.id, origem: tipo, ref_id: linha.id, referencia: rotulo,
        campo, valor_antes: textoValor(antes), valor_depois: textoValor(valor), por_nome: S.eu || null,
      }),
    });
    avisar('Salvo ✓');
  } catch (e) {
    avisar('Não salvou: ' + e.message, true);
    await recarregar();   // a tela otimista mentiu; volta para a verdade do banco
  }
}

function textoValor(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v === true) return 'Sim';
  if (v === false) return 'Não';
  return String(v);
}

async function recarregar() {
  try {
    await carregar();
    if (S.aba === 'historico') await carregarEventos();
    render();
  } catch (e) { avisar('Falha ao atualizar: ' + e.message, true); }
}

/* ============================================================
   4. EDIÇÃO
   ============================================================ */
function acharLinha(tipo, id) {
  return (tipo === 'contratacao' ? S.contratacoes : S.materiais).find(x => x.id === id);
}

// Converte o que o <input> devolve (sempre texto) para o tipo da coluna.
async function editar(tipo, id, campo, bruto, ehNumero) {
  const linha = acharLinha(tipo, id);
  if (!linha) return;
  // Porta de entrada de toda edição. Sem nome não grava: um histórico que diz
  // "alguém mudou para EM COTAÇÃO" não responde a pergunta que se faz numa
  // reunião de obra, que é quem destravou — ou quem parou — cada item.
  if (!await exigirNome()) { render(); return; }
  let v = bruto;
  if (ehNumero) {
    // Aceita "1.234,56" (como as pessoas digitam) e "1234.56" (como colam da planilha).
    const limpo = String(bruto).trim().replace(/\s/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.');
    v = limpo === '' ? null : Number(limpo);
    if (v !== null && isNaN(v)) { avisar('Valor inválido', true); render(); return; }
  } else if (v === '') {
    v = null;
  }
  gravar(tipo, linha, campo, v);
}
async function editarBool(tipo, id, campo, marcado) {
  const linha = acharLinha(tipo, id);
  if (!linha) return;
  if (!await exigirNome()) { render(); return; }
  gravar(tipo, linha, campo, !!marcado);
}

/* ============================================================
   5. TELA
   ============================================================ */
function trocarAba(aba) {
  S.aba = aba;
  S.filtro = 'todos';
  S.busca = '';
  document.querySelectorAll('.aba').forEach(b => b.classList.toggle('on', b.dataset.aba === aba));
  if (aba === 'historico' && !S.eventos.length) {
    carregarEventos().then(render).catch(e => avisar(e.message, true));
  }
  if (aba === 'relatorio') {
    carregarRelatorio().then(render).catch(e => avisar(e.message, true));
  }
  render();
  window.scrollTo(0, 0);
}

function alternar(id) {
  S.abertos.has(id) ? S.abertos.delete(id) : S.abertos.add(id);
  render();
}
function aoBuscar(v) {
  S.busca = v.toLowerCase();
  render();
}
function aoFiltrar(f) {
  S.filtro = f;
  render();
}

// Trocar o innerHTML destrói o elemento em foco. Sem isto, digitar na busca era
// inutilizável: cada tecla re-renderizava a tela, o campo era recriado e o
// cursor caía fora — dava para digitar uma letra e só.
//
// A chave para reencontrar o campo é o próprio handler inline, que já é único
// por campo (`editar('material','m12','fornecedor',…)`). Evita ter que espalhar
// ids artificiais por dezenas de templates.
function preservandoFoco(pintar) {
  const ativo = document.activeElement;
  const chave = ativo && (ativo.getAttribute('oninput') || ativo.getAttribute('onchange'));
  let ini = null, fim = null;
  try { ini = ativo.selectionStart; fim = ativo.selectionEnd; } catch (e) { /* date/number não expõem */ }

  pintar();

  if (!chave) return;
  const alvo = [...document.querySelectorAll('input,select,textarea')]
    .find(e => (e.getAttribute('oninput') || e.getAttribute('onchange')) === chave);
  if (!alvo) return;
  alvo.focus();
  try { if (ini != null) alvo.setSelectionRange(ini, fim); } catch (e) { /* idem */ }
}

function render() {
  if (!S.obra) return;
  renderCabecalho();
  const el = document.getElementById('conteudo');
  preservandoFoco(() => {
    if (S.aba === 'contratacoes') el.innerHTML = telaContratacoes();
    else if (S.aba === 'materiais') el.innerHTML = telaMateriais();
    else if (S.aba === 'relatorio') el.innerHTML = telaRelatorio();
    else el.innerHTML = telaHistorico();
  });
}

function renderCabecalho() {
  document.getElementById('tituloObra').textContent = S.obra.nome;
  const base = dataBase();
  const congelada = !!S.obra.data_base;
  document.getElementById('subObra').textContent =
    `Contratações & Compras · data-base ${fmtData(base)}${congelada ? ' (congelada)' : ''}`;

  const chip = document.getElementById('chipPrazo');
  if (S.obra.termino_obra) {
    const d = diasEntre(base, S.obra.termino_obra);
    chip.innerHTML = d >= 0
      ? `Término da obra <b>${fmtData(S.obra.termino_obra)}</b> · faltam <b>${d}</b> dias`
      : `Término previsto <b>${fmtData(S.obra.termino_obra)}</b> · <b>${-d}</b> dias atrás`;
  } else chip.textContent = '';

  document.getElementById('btnEu').textContent = S.eu ? `👤 ${S.eu}` : '👤 quem é você?';
  document.getElementById('nCtr').textContent = S.contratacoes.length;
  document.getElementById('nMat').textContent = S.materiais.length;
}

/* ============================================================
   4b. VÁRIAS OBRAS
   Cada obra tem seu próprio acompanhamento e seu próprio link. O trocador
   existe para ninguém precisar decorar slug: clica no nome da obra no topo.

   Criar obra é uma RPC (`compras_criar_obra`, migration 0011), não um insert.
   A tabela continua somente-leitura para o app de propósito — quem escreve
   nela escreve em `data_base`, e data-base preenchida congela o farol.
   ============================================================ */

// Troca de obra recarregando a página em vez de remendar o estado. São sete
// coleções em S (contratações, materiais, eventos, destinatários, envios,
// filtros, abertos) e qualquer uma esquecida vira dado de uma obra aparecendo
// na tela de outra — erro caro e difícil de notar num app de compras.
function irParaObra(slug) {
  localStorage.setItem(CHAVE_OBRA, slug);
  location.search = '?obra=' + encodeURIComponent(slug);
}

function abrirObras() {
  const fundo = document.createElement('div');
  fundo.className = 'fundo';
  const itens = S.obras.map(o => `
    <button class="obra-item ${o.id === S.obra.id ? 'on' : ''}" onclick="irParaObra('${esc(o.slug)}')">
      <span class="on-marca">${o.id === S.obra.id ? '●' : ''}</span>
      <span>
        <span class="nome">${esc(o.nome)}</span>
        <span class="mini">${esc(o.cliente || 'sem cliente')}${
          o.termino_obra ? ' · término ' + fmtData(o.termino_obra) : ''}</span>
      </span>
    </button>`).join('');

  fundo.innerHTML = `<div class="modal" style="max-width:520px">
    <h3>Obras</h3>
    <p>Cada obra tem seu link próprio — o que estiver na barra de endereço é o
       que você compartilha com o pessoal daquela obra.</p>
    <div class="lista-obras">${itens}</div>
    <details class="nova-obra">
      <summary>+ Cadastrar outra obra</summary>
      <div style="padding-top:14px">
        <input id="obraNome" placeholder="Nome da obra (ex.: Reforma da fachada — UFES)" maxlength="120">
        <input id="obraCliente" placeholder="Cliente (opcional)" maxlength="80">
        <label class="mini" style="display:block;margin:-6px 0 6px">Término previsto (opcional)</label>
        <input id="obraTermino" type="date">
        <label class="copiar">
          <input type="checkbox" id="obraCopiar" checked>
          <span>Copiar os destinatários do alerta de <b>${esc(S.obra.nome)}</b>
            <span class="mini">Sem isto a obra nasce sem ninguém na lista, e o alerta diário
              dela não sai para e-mail nenhum — sem erro, só silêncio.</span></span>
        </label>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button class="btn" onclick="this.closest('.fundo').remove()">Cancelar</button>
          <button class="btn pri" id="btnCriarObra" onclick="criarObra()">Criar obra</button>
        </div>
      </div>
    </details>
  </div>`;
  fundo.addEventListener('click', e => { if (e.target === fundo) fundo.remove(); });
  document.body.appendChild(fundo);
}

async function criarObra() {
  const nome = document.getElementById('obraNome').value.trim();
  const cliente = document.getElementById('obraCliente').value.trim();
  const termino = document.getElementById('obraTermino').value || null;
  const copiar = document.getElementById('obraCopiar').checked;
  if (!nome) { avisar('Dê um nome à obra', true); return; }

  // Sem isto, clique duplo numa conexão de canteiro cria a obra duas vezes —
  // e a segunda vem com slug sufixado, o que ninguém entende depois.
  const btn = document.getElementById('btnCriarObra');
  btn.disabled = true;
  btn.textContent = 'Criando…';
  try {
    const r = await api('rpc/compras_criar_obra', {
      method: 'POST',
      body: JSON.stringify({
        p_nome: nome,
        p_cliente: cliente || null,
        p_termino: termino,
        p_copiar_destinatarios_de: copiar ? S.obra.id : null,
      }),
    });
    irParaObra(r.slug);
  } catch (e) {
    avisar(e.message, true);
    btn.disabled = false;
    btn.textContent = 'Criar obra';
  }
}

// Obra recém-criada não tem planilha nenhuma. Mostrar a lista vazia e os KPIs
// zerados deixaria a pessoa procurando o que fazer; o caminho é um só, então a
// tela diz qual é.
function blocoPrimeiraImportacao(tipo) {
  const qual = tipo === 'contratacoes'
    ? 'de prazos de contratação das terceirizadas'
    : 'de materiais a comprar';
  const resto = tipo === 'contratacoes'
    ? 'Depois repita na aba <b>Materiais</b>, com a outra planilha.'
    : 'Se ainda não importou a de terceirizadas, ela fica na aba <b>Terceirizadas</b>.';
  return `<div class="quadro" style="padding:34px 24px;text-align:center">
    <div style="font-size:32px;line-height:1">📄</div>
    <h3 style="margin:10px 0 6px;font:700 16px var(--fonte)">
      Esta obra ainda não tem a planilha ${qual}</h3>
    <p class="mini" style="max-width:430px;margin:0 auto 16px;line-height:1.6">
      O acompanhamento nasce da planilha que o planejamento gera a partir do
      cronograma. Importe uma vez e o resto — farol, prazos, alerta diário —
      passa a andar sozinho.<br>${resto}</p>
    <button class="btn pri" onclick="abrirImportador('${tipo}')">Importar a planilha</button>
  </div>`;
}

/* ---- Referência da PC ----
   Uma linha marcada como `referencia_compartilhada` tem os valores já contados
   dentro de outro pacote — na Escola é a 2.6.3, que responde sozinha pela
   Pintura externa e também está no bloco 2.6 da Pintura interna. Somar as duas
   inflava o total da obra em R$ 58.770,77 (2,5%).

   A linha NÃO sai da tela e continua com a referência dela na coluna: para o
   contrato daquele serviço o valor é real, e é por ele que a cotação da fachada
   vai ser comparada. O que não vale é o somatório — e é só ele que muda aqui. */
function pcReferencia(lista) {
  return lista.filter(c => !c.referencia_compartilhada)
              .reduce((s, c) => s + Number(c.valor_pc_total || 0), 0);
}
function pcRepetida(lista) {
  return lista.filter(c => c.referencia_compartilhada)
              .reduce((s, c) => s + Number(c.valor_pc_total || 0), 0);
}
// Rodapé do cartão: quando algo ficou de fora, dizer quanto e por quê. Total que
// encolhe sem explicação faz a pessoa achar que o app perdeu dado.
function pePcReferencia(lista) {
  const fora = pcRepetida(lista);
  return fora
    ? `sem ${fmtMoedaCurta(fora)} de referência repetida`
    : 'mão de obra + material';
}

/* ---- KPIs ---- */
function kpi(rot, val, pe, cor, corVal) {
  return `<div class="kpi ${cor || ''}"><div class="rot">${rot}</div>
    <div class="val ${corVal || ''}">${val}</div><div class="pe">${pe || ''}</div></div>`;
}

/* ---- Tela 1: terceirizadas ---- */
function telaContratacoes() {
  const todos = S.contratacoes;
  if (!todos.length) return blocoPrimeiraImportacao('contratacoes');
  const cont = todos.filter(c => c.contratado).length;
  const atras = todos.filter(c => farolDe(c) === 'ATRASADO').length;
  const aten = todos.filter(c => farolDe(c) === 'ATENÇÃO').length;
  const andam = todos.filter(c => ['EM COTAÇÃO', 'EM NEGOCIAÇÃO'].includes(c.status_processo)).length;
  const pcTotal = pcReferencia(todos);
  const fechado = todos.reduce((s, c) => s + Number(c.valor_contratado || 0), 0);
  // Esta soma NÃO exclui a referência compartilhada, de propósito. Ela compara o
  // que foi fechado contra a PC dos MESMOS contratos: se a fachada virar contrato
  // próprio, o valor dela é gasto real e a referência dela é o parâmetro daquela
  // cotação. Os dois lados contam a mesma coisa, e a comparação continua honesta.
  // Se um dia a pintura interna E a externa forem contratadas separadamente, aqui
  // vai aparecer escopo pago duas vezes — que é informação, não defeito.
  const pcDosFechados = todos.filter(c => c.valor_contratado != null)
                             .reduce((s, c) => s + Number(c.valor_pc_total || 0), 0);
  const desvio = fechado - pcDosFechados;

  const kpis = `<div class="kpis">
    ${kpi('Serviços', todos.length, 'a contratar', 'y')}
    ${kpi('Contratados', cont, `${todos.length - cont} em aberto`, 'g', cont ? 'g' : '')}
    ${kpi('Em cotação', andam, 'cotação/negociação', 'b')}
    ${kpi('Atrasados', atras, 'prazo vencido', 'r', atras ? 'r' : '')}
    ${kpi('Atenção', aten, `vencem em ${par('alerta_atencao_dias', 5)} dias`, 'a', aten ? 'o' : '')}
    ${kpi('Referência PC', fmtMoedaCurta(pcTotal), pePcReferencia(todos), '')}
    ${kpi('Contratado', fmtMoedaCurta(fechado), pcDosFechados
        ? `${desvio <= 0 ? '▼' : '▲'} ${fmtMoedaCurta(Math.abs(desvio))} vs PC` : 'nada fechado ainda',
        '', desvio <= 0 ? 'g' : 'r')}
  </div>`;

  const filtros = [['todos', 'Todos'], ['atrasado', '🔴 Atrasados'], ['atencao', '🟡 Atenção'],
                   ['aberto', 'Em aberto'], ['andamento', 'Em cotação'], ['contratado', '✓ Contratados']];
  const barra = `<div class="ferramentas">
    <div class="busca"><input placeholder="Buscar serviço…" value="${esc(S.busca)}" oninput="aoBuscar(this.value)"></div>
    ${filtros.map(f => `<button class="filtro ${S.filtro === f[0] ? 'on' : ''}" onclick="aoFiltrar('${f[0]}')">${f[1]}</button>`).join('')}
    <button class="btn" onclick="exportarCSV('contratacoes')">↓ CSV</button>
    <button class="btn" onclick="window.print()">🖨 Imprimir</button>
    <button class="btn pri" onclick="abrirImportador('contratacoes')">↻ Atualizar da planilha</button>
  </div>` + LEGENDA;

  const linhas = todos.filter(c => {
    const f = farolDe(c);
    if (S.busca && !(`${c.atividade} ${c.linhas_pc_mo || ''} ${c.cot1_fornecedor || ''} ${c.fornecedor_escolhido || ''}`)
        .toLowerCase().includes(S.busca)) return false;
    switch (S.filtro) {
      case 'atrasado': return f === 'ATRASADO';
      case 'atencao': return f === 'ATENÇÃO';
      case 'aberto': return !c.contratado && c.status_processo !== 'NÃO SE APLICA';
      case 'andamento': return ['EM COTAÇÃO', 'EM NEGOCIAÇÃO'].includes(c.status_processo);
      case 'contratado': return c.contratado;
      default: return true;
    }
  });

  const corpo = linhas.length ? linhas.map(linhaContratacao).join('')
    : `<tr><td colspan="10" class="semrot"><div class="vazio">Nenhum serviço neste filtro.</div></td></tr>`;

  return kpis + barra + `<div class="quadro"><div class="rolagem"><table>
    <thead><tr>
      <th>#</th><th>Serviço terceirizado</th><th>Início</th><th>Término</th>
      <th>Contratar até</th><th>Ação</th><th>Situação</th><th>Status</th>
      <th class="num">Referência PC</th><th class="num">Contratado</th><th></th>
    </tr></thead><tbody>${corpo}</tbody></table></div></div>`;
}

const STATUS_CTR = ['PENDENTE', 'EM COTAÇÃO', 'EM NEGOCIAÇÃO', 'CONTRATADO', 'NÃO SE APLICA'];

function linhaContratacao(c) {
  const f = farolDe(c);
  const acao = acaoContratacao(c.prazo_contratacao, f);
  const aberta = S.abertos.has(c.id);
  const estado = estadoLinha(c);
  // Item fechado ou fora de escopo não pede mais nada. Continuar mostrando
  // "CONTRATAR ATÉ 07/08" em vermelho num serviço já contratado treina a pessoa
  // a ignorar o vermelho — e aí ele para de funcionar onde importa.
  const encerrado = estado === 'fechado' || estado === 'na';
  const na = c.status_processo === 'NÃO SE APLICA';

  const principal = `<tr class="est-${estadoLinha(c) || 'neutro'} ${aberta ? 'aberta' : ''}">
    <td data-r="Item" class="mini">${c.item ?? ''}</td>
    <td data-r="Serviço" class="atividade forte"><div class="comprio">${seloPrioridade(c)}<span class="corta" title="${esc(c.atividade)}">${esc(c.atividade)}</span></div></td>
    <td data-r="Início" class="mini">${fmtData(c.data_inicio) || '—'}</td>
    <td data-r="Término" class="mini">${fmtData(c.data_termino) || '—'}</td>
    <td data-r="Contratar até" class="forte">${fmtData(c.prazo_contratacao) || '—'}</td>
    <td data-r="Ação"><span class="acao ${encerrado ? 'feito' : acao === 'OK' ? 'ok' : 'pede'}">${
      estado === 'fechado' ? '✓ contratado' : na ? '—' : esc(rotuloSituacao(acao))}</span></td>
    <td data-r="Situação">${(f && !encerrado) ? `<span class="selo ${classeSelo(f)}">${rotuloSituacao(f)}</span>` : '<span class="selo neutro">—</span>'}</td>
    <td data-r="Status"><select class="ed ${classeStatus(c.status_processo)}"
        onchange="editar('contratacao','${c.id}','status_processo',this.value)">
      ${STATUS_CTR.map(s => `<option ${c.status_processo === s ? 'selected' : ''}>${s}</option>`).join('')}
    </select></td>
    <td data-r="Referência PC" class="num">${fmtMoeda(c.valor_pc_total)}${
      c.referencia_compartilhada
        ? `<span class="repetida" title="Estes valores já estão contados em outro pacote da PC — a linha vale para o contrato dela, mas fica fora do total da obra.">já contada</span>`
        : ''}</td>
    <td data-r="Contratado" class="num">${campoMoeda('contratacao', c.id, 'valor_contratado', c.valor_contratado)}</td>
    <td class="semrot"><button class="expandir" onclick="alternar('${c.id}')" title="Cotações e detalhes">${aberta ? '▾' : '▸'}</button></td>
  </tr>`;

  if (!aberta) return principal;

  const cotacoes = [1, 2, 3].map(i => {
    const valor = c[`cot${i}_valor`];
    const melhor = valor != null && valor === menorCotacao(c);
    return `<div class="cotacao">
      <div class="cab"><span>Cotação ${i}</span>${melhor ? '<span class="melhor">menor preço</span>' : ''}</div>
      <div class="campo"><label>Fornecedor</label>
        <input class="ed" value="${esc(c[`cot${i}_fornecedor`] || '')}" placeholder="nome do fornecedor"
          onchange="editar('contratacao','${c.id}','cot${i}_fornecedor',this.value)"></div>
      <div class="campo"><label>Escopo</label>
        <select class="ed" onchange="editar('contratacao','${c.id}','cot${i}_escopo',this.value)">
          <option value="">—</option>
          ${['SOMENTE MÃO DE OBRA', 'MÃO DE OBRA + MATERIAL', 'SOMENTE MATERIAL']
            .map(e => `<option ${c[`cot${i}_escopo`] === e ? 'selected' : ''}>${e}</option>`).join('')}
        </select></div>
      <div class="campo"><label>Valor cotado</label>
        ${campoMoeda('contratacao', c.id, `cot${i}_valor`, valor)}</div>
    </div>`;
  }).join('');

  const detalhe = `<tr class="detalhe"><td colspan="11" class="semrot"><div class="det">
    <div class="bloco">
      <h4>Referência da PC</h4>
      <div class="linha"><span>Mão de obra</span><span>${fmtMoeda(c.valor_pc_mo)}</span></div>
      <div class="linha"><span>Material</span><span>${fmtMoeda(c.valor_pc_material)}</span></div>
      <div class="linha"><span><b>Total</b></span><span><b>${fmtMoeda(c.valor_pc_total)}</b></span></div>
      <div class="linha"><span>Linhas PC</span><span class="mini">${esc(c.linhas_pc_mo || '—')}</span></div>
      ${c.escopo_negociacao ? `<div class="nota" style="margin-top:9px;background:var(--azul-bg);border-color:#b2ddff;color:var(--azul)">
        <b>Orientação de compra${c.prioridade_fechamento ? ` — prioridade ${c.prioridade_fechamento}` : ''}:</b>
        ${esc(c.escopo_negociacao)}</div>` : ''}
      ${c.obs_composicao ? `<div class="nota" style="margin-top:9px">${esc(c.obs_composicao)}</div>` : ''}
      ${materiaisDaContratacao(c)}
    </div>
    ${blocoAntecedencia(c)}
    <div class="bloco"><h4>Cotações</h4>${cotacoes}</div>
    <div class="bloco">
      <h4>Fechamento</h4>
      <div class="campo"><label>Fornecedor contratado</label>
        <input class="ed" value="${esc(c.fornecedor_escolhido || '')}" placeholder="quem fechou"
          onchange="editar('contratacao','${c.id}','fornecedor_escolhido',this.value)"></div>
      <div class="campo"><label>Valor contratado</label>
        ${campoMoeda('contratacao', c.id, 'valor_contratado', c.valor_contratado)}</div>
      <div class="campo"><label>Data da contratação</label>
        <input type="date" class="ed" value="${c.data_contratacao || ''}"
          onchange="editar('contratacao','${c.id}','data_contratacao',this.value)"></div>
      <div class="campo"><label style="display:flex;align-items:center;gap:8px;text-transform:none;font-size:13px;color:var(--tinta)">
        <input type="checkbox" class="marca-sim" ${c.contratado ? 'checked' : ''}
          onchange="editarBool('contratacao','${c.id}','contratado',this.checked)"> Contratado</label></div>
      <div class="campo"><label>Observações</label>
        <textarea class="ed" placeholder="o que está travando, com quem falar…"
          onchange="editar('contratacao','${c.id}','observacoes',this.value)">${esc(c.observacoes || '')}</textarea></div>
    </div>
  </div></td></tr>`;

  return principal + detalhe;
}

// De onde sai a data de "contratar até". Fica visível e editável porque a
// antecedência era invisível: 10 dias para tudo, inclusive mobiliário sob
// medida, e o app dizia NO PRAZO para item já perdido. Quem cobra o prazo
// precisa poder ver a conta — e quem tem o prazo real do fornecedor precisa
// poder corrigi-la sem pedir para o TI.
function blocoAntecedencia(c) {
  const padrao = par('antecedencia_dias', 10);
  const dias = c.antecedencia_dias ?? padrao;
  const proprio = c.antecedencia_dias != null;
  return `<div class="bloco">
    <h4>De onde vem o prazo</h4>
    <div class="conta">
      <span>${fmtData(c.data_inicio) || '—'}</span>
      <span class="op">−</span>
      <input class="ed n dias" type="number" min="0" max="365" value="${dias}"
        onchange="editar('contratacao','${c.id}','antecedencia_dias',this.value,true)">
      <span class="op">dias =</span>
      <b>${fmtData(c.prazo_contratacao) || '—'}</b>
    </div>
    <div class="mini" style="margin-top:7px">
      Dias corridos entre fechar o contrato e a atividade poder começar.
      ${proprio ? 'Definido para este pacote.' : `Usando o padrão da obra (${padrao} dias).`}
    </div>
    ${proprio && dias > padrao ? `<div class="nota" style="margin-top:9px">
      Estimativa de mercado para fabricação sob medida — não é prazo de fornecedor.
      Quando compras confirmar a entrega real, troque aqui.</div>` : ''}
  </div>`;
}

// A fila de negociação que o planejamento passou aos compradores. Não é o
// prazo: é a ordem de atacar. Um item pode ser prioridade 1 e ainda ter folga,
// e outro vencer antes sem estar na fila — por isso os dois convivem na tela.
function seloPrioridade(c) {
  return c.prioridade_fechamento
    ? `<span class="prio" title="Prioridade ${c.prioridade_fechamento} de fechamento">${c.prioridade_fechamento}</span>`
    : `<span class="prio sem" title="Sem prioridade de fechamento definida">–</span>`;
}

function menorCotacao(c) {
  const vs = [c.cot1_valor, c.cot2_valor, c.cot3_valor].filter(v => v != null).map(Number);
  return vs.length ? Math.min(...vs) : null;
}

// A ponte entre as duas telas: contratar o serviço sem comprar o material que
// ele aplica não adianta nada. Quem abre a contratação vê o que falta comprar.
function materiaisDaContratacao(c) {
  const ms = S.materiais.filter(m => m.contratacao_id === c.id);
  if (!ms.length) return '';
  const pend = ms.filter(m => !m.comprado).length;
  return `<div class="linha" style="margin-top:9px;border:0">
    <span>Materiais vinculados</span>
    <span>${ms.length} itens · <b style="color:${pend ? 'var(--laranja)' : 'var(--verde)'}">${pend ? pend + ' a comprar' : 'todos comprados'}</b></span>
  </div>`;
}

/* ---- Tela 2: materiais ---- */
function telaMateriais() {
  const todos = S.materiais;
  if (!todos.length) return blocoPrimeiraImportacao('materiais');
  const pcTotal = todos.reduce((s, m) => s + Number(m.custo_total_pc || 0), 0);
  const cotados = todos.filter(m => m.valor_total_cotado != null);
  const totalCotado = cotados.reduce((s, m) => s + Number(m.valor_total_cotado), 0);
  const pcDosCotados = cotados.reduce((s, m) => s + Number(m.custo_total_pc || 0), 0);
  const desvio = totalCotado - pcDosCotados;
  const urgentes = todos.filter(m => ['ATRASADO', 'URGENTE'].includes(prioridadeDe(m))).length;
  const comprados = todos.filter(m => m.comprado).length;
  const entregues = todos.filter(m => m.status_compra === 'ENTREGUE').length;

  const kpis = `<div class="kpis">
    ${kpi('Itens', todos.length, 'na lista de compra', 'y')}
    ${kpi('Orçamento PC', fmtMoedaCurta(pcTotal), 'material, sem mão de obra', '')}
    ${kpi('Total cotado', fmtMoedaCurta(totalCotado), `${cotados.length} de ${todos.length} cotados`, 'b')}
    ${kpi('Variação', cotados.length ? (desvio <= 0 ? '−' : '+') + fmtMoedaCurta(Math.abs(desvio)) : '—',
        cotados.length ? 'cotado vs PC (itens cotados)' : 'sem cotação ainda', '', desvio <= 0 ? 'g' : 'r')}
    ${kpi('Urgentes', urgentes, 'atrasados ou ≤3 dias', 'r', urgentes ? 'r' : '')}
    ${kpi('Comprados', comprados, `${todos.length - comprados} pendentes`, 'g', comprados ? 'g' : '')}
    ${kpi('Entregues', entregues, 'já na obra', 'g')}
  </div>`;

  const filtros = [['todos', 'Todos'], ['atrasado', '🔴 Atrasados'], ['urgente', '🟠 Urgentes'],
                   ['proximo', '🟡 Próximos'], ['pendente', 'A comprar'], ['comprado', '✓ Comprados'],
                   ['entregue', '📦 Entregues']];
  const barra = `<div class="ferramentas">
    <div class="busca"><input placeholder="Buscar material, linha PC, fornecedor…" value="${esc(S.busca)}" oninput="aoBuscar(this.value)"></div>
    ${filtros.map(f => `<button class="filtro ${S.filtro === f[0] ? 'on' : ''}" onclick="aoFiltrar('${f[0]}')">${f[1]}</button>`).join('')}
    <button class="btn" onclick="exportarCSV('materiais')">↓ CSV</button>
    <button class="btn" onclick="window.print()">🖨 Imprimir</button>
    <button class="btn pri" onclick="abrirImportador('materiais')">↻ Atualizar da planilha</button>
  </div>` + LEGENDA;

  const linhas = todos.filter(m => {
    const p = prioridadeDe(m);
    if (S.busca && !(`${m.material} ${m.linha_pc} ${m.atividade || ''} ${m.fornecedor || ''}`)
        .toLowerCase().includes(S.busca)) return false;
    switch (S.filtro) {
      case 'atrasado': return p === 'ATRASADO';
      case 'urgente': return p === 'URGENTE';
      case 'proximo': return p === 'PRÓXIMO';
      case 'pendente': return !m.comprado && m.status_compra !== 'NÃO SE APLICA';
      case 'comprado': return m.comprado;
      case 'entregue': return m.status_compra === 'ENTREGUE';
      default: return true;
    }
  });

  const corpo = linhas.length ? linhas.map(linhaMaterial).join('')
    : `<tr><td colspan="11" class="semrot"><div class="vazio">Nenhum material neste filtro.</div></td></tr>`;

  return kpis + barra + `<div class="quadro"><div class="rolagem"><table>
    <thead><tr>
      <th>Linha PC</th><th>Material</th><th>Un</th><th class="num">Qtd</th>
      <th class="num">Custo PC</th><th>Comprar até</th><th>Prioridade</th>
      <th>Status</th><th>Fornecedor</th><th class="num">Total cotado</th><th></th>
    </tr></thead><tbody>${corpo}</tbody></table></div></div>`;
}

const STATUS_MAT = ['PENDENTE', 'EM COTAÇÃO', 'EM NEGOCIAÇÃO', 'COMPRADO', 'ENTREGUE', 'NÃO SE APLICA'];

function linhaMaterial(m) {
  const p = prioridadeDe(m);
  const acao = acaoMaterial(m.data_limite_compra, p);
  const aberta = S.abertos.has(m.id);
  const estado = estadoLinha(m);
  const encerrado = estado === 'fechado' || estado === 'na';   // mesma regra da contratação
  const na = m.status_compra === 'NÃO SE APLICA';

  const principal = `<tr class="est-${estadoLinha(m) || 'neutro'} ${aberta ? 'aberta' : ''}">
    <td data-r="Linha PC" class="mini forte">${esc(m.linha_pc)}</td>
    <td data-r="Material" class="material"><span class="nome">${esc(m.material)}</span>
      <span class="mini">${esc(m.atividade || '')}</span></td>
    <td data-r="Un" class="mini">${esc(m.unidade || '')}</td>
    <td data-r="Qtd" class="num">${fmtNum(m.quantidade)}</td>
    <td data-r="Custo PC" class="num">${fmtMoeda(m.custo_total_pc)}</td>
    <td data-r="Comprar até" class="forte empilha">${fmtData(m.data_limite_compra) || '—'}
      <span class="acao ${encerrado ? 'feito' : acao === 'OK' ? 'ok' : 'pede'}">${
        estado === 'fechado' ? (m.entrega_realizada ? '✓ entregue' : '✓ comprado') : na ? '' : esc(rotuloSituacao(acao))}</span></td>
    <td data-r="Prioridade">${(p && !encerrado) ? `<span class="selo ${classeSelo(p)}">${rotuloSituacao(p)}</span>` : '<span class="selo neutro">—</span>'}</td>
    <td data-r="Status"><select class="ed ${classeStatus(m.status_compra)}"
        onchange="editar('material','${m.id}','status_compra',this.value)">
      ${STATUS_MAT.map(s => `<option ${m.status_compra === s ? 'selected' : ''}>${s}</option>`).join('')}
    </select></td>
    <td data-r="Fornecedor"><input class="ed" value="${esc(m.fornecedor || '')}" placeholder="—"
        onchange="editar('material','${m.id}','fornecedor',this.value)"></td>
    <td data-r="Total cotado" class="num">${fmtMoeda(m.valor_total_cotado)}</td>
    <td class="semrot"><button class="expandir" onclick="alternar('${m.id}')" title="Detalhes e entrega">${aberta ? '▾' : '▸'}</button></td>
  </tr>`;

  if (!aberta) return principal;

  const desvioUnit = (m.valor_unit_cotado != null && m.custo_unit_pc)
    ? ((Number(m.valor_unit_cotado) - Number(m.custo_unit_pc)) / Number(m.custo_unit_pc)) * 100 : null;

  const detalhe = `<tr class="detalhe"><td colspan="11" class="semrot"><div class="det">
    <div class="bloco">
      <h4>Especificação completa</h4>
      <div class="espec">${esc(m.material)}</div>
      <div class="linha"><span>Linha da PC</span><span>${esc(m.linha_pc)}</span></div>
      <div class="linha"><span>Quantidade</span><span>${fmtNum(m.quantidade)} ${esc(m.unidade || '')}</span></div>
      <div class="linha"><span>Custo unitário</span><span>${fmtMoeda(m.custo_unit_pc)}</span></div>
      <div class="linha"><span><b>Custo total</b></span><span><b>${fmtMoeda(m.custo_total_pc)}</b></span></div>
      <div class="linha"><span>Necessário na obra</span><span>${fmtData(m.data_necessaria) || '—'}</span></div>
      <div class="linha"><span>Serviço</span><span class="mini">${esc(m.atividade || '—')}</span></div>
      ${m.observacoes ? `<div class="nota" style="margin-top:9px"><b>Antes de comprar:</b> ${esc(m.observacoes)}</div>` : ''}
    </div>
    <div class="bloco">
      <h4>Cotação</h4>
      <div class="campo"><label>Fornecedor</label>
        <input class="ed" value="${esc(m.fornecedor || '')}" placeholder="nome do fornecedor"
          onchange="editar('material','${m.id}','fornecedor',this.value)"></div>
      <div class="campo"><label>Valor unitário cotado</label>
        ${campoMoeda('material', m.id, 'valor_unit_cotado', m.valor_unit_cotado)}</div>
      <div class="linha"><span>Total cotado</span><span><b>${fmtMoeda(m.valor_total_cotado)}</b></span></div>
      <button class="btn" style="margin-top:9px;width:100%" onclick="pedirCotacao('${m.id}')"
        title="Abre seu e-mail com material, quantidade e prazo já preenchidos">✉ Pedir cotação</button>
      ${desvioUnit !== null ? `<div class="linha"><span>vs PC</span>
        <span style="color:${desvioUnit <= 0 ? 'var(--verde)' : 'var(--vermelho)'};font-weight:700">
        ${desvioUnit <= 0 ? '' : '+'}${desvioUnit.toFixed(1)}%</span></div>` : ''}
    </div>
    <div class="bloco">
      <h4>Compra e entrega</h4>
      <div class="campo"><label>Data da compra</label>
        <input type="date" class="ed" value="${m.data_compra || ''}"
          onchange="editar('material','${m.id}','data_compra',this.value)"></div>
      <div class="campo"><label>Entrega prevista</label>
        <input type="date" class="ed" value="${m.entrega_prevista || ''}"
          onchange="editar('material','${m.id}','entrega_prevista',this.value)"></div>
      <div class="campo"><label>Entrega realizada</label>
        <input type="date" class="ed" value="${m.entrega_realizada || ''}"
          onchange="editar('material','${m.id}','entrega_realizada',this.value)"></div>
      <div class="campo"><label style="display:flex;align-items:center;gap:8px;text-transform:none;font-size:13px;color:var(--tinta)">
        <input type="checkbox" class="marca-sim" ${m.comprado ? 'checked' : ''}
          onchange="editarBool('material','${m.id}','comprado',this.checked)"> Comprado</label></div>
      ${alertaEntrega(m)}
    </div>
  </div></td></tr>`;

  return principal + detalhe;
}

// Comprar não é receber. Uma entrega prevista depois da data em que o material
// é necessário na obra atrasa o serviço mesmo com a compra "resolvida" — é o
// furo que a planilha não mostrava, porque ela não tinha coluna de entrega.
// Entrega já realizada encerra o assunto, mesmo tendo chegado tarde.
function atrasoEntrega(m) {
  if (!m.entrega_prevista || !m.data_necessaria || m.entrega_realizada) return null;
  const atraso = diasEntre(m.data_necessaria, m.entrega_prevista);
  return (atraso !== null && atraso > 0) ? atraso : null;
}
function alertaEntrega(m) {
  const atraso = atrasoEntrega(m);
  if (!atraso) return '';
  return `<div class="nota" style="background:var(--vermelho-bg);border-color:#fecdc9;color:var(--vermelho)">
    A entrega prevista chega <b>${atraso} dia${atraso > 1 ? 's' : ''}</b> depois da data em que o material
    é necessário na obra (${fmtData(m.data_necessaria)}).</div>`;
}

// Fecha o ciclo dentro do app: compras vê o que falta cotar e dispara o pedido
// sem reescrever material, quantidade e prazo à mão num e-mail em branco —
// que é onde o dado se perde e vira "o fornecedor entendeu outra coisa".
function montarPedidoCotacao(m, obraNome, quem) {
  const prazo = m.data_limite_compra ? fmtData(m.data_limite_compra) : 'a definir';
  const assunto = `Solicitação de cotação — ${m.linha_pc} — ${obraNome}`;
  const corpo = [
    'Prezados,',
    '',
    `Solicitamos cotação para o item abaixo, referente à obra ${obraNome}.`,
    '',
    `Material: ${m.material}`,
    `Quantidade: ${fmtNum(m.quantidade)} ${m.unidade || ''}`.trim(),
    `Aplicação: ${m.atividade || '—'}`,
    `Necessário na obra em: ${fmtData(m.data_necessaria) || 'a confirmar'}`,
    '',
    `Pedimos retorno até ${prazo}, data-limite para a compra não impactar o cronograma.`,
    '',
    ...(m.observacoes ? ['Observações técnicas a confirmar na proposta:', m.observacoes, ''] : []),
    'Favor informar preço unitário, prazo de entrega e condições de pagamento.',
    '',
    'Atenciosamente,',
    quem || '',
    'Rio Sul Construções',
  ].join('\n');

  // O campo Fornecedor guarda o NOME, não o e-mail. Quando alguém já colou um
  // endereço ali, aproveitamos; senão deixamos o destinatário em branco para a
  // pessoa escolher — melhor vazio do que endereçado errado.
  const destino = (m.fornecedor && m.fornecedor.includes('@')) ? m.fornecedor : '';
  return `mailto:${encodeURIComponent(destino)}?subject=${encodeURIComponent(assunto)}&body=${encodeURIComponent(corpo)}`;
}

// mailto abre o cliente de e-mail da própria pessoa: o pedido sai do endereço
// dela, com a assinatura dela. Cotação é conversa comercial, não notificação
// automática — tem que sair de um humano identificável, e a resposta do
// fornecedor precisa cair numa caixa que alguém lê.
function pedirCotacao(id) {
  const m = acharLinha('material', id);
  if (!m) return;
  location.href = montarPedidoCotacao(m, S.obra.nome, S.eu);
}

/* ============================================================
   Tela 3: RELATÓRIO
   É a tela que vai impressa para a reunião de obra e o mesmo panorama que sai
   por e-mail todo dia útil às 08:00. Responde três perguntas, nessa ordem:
   o que trava a obra hoje · quanto do plano já foi fechado · quanto custa.
   ============================================================ */
function telaRelatorio() {
  const base = dataBase();
  const ctr = S.contratacoes, mat = S.materiais;

  // "Exige ação" = prazo estourado ou na iminência, e ainda não resolvido.
  const ctrAcao = ctr.filter(c => !c.contratado && c.status_processo !== 'NÃO SE APLICA'
      && ['ATRASADO', 'ATENÇÃO'].includes(farolDe(c)))
    .map(c => ({ tipo: 'Terceirizada', nome: c.atividade, prazo: c.prazo_contratacao,
                 selo: farolDe(c), status: c.status_processo, valor: c.valor_pc_total,
                 dias: diasEntre(base, c.prazo_contratacao) }));
  const matAcao = mat.filter(m => !m.comprado && m.status_compra !== 'NÃO SE APLICA'
      && ['ATRASADO', 'URGENTE'].includes(prioridadeDe(m)))
    .map(m => ({ tipo: 'Material', nome: `${m.linha_pc} — ${m.material}`, prazo: m.data_limite_compra,
                 selo: prioridadeDe(m), status: m.status_compra, valor: m.custo_total_pc,
                 dias: diasEntre(base, m.data_limite_compra) }));
  const acoes = [...ctrAcao, ...matAcao].sort((a, b) => (a.dias ?? 999) - (b.dias ?? 999));

  const contratados = ctr.filter(c => c.contratado).length;
  const comprados = mat.filter(m => m.comprado).length;
  const entregues = mat.filter(m => m.status_compra === 'ENTREGUE').length;
  const pcCtr = pcReferencia(ctr);
  const pcMat = mat.reduce((s, m) => s + Number(m.custo_total_pc || 0), 0);
  const fechado = ctr.reduce((s, c) => s + Number(c.valor_contratado || 0), 0);
  const cotados = mat.filter(m => m.valor_total_cotado != null);
  const cotado = cotados.reduce((s, m) => s + Number(m.valor_total_cotado), 0);
  const pcDosCotados = cotados.reduce((s, m) => s + Number(m.custo_total_pc || 0), 0);
  const desvioMat = cotado - pcDosCotados;
  const diasObra = S.obra.termino_obra ? diasEntre(base, S.obra.termino_obra) : null;

  const kpis = `<div class="kpis">
    ${kpi('Exigem ação hoje', acoes.length, 'prazo vencido ou na iminência', acoes.length ? 'r' : 'g',
        acoes.length ? 'r' : 'g')}
    ${kpi('Terceirizadas', `${contratados}/${ctr.length}`, 'contratadas', 'y')}
    ${kpi('Materiais', `${comprados}/${mat.length}`, `${entregues} já entregues`, 'y')}
    ${kpi('Prazo da obra', diasObra === null ? '—' : (diasObra >= 0 ? `${diasObra} d` : `${-diasObra} d`),
        diasObra === null ? '' : (diasObra >= 0 ? `até ${fmtData(S.obra.termino_obra)}` : 'em atraso'),
        'b', diasObra !== null && diasObra < 0 ? 'r' : '')}
    ${kpi('Referência PC', fmtMoedaCurta(pcCtr), pePcReferencia(ctr), '')}
    ${kpi('Já fechado', fmtMoedaCurta(fechado + cotado), 'contratado + cotado', 'g')}
  </div>`;

  const linhasAcao = acoes.length
    ? acoes.map(a => `<tr>
        <td data-r="Tipo" class="mini">${a.tipo}</td>
        <td data-r="Item" class="material forte"><span class="corta" title="${esc(a.nome)}">${esc(a.nome)}</span></td>
        <td data-r="Prazo" class="forte">${fmtData(a.prazo)}</td>
        <td data-r="Situação"><span class="selo ${classeSelo(a.selo)}">${rotuloSituacao(a.selo)}</span></td>
        <td data-r="Atraso" class="mini">${a.dias < 0 ? `<b style="color:var(--vermelho)">${-a.dias} dias atrás</b>`
            : `em ${a.dias} dia${a.dias === 1 ? '' : 's'}`}</td>
        <td data-r="Status" class="mini">${esc(a.status)}</td>
        <td data-r="Valor PC" class="num">${fmtMoeda(a.valor)}</td>
      </tr>`).join('')
    : `<tr><td colspan="7" class="semrot"><div class="vazio" style="color:var(--verde)">
        ✓ Nada vencido nem na iminência. Contratações e compras estão dentro do prazo.</div></td></tr>`;

  const porServico = ctr.map(c => {
    const ms = S.materiais.filter(m => m.contratacao_id === c.id);
    const pend = ms.filter(m => !m.comprado).length;
    const f = farolDe(c);
    return `<tr>
      <td data-r="Serviço" class="atividade forte"><div class="comprio">${seloPrioridade(c)}<span class="corta" title="${esc(c.atividade)}">${esc(c.atividade)}</span></div></td>
      <td data-r="Contratar até">${fmtData(c.prazo_contratacao) || '—'}</td>
      <td data-r="Situação">${f ? `<span class="selo ${classeSelo(f)}">${rotuloSituacao(f)}</span>` : '—'}</td>
      <td data-r="Contratação" class="mini">${c.contratado
          ? `<b style="color:var(--verde)">✓ contratado</b>` : esc(c.status_processo)}</td>
      <td data-r="Materiais" class="mini">${ms.length
          ? (pend ? `<b style="color:var(--laranja)">${pend} de ${ms.length} a comprar</b>`
                  : `<b style="color:var(--verde)">${ms.length} comprados</b>`)
          : '<i>sem material vinculado</i>'}</td>
      <td data-r="Referência PC" class="num">${fmtMoeda(c.valor_pc_total)}</td>
      <td data-r="Contratado" class="num">${fmtMoeda(c.valor_contratado)}</td>
    </tr>`;
  }).join('');

  return `<div class="ferramentas">
      <div style="flex:1;min-width:200px">
        <div style="font:700 17px var(--fonte)">Relatório de contratações e compras</div>
        <div class="mini">${esc(S.obra.nome)} · posição de ${fmtData(base)}</div>
      </div>
      <button class="btn" onclick="carregarRelatorio().then(render)">↻ Atualizar</button>
      <button class="btn pri" onclick="window.print()">🖨 Imprimir</button>
    </div>

    ${kpis}

    <div class="quadro" style="margin-bottom:16px">
      <div style="padding:13px 16px 0"><h3 style="margin:0;font:700 14px var(--fonte)">
        Exigem ação hoje</h3>
        <div class="mini" style="margin-top:2px">Ordenado do mais atrasado para o mais próximo de vencer.</div></div>
      <div class="rolagem"><table>
        <thead><tr><th>Tipo</th><th>Item</th><th>Prazo</th><th>Situação</th><th>Atraso</th>
          <th>Status</th><th class="num">Valor PC</th></tr></thead>
        <tbody>${linhasAcao}</tbody></table></div>
    </div>

    ${blocoEntregasTarde()}

    <div class="quadro" style="margin-bottom:16px">
      <div style="padding:13px 16px 0"><h3 style="margin:0;font:700 14px var(--fonte)">
        Andamento por serviço</h3>
        <div class="mini" style="margin-top:2px">Contratar o serviço sem comprar o material que ele aplica não destrava a obra — as duas colunas contam juntas.</div></div>
      <div class="rolagem"><table>
        <thead><tr><th>Serviço</th><th>Contratar até</th><th>Situação</th><th>Contratação</th>
          <th>Materiais</th><th class="num">Referência PC</th><th class="num">Contratado</th></tr></thead>
        <tbody>${porServico}</tbody></table></div>
    </div>

    <div class="quadro" style="margin-bottom:16px;padding:16px">
      <h3 style="margin:0 0 11px;font:700 14px var(--fonte)">Valores</h3>
      <div class="det" style="padding:0">
        <div class="bloco">
          <h4>Terceirizadas</h4>
          <div class="linha"><span>Referência PC (${ctr.filter(c => !c.referencia_compartilhada).length} serviço${
            ctr.filter(c => !c.referencia_compartilhada).length === 1 ? '' : 's'}${
            pcRepetida(ctr) ? ', fora a referência repetida' : ''})</span><span>${fmtMoeda(pcCtr)}</span></div>
          <div class="linha"><span>Contratado até agora</span><span><b>${fmtMoeda(fechado)}</b></span></div>
        </div>
        <div class="bloco">
          <h4>Materiais</h4>
          <div class="linha"><span>Orçamento de material na PC</span><span>${fmtMoeda(pcMat)}</span></div>
          <div class="linha"><span>Cotado (${cotados.length} de ${mat.length} itens)</span><span><b>${fmtMoeda(cotado)}</b></span></div>
          ${cotados.length ? `<div class="linha"><span>Desvio nos itens já cotados</span>
            <span style="color:${desvioMat <= 0 ? 'var(--verde)' : 'var(--vermelho)'};font-weight:700">
            ${desvioMat <= 0 ? '−' : '+'}${fmtMoeda(Math.abs(desvioMat))}</span></div>` : ''}
        </div>
        <div class="bloco">
          <h4>Como ler</h4>
          <div class="nota">O desvio compara <b>só os itens já cotados</b> contra a PC deles.
            Somar item sem preço como zero faria a obra parecer barata enquanto a maior parte
            da compra ainda nem foi orçada.</div>
        </div>
      </div>
    </div>

    ${blocoDestinatarios()}`;
}

// Item comprado com entrega marcada para depois da data em que ele é preciso na
// obra. É o atraso mais perigoso do conjunto, porque na coluna Status ele
// aparece como COMPRADO — resolvido. A planilha não tinha como mostrar isso.
function blocoEntregasTarde() {
  const tarde = S.materiais
    .map(m => ({ m, atraso: atrasoEntrega(m) }))
    .filter(x => x.atraso)
    .sort((a, b) => b.atraso - a.atraso);

  if (!tarde.length) return '';

  return `<div class="quadro" style="margin-bottom:16px">
    <div style="padding:13px 16px 0">
      <h3 style="margin:0;font:700 14px var(--fonte);color:var(--vermelho)">
        Compradas, mas chegam tarde</h3>
      <div class="mini" style="margin-top:2px">
        Entrega prevista depois da data em que o material é necessário na obra.
        Aparecem como resolvidas no status — não estão.</div></div>
    <div class="rolagem"><table>
      <thead><tr><th>Linha PC</th><th>Material</th><th>Necessário</th>
        <th>Entrega prevista</th><th>Atraso</th><th>Fornecedor</th></tr></thead>
      <tbody>${tarde.map(({ m, atraso }) => `<tr>
        <td data-r="Linha PC" class="mini forte">${esc(m.linha_pc)}</td>
        <td data-r="Material" class="material"><span class="corta" title="${esc(m.material)}">${esc(m.material)}</span></td>
        <td data-r="Necessário">${fmtData(m.data_necessaria)}</td>
        <td data-r="Entrega prevista" class="forte">${fmtData(m.entrega_prevista)}</td>
        <td data-r="Atraso"><span class="selo atrasado">${atraso} dia${atraso > 1 ? 's' : ''}</span></td>
        <td data-r="Fornecedor" class="mini">${esc(m.fornecedor || '—')}</td>
      </tr>`).join('')}</tbody></table></div>
  </div>`;
}

/* ---- Destinatários do alerta diário ---- */
function blocoDestinatarios() {
  const papeis = ['compras', 'gestor', 'planejamento', 'diretoria'];
  const lista = S.destinatarios.length
    ? S.destinatarios.map(d => `<tr>
        <td data-r="Nome" class="forte">${esc(d.nome)}</td>
        <td data-r="E-mail" class="mini">${esc(d.email)}</td>
        <td data-r="Papel"><select class="ed" onchange="editarDestinatario('${d.id}','papel',this.value)">
          ${papeis.map(p => `<option ${d.papel === p ? 'selected' : ''}>${p}</option>`).join('')}</select></td>
        <td data-r="Recebe"><label style="display:flex;align-items:center;gap:7px;justify-content:flex-end">
          <input type="checkbox" class="marca-sim" ${d.ativo ? 'checked' : ''}
            onchange="editarDestinatario('${d.id}','ativo',this.checked)">
          <span class="mini">${d.ativo ? 'recebe' : 'pausado'}</span></label></td>
      </tr>`).join('')
    : `<tr><td colspan="4" class="semrot"><div class="vazio">
        Ninguém cadastrado — o alerta diário não vai sair para nenhum e-mail.</div></td></tr>`;

  const ultimo = S.envios[0];
  const statusEnvio = ultimo
    ? `<div class="nota" style="margin-top:12px;${ultimo.status === 'erro'
        ? 'background:var(--vermelho-bg);border-color:#fecdc9;color:var(--vermelho)' : ''}">
        <b>Último envio:</b> ${fmtData(ultimo.em)} para ${esc(ultimo.destinatario)} —
        ${ultimo.status === 'enviado' ? 'entregue ✓' : `falhou: ${esc(String(ultimo.erro || '').slice(0, 160))}`}
       </div>`
    : `<div class="nota" style="margin-top:12px">Nenhum envio registrado ainda.</div>`;

  return `<div class="quadro" style="padding:16px">
    <h3 style="margin:0 0 4px;font:700 14px var(--fonte)">Quem recebe o alerta diário</h3>
    <div class="mini" style="margin-bottom:12px">
      Todo dia útil às 08:00 sai este mesmo panorama por e-mail para a lista abaixo.</div>
    <div class="rolagem"><table>
      <thead><tr><th>Nome</th><th>E-mail</th><th>Papel</th><th style="text-align:right">Recebe</th></tr></thead>
      <tbody>${lista}</tbody></table></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
      <input id="novoNome" class="ed" placeholder="Nome" style="border-color:var(--borda);background:#fff;max-width:180px">
      <input id="novoEmail" class="ed" placeholder="email@riosulconstrucoes.com.br" type="email"
        style="border-color:var(--borda);background:#fff;max-width:260px">
      <select id="novoPapel" class="ed" style="border-color:var(--borda);background:#fff;max-width:150px">
        ${papeis.map(p => `<option>${p}</option>`).join('')}</select>
      <button class="btn pri" onclick="adicionarDestinatario()">+ Adicionar</button>
    </div>
    ${statusEnvio}
  </div>`;
}

async function adicionarDestinatario() {
  const nome = document.getElementById('novoNome').value.trim();
  const email = document.getElementById('novoEmail').value.trim().toLowerCase();
  const papel = document.getElementById('novoPapel').value;
  if (!nome || !email) { avisar('Preencha nome e e-mail', true); return; }
  if (!await exigirNome()) return;
  try {
    await api('compras_destinatario', {
      method: 'POST',
      body: JSON.stringify({ obra_id: S.obra.id, nome, email, papel }),
    });
    await carregarRelatorio();
    render();
    avisar('Destinatário incluído ✓');
  } catch (e) {
    // O banco valida o formato do endereço; a mensagem crua do Postgres não
    // ajuda quem está na obra, então traduzimos o caso comum.
    avisar(/check|violates/i.test(e.message)
      ? 'E-mail inválido ou já cadastrado para esta obra.' : e.message, true);
  }
}

async function editarDestinatario(id, campo, valor) {
  if (!await exigirNome()) { render(); return; }
  const d = S.destinatarios.find(x => x.id === id);
  if (d) d[campo] = valor;
  render();
  try {
    await api(`compras_destinatario?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify({ [campo]: valor }) });
    avisar('Salvo ✓');
  } catch (e) {
    avisar('Não salvou: ' + e.message, true);
    await carregarRelatorio();
    render();
  }
}

/* ---- Tela 4: histórico ---- */
const ROTULO_CAMPO = {
  status_processo: 'status', status_compra: 'status', contratado: 'contratado',
  comprado: 'comprado', fornecedor: 'fornecedor', fornecedor_escolhido: 'fornecedor contratado',
  valor_contratado: 'valor contratado', valor_unit_cotado: 'valor unitário cotado',
  data_contratacao: 'data da contratação', data_compra: 'data da compra',
  entrega_prevista: 'entrega prevista', entrega_realizada: 'entrega realizada',
  observacoes: 'observações',
  cot1_fornecedor: 'cotação 1 — fornecedor', cot1_valor: 'cotação 1 — valor', cot1_escopo: 'cotação 1 — escopo',
  cot2_fornecedor: 'cotação 2 — fornecedor', cot2_valor: 'cotação 2 — valor', cot2_escopo: 'cotação 2 — escopo',
  cot3_fornecedor: 'cotação 3 — fornecedor', cot3_valor: 'cotação 3 — valor', cot3_escopo: 'cotação 3 — escopo',
};

function telaHistorico() {
  if (!S.eventos.length) {
    return `<div class="quadro"><div class="vazio">
      Ainda não há mudanças registradas.<br>
      <span class="mini">Cada edição de status, cotação, compra ou entrega passa a aparecer aqui — com quem fez e quando.</span>
    </div></div>`;
  }
  const itens = S.eventos.map(ev => {
    const d = new Date(ev.em);
    const quando = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const campo = ROTULO_CAMPO[ev.campo] || ev.campo;
    const de = ev.valor_antes ? `<span class="de">${esc(ev.valor_antes)}</span> → ` : '';
    return `<div class="evento">
      <span class="quando">${quando}</span>
      <span class="quem">${esc(ev.por_nome || 'alguém')}</span>
      <span class="oque">alterou <b>${esc(campo)}</b> de <i>${esc(ev.referencia || '')}</i>: ${de}<span class="pra">${esc(ev.valor_depois || '(vazio)')}</span></span>
    </div>`;
  }).join('');
  return `<div class="ferramentas"><button class="btn" onclick="carregarEventos().then(render)">↻ Atualizar</button></div>
    <div class="quadro">${itens}</div>`;
}

/* ============================================================
   6. EXPORTAR — a planilha de volta, para anexar em e-mail/ata
   ============================================================ */
function exportarCSV(qual) {
  const base = dataBase();
  let cab, linhas, nome;
  if (qual === 'contratacoes') {
    cab = ['Item', 'Atividade terceirizada', 'Data de início', 'Data de término', 'Prazo final para contratação',
           'Ação', 'Situação', 'Status', 'Contratado', 'Valor PC mão de obra', 'Valor PC material', 'Total PC',
           'Fornecedor 1', 'Escopo 1', 'Valor cotado 1', 'Fornecedor 2', 'Escopo 2', 'Valor cotado 2',
           'Fornecedor 3', 'Escopo 3', 'Valor cotado 3', 'Fornecedor contratado', 'Valor contratado',
           'Data da contratação', 'Observação da composição PC', 'Observações'];
    linhas = S.contratacoes.map(c => {
      const f = farolContratacao(c.prazo_contratacao, base, par('alerta_atencao_dias', 5));
      return [c.item, c.atividade, fmtData(c.data_inicio), fmtData(c.data_termino), fmtData(c.prazo_contratacao),
              acaoContratacao(c.prazo_contratacao, f), f, c.status_processo, c.contratado ? 'Sim' : 'Não',
              c.valor_pc_mo, c.valor_pc_material, c.valor_pc_total,
              c.cot1_fornecedor, c.cot1_escopo, c.cot1_valor, c.cot2_fornecedor, c.cot2_escopo, c.cot2_valor,
              c.cot3_fornecedor, c.cot3_escopo, c.cot3_valor, c.fornecedor_escolhido, c.valor_contratado,
              fmtData(c.data_contratacao), c.obs_composicao, c.observacoes];
    });
    nome = 'contratacoes';
  } else {
    cab = ['Item', 'Atividade', 'Linha PC', 'Material / item a comprar', 'Unidade', 'Quantidade PC',
           'Custo unitário de material PC', 'Custo total de material PC', 'Data necessária na obra',
           'Data-limite para compra', 'Ação', 'Prioridade', 'Fornecedor', 'Valor unitário cotado',
           'Valor total cotado', 'Status da compra', 'Comprado', 'Data da compra', 'Entrega prevista',
           'Entrega realizada', 'Observações / validações necessárias'];
    linhas = S.materiais.map(m => {
      const p = prioridadeMaterial(m.data_limite_compra, base, par('urgente_dias', 3), par('proximo_dias', 10));
      return [m.item, m.atividade, m.linha_pc, m.material, m.unidade, m.quantidade, m.custo_unit_pc,
              m.custo_total_pc, fmtData(m.data_necessaria), fmtData(m.data_limite_compra),
              acaoMaterial(m.data_limite_compra, p), p, m.fornecedor, m.valor_unit_cotado,
              m.valor_total_cotado, m.status_compra, m.comprado ? 'Sim' : 'Não', fmtData(m.data_compra),
              fmtData(m.entrega_prevista), fmtData(m.entrega_realizada), m.observacoes];
    });
    nome = 'materiais';
  }

  // ";" e vírgula decimal: é o que o Excel em pt-BR abre sem perguntar nada.
  const cel = v => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') return String(v).replace('.', ',');
    return `"${String(v).replace(/"/g, '""')}"`;
  };
  const csv = '﻿' + [cab, ...linhas].map(l => l.map(cel).join(';')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${nome}-${S.obra.slug}-${base}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  avisar('CSV gerado ✓');
}

/* ============================================================
   7. QUEM ESTÁ EDITANDO
   Sem login, por decisão: compras e fornecedores usam o link direto. O nome
   é o que dá rastro ao histórico — pedimos uma vez e guardamos no aparelho.
   ============================================================ */
let _resolverNome = null;

function perguntarQuemSou(obrigatorio) {
  const fundo = document.createElement('div');
  fundo.className = 'fundo';
  fundo.innerHTML = `<div class="modal">
    <h3>Quem está registrando?</h3>
    <p>${obrigatorio
      ? 'Antes de alterar, informe seu nome. Ele fica no histórico ao lado do que você mudar.'
      : 'Seu nome aparece no histórico ao lado do que você alterar.'}
      Fica salvo neste aparelho — você só informa uma vez.</p>
    <input id="campoNome" placeholder="Ex.: Fernando (Planejamento)" value="${esc(S.eu)}" maxlength="60">
    <div id="erroNome" class="mini" style="color:var(--vermelho);margin:-10px 0 13px;display:none">
      Escreva seu nome para continuar.</div>
    <div style="display:flex;gap:8px;justify-content:flex-end">
      <button class="btn" onclick="fecharQuemSou(false)">Cancelar</button>
      <button class="btn pri" onclick="salvarQuemSou()">Salvar</button>
    </div></div>`;
  // Clique fora só fecha quando o nome NÃO é obrigatório. Foi exatamente assim
  // que o primeiro registro do app saiu sem autor: a caixa era dispensável sem
  // querer, e a edição passava mesmo assim.
  if (!obrigatorio) fundo.addEventListener('click', e => { if (e.target === fundo) fecharQuemSou(false); });
  document.body.appendChild(fundo);
  const campo = document.getElementById('campoNome');
  campo.focus();
  campo.addEventListener('keydown', e => { if (e.key === 'Enter') salvarQuemSou(); });
}

function salvarQuemSou() {
  const v = document.getElementById('campoNome').value.trim();
  if (!v) {
    document.getElementById('erroNome').style.display = '';
    document.getElementById('campoNome').focus();
    return;
  }
  S.eu = v;
  localStorage.setItem('rsc_compras_quem', v);
  fecharQuemSou(true);
  renderCabecalho();
}

// Cancelar não é uma brecha: ele descarta a EDIÇÃO junto. Ou a pessoa se
// identifica e a mudança é gravada, ou nada acontece — nunca mudança órfã.
function fecharQuemSou(ok) {
  document.querySelector('.fundo')?.remove();
  const resolver = _resolverNome;
  _resolverNome = null;
  if (resolver) resolver(ok);
}

function exigirNome() {
  if (S.eu) return Promise.resolve(true);
  return new Promise(resolve => { _resolverNome = resolve; perguntarQuemSou(true); });
}

/* ============================================================
   8. AVISOS E PARTIDA
   ============================================================ */
let _avisoT;
function avisar(msg, erro) {
  const el = document.getElementById('aviso');
  el.textContent = msg;
  el.classList.toggle('erro', !!erro);
  el.classList.add('ver');
  clearTimeout(_avisoT);
  _avisoT = setTimeout(() => el.classList.remove('ver'), erro ? 5200 : 2100);
}

async function iniciar() {
  try {
    await carregar();
    render();
    // Sem pedir o nome de saída: quem só quer CONSULTAR a lista não deve
    // esbarrar numa caixa. O nome é pedido na primeira edição, que é onde ele
    // realmente importa.
  } catch (e) {
    document.getElementById('conteudo').innerHTML =
      `<div class="quadro"><div class="vazio">Não consegui carregar o acompanhamento.<br>
       <span class="mini">${esc(e.message)}</span></div></div>`;
  }
}

// Várias pessoas editam a mesma lista ao mesmo tempo. Recarregar ao voltar para
// a aba evita o caso em que compras marca "COMPRADO" e o gestor, com a tela
// velha aberta, grava por cima com o valor antigo.
//
// Mas recarregar no meio de uma digitação APAGA o que a pessoa está escrevendo:
// o texto ainda não foi salvo, então ele não existe no banco e a re-renderização
// devolve o campo vazio. Digitar o nome de um fornecedor leva mais de um minuto
// quando se está no canteiro, conferindo o orçamento — era perda garantida.
// Enquanto houver um campo em foco, o refresh espera o próximo ciclo.
function editandoAlgo() {
  const el = document.activeElement;
  return !!el && ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName);
}
function recarregarSeOcioso() {
  if (!document.hidden && S.obra && !editandoAlgo()) recarregar();
}
document.addEventListener('visibilitychange', recarregarSeOcioso);
setInterval(recarregarSeOcioso, 60000);

iniciar();
