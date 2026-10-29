# gamedev-forge

[English](README.md) | **Русский**

Локальные инструменты для проверки веб-игр и создания игровых ассетов в Blender.
Короткий цикл обратной связи: запустить игру, посмотреть кадры, измерить,
изменить одну вещь и проверить заново.

- **[game-forge](game-forge/README.ru.md)** — браузерные сценарии, скриншоты,
  проверка бюджетов производительности и симуляция баланса через адаптер.
- **[blender-kit](blender-kit/README.ru.md)** — превью моделей и запекание 3D
  в прозрачные атласы спрайтов с JSON для Phaser.
- **[Помощники для агентов](claude/)** — необязательные скиллы и промпты ревью
  для Claude Code. CLI работают без ИИ-сервисов и API-ключей.

Инструменты находятся на ранней стадии разработки. Основные инструкции
доступны на английском и русском. Комментарии в коде, сообщения CLI и
помощники агентов — на английском; исторические заметки и журналы — на русском.

## Попробовать game-forge

Нужны **Node.js 22+**, npm и macOS или Linux. CI работает на Ubuntu с Node.js 22.
Windows пока не проверен; для shell-обёрток используйте WSL.

```bash
git clone https://github.com/pawellazarew/gamedev-forge.git
cd gamedev-forge/game-forge
npm ci
npx playwright-core install chromium
node bin/forge.mjs doctor
node bin/forge.mjs play ../fixtures/tiny-game
node bin/forge.mjs all ../fixtures/tiny-game --runs 10
```

На Linux могут понадобиться системные библиотеки браузера:
`npx playwright-core install --with-deps chromium`.

Результаты сохраняются в `fixtures/tiny-game/.forge/`; симлинки `latest-*`
ведут на последние прогоны. Команда `report` выводит путь к HTML-отчёту.
Встроенная тестовая игра не требует движка или сборки.

## Подключить свою игру

Из каталога `game-forge/`:

```bash
node bin/forge.mjs init /absolute/path/to/game
node bin/forge.mjs probe /absolute/path/to/game --seconds 8 --strict
node bin/forge.mjs shots /absolute/path/to/game
node bin/forge.mjs play /absolute/path/to/game
```

В созданном `forge.config.mjs` укажите статическую сборку игры (`root` и `entry`).
Браузерные сценарии задайте в `forge/scenarios.mjs`.
Для WebGL добавьте `renderer: 'webgl'`, для отрисовки по событиям —
`renderMode: 'on-demand'`.

Для `probe` адаптер симуляции не нужен. Для `sim` реализуйте
[контракт адаптера](game-forge/adapters/ADAPTER.md); при наличии адаптера
`all` тоже запускает симуляцию. Самодостаточный пример —
[tiny-game](fixtures/tiny-game/), более крупные интеграции —
[docs/examples](docs/examples/).

## Попробовать blender-kit

Отдельно установите **Blender 5.x**. На Linux добавьте `blender` в `PATH`;
на macOS обёртка также ищет `/Applications/Blender.app`.
Произвольный путь задаётся через `BLENDER_APP=/absolute/path/to/blender`.

```bash
cd blender-kit
./blend.sh demo_robot.py -- --out /tmp/robot.blend
./blend.sh render_preview.py --blend /tmp/robot.blend -- --out /tmp/preview.png
./blend.sh bake_sprites.py --blend /tmp/robot.blend -- \
  --out /tmp/robot-sprites --anim walk --dirs 8 --frames 1-24 --step 3 --size 96
```

BlenderMCP для этих команд не нужен.
[Параметры и ограничения Blender →](blender-kit/README.ru.md)

## Необязательная настройка Claude Code

```bash
./install.sh /absolute/path/to/project
```

Установщик копирует агентов и скиллы в `.claude/` проекта, перезаписывая
файлы с совпадающими именами. Перед установкой прочитайте промпты.
Нужные симлинки в `tools/` установщик выводит сам. Промпты, вызывающие
CLI других моделей, требуют отдельной установки этих CLI.

## Как читать результаты

- Работа кадра — время JavaScript внутри animation callbacks, без времени GPU.
  Для WebGL на реальном GPU используйте `--headed` и профилируйте целевые устройства.
- Зелёный probe означает, что заданные проверки прошли. Он не доказывает
  качество визуала, производительность на телефоне, доступность или интересность игры.
- Симуляция измеряет поведение ботов. Стена баланса может оказаться ошибкой бота.
- Снятые PNG нужно открыть и оценить самостоятельно или передать ревьюеру:
  съёмка не запускает визуальное ревью автоматически.
- Запускайте только доверенные игры, конфиги, адаптеры и Blender-скрипты:
  они исполняют код локально. Встроенный сервер предназначен для локальных прогонов.

[Подробности измерений →](game-forge/README.ru.md)

## Разработка

```bash
cd game-forge
npm ci
npm run test:unit
npm run test:e2e  # нужен Chromium
```

CI также проверяет исправные и сломанные примеры рендера, попадание указателем,
результаты симуляции и синтаксис скриптов. Рендер Blender в CI не проверяется.
Порядок работы — в [CONTRIBUTING.md](CONTRIBUTING.md).

## Лицензия и благодарности

[MIT](LICENSE). Заимствованные материалы о моделировании в Blender сохраняют
исходную лицензию и авторство: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Вдохновлено [The Long Silence](https://github.com/achimala/TheLongSilence)
и докладом Антона Чуева о сложностях разработки игр с помощью ИИ.
