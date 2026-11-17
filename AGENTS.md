# Yamobur — Instructions for AI Agents

## Commands
- Нет. Чистая статика.

## Conventions
- Static HTML, zero deps
- Лендинг услуги ямобура-вездехода (Гефест, Пермь)
- Рабочая копия: `D:\laragon\www\yamobur\` (клон репо, Laragon: http://localhost/yamobur/site/)
- Прод: `yamobur-vezdehod.ru` на crafty, каталог `www/yamobur-vezdehod.ru/`; деплой — содержимое `site/` целиком. Домен, DNS, SSL, Вебмастер и Метрика — `docs/CONTEXT.md`, раздел «Домен, хостинг и деплой»
- Единственный проект по сайту — этот репозиторий; `yamobur-vezdehod.ru` сведён к указателю

## Structure
- `site/` — статик-сайт (index, harakteristiki, ceny, raboty, statyi, stati/*.html, css/, js/, img/, robots.txt, sitemap.xml)
- `*.html` + `*_files/` в корне — Joomla-сохранёнки, источник контента (НЕ трогать, не деплоить)

## Do NOT touch
- Ничего не удалять. Сохранёнки не редактировать.
- Контент статей вне сохранёнок — из Wayback (актуальность подтверждать владельцем).

## Documentation rules
- После работы — обнови docs/CONTEXT.md
- НЕ создавай новых файлов документации без разрешения
