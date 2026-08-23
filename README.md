# Berg Kassa WebUI

Read-only WebUI для просмотра операций из PostgreSQL `berg_kassa`, схема `vl`.

## Запуск

```powershell
.\.tools\php\php.exe bin\create-user.php
$password = Read-Host 'Пароль пользователя' -AsSecureString
$env:NEW_USER_PASSWORD = [Net.NetworkCredential]::new('', $password).Password
.\.tools\php\php.exe bin\create-user.php admin vl,company_2 1
Remove-Item Env:NEW_USER_PASSWORD
.\php.cmd -S 127.0.0.1:8080 -t public public\router.php
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

Приложение читает подключение к PostgreSQL из `.env`. Для повторного импорта
данных из MSSQL:

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

Скрипт намеренно не передаёт `.env` по незашифрованному FTP. Создайте `.env`
уровнем выше `public_html` через SSH или защищённый файловый менеджер, используя
PostgreSQL-параметры хостинга как значения `LOCAL_PGSQL_*`.
