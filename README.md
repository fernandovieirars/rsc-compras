# Contratações &amp; Compras — acompanhamento de obra

App para o **plano de ação de término da obra**: acompanhar, junto com o setor
de compras e o gestor da obra, os prazos-limite de **contratação de
terceirizadas** e de **compra de materiais**.

Substitui duas planilhas que circulavam por e-mail:

| Planilha de origem | Vira |
|---|---|
| Prazos de contratação e cotações | aba **Terceirizadas** |
| Materiais a comprar | aba **Materiais** |

O cálculo delas está preservado linha por linha (ver *Fidelidade às planilhas*).
O que muda é que **a linha é uma só** e todo mundo edita a mesma.

---

## O problema que isto resolve

Não é o cálculo — a planilha calculava certo. É a **cópia**:

- compras preenche a cotação num arquivo;
- o gestor marca "Contratado: Sim" noutro;
- o planejamento reimporta o cronograma e gera um terceiro;
- ninguém sabe qual é o verdadeiro.

E há um defeito mais silencioso: a planilha tem uma **data-base fixa numa
célula**. Parada numa caixa de entrada, ela envelhece calada — o farol continua
verde num item que venceu semana passada. Aqui a data-base é **hoje**, e o farol
é recalculado a cada abertura.

---

## Como usar

1. Abra o link. Não tem login. Só consultar não pede nada.
2. Na **primeira edição**, o app pede seu nome — ele aparece no **Histórico** ao
   lado do que você alterar, e fica salvo no aparelho. A caixa não fecha vazia:
   ou a pessoa se identifica, ou a mudança não é gravada. Um histórico que diz
   "alguém mudou para EM COTAÇÃO" não responde a pergunta que se faz na reunião
   de obra, que é quem destravou — ou quem parou — cada item.
3. Edite direto na tabela: status, fornecedor, valores cotados, datas de compra
   e entrega. Salva sozinho.
4. `▸` no fim da linha abre as cotações e os detalhes.

A tela recarrega ao voltar para a aba e a cada minuto — várias pessoas mexem na
mesma lista ao mesmo tempo.

---

## Várias obras

Cada obra tem seu acompanhamento e seu link: `?obra=escola-ambev`. **Clique no
nome da obra no topo** para trocar de obra ou cadastrar outra.

Sem `?obra=` na URL, o app abre a última obra que você usou neste aparelho — e,
na primeira visita, a primeira da lista. Com `?obra=` de uma obra que não
existe, ele dá erro em vez de abrir outra: link errado tem de aparecer como
link errado, e não como o prazo da obra vizinha.

### Cadastrar uma obra

No trocador, em **+ Cadastrar outra obra**. Pede nome, cliente (opcional) e
término previsto (opcional); o `slug` do link é derivado do nome pelo banco.
Nome repetido não é recusado — ganha sufixo (`reforma-fachada-2`), porque duas
obras podem se chamar igual em anos diferentes.

Depois de criar, faltam duas coisas, e a tela conduz a ambas:

1. **Importar as duas planilhas** (abas Terceirizadas e Materiais). Enquanto não
   vierem, a obra aparece vazia e o alerta diário dela **não é enviado** — obra
   sem planilha geraria um e-mail de tabelas vazias todo dia, e ruído diário
   ensina a lista a ignorar o alerta.
2. **Conferir os destinatários** na aba Relatório. A lista é *por obra*. Ao
   cadastrar, a caixa "copiar os destinatários" vem marcada e traz a lista da
   obra aberta — sem isso a obra nasce sem ninguém, e o alerta dela não sai para
   e-mail nenhum, sem erro e sem log.

### Por que criar obra é uma RPC, e não um `insert`

`compras_obra` é **somente-leitura** para o app (migration 0006) e continua
sendo. Quem escreve na tabela escreve em `data_base`, e data-base preenchida
congela o farol num dia fixo: a tela para de envelhecer e ninguém percebe,
porque tudo continua carregando. É o defeito da planilha que este app existe
para corrigir.

Então o cadastro passa por `compras_criar_obra` (migration 0011), uma função
`security definer` que insere **só** nome, cliente e término. `data_base` não
está na assinatura — não há como preenchê-la pela tela.

Há um segundo motivo, prático: o guarda de permissões (migration 0007) declara
`compras_obra → SELECT` e roda de hora em hora devolvendo tudo ao lugar. Um
`grant insert` na tabela seria revogado sozinho em até 60 minutos e o cadastro
quebraria depois do deploy, longe de quem mexeu. O guarda não olha função.

---

## Fidelidade às planilhas

As colunas de fórmula viraram funções em `app.js`:

| Planilha | Fórmula original | Função |
|---|---|---|
| Contratação, `Status` | `=SE(prazo<base;"ATRASADO";SE(prazo-base<=5;"ATENÇÃO";"OK"))` | `farolContratacao()` |
| Materiais, `Prioridade` | `=SE(limite<base;"ATRASADO";SE(limite-base<=3;"URGENTE";SE(limite-base<=10;"PRÓXIMO";"PROGRAMADO")))` | `prioridadeMaterial()` |
| Materiais, `Ação` | `=SE(prioridade="PROGRAMADO";"OK";"COMPRAR ATÉ "&TEXTO(limite;"dd/mm/aaaa"))` | `acaoMaterial()` |
| Materiais, `Valor total cotado` | `=quantidade*valor_unitário` | coluna gerada no banco |

`node testes/calculo.test.js` prova a equivalência: alimenta as funções com os
prazos reais das 72 linhas da obra e compara com o que o **próprio Excel**
calculou (`testes/planilhas.fixture.json`, extraído dos arquivos de origem).
São 156 verificações, incluindo as bordas das janelas e o horário de verão.

### Três divergências corrigidas

1. **Coluna `Ação` da planilha de contratação era digitada à mão** e discordava
   do próprio farol: o item 4 (*Piso externo*) dizia `OK` com a situação em
   `ATENÇÃO`. No app a regra é uma só, igual à dos materiais — aquele item passa
   a mostrar `CONTRATAR ATÉ 07/08/2026`.
2. **A coluna `Status` das contratações tinha lista de validação**
   (`PENDENTE / EM COTAÇÃO / …`) mas continha uma fórmula de farol — dois
   sentidos no mesmo lugar. Aqui viraram duas colunas: **Situação** (calculada) e
   **Status** (o que compras informa).
3. **`Total cotado` só soma itens efetivamente cotados.** Somar item sem preço
   como zero faria a comparação com a PC parecer uma economia que não existe.

### A linha que aparece em dois pacotes

O material 58 (*Pintura de paredes*, linha PC 2.6.3) é **referência compartilhada**:
ele responde sozinho pelo pacote 14 (*Pintura externa*) e também está dentro do
bloco 2.6 do pacote 13 (*Pintura interna*).

Somando os 18 pacotes direto, **R$ 58.770,77 entram duas vezes** — o total da obra
vira R$ 2.368.296,64 em vez de R$ 2.309.525,86, 2,5% a mais. A prova de que a
leitura está certa: tirando a 2.6.3, o material somado pelos pacotes bate com a
soma dos 102 itens da planilha de materiais (R$ 1.270.239,20), a menos de um
centavo de arredondamento.

Os dois pacotes continuam existindo, porque a fachada pode ir para outro
empreiteiro e precisa do seu próprio prazo e contrato. O que muda é só o
somatório: a coluna `referencia_compartilhada` (migration 0012) marca a linha, o
cartão **Referência PC** a exclui e diz quanto ficou de fora, e a linha segue na
tela com a referência dela e um aviso *já contada*.

Duas coisas de propósito, e que o teste trava:

- **A comparação por contrato não exclui.** `Contratado × PC` compara o que foi
  fechado contra a PC dos mesmos contratos; os dois lados contam a mesma coisa.
  Se um dia a pintura interna e a externa forem contratadas separadamente, ali
  vai aparecer escopo pago em dobro — que é informação, não defeito.
- **A marca não entra em `CAMPOS_PLANEJAMENTO`.** Reimportar a planilha não pode
  apagá-la, do mesmo jeito que não apaga fornecedor nem cotação.

Há ainda um ponto a conferir antes de emitir pedido, que não é soma em dobro: os
códigos `5.3.1` e `5.3.2` estão **duplicados na PC REV05** — servem tanto ao
mobiliário quanto à informática, com valores diferentes. São itens distintos; o
que falha é o código identificar o item sozinho.

---

## Relatório e alerta diário

A aba **Relatório** responde três perguntas, nessa ordem: o que trava a obra
hoje, quanto do plano já foi fechado, quanto custa. Sai formatada para impressão
(a folha de estilo esconde filtros, botões e campos de edição).

O mesmo panorama sai por e-mail **todo dia útil às 08:00**, pela Edge Function
`alerta-compras-diario`, agendada no `pg_cron`. Quem recebe é gerenciado na
própria tela — não é lista fixa em código.

**A função não calcula nada.** Farol, prioridade e ação vêm prontos das views
`compras_painel_*`. A regra de prazo já existia em dois lugares (a planilha
original e o JavaScript do app); uma terceira cópia em TypeScript acabaria
divergindo, e a divergência apareceria como um e-mail dizendo "OK" para um item
que a tela mostra vermelho.

Disparo manual, útil para testar:

```
POST /functions/v1/alerta-compras-diario?diag=1  # que transporte está ativo, que secret falta
POST /functions/v1/alerta-compras-diario?dry=1   # monta e devolve o HTML, sem enviar
POST /functions/v1/alerta-compras-diario         # envia de verdade
```

### Por onde o e-mail sai

Pelo **Microsoft Graph**, com a app registration que a Rio Sul já tem no Entra —
remetente `noreply@riosulconstrucoes.com.br`. Não depende de domínio verificado
em serviço de terceiro.

Isso é correção, não preferência. O envio era pelo Resend, que exige o domínio
verificado por DNS; os registros nunca foram publicados, então a conta ficou em
**modo de teste** — entrega só ao dono da conta e recusa o resto com
`403 validation_error`. Conferido no banco em 07/08/2026: a função
`ativar-remetente` tentou **62 vezes em três dias**, sempre com a mesma resposta:

```json
{ "acao": "aguardando",
  "motivo": "dominio ainda nao verificado no Resend (registros de DNS pendentes)",
  "remetente_atual": "onboarding@resend.dev" }
```

O alerta "funcionava" e não chegava a ninguém. E não é caso isolado: o app de
planos de ação acumulou **181 falhas silenciosas** pelo mesmo motivo, contra 86
entregas, todas para uma única pessoa. Ninguém percebeu porque o erro só existia
no log — por isso a tela de Relatório mostra o **status do último envio**.

#### Os três secrets

O transporte é escolhido pelo ambiente, não por parâmetro: **sem** os três
secrets a função cai no Resend e nada piora; **com** eles o Graph assume na
chamada seguinte, sem redeploy e sem mexer em código.

```
supabase secrets set GRAPH_TENANT_ID=<...>     --project-ref sxinynzkudlkzvjajvaq
supabase secrets set GRAPH_CLIENT_ID=<...>     --project-ref sxinynzkudlkzvjajvaq
supabase secrets set GRAPH_CLIENT_SECRET=<...> --project-ref sxinynzkudlkzvjajvaq
```

São os mesmos valores que o projeto central da empresa já usa. Secrets no
Supabase são por **projeto**, e este é outro projeto — por isso precisam ser
copiados para cá. `GRAPH_FROM` é opcional (padrão
`noreply@riosulconstrucoes.com.br`).

**Pré-requisito no Azure:** a app registration precisa da permissão de
**aplicação** `Mail.Send`, com consentimento do administrador. A delegada não
serve — aqui não há ninguém logado.

Para saber o que está valendo sem abrir painel nenhum:

```
POST /functions/v1/alerta-compras-diario?diag=1
```

Responde qual transporte está ativo e quais secrets faltam — nunca o valor de um
segredo. E cada envio grava por onde saiu em `compras_envio_log.resumo.via`.

> A `ativar-remetente` e o job `ativar-remetente-horario` continuam de pé porque
> o Resend segue como plano B. Quando o Graph estiver enviando, os dois viram
> peso morto e podem ser removidos.

### DMARC — o registro que falta

O domínio não tem DMARC (`_dmarc.riosulconstrucoes.com.br` está vazio). Sem ele,
SPF e DKIM existem mas ninguém instrui o servidor de destino sobre o que fazer
quando falham — e falsificar remetente em nome da Rio Sul fica mais fácil.

Sair pelo Graph não resolve isso: SPF e DKIM passam a ser os do Exchange Online,
o que é melhor, mas DMARC continua ausente. Adicionar no painel do Microsoft:

| | |
|---|---|
| Tipo | TXT |
| Nome | `_dmarc` |
| Valor | `v=DMARC1; p=none; rua=mailto:dmarc@riosulconstrucoes.com.br; fo=1` |

Começar com `p=none` é deliberado: ele **apenas observa e reporta**, sem rejeitar
nada. Depois de algumas semanas lendo os relatórios e confirmando que todo envio
legítimo passa, sobe para `p=quarantine` e depois `p=reject`. Publicar `p=reject`
de saída derruba e-mail legítimo que ninguém mapeou ainda.

---

## A cor da linha

A tela mostra **dois eixos diferentes**, e misturá-los era o que a tornava
cansativa de ler:

| | responde | vem de |
|---|---|---|
| **Situação** (selo) | o prazo aperta? | cronograma — ninguém controla |
| **Estado** (cor da linha) | alguém está agindo? | compras — é o que dá para mudar |

| Cor | Significa |
|---|---|
| 🟢 verde | fechado — contratado, comprado ou entregue |
| 🟡 amarelo | alguém está cotando ou negociando |
| 🔴 vermelho | **venceu e ninguém tocou** |
| cinza | no prazo, ainda não começou |

O vermelho fica reservado ao cruzamento que a tela antiga não mostrava. Um item
pode estar `ATRASADO` e amarelo — venceu, mas tem gente cotando; e pode estar
`NO PRAZO` e sem cor — não venceu e ninguém precisou tocar. Quem abre o app de
manhã procura o vermelho, e ele significa uma coisa só: **parado e vencido**.

Item fechado para de pedir ação. Continuar mostrando `CONTRATAR ATÉ 07/08` em
vermelho num serviço já contratado treina a pessoa a ignorar o vermelho — e aí
ele deixa de funcionar onde importa.

---

## Prazo de fabricação por pacote

A obra tinha **uma** antecedência para tudo: 10 dias corridos entre fechar a
compra e o material estar na obra. Herdado da planilha, e correto para o que a
planilha cobria — argamassa, tinta, cimento.

Não vale para o que entrou depois. Mobiliário escolar sob medida (22 itens,
R$ 352 mil) leva 45 a 60 dias de fabricação; 35 computadores, 45; esquadria de
madeira sob medida, 45. Com 10 dias para todos, o app dizia **NO PRAZO para
item já perdido** — o mesmo defeito da planilha parada na caixa de entrada que
este app existe para corrigir, só que por outro caminho.

Agora `antecedencia_dias` no item vence a da obra, e o detalhe mostra a conta:

```
01/09/2026  −  [60] dias  =  03/07/2026
```

O recálculo é **gatilho no banco**, não JavaScript, porque a planilha é
reimportada: sem ele, a próxima importação devolvia todo mundo para 10 dias e
ninguém perceberia.

⚠️ Os valores semeados são **estimativa de mercado, não cotação**. Servem para
parar de mentir por omissão enquanto o prazo real não vem do fornecedor. São
editáveis na tela — quando compras confirmar a entrega, é para trocar.

---

## Guarda de permissões

Roda de hora em hora (`reforcar_permissoes_compras`).

Existe porque este projeto tem DEFAULT PRIVILEGES concedendo tudo ao `anon`
(`pg_default_acl → anon=arwdDxtm`): **toda tabela nova nasce aberta**, e os
`grant` das migrations somam em vez de substituir. Corrigir uma vez não resolve —
a próxima tabela repete, e ninguém consulta privilégio no dia a dia.

Então o mínimo de cada tabela é **declarado**, e a rotina devolve tudo ao lugar.
Também religa RLS se alguém desligar. Na primeira execução encontrou **18
desvios reais** no papel `authenticated` que as correções manuais tinham deixado
passar.

`compras_seguranca_log` vazia = nada saiu do lugar.

---

## Arquitetura

Estático puro. Sem build, sem framework, sem dependência no caminho crítico.

```
index.html      estrutura
app.css         estilo (inclui layout de celular e folha de impressão)
app.js          cálculo, banco, telas, exportação CSV
importar.js     reimportação das planilhas (.xlsx/.csv)
testes/         regressão do cálculo, contra os valores do Excel
supabase/       DDL versionado
```

Banco: **Supabase** (projeto `Riosul-reports`), acessado por `fetch` direto no
PostgREST. Tabelas `compras_obra`, `compras_contratacao`, `compras_material`,
`compras_evento`.

**A única biblioteca externa é o SheetJS**, e só é buscada quando alguém importa
um `.xlsx`. Se o CDN cair, o acompanhamento continua — e o importador aceita CSV
sem biblioteca nenhuma.

### Acesso

Link aberto, sem login: é o que faz compras e fornecedores usarem de verdade.
As policies dão `select / insert / update` para `anon`. **`delete` não é
concedido a ninguém pelo link** — item que sai da planilha é desativado
(`ativo = false`), nunca apagado. Um clique errado não derruba a cotação alheia.

O conteúdo é prazo e cotação de obra. Se um dia passar a ter dado sensível,
troque as policies para exigir `authenticated`.

---

## Reimportar quando o cronograma mudar

Botão **↻ Atualizar da planilha**, em qualquer das duas abas.

A regra que governa a importação:

> A planilha manda no **planejamento** — datas, quantidades, valores da PC.
> O app manda na **execução** — fornecedor, cotação, status, compra, entrega.

A importação nunca escreve numa coluna de execução e nunca exclui linha. Mostra
a prévia (quantas mudam, quantas são novas, quantas sumiram) antes de aplicar.

Reconciliação: contratações pelo **nome da atividade**; materiais pela **linha da
PC + nome do material**. Renomear uma atividade na planilha cria linha nova em
vez de atualizar a existente.

---

## Rodar local

```bash
npx http-server . -p 8080     # ou qualquer servidor estático
node testes/calculo.test.js   # prazos, contra os valores do Excel
node testes/email.test.js     # acentuação e escolha do transporte
node testes/obras.test.js     # qual obra abrir, criação por RPC, obra vazia
node testes/referencia-pc.test.js  # referência de PC contada duas vezes
```

Abrir por `file://` também funciona para inspecionar as telas.

## Publicar

Estático — qualquer host serve. Vercel: importar o repositório, sem build
command, output = raiz. GitHub Pages: ativar em *Settings → Pages*, branch
`main`, pasta `/`.
