# Подготовка собственного pull request в Zen

Эта инструкция описывает разработку в личном `ozio/zen` и отправку чистых изменений из публичного [`oziolabs/zen-contrib`](https://github.com/oziolabs/zen-contrib) в `zen-browser/desktop`. Проверка чужого PR и перенос кода в личный fork описаны отдельно в [PR_WORKFLOW.md](PR_WORKFLOW.md). Публикация нашего PR требует лично отредактированного пользователем текста и его разрешения на конкретную отправку. Подготовка локального черновика такого разрешения не даёт.

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

## 2. Текст, названия и практика сообщества

По информации пользователя как участника сообщества, использование LLM/агентов обычно допускается, а акцент на инструментах разработки может вызывать ненужную реакцию аудитории. Это контекст от пользователя, не цитата из официальных guidelines. В проверенных общих contribution-документах универсальный запрет не найден. Отказ по конкретному PR не превращать в придуманное общее правило или автоматический запрет на нашу подготовку.

Использовать обычные названия по функции: `feature/tab-site-search`, `fix/urlbar-backspace`, `pip-trackpad`. Не добавлять название агента в branch name, PR title/body, комментарии или commit trailers по собственной инициативе. В публичном тексте описывать проблему, реализацию и результаты проверок. Отдельного обязательного раздела про инструменты разработки у нас нет.

Не утверждать, что работа выполнена без LLM/агентов, если это неправда. На прямой вопрос отвечать точно. Если актуальный шаблон, правило проекта или конкретный reviewer требует раскрытия, соблюдать это требование и согласовать ответ с пользователем. Сохранять лицензионные notices и реальное авторство заимствованного кода. Не отправлять отдельный вопрос о разрешении использовать агента по умолчанию и не публиковать несогласованные сообщения.

## 3. Два репозитория и чистая основа PR

| Роль | Репозиторий / checkout | Правило |
|---|---|---|
| Личный ежедневный Zen | [`ozio/zen`](https://github.com/ozio/zen), `/Users/oz/Projects/Zen`, ветка `dev` | Здесь экспериментируем, ведём backlog и собираем ежедневную app. Его историю и remotes сохраняем. |
| Публичные upstream contributions | [`oziolabs/zen-contrib`](https://github.com/oziolabs/zen-contrib), `/Users/oz/Projects/zen-contrib`, ветка `dev` | `dev` сохраняется как зеркало upstream; feature branches всегда начинаются от закреплённого `upstream/dev`. Личные коммиты сюда не переносятся. |
| Источник базы | [`zen-browser/desktop`](https://github.com/zen-browser/desktop), `dev` | Фиксируем upstream SHA отдельно для каждого proposal. |

9 октября 2026 создана бесплатная организация [`oziolabs`](https://github.com/oziolabs); аккаунт пользователя имеет активную роль owner (`admin` в API). Её публичный `zen-contrib` — настоящий отдельный fork `zen-browser/desktop`, изначально только с веткой `dev`. При создании remote и чистый локальный checkout совпадают с upstream `3d7777adc270460bd475130f78e688ddd5e41765`. Это исходная отметка, не обещание, что upstream больше не менялся. Локальные receipts: `.zen-local/clean-contribution-fork/` в личном checkout.

Remotes чистого checkout: `origin = https://github.com/oziolabs/zen-contrib.git`, `upstream = https://github.com/zen-browser/desktop.git`. Remotes личного checkout сохраняются отдельно: его `origin` — `ozio/zen`.

GitHub вернул существующий `ozio/zen` при попытке создать второй fork этой сети в `ozio`, поэтому для отдельного fork используется организация. Публичный fork нельзя сделать private отдельным переключателем — [GitHub: Forks](https://docs.github.com/en/pull-requests/reference/forks). Самостоятельное Leave fork network доступно только публичным forks меньше 1 ГБ без дочерних forks; наш больше этого ограничения. [GitHub: Detaching a fork](https://docs.github.com/en/pull-requests/how-tos/work-with-forks/detaching-a-fork).

Личный репозиторий пока остаётся public. Не удалять/пересоздавать его и не терять metadata ради приватности. При будущей отдельной миграции можно рассмотреть поддержку GitHub или самостоятельный private repository с сохранённой Git-историей; это требует конкретного решения, backup и проверки, а не скрытого изменения текущего origin. Уже опубликованные данные не считать задним числом приватными.

### Обновление зеркала contribution fork

В чистом checkout проверить status/remotes; продолжать только с чистым Git-состоянием. Получить обе ветки и убедиться, что `dev` и `origin/dev` не содержат коммитов вне upstream:

```sh
# Выполнять из /Users/oz/Projects/zen-contrib.
git status --short
git remote -v
git fetch --no-tags upstream dev
git fetch --no-tags origin dev
git log --oneline upstream/dev..dev
git log --oneline upstream/dev..origin/dev
```

Оба последних вывода должны быть пустыми. Если есть лишние коммиты или divergence, остановиться и рассмотреть их; не сбрасывать ветку и не force-push. Затем выполнить только fast-forward и обычный push зеркала:

```sh
git switch dev
git merge --ff-only origin/dev
git merge --ff-only upstream/dev
git push origin dev
```

Feature branches этим не обновляются автоматически. В личном fork обновление выполняется отдельно через [UPSTREAM.md](UPSTREAM.md), с сохранением собственных изменений и merge upstream.

### Порядок переноса одной функции

1. В личном fork реализовать и покрутить функцию в Playground. Зафиксировать её поведение и список необходимых canonical изменений. Коммиты и отметки личного backlog остаются здесь.
2. В чистом checkout проверить status/remotes и получить `upstream/dev`. `origin` должен указывать только на публичный contribution fork; `upstream` — на `zen-browser/desktop`. Новую branch создать прямо от свежей выбранной upstream-базы:

```sh
# Выполнять из /Users/oz/Projects/zen-contrib, после проверки remotes/status.
git fetch upstream dev
# Сохранить полный output в локальный proposal receipt.
git rev-parse upstream/dev
git switch --no-track -c feature/tab-site-search upstream/dev
```

Не создавать её от personal `dev`, personal HEAD или предыдущей feature branch. Существующую review-ветку не переосновывать молча и не force-push: новую upstream-базу согласовать по состоянию review, либо merge с рассмотрением конфликтов.

3. Реализовать выбранное поведение поверх этой базы: перенести только необходимые hunks или переписать интеграцию под актуальный upstream. Не merge/rebase/cherry-pick весь personal `dev`. Даже выбранный личный коммит сначала проверить: в нём могут быть соседние функции, status/TODO-документация, локальные сборочные правки и зависимость от другого личного patch.
4. Просмотреть `git diff upstream/dev` и полный staged diff. В proposal оставлять только код, нужные prefs/Fluent/assets, meaningful tests и их build/manifest registration. Исключить наш backlog, инструкции, TODO/status-коммиты, playground branding, private fixtures, logs, profiles и binaries. Новые незакрытые TODO в функции решить до отправки или явно согласовать scope; существующие upstream TODO/licensing comments автоматически не удалять.
5. Теперь тестировать **этот clean proposal**, а не только личный fork. Выполнить свежий import, lint затронутых imported files, registered native tests и реальную UI-проверку. Если upstream устроен иначе, адаптировать код; pass личного SHA не переносится на proposal автоматически.
6. Закоммитить только reviewed feature/test paths с обычным содержательным сообщением. Чистота исходной базы проверяется по upstream SHA и diff; отсутствие лишнего commit title само по себе ничего не доказывает. После финального коммита повторить затронутые проверки на exact head и подготовить текст для редакции пользователя.

Создание clean fork само по себе не переносит в него все личные функции. Просьба подготовить конкретную функцию к PR разрешает её локальный перенос, исправления и тестирование; согласование публичного текста и отправка остаются отдельным финальным этапом. Исправления, найденные при clean testing/review, затем переносить обратно в личную canonical реализацию отдельным рассмотренным изменением. Подготовленный clean checkout содержит только upstream `3d7777adc270460bd475130f78e688ddd5e41765`; сам перенос поиска и native testing ещё не выполнены.

### Локальная инфраструктура тестирования вне публичного diff

Не копировать `tools/local/`, `tools/playground/`, `AGENTS.md`, эту инструкцию или personal mozconfig в public branch. Проверенный внешний control entrypoint можно вызывать с отдельным root и общими **только toolchain inputs**:

```sh
python3.11 /Users/oz/Projects/Zen/tools/local/dev.py \
  --root /Users/oz/Projects/zen-contrib \
  --toolchains /Users/oz/Projects/Zen/.zen-local/toolchains doctor --json
```

Такой doctor реально прошёл для clean SHA `3d7777adc270460bd475130f78e688ddd5e41765`: Node 22, Python 3.11, Rust 1.95.0 выбраны, Git чистый; engine и Playground ещё не подготовлены. `doctor` не является native build/test. `.zen-local/`, `.unlazy/` и машинный `AGENTS.md` исключены только через локальный `.git/info/exclude`; это не изменение upstream `.gitignore` и не часть PR. Машинный `AGENTS.md` содержит указатель на эту инструкцию и правила clean checkout; не force-add его в публичную ветку.

При дальнейшем bootstrap/build/package тем же entrypoint всегда передавать тот же `--root`/`--toolchains` **до subcommand**. State, profiles, cache, evidence и artifacts принадлежат clean root. Не заимствовать личный профиль или primary Playground state и не копировать их в новый checkout. Compiled local testing options и test-capable mozconfig проверять отдельно; они не должны незаметно попасть в публичный source diff.

До запуска проверить диск: холодная engine/native сборка и отдельные objects/packages требуют дополнительного места. Для тестирования можно использовать managed launch `run playground --sha FULL_SHA --in-artifact`, чтобы не перезаписывать уже существующую `/Applications/Zen Playground.app`. Выбрать свободный loopback Marionette port через `--port`, доказать binary/profile/PID/SHA и настроить chrome bridge на **clean root**. При необходимости dedicated FoxPilot сначала штатно остановить другой verified Playground, не давая двум test instances владеть одним broker. Основной браузер не закрывать ради clean PR проверки. Native интеграции, которым требуется Applications location, проверять отдельно по guarded identity/deployment rules.

Canonical исходные изменения поиска в личном fork, которые надо рассмотреть для переноса:

- [UrlbarInput patch](src/browser/components/urlbar/content/UrlbarInput-mjs.patch) — сопоставление движков, native search mode и клавиатура.
- [urlbar CSS patch](src/browser/themes/shared/urlbar-css.patch) — visual mode/hint; выделить только относящиеся к поиску hunks.
- [Локальные unit-тесты](tests/urlbar/site-search.test.mjs) — вспомогательное покрытие; native suite добавляется в clean upstream layout.

Редактировать canonical `src/`, `prefs/`, patches; изменения только в `engine/` исчезнут при импорте. Просмотреть экспорт, импортировать и проверить итоговые Firefox-файлы. Предупреждение Surfer о количестве patches не доказывает их актуальность. [Code structure documentation](https://docs.zen-browser.app/contribute/desktop/code-structure-and-prefs) содержит старые пути; актуальное дерево и ближайшая реализация имеют приоритет.

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

1. Подготовить локальный readable diff, exact head/base SHA, результаты проверок и title/body draft. Отдельно обозначить реальные blockers и непроверенные ОС. Проверить, что head принадлежит clean contribution fork и diff не содержит personal history/status work. Не открывать PR заранее, даже draft.
2. Пользователь лично редактирует title/body — в файле или сообщением. Сам агент может дать исходный черновик, объяснить требования и предложить правки. Итоговый публичный текст должен содержать пользовательскую редакцию и правдивые сведения.
3. Показать финальные title/body и scope. Зафиксировать exact head/base, revision и SHA-256 одобренных текстовых файлов в `.zen-local/`. Получить явное разрешение на создание конкретного PR. Одобрение идеи функции или файла-инструкции не является разрешением отправки. Сверить актуальные явные правила проекта и обязательные поля шаблона; следовать разделу 2 без придуманного дополнительного approval flow.
4. Создать PR только с одобренным текстом. Использовать отдельный approved body-файл с настоящими переводами строк; не собирать Markdown через shell interpolation. В установленном GitHub CLI `gh pr create --head OWNER:BRANCH` не поддерживает organization owner: это прямо указано в `gh pr create --help` и [CLI issue 10093](https://github.com/cli/cli/issues/10093). Для нашего `oziolabs` использовать [Create a pull request API](https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request).

Подготовить локальный JSON request программно из одобренных UTF-8 title/body, без изменения текста. Его поля: `title`, `body`, `head = oziolabs:FEATURE_BRANCH`, `head_repo = zen-contrib`, `base = dev`; `draft = true` только при согласованном draft-режиме. Сохранить digest request рядом с approval receipt. Непосредственно перед отправкой сверить remote head SHA, upstream base и весь request с одобренными данными. Публикация feature branch в `origin` также выполняется только в рамках разрешённой отправки.

Команда после этих проверок:

```sh
# Выполнять только после шагов 1–3 и разрешения публикации head-ветки.
gh api --method POST repos/zen-browser/desktop/pulls \
  -H 'Accept: application/vnd.github+json' \
  --input "$ZEN_APPROVED_PR_REQUEST"
```

`ZEN_APPROVED_PR_REQUEST` — путь к проверенному локальному JSON, не публичный внутренний документ с заметками. Владелец head — `oziolabs`, репозиторий — `zen-contrib`; сверить их в GitHub. Draft не обходит требование согласования. После неизвестного результата создания сначала найти PR по `head = oziolabs:FEATURE_BRANCH` и `base = dev` и проверить его, не отправлять дубликат.

5. Прочитать созданный PR через GitHub, сверить репозиторий/base/head, title и body с одобренными. Сразу прикрепить его к текущей задаче через `mcp__codex_app__attach_artifact` с URL; дать пользователю ссылку.
6. Любое изменение текста PR требует новой согласованной редакции. Существенное изменение code head/base после согласования требует повторного review и обновлённых proofs. Review/comments можно читать; публичные ответы отправлять только при явном разрешении с согласованным содержанием. Merge в upstream агент самостоятельно не выполняет.

## 8. Что писать в PR

Наша рекомендуемая структура, которую пользователь вправе отредактировать:

- Короткий title с конкретным результатом, без выдуманной привязки к bug.
- Description: проблема, конкретный триггер и новое поведение. Для поиска — источник engines, приоритет, вход/выход из режима, сохранение native submission/default search.
- Scope/implementation: только детали, нужные reviewer; назвать intentional limits и регрессии, которые должны сохраняться.
- Testing: точные commands, результаты, source/head, OS/архитектура и реальные UI-сценарии. Разделить unit/mock, native harness и ручные проверки. Не считать screenshot или чужой CI собственной проверкой.
- Дополнительные обязательные сведения: только те, которые требует актуальный project template/rule/reviewer; ответы должны быть точными. Отдельное упоминание инструментов не добавлять по умолчанию.
- Issue/demo: только действительная ссылка; небольшой ролик или synthetic screenshot без личных вкладок и данных.

Пока подготовлен [локальный draft по Tab site search](docs/upstream-site-search-pr-draft.md). Он не готов для публикации: требуется чистый feature diff, окончательный scope, native тесты и пользовательская редакция текста. Создание этих инструкций не выполняет feature-testing campaign и не создаёт PR.
