import unicodedata


ALLOWED_TEXT_DESCRIPTION = (
    "any printable text is allowed; raw control characters are not allowed."
)


def invalid_text_message(field_label: str) -> str:
    return f"Invalid characters in {field_label}: {ALLOWED_TEXT_DESCRIPTION}"


def is_valid_annotation_text(value: str | None) -> bool:
    if not value:
        return True
    return all(_is_allowed_annotation_character(character) for character in value)


def _is_allowed_annotation_character(character: str) -> bool:
    if character.isspace():
        return True
    return unicodedata.category(character)[0] != "C"


def find_invalid_annotation_text(value: str | None, field_label: str) -> str | None:
    if is_valid_annotation_text(value):
        return None
    return invalid_text_message(field_label)
