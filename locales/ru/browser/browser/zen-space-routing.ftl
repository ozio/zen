# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

zen-space-routing-settings = 
    .label = Настройки маршрутизации
zen-space-routing-rulepanel-placeholder = Маршруты позволяют настроить где каждый конкретный сайт будет открываться. Например, вы можете настроить чтобы ссылки на YouTube всегда открывались в пространстве "Личное".
zen-space-routing-dialog-title = Маршрутизация пространств
zen-space-routing-external-default = Стандартный маршрут для внешних ссылок
zen-space-routing-new-route = Новый маршрут
zen-space-routing-open-in-space = Открывать в пространстве
zen-space-routing-most-recent-space = Последнее активное
zen-space-routing-close-button = 
    .aria-label = Закрыть
    .tooltiptext = Закрыть
zen-space-routing-contains = 
    .label = Содержит
zen-space-routing-equal-to = 
    .label = Совпадает с
zen-space-routing-regex = 
    .label = RegEx
zen-space-routing-open-in = Открывать в
zen-space-routing-url = URL
zen-space-routing-tab-routed-toast = Новая вкладка открыта в { $targetWorkspace}
tab-context-zen-add-domain-to-sr = 
    .label =
        { $tabCount ->
            [one] Добавить маршрутизацию для домена
           *[other] Добавить маршрутизацию для доменов
        }

zen-space-routing-first-space = Первое пространство
zen-space-routing-priority = Правила проверяются сверху вниз. Срабатывает первое совпадение.
zen-space-routing-ai-enabled = Использовать Jev для внешних ссылок без подходящего правила
zen-space-routing-ai-scope = Только ссылки из других приложений. При неуверенном ответе или ошибке используется пространство по умолчанию ниже.
zen-space-routing-ai-settings = Настройки Jev
zen-space-routing-ai-key = API-ключ TypeSafe
zen-space-routing-ai-save-key = Сохранить ключ
zen-space-routing-ai-clear-key = Удалить ключ
zen-space-routing-ai-check-key = Проверить подключение
zen-space-routing-ai-prompt = Промпт для распределения ссылок
zen-space-routing-ai-reset-prompt = Восстановить стандартный промпт
zen-space-routing-ai-spaces = Пространства и их назначение — подставляются автоматически
zen-space-routing-ai-probability = Минимальная вероятность (%)
zen-space-routing-ai-margin = Отрыв от второго места (п. п.)
zen-space-routing-ai-timeout = Ожидание ответа (мс)
zen-space-routing-ai-privacy = Jev получает домен и путь ссылки, названия пространств, описания и промпт. Параметры запроса и фрагмент удаляются. Страницы и история не отправляются. Приватные окна, IP-адреса и локальные имена обходят Jev. API-ключ хранится зашифрованным в этом профиле.
zen-space-routing-preview = Проверить внешнюю ссылку
zen-space-routing-preview-run = Проверить без открытия вкладки
zen-space-routing-preview-result = { $space } — { $reason }
zen-space-routing-unknown = Недостаточно данных
zen-space-routing-status-key-saved = Ключ сохранён в зашифрованном виде.
zen-space-routing-status-checking = Проверяем…
zen-space-routing-status-connected = Подключение к Jev проверено.
zen-space-routing-status-rule = Совпавшее правило
zen-space-routing-status-jev = Jev выбрал это пространство
zen-space-routing-status-uncertain = Неуверенный ответ; выбран запасной вариант
zen-space-routing-status-disabled = Jev выключен; выбран запасной вариант
zen-space-routing-status-excluded-url = Этот адрес не отправляется в Jev
zen-space-routing-status-excluded-window = Jev недоступен в этом окне
zen-space-routing-status-missing-key = API-ключ не сохранён.
zen-space-routing-status-invalid-key = API-ключ отклонён.
zen-space-routing-status-service-error = Jev недоступен; выбран запасной вариант
zen-space-routing-status-timeout = Jev не ответил вовремя; выбран запасной вариант
zen-space-routing-status-cancelled = Запрос отменён
zen-space-routing-status-busy = Слишком много запросов; выбран запасной вариант
zen-space-routing-status-invalid-response = Некорректный ответ Jev; выбран запасной вариант
zen-space-routing-status-invalid-spaces = Jev поддерживает от 1 до 254 пространств
zen-space-routing-status-settings-changed = Настройки изменились; выбран запасной вариант
zen-space-routing-status-failed = Не удалось завершить проверку. Проверьте URL, настройки и сохранённый ключ.
zen-space-routing-url-mask =
    .label = Маска URL
zen-space-routing-ai-description =
    .placeholder = Какие ссылки относятся к этому пространству?
zen-space-routing-move-up =
    .label = ↑
    .tooltiptext = Поднять правило
zen-space-routing-move-down =
    .label = ↓
    .tooltiptext = Опустить правило
