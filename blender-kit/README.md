# blender-kit

Headless-обвязка Blender для игровых ассетов: спрайтшиты, превью моделей,
интеграция с Claude через BlenderMCP.

Требует Blender 5.x (`/Applications/Blender.app`, сейчас 5.1.1). Всё, кроме
интерактивной лепки, работает без GUI — значит повторяемо и годится для
автономного цикла.

## Скрипты

| Файл | Что делает |
|---|---|
| `blend.sh` | обёртка `blender -b -P` |
| `bake_sprites.py` | 3D → атлас спрайтов (направления × кадры) + JSON под Phaser |
| `render_preview.py` | 4 ракурса в один PNG, чтобы агент посмотрел на модель |
| `demo_robot.py` | тестовая модель с анимацией шага |
| `forge_bpy.py` | общее: камера, свет, рендер, работа с пикселями, атлас |
| `install_mcp_addon.sh` | ставит аддон BlenderMCP для интерактивного режима |

## Примеры

```bash
./blend.sh demo_robot.py -- --out /tmp/robot.blend
./blend.sh render_preview.py --blend /tmp/robot.blend -- --out /tmp/preview.png
./blend.sh bake_sprites.py --blend /tmp/robot.blend -- \
  --out /tmp/robot-sprites --anim walk --dirs 8 --frames 1-24 --step 3 --size 96
```

## Два режима работы с Blender

**Headless (по умолчанию).** Скрипт на bpy собирает сцену и рендерит.
Детерминирован, повторяем, годится для цикла «поменял параметр → пересобрал».

**Интерактивный (BlenderMCP).** Claude пишет код в живой Blender через сокет
`localhost:9876` и сразу видит результат — так удобно лепить форму.
Установка: `./install_mcp_addon.sh`, затем в Blender N-панель → BlenderMCP →
Connect, и `claude mcp add blender -- uvx blender-mcp`.

Практика из [TheLongSilence](https://github.com/achimala/TheLongSilence):
лепим интерактивно, найденный приём переносим в скрипт, скрипт становится
частью сборки. Метод моделирования — скилл `blender-hardsurface`.

## Грабли

- `primitive_cube_add(size=1)` даёт куб со стороной 1 — `scale` равен нужному
  размеру, а не половине.
- Blender хранит пиксели снизу вверх: при чтении/записи нужен `[::-1]`.
- Даунсемпл без премультипликации альфы даёт ореол по контуру спрайта.
- Имя движка EEVEE менялось между версиями — `forge_bpy.setup_render()`
  выбирает существующий из `BLENDER_EEVEE_NEXT` / `BLENDER_EEVEE` / `CYCLES`.
- Подозрительно быстрый рендер в 5.x = композитор без `CompositorNodeRLayers`
  (подробности в скилле `blender-hardsurface`).
