import { ZipArchive } from "@stll/docx-core/zip";

// Synthetic invoices in each supported syntax. Every party, number and account
// is invented; the element structure follows each published schema.

const encoder = new TextEncoder();

export const SAMPLE_ATTACHMENT_TEXT = "Synthetic delivery note";
const attachmentBase64 = Buffer.from(SAMPLE_ATTACHMENT_TEXT).toString("base64");

export const isdocXml = ({
  lines = 2,
}: { lines?: number } = {}) => `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="http://isdoc.cz/namespace/2013" version="6.0.2">
  <DocumentType>1</DocumentType>
  <ID>FV-2026-0042</ID>
  <UUID>00000000-0000-4000-8000-000000000042</UUID>
  <IssueDate>2026-03-02</IssueDate>
  <TaxPointDate>2026-02-28</TaxPointDate>
  <VATApplicable>true</VATApplicable>
  <Note>Legal services, February</Note>
  <LocalCurrencyCode>CZK</LocalCurrencyCode>
  <CurrRate>1</CurrRate>
  <RefCurrRate>1</RefCurrRate>
  <AccountingSupplierParty><Party>
    <PartyIdentification><ID>00000001</ID></PartyIdentification>
    <PartyName><Name>Example Supplier s.r.o.</Name></PartyName>
    <PostalAddress>
      <StreetName>Example Street</StreetName><BuildingNumber>1</BuildingNumber>
      <CityName>Praha</CityName><PostalZone>110 00</PostalZone>
      <Country><IdentificationCode>CZ</IdentificationCode><Name>Czech Republic</Name></Country>
    </PostalAddress>
    <PartyTaxScheme><CompanyID>CZ00000001</CompanyID><TaxScheme>VAT</TaxScheme></PartyTaxScheme>
  </Party></AccountingSupplierParty>
  <AccountingCustomerParty><Party>
    <PartyIdentification><ID>00000002</ID></PartyIdentification>
    <PartyName><Name>Example Customer a.s.</Name></PartyName>
    <PostalAddress>
      <StreetName>Sample Avenue</StreetName><BuildingNumber>2</BuildingNumber>
      <CityName>Brno</CityName><PostalZone>602 00</PostalZone>
      <Country><IdentificationCode>CZ</IdentificationCode><Name>Czech Republic</Name></Country>
    </PostalAddress>
  </Party></AccountingCustomerParty>
  <InvoiceLines>${Array.from(
    { length: lines },
    (_, index) => `
    <InvoiceLine>
      <ID>${index + 1}</ID>
      <InvoicedQuantity unitCode="HUR">2</InvoicedQuantity>
      <LineExtensionAmount>3000.00</LineExtensionAmount>
      <LineExtensionAmountTaxInclusive>3630.00</LineExtensionAmountTaxInclusive>
      <LineExtensionTaxAmount>630.00</LineExtensionTaxAmount>
      <UnitPrice>1500.00</UnitPrice>
      <UnitPriceTaxInclusive>1815.00</UnitPriceTaxInclusive>
      <ClassifiedTaxCategory><Percent>21</Percent><VATCalculationMethod>0</VATCalculationMethod></ClassifiedTaxCategory>
      <Item><Description>Consultation ${index + 1}</Description></Item>
    </InvoiceLine>`,
  ).join("")}
  </InvoiceLines>
  <TaxTotal>
    <TaxSubTotal>
      <TaxableAmount>6000.00</TaxableAmount><TaxAmount>1260.00</TaxAmount>
      <TaxInclusiveAmount>7260.00</TaxInclusiveAmount>
      <TaxCategory><Percent>21</Percent></TaxCategory>
    </TaxSubTotal>
    <TaxAmount>1260.00</TaxAmount>
  </TaxTotal>
  <LegalMonetaryTotal>
    <TaxExclusiveAmount>6000.00</TaxExclusiveAmount>
    <TaxInclusiveAmount>7260.00</TaxInclusiveAmount>
    <PaidDepositsAmount>0.00</PaidDepositsAmount>
    <PayableAmount>7260.00</PayableAmount>
  </LegalMonetaryTotal>
  <PaymentMeans><Payment>
    <PaidAmount>7260.00</PaidAmount>
    <PaymentMeansCode>42</PaymentMeansCode>
    <Details>
      <PaymentDueDate>2026-03-16</PaymentDueDate>
      <ID>000000-0000000001</ID><BankCode>0000</BankCode>
      <IBAN>CZ0000000000000000000001</IBAN><BIC>EXAMCZPP</BIC>
      <VariableSymbol>20260042</VariableSymbol>
    </Details>
  </Payment></PaymentMeans>
</Invoice>
`;

export const isdocxPackage = async ({
  manifest = true,
}: { manifest?: boolean } = {}) => {
  const archive = new ZipArchive();
  archive.set("faktura.isdoc", encoder.encode(isdocXml()));
  archive.set("supplements/delivery-note.txt", encoder.encode(SAMPLE_ATTACHMENT_TEXT));
  if (manifest) {
    archive.set(
      "manifest.xml",
      encoder.encode(
        '<?xml version="1.0" encoding="UTF-8"?><manifest xmlns="http://isdoc.cz/namespace/2013/manifest"><maindocument filename="faktura.isdoc"/><supplementscount>1</supplementscount><supplements><supplement filename="supplements/delivery-note.txt"/></supplements></manifest>',
      ),
    );
  }
  return await archive.generate({ compression: "deflate" });
};

const fatturaBody = (number: string, withAttachment: boolean) => `
  <FatturaElettronicaBody>
    <DatiGenerali><DatiGeneraliDocumento>
      <TipoDocumento>TD01</TipoDocumento>
      <Divisa>EUR</Divisa>
      <Data>2026-04-10</Data>
      <Numero>${number}</Numero>
      <ImportoTotaleDocumento>1220.00</ImportoTotaleDocumento>
      <Causale>Synthetic consulting fees</Causale>
    </DatiGeneraliDocumento></DatiGenerali>
    <DatiBeniServizi>
      <DettaglioLinee>
        <NumeroLinea>1</NumeroLinea>
        <Descrizione>Consulenza</Descrizione>
        <Quantita>4.00</Quantita>
        <UnitaMisura>ore</UnitaMisura>
        <PrezzoUnitario>250.00</PrezzoUnitario>
        <PrezzoTotale>1000.00</PrezzoTotale>
        <AliquotaIVA>22.00</AliquotaIVA>
      </DettaglioLinee>
      <DatiRiepilogo>
        <AliquotaIVA>22.00</AliquotaIVA>
        <ImponibileImporto>1000.00</ImponibileImporto>
        <Imposta>220.00</Imposta>
        <EsigibilitaIVA>I</EsigibilitaIVA>
      </DatiRiepilogo>
    </DatiBeniServizi>
    <DatiPagamento>
      <CondizioniPagamento>TP02</CondizioniPagamento>
      <DettaglioPagamento>
        <ModalitaPagamento>MP05</ModalitaPagamento>
        <DataScadenzaPagamento>2026-05-10</DataScadenzaPagamento>
        <ImportoPagamento>1220.00</ImportoPagamento>
        <IBAN>IT00X0000000000000000000001</IBAN>
      </DettaglioPagamento>
    </DatiPagamento>${
      withAttachment
        ? `
    <Allegati>
      <NomeAttachment>bolla.txt</NomeAttachment>
      <FormatoAttachment>TXT</FormatoAttachment>
      <DescrizioneAttachment>Delivery note</DescrizioneAttachment>
      <Attachment>${attachmentBase64}</Attachment>
    </Allegati>`
        : ""
    }
  </FatturaElettronicaBody>`;

export const fatturaPaXml = ({
  bodies = 1,
  signed = false,
}: { bodies?: number; signed?: boolean } = {}) => `<?xml version="1.0" encoding="UTF-8"?>
<p:FatturaElettronica versione="FPR12"
  xmlns:p="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2"
  xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
  <FatturaElettronicaHeader>
    <DatiTrasmissione>
      <IdTrasmittente><IdPaese>IT</IdPaese><IdCodice>00000000001</IdCodice></IdTrasmittente>
      <ProgressivoInvio>00001</ProgressivoInvio>
      <FormatoTrasmissione>FPR12</FormatoTrasmissione>
      <CodiceDestinatario>0000000</CodiceDestinatario>
    </DatiTrasmissione>
    <CedentePrestatore>
      <DatiAnagrafici>
        <IdFiscaleIVA><IdPaese>IT</IdPaese><IdCodice>00000000001</IdCodice></IdFiscaleIVA>
        <Anagrafica><Denominazione>Esempio Fornitore S.r.l.</Denominazione></Anagrafica>
        <RegimeFiscale>RF01</RegimeFiscale>
      </DatiAnagrafici>
      <Sede><Indirizzo>Via Esempio</Indirizzo><NumeroCivico>1</NumeroCivico><CAP>00100</CAP><Comune>Roma</Comune><Provincia>RM</Provincia><Nazione>IT</Nazione></Sede>
    </CedentePrestatore>
    <CessionarioCommittente>
      <DatiAnagrafici>
        <CodiceFiscale>XXXXXX00X00X000X</CodiceFiscale>
        <Anagrafica><Nome>Mario</Nome><Cognome>Esempio</Cognome></Anagrafica>
      </DatiAnagrafici>
      <Sede><Indirizzo>Piazza Campione 2</Indirizzo><CAP>20100</CAP><Comune>Milano</Comune><Provincia>MI</Provincia><Nazione>IT</Nazione></Sede>
    </CessionarioCommittente>
  </FatturaElettronicaHeader>${Array.from({ length: bodies }, (_, index) =>
    fatturaBody(`2026/${index + 1}`, index === 0),
  ).join("")}${
    signed
      ? `
  <ds:Signature><ds:SignedInfo/><ds:SignatureValue>AAAA</ds:SignatureValue></ds:Signature>`
      : ""
  }
</p:FatturaElettronica>
`;

const UBL_NAMESPACES = `xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"`;

const ublParty = (name: string, vat: string) => `<cac:Party>
      <cbc:EndpointID schemeID="0088">0000000000001</cbc:EndpointID>
      <cac:PostalAddress>
        <cbc:StreetName>Musterweg 1</cbc:StreetName>
        <cbc:CityName>Berlin</cbc:CityName><cbc:PostalZone>10115</cbc:PostalZone>
        <cac:Country><cbc:IdentificationCode>DE</cbc:IdentificationCode></cac:Country>
      </cac:PostalAddress>
      <cac:PartyTaxScheme><cbc:CompanyID>${vat}</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>
      <cac:PartyLegalEntity><cbc:RegistrationName>${name}</cbc:RegistrationName><cbc:CompanyID schemeID="0002">HRB 00000</cbc:CompanyID></cac:PartyLegalEntity>
    </cac:Party>`;

export const ublXml = (
  root: "Invoice" | "CreditNote" = "Invoice",
  {
    lines = 1,
    description = "Synthetic widget",
    accountId = "DE00000000000000000001",
  }: { lines?: number; description?: string; accountId?: string } = {},
) => {
  const isCredit = root === "CreditNote";
  const quantity = isCredit ? "CreditedQuantity" : "InvoicedQuantity";
  return `<?xml version="1.0" encoding="UTF-8"?>
<${root} xmlns="urn:oasis:names:specification:ubl:schema:xsd:${root}-2"
  ${UBL_NAMESPACES}>
  <cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0</cbc:CustomizationID>
  <cbc:ID>UBL-0007</cbc:ID>
  <cbc:IssueDate>2026-05-04</cbc:IssueDate>
  ${isCredit ? "" : "<cbc:DueDate>2026-06-03</cbc:DueDate>"}
  <cbc:${root}TypeCode>${isCredit ? "381" : "380"}</cbc:${root}TypeCode>
  <cbc:Note>Synthetic order 7</cbc:Note>
  <cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>
  <cac:AdditionalDocumentReference>
    <cbc:ID>DN-7</cbc:ID>
    <cbc:DocumentDescription>Delivery note</cbc:DocumentDescription>
    <cac:Attachment><cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain" filename="delivery-note.txt">${attachmentBase64}</cbc:EmbeddedDocumentBinaryObject></cac:Attachment>
  </cac:AdditionalDocumentReference>
  <cac:AccountingSupplierParty>${ublParty("Beispiel Lieferant GmbH", "DE000000001")}</cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>${ublParty("Beispiel Kunde AG", "DE000000002")}</cac:AccountingCustomerParty>
  <cac:PaymentMeans>
    <cbc:PaymentMeansCode>58</cbc:PaymentMeansCode>
    <cbc:PaymentID>UBL-0007</cbc:PaymentID>
    <cac:PayeeFinancialAccount><cbc:ID>${accountId}</cbc:ID><cac:FinancialInstitutionBranch><cbc:ID>EXAMDEFF</cbc:ID></cac:FinancialInstitutionBranch></cac:PayeeFinancialAccount>
  </cac:PaymentMeans>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="EUR">19.00</cbc:TaxAmount>
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="EUR">100.00</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="EUR">19.00</cbc:TaxAmount>
      <cac:TaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>19</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory>
    </cac:TaxSubtotal>
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="EUR">100.00</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="EUR">100.00</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="EUR">119.00</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="EUR">119.00</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
${Array.from(
  { length: lines },
  (_, index) => `  <cac:${root}Line>
    <cbc:ID>${index + 1}</cbc:ID>
    <cbc:${quantity} unitCode="C62">10</cbc:${quantity}>
    <cbc:LineExtensionAmount currencyID="EUR">100.00</cbc:LineExtensionAmount>
    <cac:Item>
      <cbc:Name>${description}</cbc:Name>
      <cac:ClassifiedTaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>19</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:ClassifiedTaxCategory>
    </cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="EUR">1.00</cbc:PriceAmount><cbc:BaseQuantity unitCode="C62">0.1</cbc:BaseQuantity></cac:Price>
  </cac:${root}Line>
`,
).join("")}</${root}>
`;
};

const ciiParty = (role: string, name: string, vat: string) => `<ram:${role}>
        <ram:Name>${name}</ram:Name>
        <ram:SpecifiedLegalOrganization><ram:ID schemeID="0002">00000000000000</ram:ID></ram:SpecifiedLegalOrganization>
        <ram:PostalTradeAddress>
          <ram:PostcodeCode>75001</ram:PostcodeCode><ram:LineOne>1 rue Exemple</ram:LineOne>
          <ram:CityName>Paris</ram:CityName><ram:CountryID>FR</ram:CountryID>
        </ram:PostalTradeAddress>
        <ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">${vat}</ram:ID></ram:SpecifiedTaxRegistration>
      </ram:${role}>`;

export const ciiXml = () => `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice
  xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"
  xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100"
  xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">
  <rsm:ExchangedDocumentContext>
    <ram:GuidelineSpecifiedDocumentContextParameter><ram:ID>urn:cen.eu:en16931:2017</ram:ID></ram:GuidelineSpecifiedDocumentContextParameter>
  </rsm:ExchangedDocumentContext>
  <rsm:ExchangedDocument>
    <ram:ID>CII-0099</ram:ID>
    <ram:TypeCode>380</ram:TypeCode>
    <ram:IssueDateTime><udt:DateTimeString format="102">20260607</udt:DateTimeString></ram:IssueDateTime>
    <ram:IncludedNote><ram:Content>Synthetic subscription</ram:Content></ram:IncludedNote>
  </rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>
    <ram:IncludedSupplyChainTradeLineItem>
      <ram:AssociatedDocumentLineDocument><ram:LineID>1</ram:LineID></ram:AssociatedDocumentLineDocument>
      <ram:SpecifiedTradeProduct><ram:Name>Synthetic licence</ram:Name></ram:SpecifiedTradeProduct>
      <ram:SpecifiedLineTradeAgreement><ram:NetPriceProductTradePrice><ram:ChargeAmount>50.00</ram:ChargeAmount></ram:NetPriceProductTradePrice></ram:SpecifiedLineTradeAgreement>
      <ram:SpecifiedLineTradeDelivery><ram:BilledQuantity unitCode="C62">2</ram:BilledQuantity></ram:SpecifiedLineTradeDelivery>
      <ram:SpecifiedLineTradeSettlement>
        <ram:ApplicableTradeTax><ram:TypeCode>VAT</ram:TypeCode><ram:CategoryCode>S</ram:CategoryCode><ram:RateApplicablePercent>20</ram:RateApplicablePercent></ram:ApplicableTradeTax>
        <ram:SpecifiedTradeSettlementLineMonetarySummation><ram:LineTotalAmount>100.00</ram:LineTotalAmount></ram:SpecifiedTradeSettlementLineMonetarySummation>
      </ram:SpecifiedLineTradeSettlement>
    </ram:IncludedSupplyChainTradeLineItem>
    <ram:ApplicableHeaderTradeAgreement>
      ${ciiParty("SellerTradeParty", "Exemple Vendeur SAS", "FR00000000001")}
      ${ciiParty("BuyerTradeParty", "Exemple Client SARL", "FR00000000002")}
    </ram:ApplicableHeaderTradeAgreement>
    <ram:ApplicableHeaderTradeDelivery/>
    <ram:ApplicableHeaderTradeSettlement>
      <ram:PaymentReference>CII-0099</ram:PaymentReference>
      <ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>
      <ram:SpecifiedTradeSettlementPaymentMeans>
        <ram:TypeCode>58</ram:TypeCode>
        <ram:PayeePartyCreditorFinancialAccount><ram:IBANID>FR0000000000000000000000001</ram:IBANID></ram:PayeePartyCreditorFinancialAccount>
      </ram:SpecifiedTradeSettlementPaymentMeans>
      <ram:ApplicableTradeTax>
        <ram:CalculatedAmount>20.00</ram:CalculatedAmount><ram:TypeCode>VAT</ram:TypeCode>
        <ram:BasisAmount>100.00</ram:BasisAmount><ram:CategoryCode>S</ram:CategoryCode>
        <ram:RateApplicablePercent>20</ram:RateApplicablePercent>
      </ram:ApplicableTradeTax>
      <ram:SpecifiedTradePaymentTerms>
        <ram:DueDateDateTime><udt:DateTimeString format="102">20260707</udt:DateTimeString></ram:DueDateDateTime>
      </ram:SpecifiedTradePaymentTerms>
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>
        <ram:LineTotalAmount>100.00</ram:LineTotalAmount>
        <ram:TaxBasisTotalAmount>100.00</ram:TaxBasisTotalAmount>
        <ram:TaxTotalAmount currencyID="EUR">20.00</ram:TaxTotalAmount>
        <ram:GrandTotalAmount>120.00</ram:GrandTotalAmount>
        <ram:DuePayableAmount>120.00</ram:DuePayableAmount>
      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>
    </ram:ApplicableHeaderTradeSettlement>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>
`;

/** A detached XAdES signature over some other file: never an invoice. */
export const xadesSignatureXml = () => `<?xml version="1.0" encoding="UTF-8"?>
<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#" xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" Id="sig-1">
  <ds:SignedInfo>
    <ds:Reference URI="invoice.xml"><ds:DigestValue>AAAA</ds:DigestValue></ds:Reference>
  </ds:SignedInfo>
  <ds:SignatureValue>AAAA</ds:SignatureValue>
  <ds:Object><xades:QualifyingProperties Target="#sig-1"/></ds:Object>
</ds:Signature>
`;

export const plainXml = () =>
  '<?xml version="1.0" encoding="UTF-8"?><catalog><item>Not an invoice</item></catalog>\n';

export const xmlBytes = (xml: string) => encoder.encode(xml);
