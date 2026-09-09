export const CHATGPT_APP_SUBMISSION_PROFILE = {
  app_info: {
    display_name: "stella",
    subtitle: "Work with legal matters",
    description:
      "stella connects ChatGPT to a permission-aware legal workspace. Users can search and read matter documents, inspect matters, contacts, tasks, and billing records, research case law and legislation, manage workspace records, and create or fill document templates.",
    category: "PRODUCTIVITY",
  },
  test_cases: [
    {
      description: "List the reviewer’s accessible active matters.",
      user_prompt:
        "Using stella, list all active matters I can access, including each matter name and ID.",
      file_attachment_urls: null,
      tools_triggered: "list_matters",
      expected_output:
        "Returns the accessible active matters with names and IDs, without exposing inaccessible matters.",
      expected_output_url: null,
    },
    {
      description: "Search documents across accessible matters.",
      user_prompt:
        "Using stella, find documents across my matters that mention a change-of-control clause.",
      file_attachment_urls: null,
      tools_triggered: "search_across_matters",
      expected_output:
        "Returns relevant matches from accessible matters with enough context to identify the source documents.",
      expected_output_url: null,
    },
    {
      description: "List documents inside a selected matter.",
      user_prompt:
        "Using stella, list the documents in the first active matter, including document names and IDs.",
      file_attachment_urls: null,
      tools_triggered: "list_documents",
      expected_output:
        "Returns the selected matter’s documents with names and IDs.",
      expected_output_url: null,
    },
    {
      description: "Discover available document templates.",
      user_prompt:
        "Using stella, list the document templates available to my organization and identify their fillable fields.",
      file_attachment_urls: null,
      tools_triggered: "list_templates",
      expected_output:
        "Returns available templates and their fillable-field details.",
      expected_output_url: null,
    },
    {
      description: "Create a private review matter.",
      user_prompt:
        "Using stella, create an active matter named ChatGPT Submission Review.",
      file_attachment_urls: null,
      tools_triggered: "save_matter",
      expected_output:
        "Creates the private matter after any required approval and returns its identifier and status.",
      expected_output_url: null,
    },
  ],
  negative_test_cases: [
    {
      description: "Do not trigger for general legal education.",
      user_prompt:
        "Explain the general difference between a warranty and a representation.",
      file_attachment_urls: null,
      tools_triggered: null,
      expected_output:
        "The app should not be invoked because the request does not need the user’s stella data or actions.",
      expected_output_url: null,
    },
    {
      description: "Do not trigger for sending external email.",
      user_prompt:
        "Send an email to opposing counsel confirming tomorrow’s meeting.",
      file_attachment_urls: null,
      tools_triggered: null,
      expected_output:
        "The app should not be invoked because stella does not provide an email-sending tool.",
      expected_output_url: null,
    },
    {
      description: "Do not trigger for filing with a court.",
      user_prompt: "File this brief with the court now.",
      file_attachment_urls: null,
      tools_triggered: null,
      expected_output:
        "The app should not be invoked because stella does not submit filings to courts.",
      expected_output_url: null,
    },
  ],
} as const;
