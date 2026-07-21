ALLOWED_TEXT_DESCRIPTION = "all characters are allowed."


def invalid_text_message(field_label: str) -> str:
    return f"Invalid characters in {field_label}: {ALLOWED_TEXT_DESCRIPTION}"


def is_valid_annotation_text(value: str | None) -> bool:
    return True


def find_invalid_annotation_text(value: str | None, field_label: str) -> str | None:
    return None
