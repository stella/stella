/** A letters-only tag unique to `index` (A, B, …, Z, BA, BB, …). */
const largeOfacNameTag = (index: number): string => {
  let rest = index;
  let tag = "";
  do {
    tag = String.fromCodePoint(65 + (rest % 26)) + tag;
    rest = Math.floor(rest / 26);
  } while (rest > 0);
  return tag;
};

/**
 * A synthetic OFAC SDN export with `count` distinct, fully populated records,
 * sized like the real list (about 20k entries, tens of megabytes). Every name
 * and number is generated; nothing comes from a published list.
 */
export const largeOfacSdnXml = (count: number): string => {
  const records: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const uid = 100_000 + index;
    const tag = largeOfacNameTag(index);
    const year = String(index % 90).padStart(2, "0");
    records.push(`  <sdnEntry>
    <uid>${uid}</uid>
    <firstName>Given${tag}</firstName>
    <lastName>FAMILY ${tag} HOLDINGS</lastName>
    <sdnType>Individual</sdnType>
    <programList><program>PROGRAM-${index % 40}</program><program>CYBER2</program></programList>
    <akaList>
      <aka><uid>${uid}1</uid><type>a.k.a.</type><category>strong</category><firstName>Alias${tag}</firstName><lastName>OTHER ${tag}</lastName></aka>
      <aka><uid>${uid}2</uid><type>a.k.a.</type><category>weak</category><lastName>NICK ${tag}</lastName></aka>
    </akaList>
    <dateOfBirthList>
      <dateOfBirthItem><uid>${uid}3</uid><dateOfBirth>10 Dec 19${year}</dateOfBirth><mainEntry>true</mainEntry></dateOfBirthItem>
    </dateOfBirthList>
    <nationalityList><nationality><uid>${uid}4</uid><country>Spain</country><mainEntry>true</mainEntry></nationality></nationalityList>
    <idList><id><uid>${uid}5</uid><idType>Passport</idType><idNumber>P${uid}</idNumber><idCountry>Spain</idCountry></id></idList>
    <addressList><address><uid>${uid}6</uid><address1>${index} Main Street</address1><city>Madrid</city><postalCode>28001</postalCode><country>Spain</country></address></addressList>
  </sdnEntry>`);
  }
  return `<?xml version="1.0" standalone="yes"?>
<sdnList xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns="https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/XML">
  <publshInformation>
    <Publish_Date>09/23/2026</Publish_Date>
    <Record_Count>${count}</Record_Count>
  </publshInformation>
${records.join("\n")}
</sdnList>
`;
};
