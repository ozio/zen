# Tab site search: локальный черновик для upstream

**Статус: локальный рабочий текст, не разрешён для публикации.** Пользователь должен лично отредактировать title/body и согласовать конкретную отправку по [UPSTREAM_PR.md](../UPSTREAM_PR.md). Этот файл содержит также внутренние заметки; целиком передавать его в `--body-file` нельзя.

Исходная личная реализация: `18d75652b931bc5e0d7cc850638fe8b15ed85307`. Исследованная upstream-база: `aa8f545346c1725bcd598c7ec86188793d423a67`. Чистый proposal head ещё не создан и на этой базе не протестирован.

## Готовность и окончательный scope

| Вопрос | Сейчас |
|---|---|
| Источник движков | Настроенные Zen/Firefox search engines через native engineStore/SearchService: built-in и добавленные пользователем. Это не список произвольных сайтов. |
| Триггер нашей реализации | Имя/alias, затем префикс имени или alias; exact имеет приоритет, дальше используется порядок настроек. Сравнение нормализовано по Unicode и регистру. |
| Поиск по введённому домену | Последнее пожелание пользователя: совпадение адреса с доменом настроенного search engine. **В нашей реализации это ещё не добавлено.** Native Firefox Tab-to-Search может работать отдельно; не приписывать его нашему matcher. Нужен выбор scope перед PR. |
| Вход/выход | Tab включает временный search mode; Escape выходит, не закрывая Command T; Backspace выходит при пустом запросе, включая состояние после удаления текста. |
| Покрытие личной версии | 10 unit/mock-тестов сопоставления/клавиатуры; 7 групп native Playground-сценариев и отдельная проверка создания engine через Settings на macOS ARM64. |
| Штатные upstream tests | Новый browser-chrome test для функции ещё не написан/не зарегистрирован. Новый прогон lint и тестов чистого proposal не выполнен. |
| Windows/Linux | Native runtime не проверялся. |
| Допустимость агентского кода | Не согласована с мейнтейнером; учитывать конкретный [отказ по Cursor в #15176](https://github.com/zen-browser/desktop/pull/15176#issuecomment-5470516644). |
| Публичные действия | PR/discussion/comment для этой подготовки не создавались. |

Общие 53 focused tests в личном release-отчёте включают PiP и другие проверки. В PR про поиск нельзя представлять их как 53 search tests. Подробности уже пройденных native проверок и package identity находятся в [личном отчёте](auto-pip-and-site-search.md); приватные evidence files в upstream не добавлять.

## Предлагаемый title

```text
no-bug: Choose configured search engines with Tab in the floating URL bar
```

`no-bug` — предложение по наблюдаемой практике, не обнаруженное обязательное требование к PR title. Если появится реальный issue, изменить связь только после проверки его предмета.

## Предлагаемый body для редакции пользователя

### Description

Zen's floating URL bar can enter a temporary search mode after the user types the name, shortcut, or name/shortcut prefix of a configured search engine and presses Tab. This makes a configured search destination available directly from Command T while retaining Firefox's native search submission.

The candidate is selected from the existing search-engine settings. Exact name/alias matches take priority over prefixes; ambiguous prefixes follow the configured order. Engines hidden from the search shortcuts are excluded. The hint uses the engine's name and icon, with a search-icon fallback.

Tab consumes the engine trigger and starts an empty query. Enter submits through the selected engine without changing the default engine. Escape exits the mode and keeps the floating URL bar open. Backspace exits only when the query is empty, including after deleting a previously entered query. An empty-mode exit restores its trigger; an existing query is retained when leaving with Escape.

Ordinary URL navigation, default search, modified keys, IME composition, and autocomplete result navigation must retain their native handling. The match uses the user's typed text rather than an address autofill completion.

### Scope

This draft describes the current name/alias implementation in our personal fork. Matching a typed address against the domains of configured search engines is a separate requested addition and has not been implemented in this version. The final contribution scope and clean upstream-based diff still need review.

### Testing

Existing evidence for personal-fork source `18d75652b931bc5e0d7cc850638fe8b15ed85307`:

- 10 Node/vm tests pass for matching priority, normalization, hidden/URL inputs, Tab, Escape, empty-query Backspace, native-key handling, and tab state isolation. Platform boundaries are mocked.
- 7 native scenario groups passed in the signed standalone macOS ARM64 Playground: hint/icon display; Escape; Backspace immediately after Tab; deletion followed by Backspace; encoded search submission; normal default search/new Command T; and ordinary URL navigation.
- A synthetic engine was added through native Settings using a shortcut and `%s` search URL; submission was checked and the engine removed afterward.

Upstream browser-chrome regressions have not yet been added or run. The clean proposal head and its current-upstream lint have not yet been validated. Windows and Linux native runtime have not been tested. These existing personal-fork results must not be substituted for verification of the final PR head.

### Provenance

The implementation was generated/developed with assistance from a Codex agent. Its eligibility for upstream submission has not yet been confirmed with the maintainers. This local draft is awaiting that clarification and the contributor's edited publication text.

## План тестов перед отправкой

Это работа для следующего этапа, а не список уже выполненных тестов. Основной native файл: `src/zen/tests/urlbar/browser_site_search.js`, зарегистрированный в `browser.toml`. Проверять настоящие состояния input/searchMode/navigation и корректно очищать engines, default, prefs, tabs и listeners. Использовать loopback/synthetic sites.

| Группа | Существенные сценарии |
|---|---|
| Engines и priority | Built-in и custom; exact против prefix; конфликт имени/alias; несколько prefixes; порядок настроек; hidden engine; неизвестный/пустой ввод; Unicode/case; добавление, удаление и переименование без перезапуска. |
| Tab и submission | Настоящая клавиша Tab, один mode chip, правильный icon/fallback; native `%s`/submission, пробелы, `&`, японский текст; Enter ведёт в нужный engine, default не меняется. |
| Выход из режима | Escape с пустым/непустым query; Backspace сразу после Tab; удалить весь query и нажать Backspace; Backspace при непустом query и caret в начале; selection/Delete/cut; Command T остаётся открыт, обычный ввод работает. |
| Native ввод | Shift/modified Tab, modifiers для Enter, IME composition, текущий autocomplete selection/result menu, обычная навигация URL, built-in `@` aliases и Firefox Tab-to-Search; hint не перехватывает неподходящий ввод. |
| Autofill и lifecycle | Typed prefix против отображаемого autocomplete; blur/reopen; close-token; переход вкладки/окна/Space; отмена и изменение engine во время async favicon; отключение элемента и cleanup observers. |
| UI и доступность | Floating Command T и обычная строка; single-toolbar/multiple layouts, compact mode; focus, keyboard exit button, accessible name, Fluent, light/dark/high contrast, масштаб и длинные имена. |
| ОС и persistence | macOS Cmd и реальный поиск; Windows/Linux Ctrl, layouts и IME на соответствующих ОС; сохранённые engines после штатного restart того же чистого профиля. До выполнения помечать not run. |

Если в окончательный scope включается доменное сопоставление, сначала зафиксировать правила canonical host и приоритета. Новые regression cases: домен только существующего visible search engine; scheme/`www`/порт/trailing dot/IDN; subdomain и несколько engines одного домена; отсутствие false match `google.com.evil` для `google.com`; обычные URL с path/query не должны незаметно стать другим поиском. Не выводить engine из любого посещённого сайта и не использовать наивный suffix comparison.

Последовательность завершения:

1. Решить scope текущего name/alias поиска и желаемого domain trigger, а также допустимость AI provenance.
2. Подготовить минимальный clean proposal от актуального upstream `dev`, без других personal hunks.
3. Добавить meaningful browser-chrome regressions; свежий import, upstream lint плюс affected Firefox lint и `npm test -- urlbar`; broader tests только по влиянию diff.
4. Проверить native UI финального head в Playground; зафиксировать OS/SHA/commands и честные ограничения. Сохранить synthetic screenshot/ролик для review.
5. Обновить этот черновик по фактическим результатам. Пользователь лично редактирует окончательные title/body; после согласования exact text и head/base и разрешения можно создать PR.

Ни domain matching, ни upstream test suite, ни публикация не выполнялись в рамках подготовки двух инструкций.
