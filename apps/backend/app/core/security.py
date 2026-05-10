import base64
import hashlib
import hmac
import secrets
from datetime import UTC, datetime, timedelta
from typing import Any

from jose import JWTError, jwt

from app.core.config import get_settings

settings = get_settings()
PBKDF2_SCHEME = "pbkdf2-sha256"
PBKDF2_ROUNDS = 29000
SALT_BYTES = 16


def _ab64_encode(value: bytes) -> str:
    return base64.b64encode(value).decode("ascii").rstrip("=").replace("+", ".")


def _ab64_decode(value: str) -> bytes:
    normalized = value.replace(".", "+")
    padding = "=" * ((4 - len(normalized) % 4) % 4)
    return base64.b64decode(normalized + padding)


def _pbkdf2_checksum(password: str, salt: bytes, rounds: int) -> str:
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, rounds)
    return _ab64_encode(digest)


def verify_password(plain_password: str, hashed_password: str) -> bool:
    try:
        _, scheme, raw_rounds, raw_salt, expected_checksum = hashed_password.split("$")
        if scheme != PBKDF2_SCHEME:
            return False
        rounds = int(raw_rounds)
        if rounds <= 0:
            return False
        checksum = _pbkdf2_checksum(plain_password, _ab64_decode(raw_salt), rounds)
    except (TypeError, ValueError):
        return False
    return hmac.compare_digest(checksum, expected_checksum)


def get_password_hash(password: str) -> str:
    salt = secrets.token_bytes(SALT_BYTES)
    checksum = _pbkdf2_checksum(password, salt, PBKDF2_ROUNDS)
    return f"${PBKDF2_SCHEME}${PBKDF2_ROUNDS}${_ab64_encode(salt)}${checksum}"


def create_access_token(
    subject: str,
    role: str,
    expires_delta: timedelta | None = None,
    session_id: str | None = None,
) -> str:
    expire = datetime.now(UTC) + (expires_delta or timedelta(minutes=settings.token_expire_minutes))
    to_encode = {"sub": subject, "role": role, "type": "access", "exp": expire}
    if session_id:
        to_encode["sid"] = session_id
    return jwt.encode(to_encode, settings.jwt_secret_key, algorithm=settings.algorithm)


def create_refresh_token(
    subject: str,
    role: str,
    expires_delta: timedelta | None = None,
    session_id: str | None = None,
) -> str:
    expire = datetime.now(UTC) + (
        expires_delta or timedelta(minutes=settings.refresh_token_expire_minutes)
    )
    to_encode = {"sub": subject, "role": role, "type": "refresh", "exp": expire}
    if session_id:
        to_encode["sid"] = session_id
    return jwt.encode(to_encode, settings.jwt_refresh_secret_key, algorithm=settings.algorithm)


def decode_access_token(token: str) -> dict[str, Any]:
    try:
        return jwt.decode(token, settings.jwt_secret_key, algorithms=[settings.algorithm])
    except JWTError as exc:
        raise ValueError("Invalid access token") from exc


def decode_refresh_token(token: str) -> dict[str, Any]:
    try:
        return jwt.decode(token, settings.jwt_refresh_secret_key, algorithms=[settings.algorithm])
    except JWTError as exc:
        raise ValueError("Invalid refresh token") from exc
