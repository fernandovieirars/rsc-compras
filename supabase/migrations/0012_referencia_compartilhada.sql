-- =====================================================================
-- Referência de PC que aparece em dois pacotes: marcar, para não somar duas vezes.
--
-- O QUE FOI ENCONTRADO
-- Na PC REV05 da Escola, a linha 2.6.3 (pintura de paredes) é a TOTALIDADE do
-- pacote 14 (Pintura externa) e ao mesmo tempo está DENTRO do pacote 13
-- (Pintura interna, bloco 2.6 completo). Somando os 18 pacotes, R$ 58.770,77
-- entram duas vezes: o total da obra vira R$ 2.368.296,64 em vez de
-- R$ 2.309.525,86 — 2,5% a mais.
--
-- A prova de que a leitura está certa: tirando a 2.6.3, o material somado pelos
-- pacotes bate com a soma dos 102 itens da planilha de materiais
-- (R$ 1.270.239,20), a menos de um centavo de arredondamento.
--
-- POR QUE OS DOIS PACOTES CONTINUAM EXISTINDO
-- Não é erro de cadastro. A fachada pode ir para outro empreiteiro, e aí o
-- pacote 14 precisa existir com o seu próprio prazo, cotação e contrato. O que
-- não vale é o SOMATÓRIO. Por isso a linha não é apagada nem desativada: ela é
-- marcada, continua valendo para o contrato dela, e sai apenas dos totais.
--
-- POR QUE UMA COLUNA, E NÃO DETECÇÃO AUTOMÁTICA
-- Daria para inferir comparando `linhas_pc_*` entre pacotes e procurando um
-- contido no outro. Seria adivinhação: dois pacotes podem legitimamente citar a
-- mesma linha de PC sem que um contenha o valor do outro, e nesse dia o total
-- passaria a subtrair sozinho, sem ninguém entender por quê. A própria PC diz
-- qual é o caso, na observação da composição — a marca segue a PC, não um palpite.
--
-- A coluna NÃO entra em CAMPOS_PLANEJAMENTO (importar.js): reimportar a planilha
-- não pode apagar a marca, do mesmo jeito que não apaga fornecedor nem cotação.
--
-- Idempotente.
-- =====================================================================

alter table public.compras_contratacao
  add column if not exists referencia_compartilhada boolean not null default false;

comment on column public.compras_contratacao.referencia_compartilhada is
  'Os valores de PC desta linha JÁ ESTÃO contados em outro pacote — não somar no '
  'total da obra. A linha continua valendo para o contrato dela. Caso de origem: '
  'a 2.6.3 da Escola, que responde sozinha pela Pintura externa e também está '
  'dentro do bloco 2.6 da Pintura interna.';

-- Backfill do caso conhecido. Amarrado à obra, ao item e ao nome da atividade —
-- item 14 sozinho não identifica nada em outra obra.
update public.compras_contratacao c
   set referencia_compartilhada = true
  from public.compras_obra o
 where c.obra_id = o.id
   and o.slug = 'escola-ambev'
   and c.item = 14
   and c.atividade ilike 'Pintura externa%'
   and c.referencia_compartilhada is distinct from true;
