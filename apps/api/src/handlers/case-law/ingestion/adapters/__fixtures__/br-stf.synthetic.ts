/**
 * A synthetic STF search hit stating every field either base states.
 *
 * The field inventory is certified against one stored envelope, and no real
 * record carries both an acórdão's fields and a decisão's, so this one does.
 * Names, numbers and text are invented; the shape is the recorded one.
 */
export const BR_STF_SYNTHETIC_HIT = {
  _index: "jurisprudencia-idx20230518",
  _id: "sjur999001",
  _ignored: ["documental_observacao_html.keyword"],
  _source: {
    base: "acordaos",
    id: "sjur999001",
    dg_unique: "sjur999001",
    titulo: "ARE 9990001 AgR",
    acompanhamento_processual_url:
      "https://portal.stf.jus.br/processos/listarProcessos.asp?numeroProcesso=9990001&classe=ARE",
    acordao_ata:
      "A Turma, por unanimidade, negou provimento ao agravo regimental, nos termos do voto do Relator.",
    colac_numero: 1,
    colac_pagina: 2,
    decisao_texto:
      "DECISÃO\r\n    1. Agravo fictício interposto contra decisão de inadmissão.\r\n    2. Nego seguimento ao agravo.",
    dg_atualizado_em: "2026-01-15T10:20:30.123456",
    dje_url:
      "https://portal.stf.jus.br/servicos/dje/listarDiarioJustica.asp?tipoPesquisaDJ=AP&numero=9990001&classe=ARE",
    documental_acordao_mesmo_sentido_is_secundario: false,
    documental_acordao_mesmo_sentido_lista_html:
      '<a class="urls">ARE 9990002 AgR</a>',
    documental_acordao_mesmo_sentido_lista_texto: "ARE 9990002 AgR",
    documental_assunto_texto: "DIREITO PROCESSUAL CIVIL | Recurso fictício",
    documental_decisao_mesmo_sentido_is_secundario: false,
    documental_decisao_mesmo_sentido_lista_html:
      '<a class="urls">ARE 9990003</a>',
    documental_decisao_mesmo_sentido_lista_texto: "ARE 9990003",
    documental_doutrina_texto: "AUTOR FICTÍCIO. Obra imaginária. 1. ed. 2020.",
    documental_indexacao_texto: "- AGRAVO REGIMENTAL, RECURSO FICTÍCIO.",
    documental_jurisprudencia_citada_texto: "ARE 9990004 AgR (1ªT).",
    documental_legislacao_citada_texto: [
      "LEG-FED   CF      ANO-1988\n          ART-00005 INC-00035\n",
    ],
    documental_observacao_html: "- Acórdão(s) citado(s): <a>ARE 9990004</a>",
    documental_observacao_texto: "- Acórdão(s) citado(s): ARE 9990004",
    documental_publicacao_lista_texto:
      "PROCESSO ELETRÔNICO\nDJe-010  DIVULG 14-01-2026  PUBLIC 15-01-2026",
    documental_tese_tema_texto: "Tema 9999 - Tema fictício.",
    documental_tese_texto: "Tese fictícia fixada para o tema imaginário.",
    documental_tese_tipo: "Tese",
    ementa_texto:
      "Ementa: AGRAVO REGIMENTAL. RECURSO FICTÍCIO. AUSÊNCIA DE PREQUESTIONAMENTO. AGRAVO DESPROVIDO.",
    externo_seq_objeto_incidente: 9_990_001,
    inteiro_teor_texto:
      "Supremo Tribunal Federal\nEmenta e Acórdão\n\nInteiro Teor do Acórdão - Página 1 de 2\n\nAGRAVO REGIMENTAL NO RECURSO\nEXTRAORDINÁRIO COM AGRAVO 9.990.001\n\n1. Agravo regimental fictício contra decisão que negou\nseguimento ao recurso.\n\n2. Agravo regimental a que se nega provimento.\n\fSupremo Tribunal Federal\nEmenta e Acórdão\n\nInteiro Teor do Acórdão - Página 2 de 2\n\nACÓRDÃO\nVistos, relatados e discutidos estes autos fictícios.",
    inteiro_teor_url:
      "https://portal.stf.jus.br/jurisprudencia/obterInteiroTeor.asp?idDocumento=999000001",
    is_colac: false,
    is_decisao_presidencia: false,
    is_processo_antigo: false,
    is_questao_ordem: false,
    is_repercussao_geral: false,
    is_repercussao_geral_admissibilidade: false,
    is_repercussao_geral_merito: false,
    julgamento_data: "2026-01-12",
    julgamento_is_sessao_virtual: true,
    ministro_facet: ["MINISTRO FICTÍCIO"],
    ods_onu: ["ODS 16"],
    old_seq_colac: null,
    old_seq_repercussao_geral: null,
    old_seq_sjur: 999_001,
    orgao_julgador: "Primeira Turma",
    partes_lista_texto:
      "AGTE.(S)  : PARTE FICTÍCIA A \nAGDO.(A/S)  : PARTE FICTÍCIA B",
    presidente_nome: "PRESIDENTE FICTÍCIO",
    procedencia_geografica_completo: "DF - DISTRITO FEDERAL",
    procedencia_geografica_pais_extenso: "Brasil",
    procedencia_geografica_pais_sigla: "BR",
    procedencia_geografica_uf_extenso: "Distrito Federal",
    procedencia_geografica_uf_sigla: "DF",
    processo_classe_processual_unificada_classe_sigla: "ARE",
    processo_classe_processual_unificada_extenso:
      "RECURSO EXTRAORDINÁRIO COM AGRAVO",
    processo_classe_processual_unificada_incidente_sigla: "AgR",
    processo_classe_processual_unificada_sigla: "ARE-AgR",
    processo_codigo_completo: "ARE 9990001 AgR",
    processo_numero: 9_990_001,
    publicacao_data: "2026-01-15",
    relator_acordao_nome: "RELATOR DO ACÓRDÃO FICTÍCIO",
    relator_decisao_nome: "RELATOR DA DECISÃO FICTÍCIO",
    relator_processo_nome: "MINISTRO FICTÍCIO",
    republicacao_data: null,
    revisor_processo_nome: "REVISOR FICTÍCIO",
  },
} as const;
