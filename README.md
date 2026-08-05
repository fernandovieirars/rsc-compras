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

**Uma obra por link:** `?obra=escola-ambev` (o padrão). Outra obra é outro
`slug` na tabela `compras_obra`.

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

### Um dado que ficou como está

O material 58 (*Pintura de paredes*, linha PC 2.6.3) não tem contratação
correspondente: na PC essa linha é **compartilhada** entre pintura interna e
externa. Ficou sem vínculo de propósito, com a observação de origem preservada —
somá-la nas duas contaria o custo em dobro.

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
node testes/calculo.test.js   # testes
```

Abrir por `file://` também funciona para inspecionar as telas.

## Publicar

Estático — qualquer host serve. Vercel: importar o repositório, sem build
command, output = raiz. GitHub Pages: ativar em *Settings → Pages*, branch
`main`, pasta `/`.
