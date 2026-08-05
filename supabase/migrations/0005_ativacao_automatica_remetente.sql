-- =====================================================================
-- Ativação automática do remetente definitivo.
--
-- O PROBLEMA
-- Publicar os 3 registros de DNS é a única etapa que exige uma pessoa: a
-- Microsoft hospeda o DNS do domínio (ns*.bdm.microsoftonline.com) e não expõe
-- API para editá-lo — é operação de painel, nem para administrador.
--
-- Sem esta automação sobrariam DUAS etapas manuais depois disso: alguém teria
-- que lembrar de avisar, e outra pessoa teria que rodar um UPDATE. Duas etapas
-- humanas para um evento que o próprio sistema consegue perceber.
--
-- COMO PERCEBE
-- A chave do Resend deste projeto é só de envio: consultar /domains responde
-- 401. Então em vez de perguntar "o domínio está verificado?", a função TENTA
-- enviar do endereço definitivo. Enquanto o DNS não estiver publicado o Resend
-- recusa com 403 e nada muda — nenhum e-mail sai. No instante em que passar, o
-- envio funciona, a troca é gravada e o job se desagenda.
--
-- Idempotente: seguro rodar mais de uma vez.
-- =====================================================================

create or replace function public.desagendar_ativacao_remetente()
returns text language plpgsql security definer set search_path = public, cron as $$
begin
  if exists (select 1 from cron.job where jobname = 'ativar-remetente-horario') then
    perform cron.unschedule('ativar-remetente-horario');
    return 'desagendado';
  end if;
  return 'ja estava desagendado';
end $$;

comment on function public.desagendar_ativacao_remetente is
  'Chamada pela Edge Function ativar-remetente quando o domínio finalmente '
  'verifica. O job é uma espera, não uma rotina: cumprido o objetivo, ele se '
  'apaga em vez de bater de hora em hora para sempre.';

-- SECURITY DEFINER com execução restrita: quem tem o link do app não deve
-- conseguir mexer no agendamento.
revoke all on function public.desagendar_ativacao_remetente() from public, anon, authenticated;
grant execute on function public.desagendar_ativacao_remetente() to service_role;

-- Minuto 17 de propósito: não disputa com os jobs que rodam no minuto 0.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'notificar-planos-vencidos-diario')
     and not exists (select 1 from cron.job where jobname = 'ativar-remetente-horario') then
    perform cron.schedule(
      'ativar-remetente-horario',
      '17 * * * *',
      (select replace(command, 'notificar-planos-vencidos', 'ativar-remetente')
         from cron.job where jobname = 'notificar-planos-vencidos-diario')
    );
  end if;
end $$;
