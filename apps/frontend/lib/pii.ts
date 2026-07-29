import type { PIIAnnotation } from "@outcomes/shared-types";

const PII_PATTERNS: Array<{ label: string; regex: RegExp; confidence: number }> = [
  { label: "EMAIL", regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, confidence: 0.97 },
  { label: "PHONE", regex: /(?:(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4})/g, confidence: 0.9 },
  { label: "SSN", regex: /\b\d{3}-\d{2}-\d{4}\b/g, confidence: 0.98 },
  { label: "DATE", regex: /\b(?:0?[1-9]|1[0-2])[/-](?:0?[1-9]|[12]\d|3[01])[/-](?:\d{2}|\d{4})\b/g, confidence: 0.93 },
  { label: "DATE", regex: /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(?:0?[1-9]|[12]\d|3[01])(?:st|nd|rd|th)?(?:,?\s+\d{2,4})?\b/gi, confidence: 0.86 },
  { label: "AADHAAR_NUMBER", regex: /(?<!\d)(?:\d{4}\s?\d{4}\s?\d{4})(?!\d)/g, confidence: 0.95 },
  { label: "CREDIT_CARD", regex: /\b(?:\d[ -]*?){13,16}\b/g, confidence: 0.86 },
  { label: "ZIPCODE", regex: /\b\d{5}(?:-\d{4})?\b/g, confidence: 0.8 },
  { label: "IP_ADDRESS", regex: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, confidence: 0.84 },
  { label: "URL", regex: /\bhttps?:\/\/[^\s/$.?#].[^\s]*\b/gi, confidence: 0.9 },
  { label: "ADDRESS", regex: /\b\d{1,6}\s+(?!(?:at|to|in|on|near|for|about)\b)(?:[A-Z0-9.'-]+\s+){0,4}?(?:street|st\.?|road|rd\.?|avenue|ave\.?|boulevard|blvd\.?|lane|ln\.?|drive|dr\.?|court|ct\.?|place|pl\.?|plaza|way|circle|cir\.?|terrace|ter\.?|parkway|pkwy\.?)\b/gi, confidence: 0.9 },
];

const CONTEXT_PII_PATTERNS: Array<{ label: string; regex: RegExp; confidence: number }> = [
  {
    label: "ACCOUNT_NUMBER",
    regex: /\b(?:account)\s*(?:number|no\.?|#|id)?\s*[:\-]?\s*([A-Z0-9-]{4,})\b/gi,
    confidence: 0.9,
  },
  {
    label: "INSURANCE_ID",
    regex: /\b(?:member|policy|subscriber|insurance)\s*(?:number|no\.?|#|id)?\s*[:\-]?\s*([A-Z0-9-]{4,})\b/gi,
    confidence: 0.88,
  },
  {
    label: "ID_NUMBER",
    regex: /\b(?:reference|case|claim|mrn|patient|medical record)\s*(?:number|no\.?|#|id)?\s*[:\-]?\s*([A-Z0-9-]{4,})\b/gi,
    confidence: 0.86,
  },
];

const NAME_PATTERNS: RegExp[] = [
  /\bthis message is for\s+([a-z]+(?:\s+[a-z]+){0,2}?)(?=\s+(?:my name is|this is|i am|i'm|calling|from|with|and)\b|[.,;!?]|$)/gi,
  /\bmy name is\s+([a-z]+(?:\s+[a-z]+){0,2}?)(?=\s+(?:i am|i'm|calling|from|with|and|on behalf|about)\b|[.,;!?]|$)/gi,
  /\bthis is\s+([a-z]+(?:\s+[a-z]+){0,2}?)(?=\s+(?:i am|i'm|calling|from|with|and|on behalf|about)\b|[.,;!?]|$)/gi,
  /\bspeaking with\s+([a-z]+(?:\s+[a-z]+){0,2}?)(?=\s+(?:from|at|and|about)\b|[.,;!?]|$)/gi,
  /\b(?:note says|says|for|patient|client)\s+([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,2})(?=\s+(?:lives?|is|was|has|needs|called|from|near|at|in|on|with|and)\b|[.,;!?]|$)/g,
];

const LOCATION_PATTERNS: RegExp[] = [
  /\b(?:near|at|in|from|around|inside|outside)\s+([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,3})(?=\s+(?:and|or|near|at|in|on|from|with|for|by|to|around|inside|outside)\b|[.,;!?]|$)/g,
];

const NAME_BLACKLIST = new Set([
  "agent",
  "assistant",
  "calling",
  "customer",
  "doctor",
  "message",
  "name",
  "number",
  "patient",
  "phone",
  "service",
]);

const LOCATION_BLACKLIST = new Set([
  ...Array.from(NAME_BLACKLIST),
  "am",
  "pm",
  "jan",
  "january",
  "feb",
  "february",
  "mar",
  "march",
  "apr",
  "april",
  "may",
  "jun",
  "june",
  "jul",
  "july",
  "aug",
  "august",
  "sep",
  "september",
  "oct",
  "october",
  "nov",
  "november",
  "dec",
  "december",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
  "english",
  "spanish",
  "hindi",
  "tamil",
  "telugu",
  "kannada",
  "malayalam",
  "marathi",
  "bengali",
  "morning",
  "afternoon",
  "evening",
  "night",
  "today",
  "tomorrow",
  "yesterday",
]);

function createId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `pii-${Math.random().toString(36).slice(2, 10)}`;
}

export function sanitizePIIAnnotations(transcript: string, annotations: PIIAnnotation[]): PIIAnnotation[] {
  const transcriptLength = transcript.length;
  const cleaned = annotations
    .map((annotation) => ({
      ...annotation,
      source: annotation.source ?? null,
      confidence: annotation.confidence ?? null
    }))
    .filter((annotation) => {
      if (!annotation.id || !annotation.label) return false;
      if (!Number.isInteger(annotation.start) || !Number.isInteger(annotation.end)) return false;
      if (annotation.start < 0 || annotation.end <= annotation.start) return false;
      if (annotation.end > transcriptLength) return false;
      const value = transcript.slice(annotation.start, annotation.end);
      return value.trim().length > 0;
    })
    .map((annotation) => ({
      ...annotation,
      value: transcript.slice(annotation.start, annotation.end)
    }))
    .sort((a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id));

  const deduped: PIIAnnotation[] = [];
  for (const annotation of cleaned) {
    const duplicate = deduped.some(
      (item) =>
        item.start === annotation.start &&
        item.end === annotation.end &&
        item.label === annotation.label
    );
    if (!duplicate) {
      deduped.push(annotation);
    }
  }
  return deduped;
}

export function detectPIIAnnotations(transcript: string): PIIAnnotation[] {
  if (!transcript.trim()) {
    return [];
  }
  const detected: PIIAnnotation[] = [];

  for (const pattern of PII_PATTERNS) {
    const regex = new RegExp(pattern.regex.source, pattern.regex.flags.includes("g") ? pattern.regex.flags : `${pattern.regex.flags}g`);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(transcript)) !== null) {
      const value = match[0];
      if (!value.trim()) {
        continue;
      }
      const start = match.index;
      const end = start + value.length;
      detected.push({
        id: createId(),
        label: pattern.label,
        start,
        end,
        value,
        source: "auto",
        confidence: pattern.confidence
      });
      if (regex.lastIndex === match.index) {
        regex.lastIndex += 1;
      }
    }
  }

  for (const pattern of CONTEXT_PII_PATTERNS) {
    const regex = new RegExp(pattern.regex.source, pattern.regex.flags.includes("g") ? pattern.regex.flags : `${pattern.regex.flags}g`);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(transcript)) !== null) {
      const value = match[1];
      if (!value || !isValidContextValue(value)) {
        continue;
      }
      const start = match.index + match[0].lastIndexOf(value);
      const end = start + value.length;
      detected.push({
        id: createId(),
        label: pattern.label,
        start,
        end,
        value,
        source: "auto",
        confidence: pattern.confidence
      });
      if (regex.lastIndex === match.index) {
        regex.lastIndex += 1;
      }
    }
  }

  for (const pattern of NAME_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(transcript)) !== null) {
      const value = match[1]?.replace(/\s+/g, " ").trim();
      if (!value || !likelyPersonName(value)) {
        continue;
      }
      const start = match.index + match[0].indexOf(match[1]);
      const end = start + match[1].length;
      detected.push({
        id: createId(),
        label: "PERSON",
        start,
        end,
        value: transcript.slice(start, end),
        source: "auto",
        confidence: 0.96
      });
      if (regex.lastIndex === match.index) {
        regex.lastIndex += 1;
      }
    }
  }

  for (const pattern of LOCATION_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(transcript)) !== null) {
      const value = match[1]?.replace(/\s+/g, " ").trim();
      if (!value || !likelyLocationName(value)) {
        continue;
      }
      const rawStart = match.index + match[0].indexOf(match[1]);
      const [start, end] = trimTerminalPunctuation(transcript, rawStart, rawStart + match[1].length);
      detected.push({
        id: createId(),
        label: "LOCATION",
        start,
        end,
        value: transcript.slice(start, end),
        source: "auto",
        confidence: 0.78
      });
      if (regex.lastIndex === match.index) {
        regex.lastIndex += 1;
      }
    }
  }

  detected.sort((a, b) => a.start - b.start || b.end - a.end);
  const nonOverlapping: PIIAnnotation[] = [];
  for (const annotation of detected) {
    const overlaps = nonOverlapping.some(
      (item) => annotation.start < item.end && item.start < annotation.end
    );
    if (!overlaps) {
      nonOverlapping.push(annotation);
    }
  }
  return sanitizePIIAnnotations(transcript, nonOverlapping);
}

function isValidContextValue(value: string): boolean {
  const normalized = value.replace(/[^A-Z0-9]/gi, "");
  if (normalized.length < 4) return false;
  if (/^[A-Z]+$/i.test(normalized)) return false;
  return /\d/.test(normalized);
}

function likelyPersonName(value: string): boolean {
  const tokens = value.trim().toLowerCase().split(/\s+/);
  if (tokens.length === 0 || tokens.length > 3) return false;
  return tokens.every((token) => token.length >= 2 && !NAME_BLACKLIST.has(token));
}

function likelyLocationName(value: string): boolean {
  const tokens = value
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z]/g, ""))
    .filter(Boolean);
  if (tokens.length === 0 || tokens.length > 4) return false;
  if (tokens.some((token) => token.length < 2)) return false;
  return !tokens.every((token) => LOCATION_BLACKLIST.has(token));
}

function trimTerminalPunctuation(text: string, start: number, end: number): [number, number] {
  let trimmedEnd = end;
  while (trimmedEnd > start && /[.,;!?]/.test(text[trimmedEnd - 1] ?? "")) {
    trimmedEnd -= 1;
  }
  return [start, trimmedEnd];
}
