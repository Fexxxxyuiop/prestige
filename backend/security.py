import hashlib
import hmac
import json
import time

from urllib.parse import parse_qsl

from fastapi import Header, HTTPException

from backend.config import settings


def validate_init_data(init_data: str) -> dict:
    if not init_data or not settings.BOT_TOKEN:
        raise ValueError("Telegram authorization is unavailable")

    try:
        parsed = dict(parse_qsl(init_data, keep_blank_values=True))

        received_hash = parsed.pop("hash", None)
        parsed.pop("signature", None)

        if not received_hash:
            raise ValueError("Missing hash")

        data_check_string = "\n".join(
            f"{key}={value}"
            for key, value in sorted(parsed.items())
        )

        secret_key = hmac.new(
            b"WebAppData",
            settings.BOT_TOKEN.encode(),
            hashlib.sha256,
        ).digest()

        calculated_hash = hmac.new(
            secret_key,
            data_check_string.encode(),
            hashlib.sha256,
        ).hexdigest()

        if not hmac.compare_digest(calculated_hash, received_hash):
            raise ValueError("Invalid Telegram signature")

        auth_date = int(parsed.get("auth_date", "0"))
        current_time = int(time.time())

        if auth_date > current_time + 60:
            raise ValueError("Invalid authorization date")

        if current_time - auth_date > settings.INIT_DATA_MAX_AGE_SECONDS:
            raise ValueError("Telegram authorization expired")

        user_data = json.loads(parsed.get("user", "{}"))

        if not isinstance(user_data.get("id"), int):
            raise ValueError("Invalid Telegram user")

        return user_data

    except (ValueError, TypeError, json.JSONDecodeError) as error:
        raise ValueError("Invalid Telegram authorization") from error


async def current_user(
    x_telegram_init_data: str | None = Header(
        default=None,
        alias="X-Telegram-Init-Data",
    ),
):
    if not x_telegram_init_data:
        raise HTTPException(
            status_code=401,
            detail="Telegram authorization required",
        )

    try:
        return validate_init_data(x_telegram_init_data)
    except ValueError:
        raise HTTPException(
            status_code=401,
            detail="Invalid Telegram authorization",
        )


async def require_admin(user: dict = None):
    if not user or user.get("id") not in settings.admins:
        raise HTTPException(
            status_code=403,
            detail="Administrator access required",
        )

    return user
