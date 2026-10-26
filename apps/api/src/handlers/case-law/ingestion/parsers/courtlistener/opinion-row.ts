export type OpinionRow = Readonly<
  Record<
    | "id"
    | "date_created"
    | "date_modified"
    | "author_str"
    | "per_curiam"
    | "joined_by_str"
    | "type"
    | "sha1"
    | "page_count"
    | "download_url"
    | "local_path"
    | "plain_text"
    | "html"
    | "html_lawbox"
    | "html_columbia"
    | "html_anon_2020"
    | "xml_harvard"
    | "xml_scan"
    | "html_with_citations"
    | "extracted_by_ocr"
    | "author_id"
    | "cluster_id",
    string
  >
>;
