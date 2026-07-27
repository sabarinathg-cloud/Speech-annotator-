from io import BytesIO
from pathlib import Path
from typing import Any

import pandas as pd


SUPPORTED_TABULAR_SUFFIXES = {".csv", ".xlsx", ".xls", ".parquet"}


def load_tabular_as_dataframe(file_bytes: bytes, file_suffix: str | None = None) -> pd.DataFrame:
    suffix = (file_suffix or "").lower()
    if suffix == ".csv":
        return pd.read_csv(BytesIO(file_bytes), dtype=str).fillna("")
    if suffix == ".parquet":
        return pd.read_parquet(BytesIO(file_bytes), engine="pyarrow").fillna("")
    return load_excel_as_dataframe(file_bytes, suffix)


def load_tabular_file_as_dataframe(file_path: Path) -> pd.DataFrame:
    suffix = file_path.suffix.lower()
    if suffix == ".csv":
        return pd.read_csv(file_path, dtype=str).fillna("")
    if suffix == ".parquet":
        return pd.read_parquet(file_path, engine="pyarrow").fillna("")
    engine = "xlrd" if suffix == ".xls" else "openpyxl"
    return pd.read_excel(file_path, engine=engine, dtype=str).fillna("")


def load_excel_as_dataframe(file_bytes: bytes, file_suffix: str | None = None) -> pd.DataFrame:
    engine = "xlrd" if file_suffix == ".xls" else "openpyxl"
    return pd.read_excel(BytesIO(file_bytes), engine=engine, dtype=str).fillna("")


def write_dataframe_to_tabular_file(df: pd.DataFrame, file_path: Path) -> None:
    suffix = file_path.suffix.lower()
    if suffix == ".csv":
        df.to_csv(file_path, index=False)
        return
    if suffix == ".parquet":
        df.to_parquet(file_path, index=False, engine="pyarrow")
        return
    df.to_excel(file_path, index=False, engine="openpyxl")


def filter_dataframe_to_first_rows(df: pd.DataFrame, *, limit: int) -> pd.DataFrame:
    return df.head(limit).copy()


def filter_dataframe_to_first_call_ids(
    df: pd.DataFrame,
    *,
    call_id_column: str,
    limit: int,
) -> pd.DataFrame:
    if call_id_column not in df.columns:
        raise ValueError(f"Call ID column '{call_id_column}' was not found in the source file")

    call_ids = df[call_id_column].fillna("").astype(str).str.strip()
    selected_call_ids = []
    seen = set()
    for call_id in call_ids:
        if not call_id or call_id in seen:
            continue
        seen.add(call_id)
        selected_call_ids.append(call_id)
        if len(selected_call_ids) >= limit:
            break

    if not selected_call_ids:
        raise ValueError(f"Call ID column '{call_id_column}' does not contain any non-empty call IDs")

    return df.loc[call_ids.isin(selected_call_ids)].copy()


def write_first_rows_subset(source_path: Path, destination_path: Path, *, limit: int) -> int:
    if source_path.suffix.lower() == ".parquet":
        return _write_parquet_first_rows_subset(source_path, destination_path, limit=limit)

    df = load_tabular_file_as_dataframe(source_path)
    filtered = filter_dataframe_to_first_rows(df, limit=limit)
    write_dataframe_to_tabular_file(filtered, destination_path)
    return len(filtered.index)


def write_first_call_ids_subset(
    source_path: Path,
    destination_path: Path,
    *,
    call_id_column: str,
    limit: int,
) -> int:
    if source_path.suffix.lower() == ".parquet":
        return _write_parquet_first_call_ids_subset(
            source_path,
            destination_path,
            call_id_column=call_id_column,
            limit=limit,
        )

    df = load_tabular_file_as_dataframe(source_path)
    filtered = filter_dataframe_to_first_call_ids(df, call_id_column=call_id_column, limit=limit)
    write_dataframe_to_tabular_file(filtered, destination_path)
    return len(filtered.index)


def _write_parquet_first_call_ids_subset(
    source_path: Path,
    destination_path: Path,
    *,
    call_id_column: str,
    limit: int,
) -> int:
    try:
        import pyarrow as pa
        import pyarrow.compute as pc
        import pyarrow.parquet as pq
    except ImportError as exc:
        raise RuntimeError("Parquet support requires pyarrow to be installed") from exc

    parquet_file = pq.ParquetFile(source_path)
    if call_id_column not in parquet_file.schema.names:
        raise ValueError(f"Call ID column '{call_id_column}' was not found in the source file")

    selected_call_ids: list[str] = []
    seen = set()
    for batch in parquet_file.iter_batches(columns=[call_id_column], batch_size=65_536):
        for raw_call_id in batch.column(0).to_pylist():
            call_id = "" if raw_call_id is None else str(raw_call_id).strip()
            if not call_id or call_id in seen:
                continue
            seen.add(call_id)
            selected_call_ids.append(call_id)
            if len(selected_call_ids) >= limit:
                break
        if len(selected_call_ids) >= limit:
            break

    if not selected_call_ids:
        raise ValueError(f"Call ID column '{call_id_column}' does not contain any non-empty call IDs")

    selected = set(selected_call_ids)
    selected_array = pa.array(list(selected), type=pa.string())
    writer: pq.ParquetWriter | None = None
    written_count = 0
    try:
        for batch in parquet_file.iter_batches(batch_size=65_536):
            table = pa.Table.from_batches([batch])
            call_ids = pc.utf8_trim_whitespace(pc.cast(table[call_id_column], pa.string()))
            mask = pc.is_in(call_ids, value_set=selected_array)
            filtered_table = table.filter(mask)
            if filtered_table.num_rows == 0:
                continue
            if writer is None:
                writer = pq.ParquetWriter(destination_path, filtered_table.schema)
            writer.write_table(filtered_table)
            written_count += filtered_table.num_rows
    finally:
        if writer is not None:
            writer.close()

    return written_count


def _write_parquet_first_rows_subset(source_path: Path, destination_path: Path, *, limit: int) -> int:
    try:
        import pyarrow as pa
        import pyarrow.parquet as pq
    except ImportError as exc:
        raise RuntimeError("Parquet support requires pyarrow to be installed") from exc

    parquet_file = pq.ParquetFile(source_path)
    writer: pq.ParquetWriter | None = None
    written_count = 0
    try:
        for batch in parquet_file.iter_batches(batch_size=65_536):
            if written_count >= limit:
                break
            remaining = limit - written_count
            table = pa.Table.from_batches([batch.slice(0, remaining)])
            if table.num_rows == 0:
                continue
            if writer is None:
                writer = pq.ParquetWriter(destination_path, table.schema)
            writer.write_table(table)
            written_count += table.num_rows
    finally:
        if writer is not None:
            writer.close()

    return written_count


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
