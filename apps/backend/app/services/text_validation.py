ALLOWED_TEXT_DESCRIPTION = (
    "only letters, numbers, spaces, line breaks and . , ? ! - @ are allowed."
)
ALLOWED_PUNCTUATION = set(".,?!-@")
ALLOWED_WHITESPACE = {" ", "\n", "\r", "\t"}


def invalid_text_message(field_label: str) -> str:
    return f"Invalid characters in {field_label}: {ALLOWED_TEXT_DESCRIPTION}"


def is_valid_annotation_text(value: str | None) -> bool:
    if not value:
        return True
    return all(
        character in ALLOWED_WHITESPACE
        or character in ALLOWED_PUNCTUATION
        or character.isalpha()
        or character.isdecimal()
        for character in value
    )


def find_invalid_annotation_text(value: str | None, field_label: str) -> str | None:
    if is_valid_annotation_text(value):
        return None
    return invalid_text_message(field_label)
