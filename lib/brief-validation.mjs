// Only these locally authored corrections may cross the research tool boundary.
// Never copy a submitted value, source passage or caught exception into a correction.
const messages = Object.freeze({
  BRIEF_OBJECT: 'Provide a research brief object with the required fields.',
  REQUEST_MISMATCH: 'Copy the question and scope exactly from the research request.',
  TEXT_4000: 'Use nonempty text of at most 4000 characters.',
  TEXT_1600: 'Use nonempty text of at most 1600 characters.',
  TEXT_1200: 'Use nonempty text of at most 1200 characters.',
  TEXT_1000: 'Use nonempty text of at most 1000 characters.',
  LIST_12: 'Provide an array containing at most 12 text entries.',
  FINDINGS_20: 'Provide an array containing at most 20 findings.',
  FINDING_OBJECT: 'Provide a finding object with claim, status, reason and citations.',
  FINDING_STATUS: 'Use supported, conflicting or unverified as the finding status.',
  CITATIONS_4: 'Provide an array containing at most 4 citations for this finding.',
  CITATION_REQUIRED: 'Supported or conflicting findings require an exact source citation. Otherwise mark the finding unverified and explain the gap.',
  CITATION_OBJECT: 'Provide a citation object with sourceId, start, end and quote.',
  SOURCE_UNKNOWN: 'Choose an existing sourceId from research_sources before citing or reading it.',
  DISCOVERY_ONLY: 'Search snippets are discovery leads. Fetch and cite the original page, or mark the finding unverified and record the gap.',
  LINE_RANGE: 'Read a range of 1-80 lines using positive integer start and end values, with end at least start.',
  LINE_START: 'The start line is beyond the source. Check its line count with research_sources.',
  PASSAGE_OFFSET: 'Use the nextOffset from the previous research_read result with the same source and line range.',
  QUOTE_WORDS: 'Use an exact excerpt of at most 25 words from the stated lines.',
  QUOTE_NOT_EXACT: 'The quote is not an exact excerpt of the stated lines. Read the passage and copy the text exactly.',
  BRIEF_BYTES: 'Brief exceeds 24000 UTF-8 bytes; summarize it while preserving findings, exact citations and gaps.',
});
const corrections = new WeakMap();
const simpleFields = new Set(['brief', 'question', 'scope', 'doneWhen', 'sourceId', 'lines', 'offset', 'quote', 'questions', 'gaps', 'findings']);
const listField = /^(?:questions|gaps)\[(?:[0-9]|1[01])\]$/;
const findingField = /^findings\[(?:[0-9]|1[0-9])\](?:\.(?:claim|status|reason|citations(?:\[[0-3]\](?:\.(?:sourceId|lines|quote))?)?))?$/;

export function briefValidation(code, field = 'brief') {
  const safeCode = Object.hasOwn(messages, code) ? code : 'BRIEF_OBJECT';
  const safeField = typeof field === 'string' && (simpleFields.has(field) || listField.test(field) || findingField.test(field)) ? field : 'brief';
  const correction = Object.freeze({ code: safeCode, field: safeField, message: messages[safeCode] });
  const error = new Error(`${correction.field}: ${correction.message}`);
  error.name = 'BriefValidationError';
  corrections.set(error, correction);
  return error;
}

export function briefCorrection(error) {
  return error !== null && typeof error === 'object' ? corrections.get(error) : undefined;
}
