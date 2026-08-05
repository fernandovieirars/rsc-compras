// =====================================================================
// ativar-remetente — liga o remetente definitivo sozinho.
//
// O PROBLEMA QUE RESOLVE
// Publicar os 3 registros de DNS é a única etapa que precisa de uma pessoa
// (a Microsoft hospeda o DNS do domínio e não expõe API para editá-lo). Sem
// esta função, depois de publicar alguém ainda teria que lembrar de avisar, e
// outra pessoa teria que rodar um UPDATE. Duas etapas manuais para um evento
// que o próprio sistema consegue perceber.
//
// COMO PERCEBE
// A chave do Resend deste projeto é só de envio: consultar /domains responde
// 401. Então em vez de perguntar "o domínio está verificado?", a função
// simplesmente TENTA enviar do endereço definitivo. Enquanto o domínio não
// estiver verificado o Resend recusa com 403 e nada muda. No instante em que
// passar, o envio funciona e a troca é gravada — uma vez só, para sempre.
//
// Roda de hora em hora pelo pg_cron. Quando o remetente já está ativo, sai na
// primeira linha sem gastar envio.
// =====================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RESEND_KEY = Deno.env.get('RESEND_API_KEY') || '';

// Endereço definitivo e para onde mandar a confirmação do teste.
const ALVO = 'avisos@riosulconstrucoes.com.br';
const CONFIRMAR_PARA = 'fernando.vieira@riosulconstrucoes.com.br';

const sb = createClient(SUPABASE_URL, SERVICE_KEY);
const json = (o: unknown) => new Response(JSON.stringify(o, null, 2),
  { headers: { 'Content-Type': 'application/json' } });

Deno.serve(async () => {
  const { data: cfg } = await sb.from('compras_config').select('*').eq('id', true).maybeSingle();
  const atual = cfg?.remetente_email || '';

  if (!/@resend\.dev$/i.test(atual)) {
    return json({ acao: 'nada', motivo: 'remetente definitivo ja esta ativo', remetente: atual });
  }
  if (!RESEND_KEY) return json({ acao: 'nada', motivo: 'RESEND_API_KEY ausente' });

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: `Rio Sul Obras <${ALVO}>`,
      to: [CONFIRMAR_PARA],
      subject: 'Dominio verificado: alertas de compras liberados para toda a equipe',
      html: `<!doctype html><html><body style="margin:0;background:#f6f5f1;padding:20px 12px;font-family:Arial,sans-serif">
        <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden">
          <div style="background:#1c1c1e;padding:16px 22px;border-bottom:3px solid #ffd900">
            <span style="color:#ffd900;font-weight:900;font-size:19px;letter-spacing:3px">RSC</span>
          </div>
          <div style="padding:22px">
            <h2 style="margin:0 0 10px;font-size:17px;color:#1c1c1e">Remetente ativado automaticamente</h2>
            <p style="margin:0 0 14px;font-size:14px;color:#4a4a52;line-height:1.6">
              Os registros de DNS foram detectados e o dominio esta verificado no Resend.
              O sistema trocou o remetente de <code>onboarding@resend.dev</code> para
              <b>${ALVO}</b> sozinho.
            </p>
            <p style="margin:0;font-size:14px;color:#4a4a52;line-height:1.6">
              A partir do proximo alerta diario, <b>todos os destinatarios cadastrados passam a
              receber</b> — nao so voce. Nenhuma acao e necessaria.
            </p>
          </div>
        </div></body></html>`,
    }),
  });

  if (!r.ok) {
    const corpo = (await r.text()).slice(0, 220);
    // 403 aqui é o estado normal enquanto o DNS não foi publicado. Não é erro.
    return json({
      acao: 'aguardando',
      motivo: r.status === 403
        ? 'dominio ainda nao verificado no Resend (registros de DNS pendentes)'
        : `Resend ${r.status}: ${corpo}`,
      remetente_atual: atual,
    });
  }

  await sb.from('compras_config').update({
    remetente_email: ALVO,
    atualizado_em: new Date().toISOString(),
  }).eq('id', true);

  await sb.from('compras_envio_log').insert({
    destinatario: CONFIRMAR_PARA,
    assunto: 'Dominio verificado: remetente trocado automaticamente',
    status: 'enviado',
    resumo: { evento: 'ativacao_remetente', de: atual, para: ALVO },
  });

  // Cumpriu o propósito: não precisa mais rodar de hora em hora.
  await sb.rpc('desagendar_ativacao_remetente').catch(() => {});

  return json({ acao: 'ativado', de: atual, para: ALVO });
});
