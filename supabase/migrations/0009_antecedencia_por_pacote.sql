-- ============================================================
-- Prazo de fabricação por pacote (antecedência) + contrapiso corrigido
--
-- O PROBLEMA
-- A obra tinha UMA antecedência para tudo: 10 dias corridos entre fechar a
-- compra e o material estar na obra. Herdado da planilha, e razoável para
-- argamassa, tinta e cimento — que é o que a planilha original cobria.
--
-- Não é razoável para o que entrou depois. Mobiliário escolar sob medida
-- (22 itens, R$ 352 mil) leva 45 a 60 dias de fabricação. 35 computadores
-- levam 45. Esquadria de madeira e alumínio sob medida, 45. Com 10 dias para
-- todos, o app dizia NO PRAZO para item que já estava perdido — exatamente o
-- defeito da planilha parada na caixa de entrada que este app existe para
-- corrigir, só que por outro caminho.
--
-- COMO FUNCIONA
-- antecedencia_dias no item vence a da obra. Nulo = usa a da obra (10).
-- O gatilho recalcula o prazo quando a antecedência ou a data necessária
-- mudam. Fica no banco, e não no JS, porque a planilha é reimportada: sem o
-- gatilho, a próxima importação sobrescreveria o prazo com o valor de 10 dias
-- da planilha e ninguém perceberia.
--
-- ⚠️ OS NÚMEROS SEMEADOS ABAIXO SÃO ESTIMATIVA DE MERCADO, NÃO COTAÇÃO.
-- Servem para parar de mentir por omissão enquanto o prazo real não vem do
-- fornecedor. São editáveis na tela — quando compras confirmar o prazo de
-- entrega de cada um, é para trocar.
-- ============================================================

alter table compras_contratacao add column if not exists antecedencia_dias integer;
alter table compras_material    add column if not exists antecedencia_dias integer;

comment on column compras_contratacao.antecedencia_dias is
  'Dias corridos entre fechar o contrato e a atividade poder começar. Nulo = usa compras_obra.antecedencia_dias.';
comment on column compras_material.antecedencia_dias is
  'Dias corridos de fabricação/entrega. Nulo = usa compras_obra.antecedencia_dias.';

-- ---- Gatilho: prazo = data necessária - antecedência efetiva ----
create or replace function compras_recalcular_prazo()
returns trigger language plpgsql as $$
declare
  v_padrao integer;
begin
  select antecedencia_dias into v_padrao from compras_obra where id = new.obra_id;
  v_padrao := coalesce(v_padrao, 10);

  if tg_table_name = 'compras_contratacao' then
    if new.data_inicio is not null and new.antecedencia_dias is not null then
      new.prazo_contratacao := new.data_inicio - new.antecedencia_dias;
    end if;
  else
    if new.data_necessaria is not null and new.antecedencia_dias is not null then
      new.data_limite_compra := new.data_necessaria - new.antecedencia_dias;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_prazo_contratacao on compras_contratacao;
create trigger trg_prazo_contratacao before insert or update
  of data_inicio, antecedencia_dias on compras_contratacao
  for each row execute function compras_recalcular_prazo();

drop trigger if exists trg_prazo_material on compras_material;
create trigger trg_prazo_material before insert or update
  of data_necessaria, antecedencia_dias on compras_material
  for each row execute function compras_recalcular_prazo();

-- ---- Semeadura por pacote ----
do $$
declare
  v_obra uuid;
begin
  select id into v_obra from compras_obra where slug = 'escola-ambev';
  if v_obra is null then return; end if;

  -- Correção do contrapiso: 1.5.2.5 "Regularização de contrapiso com argamassa",
  -- sob 1.5.2 "Piso concreto estrutural" — é o piso da escola. A outra candidata
  -- (1.15.1.7) está sob 1.15 FEIRINHA, prédio diferente. Base 1: 22/07, 0% feito.
  update compras_contratacao
     set data_inicio = date '2026-07-22', atualizado_em = now()
   where obra_id = v_obra and ativo
     and atividade = 'Contrapiso e regularização — salas e áreas internas';

  update compras_material
     set data_necessaria = date '2026-07-22', atualizado_em = now()
   where obra_id = v_obra and ativo
     and atividade = 'Contrapiso e regularização — salas e áreas internas';

  -- Fabricação sob medida — o prazo real está no fornecedor, não aqui.
  with dias(atividade, d) as (values
    ('Mobiliário — salas, biblioteca e administrativo',      60),
    ('Esquadrias — madeira, alumínio e portas sanitárias',   45),
    ('Informática — computadores e rede',                    45),
    ('Comunicação visual e identidade',                      30),
    ('Infraestrutura de ar-condicionado',                    30),
    ('Equipamentos de copa e cozinha',                       30),
    ('Pisos internos — salas e demais áreas',                20),
    ('Revestimento de piso e paredes — banheiros e cantina', 20),
    ('Forro de gesso acartonado',                            15)
  )
  update compras_contratacao c set antecedencia_dias = dias.d
    from dias where c.obra_id = v_obra and c.ativo and c.atividade = dias.atividade;

  with dias(atividade, d) as (values
    ('Mobiliário — salas, biblioteca e administrativo',      60),
    ('Esquadrias — madeira, alumínio e portas sanitárias',   45),
    ('Informática — computadores e rede',                    45),
    ('Comunicação visual e identidade',                      30),
    ('Infraestrutura de ar-condicionado',                    30),
    ('Equipamentos de copa e cozinha',                       30),
    ('Pisos internos — salas e demais áreas',                20),
    ('Revestimento de piso e paredes — banheiros e cantina', 20),
    ('Forro de gesso acartonado',                            15)
  )
  update compras_material m set antecedencia_dias = dias.d
    from dias where m.obra_id = v_obra and m.ativo and m.atividade = dias.atividade;
end $$;

-- ---- Registro da origem do contrapiso ----
update compras_contratacao
   set obs_composicao = coalesce(obs_composicao || ' ', '') ||
       'Prazo pela tarefa 1.5.2.5 (Regularização de contrapiso com argamassa), sob ' ||
       '1.5.2 Piso concreto estrutural — início 22/07/2026 na linha de base 1, com 0% ' ||
       'executado. A tarefa 1.15.1.7 de mesmo nome pertence à Feirinha, não à escola.'
 where ativo and atividade = 'Contrapiso e regularização — salas e áreas internas'
   and coalesce(obs_composicao, '') not like '%1.5.2.5%';
