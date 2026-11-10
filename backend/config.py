from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    BOT_TOKEN: str = ""
    BOT_USERNAME: str = ""
    WEBAPP_URL: str = ""
    DATABASE_URL: str = "sqlite+aiosqlite:///./prestige.db"

    ADMIN_IDS: str = ""
    SUPPORT_USERNAME: str = ""

    INIT_DATA_MAX_AGE_SECONDS: int = 86400

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    @property
    def admins(self) -> set[int]:
        result = set()

        for value in self.ADMIN_IDS.split(","):
            value = value.strip()
            if value.isdigit():
                result.add(int(value))

        return result


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
