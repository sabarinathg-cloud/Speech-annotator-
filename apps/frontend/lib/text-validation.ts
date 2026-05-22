const allowedPunctuation = new Set(Array.from(".,?!-@"));
const allowedWhitespace = new Set([" ", "\n", "\r", "\t"]);

export const annotationTextAllowedDescription =
  "only letters, numbers, spaces, line breaks and . , ? ! - @ are allowed.";

function isAllowedAnnotationTextCharacter(character: string): boolean {
  return (
    allowedWhitespace.has(character) ||
    allowedPunctuation.has(character) ||
    /\p{L}/u.test(character) ||
    /\p{N}/u.test(character)
  );
}

export function validateAnnotationText(value: string | null | undefined, fieldLabel: string): string | null {
  if (!value) return null;
  for (const character of value) {
    if (!isAllowedAnnotationTextCharacter(character)) {
      return `Invalid characters in ${fieldLabel}: ${annotationTextAllowedDescription}`;
    }
  }
  return null;
}
