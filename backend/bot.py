import asyncio
import logging

from aiogram import Bot, Dispatcher, F
from aiogram.filters import CommandStart
from aiogram.types import (
    Message,
    InlineKeyboardMarkup,
    InlineKeyboardButton,
    WebAppInfo,
)

from backend.config import settings


logging.basicConfig(level=logging.INFO)

bot = Bot(token=settings.BOT_TOKEN)
dp = Dispatcher()


def main_menu():
    buttons = []

    if settings.WEBAPP_URL:
        buttons.append([
            InlineKeyboardButton(
                text="🛍 Открыть Prestige Market",
                web_app=WebAppInfo(url=settings.WEBAPP_URL),
            )
        ])

    if settings.SUPPORT_USERNAME:
        support_url = (
            "https://t.me/" +
            settings.SUPPORT_USERNAME.lstrip("@")
        )

        buttons.append([
            InlineKeyboardButton(
                text="💬 Поддержка",
                url=support_url,
            )
        ])

    return InlineKeyboardMarkup(inline_keyboard=buttons)


@dp.message(CommandStart())
async def start_handler(message: Message):
    await message.answer(
        "✨ <b>PRESTIGE MARKET</b>\n\n"
        "Добро пожаловать в цифровой маркетплейс!\n\n"
        "🎁 Коллекционные Telegram-подарки\n"
        "💎 Заявки на аренду NFT\n"
        "⭐ Заказы Telegram Stars\n"
        "💠 Заказы Telegram Premium\n\n"
        "Нажми кнопку ниже, чтобы открыть каталог.",
        reply_markup=main_menu(),
        parse_mode="HTML",
    )


@dp.message(F.text == "/help")
async def help_handler(message: Message):
    await message.answer(
        "По вопросам заказов и работы сервиса "
        "обращайтесь в поддержку.",
        reply_markup=main_menu(),
    )


async def main():
    if not settings.BOT_TOKEN:
        raise RuntimeError("BOT_TOKEN is not configured")

    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())
