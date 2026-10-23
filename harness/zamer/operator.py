"""Оператор стенда: подсказки по-русски в консоли и ожидание Enter."""
from __future__ import annotations

import asyncio


class ConsoleOperator:
    def say(self, text: str) -> None:
        print(text, flush=True)

    async def wait_enter(self, text: str) -> None:
        # input() в отдельном потоке: пока оператор читает подсказку, цикл
        # asyncio продолжает принимать отчёты устройств.
        await asyncio.to_thread(input, f"\n>>> {text}\n    Нажмите Enter, когда готово. ")

    async def ask(self, text: str) -> str:
        return (await asyncio.to_thread(input, f"\n>>> {text}\n    ")).strip()
