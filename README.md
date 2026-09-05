# Berg Kassa WebUI

WebUI для просмотра и ведения операций в PostgreSQL `berg_kassa`.
Пользователь выбирает рабочую схему из списка, заданного в его профиле.

## Запуск

```powershell
.\.tools\php\php.exe bin\create-user.php
$password = Read-Host 'Пароль пользователя' -AsSecureString
$env:NEW_USER_PASSWORD = [Net.NetworkCredential]::new('', $password).Password
.\.tools\php\php.exe bin\create-user.php admin vl,company_2 1
Remove-Item Env:NEW_USER_PASSWORD
.\start-local.cmd
```

После запуска откройте <http://127.0.0.1:8080>.

Схемы перечисляются через запятую в команде и сохраняются как PostgreSQL-массив
`text[]` в `auth.users.data_schema`. Последний аргумент команды управляет доступом к
защищённым операциям: `1` — доступ разрешён, `0` — запрещён. Команда также
обновляет существующего пользователя с тем же логином.

Короткая команда для локальной базы с безопасным запросом пароля:

```powershell
.\bin\add-local-user.ps1 new_user vl 1
```

События входа, отказа доступа и изменения данных записываются в
`auth.audit_log`. Для удаления записей старше 180 дней:

```powershell
.\.tools\php\php.exe bin\prune-audit-log.php 180
```

Приложение читает подключение к PostgreSQL из `.env`. Для повторного импорта
данных из баз MSSQL в соответствующие схемы PostgreSQL задайте пары в нужном
порядке и запустите мигратор:

```dotenv
MSSQL_MIGRATIONS=trading:vl,khb_trading:khb,uss_trading:uss
```

```powershell
python -m pip install -r requirements.txt
python migrate_trading.py --apply
```

## Проверка без изменения данных

```powershell
python migrate_trading.py
.\.tools\php\php.exe -l src\app.php
.\.tools\php\php.exe -l public\index.php
node --check public\js\app.js
node --check public\js\login.js
```

Полный комплект включает статические, unit-, SQL/schema-, API- и UI-тесты.
CRUD-сценарии создают только временные записи и удаляют их после проверки:

```powershell
npm install
npx playwright install chromium
npm test
npx playwright show-report
```

Учётные данные E2E автоматически читаются из `.env`. Отдельный read-only
нагрузочный прогон (100 сценариев, 8 параллельных работников):

```powershell
npm run test:load
```

## Перенос на хостинг

Заполните `HOSTING_PGSQL_*` и `FTP_KASSA_*` в локальном `.env`. Создайте дамп
нужных схем и восстановите его в PostgreSQL хостинга:

```powershell
.\bin\backup-database.ps1 -Schemas auth,vl
.\bin\restore-hosting-database.ps1
```

Ключ `-Replace` у второго скрипта полностью заменяет уже существующие объекты из
дампа. Загрузка PHP-приложения не удаляет посторонние файлы, включая `cgi-bin`:

```powershell
.\bin\deploy-hosting.ps1
```

Перед загрузкой файлов скрипт автоматически инициализирует и обновляет объекты
схемы `auth` в PostgreSQL хостинга, включая таблицу журнала аудита.

Скрипт намеренно не передаёт `.env` по незашифрованному FTP. Создайте `.env`
уровнем выше `public_html` через SSH или защищённый файловый менеджер, используя
PostgreSQL-параметры хостинга как значения `LOCAL_PGSQL_*`.


## Структура приложения

- `src/app.php` — подключение к БД, общие HTTP-функции и фильтры.
- `src/auth.php` — сессии, авторизация, пользователи и аудит.
- `src/references.php` — справочники.
- `src/operations.php` — операции, десятичные значения и расчёт итогов.
- `src/bootstrap.php` — загрузка окружения и запуск сессии для веба и CLI.
  Подключение одного `app.php` не запускает сессию и не читает `.env`.
- `public/js/connection.js` — контроль соединения, общий `fetchJson` и выход.
- `public/js/virtual-list.js` — виртуализированный список операций;
  загружается перед `app.js`, который создаёт списки и управляет страницей.

Скрипт выгрузки включает все PHP-файлы `src` и публичные ресурсы. Тесты
конкурентной записи используют локальную БД и временные операции; помощник
`tests/integration/hold-action.php` на хостинг не выгружается.
