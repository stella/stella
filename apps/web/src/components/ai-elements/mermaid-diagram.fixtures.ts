const range = (n: number) => Array.from({ length: n }, (_, i) => i);

const flowchartSmall = `flowchart TD
  A[Client intake] --> B{Conflict check}
  B -- Clear --> C[Engagement letter]
  B -- Conflict --> D[Decline matter]
  C --> E[Open matter]
  E --> F[Assign team]
  F --> G((Kick-off))
  D --> H[Notify client]`;

const flowchartLarge = [
  "flowchart LR",
  ...range(150).map(
    (i) =>
      `  n${i}["Clause ${i}: obligations & remedies"] --> n${(i * 7 + 3) % 150}{{"Review ${i}"}}`,
  ),
  ...range(60).map((i) => `  n${i} -.-> n${(i * 13 + 5) % 150}`),
  "  subgraph Contract",
  ...range(20).map((i) => `    n${i}`),
  "  end",
].join("\n");

const sequenceSmall = `sequenceDiagram
  autonumber
  actor Associate
  participant Platform
  participant Court as Court registry
  Associate->>Platform: Upload pleading
  Platform->>Platform: Extract citations
  Platform->>Court: Fetch docket
  Court-->>Platform: Docket entries
  alt Deadline found
    Platform-->>Associate: Calendar deadline
  else None
    Platform-->>Associate: No deadlines
  end
  Note over Associate,Platform: Review before filing`;

const sequenceLarge = [
  "sequenceDiagram",
  ...range(5).map((p) => `  participant P${p} as Party ${p}`),
  ...range(120).map(
    (i) =>
      `  P${i % 5}->>P${(i * 3 + 1) % 5}: Submission ${i} (exhibit C-${i})`,
  ),
  "  loop Weekly status",
  "    P2->>P3: Status update",
  "  end",
].join("\n");

const classDiagram = `classDiagram
  class Matter {
    +String id
    +String title
    +Date opened
    +close() void
  }
  class Document {
    +String id
    +String mimeType
    +int version
    +redact(spans) Document
  }
  class Party {
    +String name
    +Role role
  }
  class Deadline {
    +Date due
    +String rule
  }
  Matter "1" *-- "many" Document : contains
  Matter "1" o-- "many" Party : involves
  Matter "1" --> "many" Deadline : tracks
  Document <|-- Pleading
  Document <|-- Contract
  Contract : +Date effective
  Pleading : +String court`;

const classLarge = [
  "classDiagram",
  ...range(40).flatMap((i) => [
    `  class Entity${i} {`,
    `    +String field${i}a`,
    `    +int field${i}b`,
    `    +method${i}() void`,
    "  }",
  ]),
  ...range(39).map((i) => `  Entity${i} --> Entity${i + 1} : rel${i}`),
  ...range(10).map((i) => `  Entity${i * 3} <|-- Entity${i * 3 + 2}`),
].join("\n");

const stateDiagram = `stateDiagram-v2
  [*] --> Draft
  Draft --> InReview : submit
  InReview --> Draft : request changes
  InReview --> Approved : approve
  Approved --> Signed : e-sign
  Signed --> Executed
  Executed --> [*]
  state InReview {
    [*] --> Legal
    Legal --> Finance
    Finance --> [*]
  }`;

const ganttDiagram = `gantt
  title Litigation timeline
  dateFormat YYYY-MM-DD
  section Pleadings
  Statement of claim   :done, a1, 2026-01-05, 14d
  Defence              :active, a2, after a1, 28d
  Reply                :a3, after a2, 14d
  section Disclosure
  Document production  :b1, after a3, 45d
  Privilege review     :b2, after a3, 30d
  section Trial
  Witness statements   :c1, after b1, 21d
  Hearing              :milestone, c2, after c1, 0d`;

const ganttLarge = [
  "gantt",
  "  title Due diligence workstreams",
  "  dateFormat YYYY-MM-DD",
  ...range(8).flatMap((s) => [
    `  section Workstream ${s}`,
    ...range(12).map(
      (t) =>
        `  Task ${s}-${t} :t${s}_${t}, ${t === 0 ? `2026-0${(s % 9) + 1}-01` : `after t${s}_${t - 1}`}, ${3 + ((s + t) % 7)}d`,
    ),
  ]),
].join("\n");

const erDiagram = `erDiagram
  MATTER ||--o{ DOCUMENT : contains
  MATTER }o--o{ PARTY : involves
  DOCUMENT ||--|{ VERSION : has
  PARTY ||--o{ CONTACT : reachable_at
  MATTER {
    uuid id PK
    string title
    date opened
  }
  DOCUMENT {
    uuid id PK
    uuid matter_id FK
    string mime_type
  }
  VERSION {
    uuid id PK
    int number
  }`;

const erLarge = [
  "erDiagram",
  ...range(30).flatMap((i) => [
    `  TABLE_${i} {`,
    "    uuid id PK",
    `    uuid parent_id FK`,
    `    string name_${i}`,
    "    timestamp created_at",
    "  }",
  ]),
  ...range(29).map((i) => `  TABLE_${i} ||--o{ TABLE_${i + 1} : owns`),
  ...range(10).map((i) => `  TABLE_${i} }o--o{ TABLE_${(i * 7) % 30} : links`),
].join("\n");

export const DIAGRAM_FIXTURES = [
  { name: "flowchart", source: flowchartSmall },
  { name: "flowchart-large", source: flowchartLarge },
  { name: "sequence", source: sequenceSmall },
  { name: "sequence-large", source: sequenceLarge },
  { name: "class", source: classDiagram },
  { name: "class-large", source: classLarge },
  { name: "state", source: stateDiagram },
  { name: "gantt", source: ganttDiagram },
  { name: "gantt-large", source: ganttLarge },
  { name: "er", source: erDiagram },
  { name: "er-large", source: erLarge },
] as const;
