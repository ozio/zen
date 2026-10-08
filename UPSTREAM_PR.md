# Подготовка собственного pull request в Zen

Эта инструкция описывает вклад из `ozio/zen` в `zen-browser/desktop`. Проверка чужого PR и перенос кода в личный fork описаны отдельно в [PR_WORKFLOW.md](PR_WORKFLOW.md). Публикация нашего PR требует лично отредактированного пользователем текста и его разрешения на конкретную отправку. Подготовка локального черновика такого разрешения не даёт.

Правила проверены **9 октября 2026, Asia/Tokyo**, по upstream `dev` на коммите [`aa8f545346c1725bcd598c7ec86188793d423a67`](https://github.com/zen-browser/desktop/commit/aa8f545346c1725bcd598c7ec86188793d423a67). Метаданные default branch, полные деревья основного и организационного репозиториев, исходники правил, CI и rulesets сохранены локально в `.zen-local/workflow-instructions/`. Перед реальной отправкой перечитать актуальные guidelines, templates, workflow, rulesets и состояние выбранной upstream-базы: этот документ не замораживает правила проекта.

## 1. Что установлено по источникам

| Предмет | Проверенный результат |
|---|---|
| Ветка назначения | `dev` — default/main branch. [`docs/contribute.md`](https://github.com/zen-browser/desktop/blob/aa8f545346c1725bcd598c7ec86188793d423a67/docs/contribute.md). |
| Обсуждение новых функций | README направляет feature requests в Discussions, bugs — в Issues. Это канал обсуждения идеи; обязательное наличие issue у каждого PR в прочитанных правилах не установлено. [`README`](https://github.com/zen-browser/desktop/blob/aa8f545346c1725bcd598c7ec86188793d423a67/README.md). |
| Подготовка среды | Contribution guide требует прочитать Building Guidelines и Code of Conduct. Актуальная страница: [Building Zen](https://docs.zen-browser.app/contribute/desktop/building). Для личной app использовать наш guarded workflow. |
| Общение | Применяется [Code of Conduct](https://github.com/zen-browser/desktop/blob/aa8f545346c1725bcd598c7ec86188793d423a67/CODE_OF_CONDUCT.md). Не публиковать чужие приватные сведения; отвечать на review по существу. |
| Шаблон PR | В полном дереве этого commit нет `CONTRIBUTING.md` или `PULL_REQUEST_TEMPLATE`; PR template также не найден в полном дереве [`zen-browser/.github`](https://github.com/zen-browser/.github/tree/4e4d6332c4b6e32f7696372a3d51b970acaf6cf0). Собственная структура ниже — наша рекомендация. |
| Сообщения коммитов | [`.formal-git/template`](https://github.com/zen-browser/desktop/blob/aa8f545346c1725bcd598c7ec86188793d423a67/.formal-git/template) задаёт `{bugId}: {message}`. Это не обнаруженный обязательный PR-title validator. При отсутствии issue допустимость `no-bug: ...` сверить с текущей практикой; не выдумывать номер. |
| Code owner | [`CODEOWNERS`](https://github.com/zen-browser/desktop/blob/aa8f545346c1725bcd598c7ec86188793d423a67/CODEOWNERS) указывает `@mr-cheffy` для всех файлов. Это не доказательство требования конкретного числа approvals. |
| Лицензия | `package.json` указывает MPL-2.0. Сохранять существующие headers и происхождение заимствований; новый header выбирать по правилам соответствующего файла/набора тестов. [`package.json`](https://github.com/zen-browser/desktop/blob/aa8f545346c1725bcd598c7ec86188793d423a67/package.json). |

DCO, CLA, обязательный `Signed-off-by`, минимальный процент coverage, запрет всех LLM и обязательное число собственных тестов в прочитанных contribution-материалах не найдены. Это ограниченный результат проверки источников, а не обещание отсутствия дополнительных требований при review или в будущем PR UI.

## 2. Происхождение кода и допустимость агентской реализации

В закрытом PR [#15176: Arc-like corner snap + trackpad swipe](https://github.com/zen-browser/desktop/pull/15176) автор указал Cursor. Мейнтейнер `mr-cheffy` [отказал в приёме](https://github.com/zen-browser/desktop/pull/15176#issuecomment-5470516644) кода, сгенерированного Cursor, сославшись на legal reasons. Публичного пояснения правового основания в прочитанных комментариях нет.

Это подтверждённое решение по конкретному PR. В текущих общих guidelines универсальный запрет всех AI-инструментов не найден; одновременно этот отказ не позволяет считать нашу агентскую реализацию заведомо приемлемой. Название ruleset с Copilot также не доказывает допустимость сгенерированных изменений.

Наш поиск реализован с участием Codex/агента. Перед отправкой нужен честный ответ мейнтейнера о допустимом формате такого вклада либо реализация, действительно соответствующая уточнённым правилам. Можно подготовить локальный вопрос с раскрытием происхождения; отправлять его в Discussions, issue, PR или комментарий без разрешения пользователя нельзя. Редактура PR пользователем, переименование переменных, удаление AI credits или поверхностный рефакторинг не превращают сгенерированный код в самостоятельно написанный человеком. Не скрывать это обстоятельство и не создавать пробный PR ради проверки реакции.

Это открытый вопрос готовности **публикации**, не запрет готовить код, инструкции, тесты и локальные черновики в нашем fork.

## 3. Как сделать пригодный для upstream diff

Сначала согласовать конкретное поведение и границы: триггер, приоритет движков, Tab/Escape/Backspace, обычная навигация, видимость и доступность. Проверить похожие issues, discussions и открытые PR. Для крупной новой функции разумно согласовать направление до сложной работы; обязательность такого согласования для любого небольшого PR в прочитанных документах не установлена.

Ежедневная ветка `dev` содержит PiP, перевод, Playground, локальную упаковку и другие личные изменения. PR с её полной историей перенесёт лишний код. Когда пользователь разрешит подготовку конкретного upstream PR, собрать минимальный proposal в отдельном worktree от закреплённого текущего `upstream/dev`; для публикуемого head использовать узкую ветку `codex/...` в нашем fork. Это специальный путь для запрошенного вклада, обычная работа в `dev` сохраняется. Сейчас proposal-ветка не создаётся.

Переносить выбранные hunks/коммиты с review каждого diff, а не весь personal fork. Не включать локальные инструкции установки, Apple/Playground branding, профили, binaries, machine-local evidence и несвязанные особенности. Не переписывать опубликованную историю `dev`, не делать force push. Подготовка proposal не обновляет ежедневную app.

Для поиска текущие canonical файлы:

- [UrlbarInput patch](src/browser/components/urlbar/content/UrlbarInput-mjs.patch) — сопоставление движков, native search mode и клавиатура.
- [urlbar CSS patch](src/browser/themes/shared/urlbar-css.patch) — visual mode/hint. В этом patch есть другие personal hunks: для PR выделить только относящиеся к поиску.
- [Локальные unit-тесты](tests/urlbar/site-search.test.mjs) — вспомогательное покрытие. Для upstream добавить native suite по следующему разделу.

Редактировать canonical `src/`, `prefs/`, patches; изменения только в `engine/` исчезнут при импорте. Просмотреть экспорт, импортировать и проверить итоговые Firefox-файлы, особенно если patch уже был применён раньше. Предупреждение Surfer о количестве patches не доказывает их актуальность. [Code structure documentation](https://docs.zen-browser.app/contribute/desktop/code-structure-and-prefs) содержит некоторые старые пути; актуальное дерево и ближайшая реализация имеют приоритет. Например, нынешние Spaces находятся в `src/zen/spaces/`.

## 4. Стиль и качество реализации

Фактические форматные требования берутся из [`.editorconfig`](https://github.com/zen-browser/desktop/blob/aa8f545346c1725bcd598c7ec86188793d423a67/.editorconfig): два пробела, LF, UTF-8, финальная новая строка, без trailing whitespace вне Markdown. Использовать существующий formatter `@zen-browser/prettier` и [Mozilla/Zen ESLint configuration](https://github.com/zen-browser/desktop/blob/aa8f545346c1725bcd598c7ec86188793d423a67/eslint.config.mjs), не вводить отдельные правила форматирования. Конфигурация ESLint использует generated engine files, поэтому запуск до подготовки engine может не работать.

Следующие требования — наш стандарт review для качественной отправки, а не найденный upstream checklist:

- Использовать SearchService/engineStore и native search mode/submission вместо отдельного списка сайтов и ручной сборки search URL. Не менять default engine при временном выборе.
- Держать изменения в подходящем UI-классе/модуле. Не вводить platform-specific ветвление для обычной urlbar-логики без причины, глобальные monkey patches или новый dependency ради небольшой функции.
- Снимать observers/listeners при отключении элемента, не обращаться к уничтоженному окну, исключать stale async callbacks и гонки favicon/engine selection. Не делать сетевые запросы в обработчике каждой клавиши.
- Сохранять поведение обычных URLs, результатов autocomplete, native shortcuts, IME, выделения/редактирования текста и модифицированных клавиш. Состояние search mode не должно утекать между вкладками и окнами.
- Текст пользовательского интерфейса локализовать через существующий Fluent-механизм; labels, кнопка выхода и focus должны быть доступными с клавиатуры и assistive technology. Проверить темы, масштаб и compact/single-toolbar layouts.
- Тесты используют синтетические движки, endpoints и данные; без личной истории, external login, приватных URL и real-vault значений. Если нужен новый network call, объяснить источник данных и необходимость.
- Сохранять MPL notices производственных файлов и лицензии переносимого кода. Native test-файлы рядом используют в том числе Public Domain/CC0 header; не заменять автоматически все их headers на MPL.

[`pre-commit`](https://github.com/zen-browser/desktop/blob/aa8f545346c1725bcd598c7ec86188793d423a67/.husky/pre-commit) вызывает lint-staged, но inspected mapping в `package.json` содержит пустую команду. Успешный коммит сам по себе не доказывает lint или запуск тестов. License-check `npm run lc` существует; читать его результат и scope, не считать его обязательным PR status без соответствующего правила.

## 5. Какие проверки нужны

Текущий [PR workflow](https://github.com/zen-browser/desktop/blob/aa8f545346c1725bcd598c7ec86188793d423a67/.github/workflows/pr-test.yml) запускается для PR в `dev`: Ubuntu, locked dependencies, download/bootstrap/import и `npm run lint`. **В этом workflow нет команды native build, browser-chrome tests или матрицы macOS/Windows/Linux.** Зелёный CI не подтверждает поведение браузера на этих ОС.

Наш минимальный набор зависит от diff:

| Изменение | Проверки перед отправкой |
|---|---|
| Urlbar JS/CSS и клавиатура | Import, upstream lint, lint затронутых imported Firefox-файлов, зарегистрированные browser-chrome regressions, packaged/native UI smoke. |
| Чистая функция сопоставления | Unit-тесты полезны дополнительно; если извлечён настоящий отдельный модуль и подходит xpcshell, зарегистрировать suite. Не выбирать harness, которого ещё нет. |
| C++ / native события | Полный native build, соответствующие gtests/другие native tests и проверка событий на реальной целевой ОС. |
| Prefs / новые source/build-файлы | Свежий import, проверка регистрации и generated outputs, требуемая полная сборка. |
| UI-тексты / визуальная часть | Fluent, доступность, темы/layouts/scale и реальная UI-проверка. Screenshot не заменяет keyboard assertions. |

Это наши gates для отправляемого изменения. Проект не опубликовал в прочитанных источниках универсальное правило «N тестов на PR» или требуемый coverage %. Проверять существенные наблюдаемые сценарии и регрессии, не только переписывать implementation в assertions.

На подготовленном checkout с выбранными repository tools:

```sh
npm run lint
npm test -- urlbar
# При более широком влиянии, после scoped suite:
npm test -- all
# Только при relevant native code и test-capable build:
npm run test:gtest
```

`npm test -- urlbar` существует: [runner](https://github.com/zen-browser/desktop/blob/aa8f545346c1725bcd598c7ec86188793d423a67/scripts/run_tests.py) передаёт `zen/tests/urlbar` в `mach test`. [moz.build](https://github.com/zen-browser/desktop/blob/aa8f545346c1725bcd598c7ec86188793d423a67/src/zen/tests/moz.build) регистрирует `urlbar/browser.toml`. Новые тесты добавить в [manifest](https://github.com/zen-browser/desktop/blob/aa8f545346c1725bcd598c7ec86188793d423a67/src/zen/tests/urlbar/browser.toml): наличия `.js` на диске недостаточно.

Для поисковой функции основной кандидат — `src/zen/tests/urlbar/browser_site_search.js` с записью в `browser.toml`. Пользоваться `UrlbarTestUtils`, `BrowserTestUtils`, `EventUtils.synthesizeKey`, `SpecialPowers` и cleanup functions по [существующему floating-urlbar тесту](https://github.com/zen-browser/desktop/blob/aa8f545346c1725bcd598c7ec86188793d423a67/src/zen/tests/urlbar/browser_floating_urlbar.js). Дожидаться реального popup/navigation/state через promises, а не произвольные sleep. После каждого теста удалять synthetic engines/tabs, восстанавливать default engine и prefs.

`npm run lint` сейчас вызывает `mach lint zen`; для Firefox urlbar patch этого может быть недостаточно. Дополнительно линтить **импортированную реализацию**, например из `engine`: `./mach lint browser/components/urlbar/content/UrlbarInput.mjs browser/themes/shared/urlbar.css`, сверив пути с текущим engine и `mach lint --help`. Линт текста `.patch` не равен линту изменённого JS.

Сначала проверить effective mozconfig и наличие test harness. Release-конфигурация с `--disable-tests` не даёт нужной test-capable сборки. Статус «не запускалось» или конкретная ошибка обязательны, если тестовая сборка не подготовлена. Все прямые npm/mach команды используют те же выбранные Python/Node/Rust, что wrapper; на этом Mac использовать проверенный `.zen-local/env.sh`, не менять global defaults. После переноса на новую upstream-базу повторить проверки на **финальном proposal head**, не переносить pass от личного source SHA автоматически.

Для №7 подробная матрица и уже имеющееся покрытие — в [локальном PR-черновике](docs/upstream-site-search-pr-draft.md). macOS-проверка не устанавливает поддержку Windows/Linux. Для общей функции желательно получить их native keyboard/layout smoke до утверждения о кроссплатформенной работоспособности; если их нет, прямо написать это в согласованном тексте.

## 6. GitHub review и требования ветки

Проверены два active rulesets. [Default branch rules, 712194](https://github.com/zen-browser/desktop/rules/712194) требуют PR и запрещают удаление/non-fast-forward default branch. В API на дату проверки: `required_approving_review_count = 0`, `require_code_owner_review = false`, `required_review_thread_resolution = false`, `require_last_push_approval = false`, `require_extra_approval_for_unattributed_changes = true`; merge/squash/rebase разрешены. Это конфигурация GitHub, а не обещание merge без содержательного review.

[Code Quality Copilot review, 19362147](https://github.com/zen-browser/desktop/rules/19362147) возвращает пустой `rules` array. В inspected rulesets обязательный `required_status_checks` не обнаружен. Не выводить обязательность конкретного check из названия ruleset; реальное состояние checks/mergeability перечитать перед отправкой. Зелёный lint и permissive counter не заменяют решение мейнтейнера.

В review предоставлять объяснение поведения и тестовую регрессию на каждый существенный дефект; при согласованной правке повторять затронутые тесты. Не обещать изменения, которых нет в финальном diff. Авторская автоматизация не разрешает агенту самостоятельно отправлять комментарии, спорить от имени пользователя или принимать решение о merge.

## 7. Порядок согласования и публикации

1. Подготовить локальный readable diff, exact head/base SHA, результаты проверок и title/body draft. Отдельно обозначить blockers, происхождение кода и непроверенные ОС. Не открывать PR заранее, даже draft.
2. Пользователь лично редактирует title/body — в файле или сообщением. Сам агент может дать исходный черновик, объяснить требования и предложить правки. Итоговый публичный текст должен содержать пользовательскую редакцию и правдивые сведения.
3. Показать финальные title/body и scope. Зафиксировать exact head/base, revision и SHA-256 одобренных текстовых файлов в `.zen-local/`. Получить явное разрешение на создание конкретного PR. Одобрение идеи функции или файла-инструкции не является разрешением отправки. Сначала закрыть вопрос допустимости агентского кода.
4. Создать PR только с одобренным текстом. Использовать отдельный approved body-файл с настоящими переводами строк; не собирать Markdown через shell interpolation. Если пользователь согласовал draft-режим, команда имеет такую форму:

```sh
# Выполнять только после шагов 1–3 и разрешения публикации head-ветки.
gh pr create --repo zen-browser/desktop --base dev \
  --head "ozio:$ZEN_PR_BRANCH" --title "$ZEN_APPROVED_PR_TITLE" \
  --body-file "$ZEN_APPROVED_PR_BODY" --draft
```

Имена переменных и их значения разрешаются по согласованным локальным данным; `--draft` не обходит требование согласования. Не передавать весь внутренний документ с заметками как body. После неизвестного результата создания сначала найти уже созданный PR и проверить его, не отправлять дубликат.

5. Прочитать созданный PR через GitHub, сверить репозиторий/base/head, title и body с одобренными. Сразу прикрепить его к текущей задаче через `mcp__codex_app__attach_artifact` с URL; дать пользователю ссылку.
6. Любое изменение текста PR требует новой согласованной редакции. Существенное изменение code head/base после согласования требует повторного review и обновлённых proofs. Review/comments можно читать; публичные ответы отправлять только при явном разрешении с согласованным содержанием. Merge в upstream агент самостоятельно не выполняет.

## 8. Что писать в PR

Наша рекомендуемая структура, которую пользователь вправе отредактировать:

- Короткий title с конкретным результатом, без выдуманной привязки к bug.
- Description: проблема, конкретный триггер и новое поведение. Для поиска — источник engines, приоритет, вход/выход из режима, сохранение native submission/default search.
- Scope/implementation: только детали, нужные reviewer; назвать intentional limits и регрессии, которые должны сохраняться.
- Testing: точные commands, результаты, source/head, OS/архитектура и реальные UI-сценарии. Разделить unit/mock, native harness и ручные проверки. Не считать screenshot или чужой CI собственной проверкой.
- Provenance: честно описать AI-assisted/generated часть и результат согласования её допустимости. Не обещать гарантий, которых не давали мейнтейнеры.
- Issue/demo: только действительная ссылка; небольшой ролик или synthetic screenshot без личных вкладок и данных.

Пока подготовлен [локальный draft по Tab site search](docs/upstream-site-search-pr-draft.md). Он не готов для публикации: требуется согласование provenance, окончательного scope, native тестов и пользовательского текста. Создание этих инструкций не выполняет feature-testing campaign и не создаёт PR.
