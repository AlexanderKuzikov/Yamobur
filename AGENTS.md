# Yamobur — Instructions for AI Agents

## Commands
- Нет. Чистая статика.

## Conventions
- Static HTML, zero deps
- Лендинг услуги ямобура-вездехода (Гефест, Пермь)
- Рабочая копия: `D:\laragon\www\yamobur\` (клон репо, Laragon: http://localhost/yamobur/site/)
- Прод: `yamobur-vezdehod.ru` на собственном VPS Sat (Selectel, `135.106.192.125`), Caddy, каталог `/var/www/sites/yamobur_vezdehod_ru/public`; деплой — содержимое `site/` целиком. Домен, DNS, SSL, Вебмастер и Метрика — `docs/CONTEXT.md`, раздел «Домен, хостинг и деплой»; инфраструктура — проект `Sites`
- Единственный проект по сайту — этот репозиторий; `yamobur-vezdehod.ru` сведён к указателю

## Structure
- `site/` — статик-сайт (index, harakteristiki, ceny, raboty, statyi, stati/*.html, css/, js/, img/, robots.txt, sitemap.xml)
- `tools/` — dev-скрипты без зависимостей: `build-design.mjs` (сборка страницы вариантов), `check-layout.mjs` (проверка вёрстки на 390/768/1440)
- `archive/` — архив: старый светлый сайт, пять вариантов дизайна, черновики v2. Не деплоится
- `*.html` + `*_files/` в корне — Joomla-сохранёнки, источник контента (НЕ трогать, не деплоить)

## Do NOT touch
- Ничего не удалять. Сохранёнки не редактировать.
- Контент статей вне сохранёнок — из Wayback (актуальность подтверждать владельцем).

## Documentation rules
- После работы — обнови docs/CONTEXT.md
- Все находки, замечания, замеры и договорённости фиксировать в docs/CONTEXT.md в той же сессии, даже если обсуждение не закончено. Чат не считается хранилищем: всё, что не записано, теряется
- НЕ создавай новых файлов документации без разрешения
