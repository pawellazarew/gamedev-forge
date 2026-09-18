# Дизайн: обвязка разработки (телеметрия, studio, тюнер, fx) для Last Samovar

Дата: 18 сентября 2026 года
Статус: план утверждён Павлом 18.09.2026, строить нечего до 27.09.2026
Аудитория: Claude Code / Codex и Павел

## 1. Статус и решения Павла

| Вопрос | Решение |
|---|---|
| План | утверждён 18.09.2026 |
| Домен для `play.*`/`tl.*` | Павел регистрирует сам до 28.09.2026; **не** `lazyfox.cc` (публичный игровой эндпоинт жжёт VPN-инфру) |
| Проверка `sendBeacon` | у семейных тестеров есть и Android, и iPhone → проверить `sendBeacon` на обеих ОС до раздачи ссылок (iOS Safari роняет `fetch` при скрытии вкладки, `quit_point` без этого не доедет) |
| Лицензия Arcada Effector | письмо автору (Антон Чуев, `t.me/tearevo`) с запросом MIT/Apache-2.0 гранта отправляет Павел |
| Дата старта работ | до 27.09.2026 ничего не строится — окно шипшипа двух игр не трогаем |

## 2. Зачем и правило «обвязка только под дату роадмапа»

Last Samovar 28.09–04.10 — семейный kill-test: узнать за одну неделю, жива ли игра, до того как в неё вложен арт и полировка. Без единой схемы событий и одного места для их чтения ответ на «дошли ли до третьей ночи» и «где бросили» придётся собирать вручную по рассказам трёх тестеров.

Правило, которым режется любая новая обвязка: **строить только то, что закрывает измеримую потребность с датой в роадмапе**. Идеи без даты (см. §13 «не строим» и §14 «доп. идеи») ждут, даже если дёшевы. Это тот же паттерн, что уже ловили раньше («мета важнее ядра» — game-agents-skills-roadmap, pavel-ship-dont-polish): встроенный редактор эффектов, дашборд аналитики без данных для показа, кастомный OTel-стек — всё это соблазн полировать инструмент вместо того, чтобы выпустить игру.

## 3. Рейтинг трёх архитектур

| Предложение | production | architecture | security | daily-ux | mean | причина одной строкой |
|---|---|---|---|---|---|---|
| **extend-forge** (выбрано) | 6.5 | 9 | 8.5 | 7 | **7.8** | Добавляет команды в CLI, которым Павел уже пользуется, переиспользует `report.mjs` и loopback-сервер с уже проверенной защитой от traversal/bind; единственные реальные дефекты — рантайм-гейт `?tune=1` и бюджет 2.5 дня на пре-тест. |
| one-studio | 6 | 5 | 8 | 8 | 6.8 | Лучший однооконный UX и верный принцип «VPS — write-only спул, дашборд тянет», но поднимает второй дашборд-стек рядом с game-forge, а сам питч «одно приложение на всё» и есть форма мета-разрастания. |
| in-game-devkit | 8.5 | 6 | 6 | 5.5 | 6.5 | Самый узкий скоуп на W1 и лучшая валидация приёма, но публикует доску kill-теста на публичном VPS без контроля доступа, хранит `who=t1..t3` по каждому родственнику и тащит читы/оверлей в тестерскую сборку. |

Итоговая архитектура — **extend-forge** с тремя правками, изменившими выбор:
- взят принцип spool/pull из one-studio (VPS только принимает, никогда не показывает);
- гейт тюнера `?tune=1` заменён на `import.meta.env.DEV` (рантайм-условие не позволяет Rollup выкинуть импорт Tweakpane из прод-бандла);
- identity тестера из in-game-devkit заменена на `crypto.randomUUID()` без `localStorage`, без читов/оверлея в сборке, которая уходит из дома.

## 4. Компоненты

| Компонент | Путь | Где работает |
|---|---|---|
| `src/telemetry.mjs` — схема + валидатор | `tools/game-forge/` | локально, CI, VPS (одна копия, три вызывающих) |
| `forge collect serve` | `tools/game-forge/src/collect.mjs` | VPS **US East 31.44.5.167**, systemd user `forge`, `127.0.0.1:8095` |
| `forge collect pull <game>` | тот же репозиторий | локальный mac → `<game>/.forge/live-<ts>/runs.jsonl` |
| `forge studio <game>` | `tools/game-forge/src/studio.mjs` | **только локально**, на существующем `src/server.mjs` |
| `forge tune` + `tunePlugin()` | `vite.config.ts` игры | только локальный Vite dev-сервер (`apply:'serve'`) |
| `forge fx bake` | `tools/game-forge/src/fx.mjs` | локально, оборачивает Arcada вне дерева репозитория |
| `forge fx serve` | тот же файл | локальный loopback `127.0.0.1:5179`, **наш** сервер, их немодифицированный клиент |
| `src/telemetry.ts` игры (~70 строк) | каждая игра | внутри игры, все сборки |
| `src/tune.ts` + панель | каждая игра | только dev-сборка, dead-code-eliminated в прод |
| `.claude/hooks/forge_feed.py` | `Me/.claude/hooks/` | локально, дописывает `~/.forge/feed/<date>.jsonl`, аргументы отредактированы |
| статичная тестерская сборка | nginx на US East, хост не `lazyfox.cc` | телефоны семьи |

Не трогаем: Newark `31.44.7.137` (боевое ядро VPN), Finland/Frankfurt (FirstByte, юрлицо РФ).

## 5. Единая схема событий `ForgeEvent`

```ts
// tools/game-forge/src/telemetry.mjs mirrors this; one validator, both sources.
export type ForgeEvent = {
  v: 1;
  game: string;              // "last-samovar"
  build: string;             // git short sha, vite define
  tune: string;              // sha1 of tuning.json — charts refuse to mix two hashes
  src: "bot" | "human";
  bot: string | null;        // "casual" | "veteran" | null
  seed: number;              // 0 for humans
  sid: string;               // crypto.randomUUID(), per session, NEVER persisted — not a device id
  n: number;                 // monotonic per session; a gap = lost beacon
  t: number;                 // seconds since session_start (humans) or logic ticks (bots)
  ev: EvName;
  p: Record<string, number | string | boolean>;  // flat, numbers/enums only, NO free-text field
};

type EvName =
  | "session_start" | "session_end"
  | "night_start" | "night_end"
  | "stoke_hold_start" | "stoke_hold_release" | "boil_over"
  | "snap_result" | "place_drag" | "petition_choice"
  | "third_night_started" | "quit_point"
  | "fps_sample" | "error";
```

Payload'ы дословно:

| Событие | Payload |
|---|---|
| `session_start` | `{ua, dpr, screen, lang, entry}` — **без** строки-отпечатка canvas/GPU |
| `night_end` | `{night, outcome, heatEnd, sec}` |
| `stoke_hold_release` | `{night, holdMs, heat, result}` |
| `snap_result` | `{night, windowMs, offsetMs, outcome}` |
| `place_drag` | `{night, item, ringFrom, ringTo, ms, ok}` |
| `petition_choice` | `{night, petition, option, msLeft}` |
| `third_night_started` | `{sec, deaths, nightsLost}` |
| `quit_point` | `{screen, night, phase, sec, idleMs}` |
| `fps_sample` | `{med, min, longFrames, windowSec}`, арифметика из `gate.ts` дословно: `GATE_MEDIAN=30`, `GATE_MIN=20`, `LONG_FRAME_MS=50`, сэмпл роняется после `GAP_MS=10000` |
| `error` | `{msg, stack1}` |

Боты пишут те же записи через `window.__FORGE__.events()`; `src/sim.mjs` кладёт их в `runs.jsonl`. Один валидатор на оба источника — схема не может разъехаться.

## 6. Доставка сборки тестерам и путь данных

- W1 — **не** черновик Яндекса. `vite build` → rsync → статика nginx на US East, хост `play.<studio>.tld`, **не** на `lazyfox.cc`.
- Телеметрия идёт на **отдельный** хост `tl.<studio>.tld`, который отдаёт только `/i`. nginx: `Access-Control-Allow-Origin: https://play.<studio>.tld` только на `/i`, `limit_req` 30/мин/IP, тело до 64 КБ, только POST.
- Защита приёма: build-токен `X-Forge-Key` (ротируется по когорте — вышедший из ротации ключ помечает свои данные мёртвыми), server-side allowlist по `Origin`, неизвестные `game`/`build`/`ev` дропаются на входе, append-only JSONL в `/var/lib/forge-collect`, **retention 90 дней**.
- systemd hardening — один в один с activity-bot: отдельный юзер, `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, `CapabilityBoundingSet=`, `ReadWritePaths=`.
- Транспорт клиента — `navigator.sendBeacon` (не `fetch`: iOS Safari роняет его при скрытии вкладки) на каждый `night_end`, на `visibilitychange→hidden`, на `pagehide`, плюс раз в 30 с.
- Identity тестера — URL-метка `?t=t1` внутри `session_start.p.label`, **никогда** не пишется в `localStorage`. Карта метка→человек живёт в заметках Павла, вне провода.
- Чтение — `forge collect pull` использует **отдельный read-токен**, не write-токен сборки. Корпус не должен висеть на открытом GET.
- Позже, для черновика Яндекса: добавить `tl.<studio>.tld` во вкладку CSP (`https`/`wss`, без порта, без IP, без пути). Разделение хостов уже верное — переезжать не придётся.

**Честный потолок:** зашитый ключ сборки аутентифицирует *сборку*, никогда не тестера. На масштабе семьи это нормально; в момент, когда ссылка уходит из семейного чата, графики перестают быть достоверными.

## 7. Вкладки forge studio

`forge studio last-samovar` — локальная страница, вкладки на существующих SVG-примитивах `report.mjs` (`lineChart`, `heatmap`). На каждом графике боты и люди — две серии из одной схемы, один код. **Постоянный баннер, когда показаны обе серии:** боты меряют достижимость, не веселье — 90% ботов и 0% людей означает «непонятно», а не «дисбаланс».

| # | Вкладка | Содержимое |
|---|---|---|
| 1 | **Kill test** (единственная, что важна 05.10) | Воронка `session_start → night_start(1) → night_end(1) → night_start(2) → third_night_started`. Строка на тестера/бота: дошёл ли до ночи 3, минуты до ночи 3, длительность сессии, экран выхода, медиана ночи (гейт 2.5–4 мин). «Воля» на удержании и «может назвать компромисс» — **вручную**, чекбокс + заметка, не автодетект |
| 2 | Quit points | гистограмма по `screen/phase/night`, медиана `idleMs` до выхода (idle = растерянность) |
| 3 | Stoke | распределение `holdMs` относительно порога кипения, доля `boil_over` по ночам, человек vs бот-ветеран |
| 4 | Snap | гистограмма `offsetMs`, доля промахов по ночам |
| 5 | Placement | тепловая карта по кольцам, `ms` перетаскивания, доля `ok:false` (провал = баг хитбокса) |
| 6 | Petitions | разбивка выборов (все выбрали одно = выбор фиктивный), `msLeft` |
| 7 | Tech | `fps_sample` по устройствам, % длинных кадров, список `error`, плюс существующие карточки `probe.json` |
| 8 | Claude | отредактированная лента активности агента |
| 9 | Effects | кросс-origin iframe на `forge fx serve` (W4) |

`forge studio --compare <runA> <runB>` закрывает существующий пробел: `report.mjs` сейчас рендерит один прогон в изоляции, без диффа.

## 8. Тюнер

- Один закоммиченный файл на игру: `tune/ui.json` — `{"hud.stokeBtn":{"type":"xy","v":[24,712]}, "color.emberFill":{"type":"color","v":"#d9531e"}, "night.lenSec":{"type":"num","v":90,"min":40,"max":180}}`. Позиции — **якорь + нормализованный оффсет**, никогда сырые px (ширина телефонов разная).
- Панель — Tweakpane (MIT, ~20 КБ), собирается из схемы, без ручного UI. Режим перетаскивания ставит `setInteractive({draggable:true})` на детей UI-контейнера; `dragend` пишет `xy`. Цвета — hex-свотчи → `setTint`.
- Сохранение: `tunePlugin()` с `apply:'serve'`, `configureServer` → `POST /__tune/save` → `fs.writeFileSync('tune/ui.json', …)` с отсортированными ключами и отступом в 2 пробела. Это уже проверенный паттерн `gateSink()`/`/__gate` из `ocean-echo/vite.config.ts`. ~50 строк; готовой библиотеки нет, не искать.
- Защита от гонки по mtime: панель отправляет `mtime`, с которым загрузилась; плагин отказывает при несовпадении — перетаскивание Павла никогда не затирает правку агента.
- **Как это видит Claude:** `git diff tune/ui.json`. Стабильный порядок ключей делает смену цвета диффом в одну строку. Без сайд-канала, без БД.
- **Исключение из прод-сборки, три слоя:** только `import.meta.env.DEV` (без запасного лаза через query-параметр); `apply:'serve'`, поэтому эндпоинта не существует ни в одной сборке; CI-проверка `grep -r tweakpane dist/ && exit 1`. Сам `tune/ui.json` едет в каждую сборку — это цифры игры, а не dev-данные.
- Бесплатные довески в той же панели, не отдельными инструментами: слайдер `Phaser.Time`, переход к ночи, дамп сериализованного состояния.

## 9. Arcada Effector

**Что это:** Arcaidia Effector, автономный 2D-редактор частичных эффектов (в духе Trapcode Particular), печёт спрайт-атласы/PNG-последовательности под игры. Автор — Anton Chuev (Tearevo), `t.me/tearevo`, `tearevo@yandex.ru`, `tearevo.com`. Zero deps, ванильный JS + Canvas2D.

**Вердикт аудита (`/Users/lazarevpavel/Downloads/Arcada Effector_1.0/server.mjs`):**

| Уровень | Находка |
|---|---|
| HIGH | строка 119 `server.listen(PORT, () => {` — без host-аргумента, Node биндит `0.0.0.0`; лог врёт про `localhost`. Любое устройство в LAN получает полный write-API |
| HIGH | ноль аутентификации и CSRF-защиты на `/api/save` (74), `/api/delete` (97), `/api/snap` (85) — любая открытая в браузере страница может стереть всю `library/*.json` |
| MED | DNS-rebinding чтение — нет проверки `Host`, `/api/list`/`/api/effect?f=` читаемы с ребайнд-атаки |
| LOW | строка 107 `if (!fp.startsWith(ROOT))` без разделителя в конце — эскейп в директории-соседи, чьё имя начинается с имени `ROOT` (подтверждено офлайн-репро); настоящие `../../` блокирует нормализация URL |
| LOW | `readBody` (36) буферизует до `80 * 1024 * 1024` на запрос без лимита конкурентности — тривиальный memory DoS |

Клиент (`js/**`) чист: ни `eval`, ни `new Function`, ни CDN, ни телеметрии, только same-origin fetch. Единственный небезопасный по данным путь — `js/ui/catalog.js:205`, `thumb` из `library/*.json` в `img.src` без проверки схемы.

**Лицензия:** ни `LICENSE`, ни SPDX, ни строки копирайта нигде — по умолчанию все права защищены; копирование в приватный репозиторий и модификация всё равно не лицензированы. Единственный сигнал владения — контакты автора во всплывающем окне «Help».

**Решение:** свой loopback-сервер + их клиент без правок, в iframe.
- **Не вендорим** — нет письменного MIT/Apache-2.0 гранта от Антона Чуева.
- **Не запускаем их `server.mjs`** — даже патч строки 119 сам по себе модификация нелицензированного исходника.
- **Что делаем:** `forge fx serve` переизобретает те же четыре эндпоинта в собственном loopback-сервере — bind `127.0.0.1`, allowlist по `Origin`/`Host`, обязательный `Content-Type: application/json`, токен сессии, кап тела 8 МБ, `fp.startsWith(ROOT + path.sep)` **плюс** повторная проверка через `fs.realpathSync`. Их немодифицированный клиент `js/**` работает на **своём** порту, кросс-origin iframe во вкладке Effects студии. Только показ — без `postMessage`, его там нет и мы не добавляем.

**Headless-цикл авторинга** (агент, без UI): разреженный JSON → `node tools/validate.mjs "library/<Name>.json"` (exit 1 при ошибках) → `node tools/simhash.mjs` для регрессии → экспорт атласа PNG + meta → `forge fx bake` копирует в `<game>/assets/fx/<effect>/`.

**Путь в Phaser:** `this.load.spritesheet('<effect>', 'assets/fx/<effect>/fx.png', { frameWidth: W, frameHeight: H })` — нативный, конвертация не нужна (формат экспорта у Arcada уже под Phaser).

## 10. Лента действий агента

`.claude/hooks/forge_feed.py` на `PreToolUse`/`PostToolUse`/`Stop` дописывает `{ts, session, tool, target, ms, ok}` — **только путь файла или голова команды, аргументы отредактированы**. Machine хранит ключи age/sops, `id_ed25519_newark_deploy`, `deploy.conf` VPN — нередактированная лента аргументов инструментов была бы постоянной поверхностью утечки. Studio тянет через `GET /api/feed?since=N` как `text/event-stream` — тот же паттерн `threading.Condition` + `Store.subscribers` + `_publish`, что уже работает в `tools/agent-chat/server.py`. Ни OTel, ни SigNoz, ни agent-activity-dashboard.

## 11. Раскладка по репозиториям

| Репозиторий | Что кладём |
|---|---|
| **gamedev-forge** (общее, переиспользуется каждой игрой) | `src/telemetry.mjs` (схема+валидатор), `src/collect.mjs`, `src/studio.mjs` + вкладки на `src/report.mjs`, `src/tune.mjs` + экспортированный `tunePlugin()`, `src/fx.mjs`, `templates/telemetry.ts`, `templates/tune.ts`, `deploy/collect/` (systemd unit, nginx-сниппет — **вне** `bin/forge.mjs`, чтобы CLI оставался dev-инструментом, не ops-инструментом), этот документ (`docs/plans/`) |
| **Каждая игра** (например `last-samovar`) | `src/telemetry.ts` (импортирует шаблон, задаёт `game`), `src/tune.ts`, `tune/ui.json` (закоммичен), `vite.config.ts` с подключённым `tunePlugin()`, `forge.config.mjs`, артефакты `.forge/` (в git только `JOURNAL.md`) |
| **Me** (личный, не git) | `.claude/hooks/forge_feed.py`, `tools/game-forge` — симлинк на `gamedev-forge` |

Захардкодить `last-samovar` первой. Обобщать на игре №2, не раньше.

## 12. Фазы

| Фаза | Даты | Агент-дни | Что делаем | Гейт/стоп-кран |
|---|---|---|---|---|
| — | до 27.09.2026 | 0 | ничего не строим — окно шипшипа двух игр не трогаем | нарушать нельзя |
| **W1** | 28.09–04.10 | 1.25 (жёсткий кап) | `telemetry.mjs`+`telemetry.ts`+`__FORGE__` адаптер (0.4); `forge collect serve` на US East + деплой двух хостов + CF rate limit + первый сквозной маячок с телефона Павла (0.5); `forge studio` v0 — только вкладка Kill test (0.35) | Павел сам играет одну полную сессию, Studio обязана показать его строки прежде, чем телефон уйдёт из дома. Сломанная телеметрия = ноль знаний |
| **W2** | с 05.10 | 1.5 | `forge collect pull` + `forge studio --compare` (0.5); вкладки Quit points/Stoke/Snap/Placement/Petitions по реальным данным W1 (0.5); `forge tune` numbers-only — Tweakpane + `/__tune/save` + `tune/ui.json` (0.5) | строим только то, что доказали данные W1 |
| **W3** | 12–18.10 | 1.0 | drag layout + цветовые свотчи в тюнере (0.5); `.claude/hooks/forge_feed.py` + вкладка Claude (0.5) | только если W1 поменял решение |
| **W4** | середина ноября, juice pass / плейтест на 5 человек | 1.3 | `forge fx serve` + вкладка Effects + `forge fx bake` (0.5); pixel-diff по `shots-<ts>/shots/*.png` (0.5); вкладка Tech — fps по устройствам + список ошибок (0.3) | — |

**Стоп-кран:** если трата W1 превышает 1.5 дня, или kill-test говорит, что игра мертва — обвязка замораживается на v0 навсегда.

## 13. Что не строим

Любой дашборд на VPS отдельно от спула; логины, аккаунты, персональные identity тестеров; Postgres, Redis, Docker; Umami / GoatCounter / Plausible / Matomo / PostHog / Countly / GameAnalytics / AppMetrica; GlitchTip / Sentry (событие `error` покрывает трёх тестеров); rrweb или любой canvas session replay; Phaser Editor 2D; feature flags (Unleash / Flagsmith); OTel / SigNoz / agent-activity-dashboard; вендоринг Arcada; шим `postMessage` внутрь исходников Arcada; универсальную мульти-игровую архитектуру плагинов; черновик Яндекса для W1; полировку дашборда — одна страница, инлайновый SVG, некрасиво — нормально; лайв-наблюдение за тестером в реальном времени.

## 14. Дополнительные идеи обвязок

| # | Идея | Стоимость | Ценность |
|---|---|---|---|
| 1 | **Детерминированный replay инпутов** — запись `{seed, inputs[]}`, воспроизведение через уже существующий `window.__FORGE__.act(input)` | 0.5 д, W2 | Самая высокая ценность на час: «она бросила на второй минуте» становится пошаговым репро. Адаптер уже есть, инфра-стоимость нулевая |
| 2 | **`forge studio --compare` / тренд по прогонам** | 0.5 д, W2 | Закрывает названный пробел (`report.mjs` рендерит один прогон в изоляции). Без него любая проверка гейта в W2–W4 слепа к медленной деградации |
| 3 | **Обратная связь в одно касание** — `toDataURL` канваса + последние 50 событий + 3 готовые причины (`boring`/`confusing`/`broke`), **без свободного текста** | 0.4 д, W4 | Даёт «почему», которого телеметрия никогда не даст, от тестеров, которые ничего не напишут сами. Только готовые варианты держат PII вне провода |
| 4 | **Pixel-diff гейт на `forge shots`** — pixelmatch против эталона | 0.5 д, W4 | Ловит тихие визуальные регрессии навсегда, в любой игре. Ловушка: нужен фиксированный seed + явный маркер кадра перед захватом, иначе случайность даёт ложные диффы |
| 5 | **`forge serve --qr`** — печатает QR ссылки на сборку + метку `?t=` в терминале | 0.1 д, W1 | Самое дешёвое в списке; убирает всё трение при раздаче ссылки на три телефона. Стоит сделать внутри бюджета W1 |
| 6 | **Тепловая карта тапов** по pointer-событиям поверх скриншота сценария | 0.3 д, W4 | Отвечает «она вообще нашла кнопку» на реальном телефоне — именно то, что потом чинит тюнер |

## 15. Риски

| Риск | Детали |
|---|---|
| Домен не выбран | блокирует деплой коллектора W1; Павел регистрирует до 28.09, иначе W1 стартует без хостов |
| `sendBeacon` на iOS не проверен | самый ценный сигнал kill-теста, `quit_point`, зависит от того, что iOS Safari реально шлёт маячок при скрытии вкладки — проверить на живом iPhone до раздачи ссылок семье |
| Честный потолок identity | ключ сборки аутентифицирует сборку, не тестера; за пределами семейного круга графикам верить нельзя |
| Лицензия Arcada не получена | без гранта инструмент навсегда вне дерева и без изменений; наш loopback-сервер — единственный способ его использовать |
| Тюнер: гонка по mtime | защищена одним полем `mtime`, но это не блокировка файла — два параллельных агента всё ещё могут написать в чужое окно между чтением и записью |
| Арифметика бюджета фаз | сумма агент-дней по фазам (0.4+0.5+0.35) + (0.5+0.5+0.5) + (0.5+0.5) + (0.5+0.5+0.3) = **5.05**, а не заявленные в синтезе «≤5 agent-days over 7 weeks» — расхождение на 0.05 дня, при планировании считать по фазовым числам, не по округлённому итогу |
| Патч сервера Arcada как «условие» безопасного локального запуска | аудит безопасности допускает локальный запуск их `server.mjs` как условие «сначала поменяй строку 119 на `server.listen(PORT, '127.0.0.1')`», но решение синтеза называет тот же патч модификацией нелицензированного исходника и поэтому запрещает запуск их сервера вообще — при разборе задачи с их сервером ориентироваться на запрет синтеза, не на условие аудита |
