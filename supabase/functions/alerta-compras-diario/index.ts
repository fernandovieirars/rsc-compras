// =====================================================================
// alerta-compras-diario — o panorama de contratações e compras por e-mail.
//
// Acionada pelo pg_cron nos dias úteis às 08:00 BRT, ou manualmente pelo
// botão na tela de Relatório do app.
//
// ESTA FUNÇÃO NÃO CALCULA NADA.
// Farol, prioridade e ação vêm prontos das views compras_painel_*. A regra de
// prazo já existe em dois lugares (a planilha original e o JavaScript do app);
// uma terceira cópia aqui em TypeScript acabaria divergindo, e a divergência
// apareceria como um e-mail dizendo "OK" para um item que a tela mostra
// vermelho. Ler a view é o que garante que o e-mail e o app contem a mesma
// história.
//
// COMO O E-MAIL SAI DAQUI
// Pelo Microsoft Graph, usando a app registration que a Rio Sul já tem no Entra
// (remetente noreply@riosulconstrucoes.com.br). Não depende de domínio
// verificado em serviço de terceiro — que é exatamente o que segurou este
// alerta: o Resend ficou em modo de teste esperando registros de DNS que
// ninguém publicou, e em modo de teste ele só entrega ao dono da conta. O
// alerta "funcionava" e não chegava a ninguém.
//
// O Resend continua como PLANO B, e a escolha é do ambiente, não de um
// parâmetro: sem os três secrets do Graph a função cai nele sozinha e nada
// piora; publicados os secrets, o Graph assume na chamada seguinte, sem tocar
// em código nem redeployar. Quem enviou fica gravado em
// compras_envio_log.resumo.via, para o diagnóstico não depender de adivinhação.
//
// ?dry=1   monta tudo e devolve o HTML sem enviar
// ?diag=1  diz qual transporte está ativo e quais secrets faltam (nunca valores)
// ?obra=   slug da obra (padrão: todas as obras cadastradas)
// =====================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RESEND_KEY = Deno.env.get('RESEND_API_KEY') || '';
const FROM_EMAIL = Deno.env.get('NOTIF_FROM_EMAIL') || 'onboarding@resend.dev';
const APP_URL = Deno.env.get('COMPRAS_APP_URL') || 'https://rsc-compras-obra.vercel.app';

// Os três do Graph são secrets do PROJETO (não da função) e vêm da mesma app
// registration já usada pelo resto da Rio Sul. Precisa da permissão de
// APLICAÇÃO `Mail.Send`, com consentimento do administrador — a delegada não
// serve, porque aqui não há ninguém logado.
const GRAPH_TENANT = Deno.env.get('GRAPH_TENANT_ID') || '';
const GRAPH_CLIENT = Deno.env.get('GRAPH_CLIENT_ID') || '';
const GRAPH_SECRET = Deno.env.get('GRAPH_CLIENT_SECRET') || '';
const GRAPH_FROM = Deno.env.get('GRAPH_FROM') || 'noreply@riosulconstrucoes.com.br';
const TEM_GRAPH = !!(GRAPH_TENANT && GRAPH_CLIENT && GRAPH_SECRET);

const sb = createClient(SUPABASE_URL, SERVICE_KEY);

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
const dt = (iso: string | null) => iso ? iso.slice(0, 10).split('-').reverse().join('/') : '—';
const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const COR: Record<string, string> = {
  ATRASADO: '#d92d20', URGENTE: '#e8590c', 'ATENÇÃO': '#b78103',
  'PRÓXIMO': '#b78103', OK: '#067647', PROGRAMADO: '#067647',
};

// O corpo vai ao Graph em JSON puro-ASCII, escapando tudo acima de 0x7F. Não é
// preciosismo: este caminho já corrompeu acentuação no app de planejamento, e
// aqui o assunto carrega "contratações" e os selos dizem "ATENÇÃO" e "PRÓXIMO" —
// sairia ilegível justamente na linha que pede ação.
function jsonAscii(o: unknown): string {
  return JSON.stringify(o).replace(/[\u0080-\uffff]/g, (c) =>
    '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

// O token vale cerca de uma hora, e esta função varre várias obras com vários
// destinatários cada. Pedir um token por e-mail multiplicaria a ida ao Entra
// sem trazer nada.
let tokenCache: { valor: string; expira: number } | null = null;

async function tokenGraph(): Promise<{ ok: true; token: string } | { ok: false; erro: string }> {
  if (tokenCache && Date.now() < tokenCache.expira) return { ok: true, token: tokenCache.valor };
  try {
    const r = await fetch(`https://login.microsoftonline.com/${GRAPH_TENANT}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: GRAPH_CLIENT,
        client_secret: GRAPH_SECRET,
        scope: 'https://graph.microsoft.com/.default',
        grant_type: 'client_credentials',
      }),
    });
    const t = await r.json();
    if (!t.access_token) {
      return { ok: false, erro: `Entra ${r.status}: ${t.error_description || t.error || 'sem access_token'}` };
    }
    // Margem de um minuto, para não pegar um token que vence no meio do laço.
    tokenCache = {
      valor: t.access_token,
      expira: Date.now() + ((Number(t.expires_in) || 3600) - 60) * 1000,
    };
    return { ok: true, token: t.access_token };
  } catch (e) {
    return { ok: false, erro: String(e) };
  }
}

async function enviarPorGraph(to: string, assunto: string, html: string) {
  const tk = await tokenGraph();
  if (!tk.ok) return { ok: false, erro: tk.erro };
  try {
    const r = await fetch(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(GRAPH_FROM)}/sendMail`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tk.token}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: jsonAscii({
          message: {
            subject: assunto,
            body: { contentType: 'HTML', content: html },
            toRecipients: [{ emailAddress: { address: to } }],
          },
          saveToSentItems: false,
        }),
      },
    );
    // O Graph aceita e responde 202, com corpo vazio. Qualquer outra coisa é erro.
    if (r.status !== 202) return { ok: false, erro: `Graph ${r.status}: ${(await r.text()).slice(0, 300)}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, erro: String(e) };
  }
}

async function enviarPorResend(to: string, assunto: string, html: string) {
  if (!RESEND_KEY) return { ok: false, erro: 'RESEND_API_KEY não configurada' };
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: `Rio Sul Obras <${FROM_EMAIL}>`, to: [to], subject: assunto, html }),
    });
    if (!r.ok) return { ok: false, erro: `Resend ${r.status}: ${(await r.text()).slice(0, 300)}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, erro: String(e) };
  }
}

// Graph quando há credencial, Resend quando não há.
export function escolherTransporte(temGraph: boolean): 'graph' | 'resend' {
  return temGraph ? 'graph' : 'resend';
}

async function enviarEmail(
  to: string, assunto: string, html: string,
): Promise<{ ok: boolean; erro?: string; via: string }> {
  const via = escolherTransporte(TEM_GRAPH);
  const r = via === 'graph'
    ? await enviarPorGraph(to, assunto, html)
    : await enviarPorResend(to, assunto, html);
  return { ...r, via };
}

function selo(t: string | null) {
  if (!t) return '';
  return `<span style="background:${COR[t] || '#8a8a94'};color:#fff;font:700 10px Arial,sans-serif;
    padding:3px 8px;border-radius:10px;white-space:nowrap">${t}</span>`;
}

function tabela(titulo: string, cabecalhos: string[], linhas: string[][], vazio: string) {
  if (!linhas.length) {
    return `<h3 style="margin:26px 0 8px;font:700 14px Arial,sans-serif;color:#1c1c1e">${titulo}</h3>
      <p style="margin:0;padding:12px 14px;background:#ecfdf3;border:1px solid #abefc6;border-radius:8px;
        font:13px Arial,sans-serif;color:#067647">${vazio}</p>`;
  }
  return `<h3 style="margin:26px 0 8px;font:700 14px Arial,sans-serif;color:#1c1c1e">${titulo}</h3>
  <table role="presentation" style="width:100%;border-collapse:collapse;font:13px Arial,sans-serif">
    <tr>${cabecalhos.map((h, i) => `<th style="text-align:${i >= cabecalhos.length - 1 ? 'right' : 'left'};
      padding:7px 9px;background:#faf9f5;border-bottom:1px solid #e3e1d8;font:700 10px Arial,sans-serif;
      color:#4a4a52;text-transform:uppercase;letter-spacing:.4px">${h}</th>`).join('')}</tr>
    ${linhas.map(l => `<tr>${l.map((c, i) => `<td style="padding:8px 9px;border-bottom:1px solid #efeee7;
      text-align:${i >= l.length - 1 ? 'right' : 'left'};color:#1c1c1e">${c}</td>`).join('')}</tr>`).join('')}
  </table>`;
}

function montarHtml(obra: any, ctr: any[], mat: any[]) {
  const ctrAcao = ctr.filter(c => !c.contratado && c.status_processo !== 'NÃO SE APLICA'
    && ['ATRASADO', 'ATENÇÃO'].includes(c.farol))
    .sort((a, b) => (a.dias_para_prazo ?? 999) - (b.dias_para_prazo ?? 999));

  const matAcao = mat.filter(m => !m.comprado && m.status_compra !== 'NÃO SE APLICA'
    && ['ATRASADO', 'URGENTE'].includes(m.prioridade))
    .sort((a, b) => (a.dias_para_limite ?? 999) - (b.dias_para_limite ?? 999));

  const contratados = ctr.filter(c => c.contratado).length;
  const comprados = mat.filter(m => m.comprado).length;
  const pcMat = mat.reduce((s, m) => s + Number(m.custo_total_pc || 0), 0);
  const cotados = mat.filter(m => m.valor_total_cotado != null);
  const totalCotado = cotados.reduce((s, m) => s + Number(m.valor_total_cotado), 0);
  const pcDosCotados = cotados.reduce((s, m) => s + Number(m.custo_total_pc || 0), 0);
  const desvio = totalCotado - pcDosCotados;

  const diasObra = obra.termino_obra
    ? Math.round((Date.parse(obra.termino_obra + 'T00:00:00Z') - Date.parse(obra.data_base + 'T00:00:00Z')) / 86400000)
    : null;

  const cartao = (rot: string, val: string, cor: string) =>
    `<td style="padding:0 5px" width="25%">
      <div style="background:#fff;border:1px solid #e3e1d8;border-left:3px solid ${cor};border-radius:8px;padding:11px 12px">
        <div style="font:700 10px Arial,sans-serif;color:#8a8a94;text-transform:uppercase;letter-spacing:.4px">${rot}</div>
        <div style="font:700 22px Arial,sans-serif;color:${cor};margin-top:4px">${val}</div>
      </div></td>`;

  return `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0;background:#f6f5f1;padding:18px 10px">
<div style="max-width:660px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.07)">

  <div style="background:#1c1c1e;padding:17px 22px;border-bottom:3px solid #ffd900">
    <span style="color:#ffd900;font:900 19px Arial,sans-serif;letter-spacing:3px">RSC</span>
    <span style="color:#8a8a94;font:11px Arial,sans-serif;margin-left:9px">Contratações &amp; Compras</span>
    <div style="color:#fff;font:700 16px Arial,sans-serif;margin-top:9px">${esc(obra.nome)}</div>
    <div style="color:#a5a5b0;font:12px Arial,sans-serif;margin-top:2px">
      ${dt(obra.data_base)}${diasObra !== null
        ? ` · término ${dt(obra.termino_obra)}, ${diasObra >= 0 ? `faltam ${diasObra} dias` : `${-diasObra} dias atrás`}`
        : ''}
    </div>
  </div>

  <div style="padding:20px 17px">
    <table role="presentation" style="width:100%;border-collapse:separate;border-spacing:0"><tr>
      ${cartao('Contratar já', String(ctrAcao.length), ctrAcao.length ? '#d92d20' : '#067647')}
      ${cartao('Comprar já', String(matAcao.length), matAcao.length ? '#d92d20' : '#067647')}
      ${cartao('Contratados', `${contratados}/${ctr.length}`, '#067647')}
      ${cartao('Comprados', `${comprados}/${mat.length}`, '#067647')}
    </tr></table>

    <div style="padding:0 5px">
    ${tabela('Terceirizadas — prazo de contratação vencendo ou vencido',
      ['Serviço', 'Contratar até', 'Situação', 'Referência PC'],
      ctrAcao.map(c => [
        `<b>${esc(c.atividade)}</b><br><span style="color:#8a8a94;font-size:11px">${esc(c.status_processo)}</span>`,
        `<b>${dt(c.prazo_contratacao)}</b><br><span style="color:${COR[c.farol]};font-size:11px">${
          c.dias_para_prazo < 0 ? `${-c.dias_para_prazo} dias atrás` : `em ${c.dias_para_prazo} dias`}</span>`,
        selo(c.farol),
        BRL.format(Number(c.valor_pc_total || 0)),
      ]),
      '✓ Nenhuma contratação com prazo vencendo. Tudo dentro do previsto.')}

    ${tabela('Materiais — compra atrasada ou urgente',
      ['Material', 'Comprar até', 'Prioridade', 'Custo PC'],
      matAcao.slice(0, 25).map(m => [
        `<b>${esc(String(m.material).slice(0, 62))}</b><br><span style="color:#8a8a94;font-size:11px">${
          esc(m.linha_pc)} · ${esc(m.status_compra)}</span>`,
        `<b>${dt(m.data_limite_compra)}</b><br><span style="color:${COR[m.prioridade]};font-size:11px">${
          m.dias_para_limite < 0 ? `${-m.dias_para_limite} dias atrás` : `em ${m.dias_para_limite} dias`}</span>`,
        selo(m.prioridade),
        BRL.format(Number(m.custo_total_pc || 0)),
      ]),
      '✓ Nenhum material atrasado ou urgente.')}
    ${matAcao.length > 25
      ? `<p style="margin:8px 0 0;font:12px Arial,sans-serif;color:#8a8a94">
         …e mais ${matAcao.length - 25} itens. Veja a lista completa no app.</p>` : ''}

    <h3 style="margin:26px 0 8px;font:700 14px Arial,sans-serif;color:#1c1c1e">Materiais — cotado x orçado</h3>
    <table role="presentation" style="width:100%;border-collapse:collapse;font:13px Arial,sans-serif">
      <tr><td style="padding:6px 0;color:#8a8a94">Orçamento de material na PC</td>
          <td style="padding:6px 0;text-align:right;font-weight:700">${BRL.format(pcMat)}</td></tr>
      <tr><td style="padding:6px 0;color:#8a8a94">Cotado até agora (${cotados.length} de ${mat.length} itens)</td>
          <td style="padding:6px 0;text-align:right;font-weight:700">${BRL.format(totalCotado)}</td></tr>
      ${cotados.length ? `<tr><td style="padding:6px 0;color:#8a8a94">Desvio nos itens já cotados</td>
          <td style="padding:6px 0;text-align:right;font-weight:700;color:${desvio <= 0 ? '#067647' : '#d92d20'}">
          ${desvio <= 0 ? '−' : '+'}${BRL.format(Math.abs(desvio))}</td></tr>` : ''}
    </table>

    <a href="${APP_URL}" style="display:inline-block;margin-top:24px;background:#ffd900;color:#1c1c1e;
      font:700 13px Arial,sans-serif;padding:12px 24px;border-radius:7px;text-decoration:none">
      Abrir o acompanhamento →</a>
    </div>
  </div>

  <div style="background:#0d0d0d;padding:11px 22px;text-align:center">
    <span style="color:#666;font:10px Arial,sans-serif">
      <b style="color:#ffd900">R</b>esponsabilidade · <b style="color:#ffd900">S</b>egurança ·
      <b style="color:#ffd900">C</b>omprometimento</span>
  </div>
</div></body></html>`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const url = new URL(req.url);
  const dry = url.searchParams.get('dry') === '1';
  const slug = url.searchParams.get('obra');

  // Diagnóstico: responde o que está configurado, nunca o valor de um segredo.
  // Serve para saber por que o e-mail não chegou sem precisar abrir o painel.
  if (url.searchParams.get('diag') === '1') {
    const faltando = ['GRAPH_TENANT_ID', 'GRAPH_CLIENT_ID', 'GRAPH_CLIENT_SECRET']
      .filter((n) => !Deno.env.get(n));
    return new Response(JSON.stringify({
      transporte_ativo: escolherTransporte(TEM_GRAPH),
      graph: { configurado: TEM_GRAPH, remetente: GRAPH_FROM, faltando },
      resend: { configurado: !!RESEND_KEY, remetente: FROM_EMAIL },
    }, null, 2), { headers: { ...cors, 'Content-Type': 'application/json' } });
  }

  let q = sb.from('compras_obra').select('*');
  if (slug) q = q.eq('slug', slug);
  const { data: obras, error: erroObras } = await q;
  if (erroObras) {
    return new Response(JSON.stringify({ erro: erroObras.message }), {
      status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  const relatorio: any[] = [];

  for (const obra of obras || []) {
    const [{ data: ctr }, { data: mat }, { data: dest }] = await Promise.all([
      sb.from('compras_painel_contratacao').select('*').eq('obra_id', obra.id),
      sb.from('compras_painel_material').select('*').eq('obra_id', obra.id),
      sb.from('compras_destinatario').select('nome,email').eq('obra_id', obra.id).eq('ativo', true),
    ]);

    const contratacoes = ctr || [], materiais = mat || [];
    // A data-base vem calculada pela view — é a mesma para todas as linhas.
    const dataBase = contratacoes[0]?.data_base || materiais[0]?.data_base ||
      new Date().toISOString().slice(0, 10);
    const html = montarHtml({ ...obra, data_base: dataBase }, contratacoes, materiais);

    const urgentes = materiais.filter((m: any) => !m.comprado && ['ATRASADO', 'URGENTE'].includes(m.prioridade)).length;
    const aContratar = contratacoes.filter((c: any) => !c.contratado && ['ATRASADO', 'ATENÇÃO'].includes(c.farol)).length;
    const assunto = (aContratar + urgentes) > 0
      ? `🔴 ${obra.nome}: ${aContratar} a contratar, ${urgentes} a comprar`
      : `✓ ${obra.nome}: contratações e compras em dia`;

    const resumo = { a_contratar: aContratar, a_comprar: urgentes, data_base: dataBase };
    const envios: any[] = [];

    if (!dest?.length) {
      relatorio.push({ obra: obra.nome, aviso: 'nenhum destinatário ativo cadastrado', resumo });
      continue;
    }

    for (const d of dest) {
      if (dry) { envios.push({ email: d.email, status: 'dry-run', via: escolherTransporte(TEM_GRAPH) }); continue; }
      const r = await enviarEmail(d.email, assunto, html);
      await sb.from('compras_envio_log').insert({
        obra_id: obra.id, destinatario: d.email, assunto,
        status: r.ok ? 'enviado' : 'erro', erro: r.erro || null,
        // `via` entra no resumo (jsonb) — assim saber por onde saiu cada e-mail
        // não custou uma coluna nova nem uma migration.
        resumo: { ...resumo, via: r.via },
      });
      envios.push({ email: d.email, status: r.ok ? 'enviado' : 'erro', via: r.via, erro: r.erro });
    }

    relatorio.push({ obra: obra.nome, assunto, resumo, envios, ...(dry ? { html } : {}) });
  }

  return new Response(JSON.stringify({
    sucesso: true, dry_run: dry, transporte: escolherTransporte(TEM_GRAPH), relatorio,
  }, null, 2), {
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
});
