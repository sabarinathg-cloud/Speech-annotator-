from io import BytesIO
from typing import Any

import pandas as pd


SUPPORTED_TABULAR_SUFFIXES = {".csv", ".xlsx", ".xls"}


def load_tabular_as_dataframe(file_bytes: bytes, file_suffix: str | None = None) -> pd.DataFrame:
    suffix = (file_suffix or "").lower()
    if suffix == ".csv":
        return pd.read_csv(BytesIO(file_bytes)).fillna("")
    return load_excel_as_dataframe(file_bytes, suffix)


def load_excel_as_dataframe(file_bytes: bytes, file_suffix: str | None = None) -> pd.DataFrame:
    engine = "xlrd" if file_suffix == ".xls" else "openpyxl"
    return pd.read_excel(BytesIO(file_bytes), engine=engine).fillna("")


def dataframe_preview(df: pd.DataFrame, limit: int = 20) -> tuple[list[str], list[dict[str, Any]], int]:
    columns = [str(col) for col in df.columns.tolist()]
    rows = []
    for _, row in df.head(limit).iterrows():
        rows.append({str(k): normalize_cell(v) for k, v in row.to_dict().items()})
    return columns, rows, len(df.index)


def normalize_cell(value: Any) -> Any:
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, (str, int, float, bool)):
        return value
    if pd.isna(value):
        return ""
    return str(value)
